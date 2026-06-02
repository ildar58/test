import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Recorder } from '../recorder';
import { DEFAULT_CONFIG } from '../config';

const { recordStop, recordMock } = vi.hoisted(() => {
  const stop = vi.fn<[], void>();
  const mock = vi.fn<[opts: { emit: (e: unknown) => void }], () => void>(() => stop);
  return { recordStop: stop, recordMock: mock };
});
vi.mock('rrweb', () => ({
  record: Object.assign(
    (opts: { emit: (e: unknown) => void }) => recordMock(opts),
    { addCustomEvent: vi.fn() }
  ),
}));

function setCookie(value: string): void {
  Object.defineProperty(document, 'cookie', { configurable: true, value, writable: true });
}

// Backend sets session_present AND session_id together on login.
const LOGGED_IN = 'session_present=1; session_id=sid-1';

/** Parsed bodies of every batch POST the transport has flushed so far. */
function flushedBodies(fetchMock: ReturnType<typeof vi.fn>): Array<{ session_id: string }> {
  return fetchMock.mock.calls.map(
    (c) => JSON.parse((c[1] as RequestInit).body as string) as { session_id: string }
  );
}

describe('Recorder state machine', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    setCookie('');
    sessionStorage.clear();
    recordMock.mockClear();
    recordStop.mockClear();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(true) });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts in IDLE — no rrweb.record while marker is absent', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    vi.advanceTimersByTime(3_000);
    expect(recordMock).not.toHaveBeenCalled();

    r.stop();
  });

  it('activates immediately when marker + session_id are present at start()', () => {
    setCookie(LOGGED_IN);
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();

    expect(recordMock).toHaveBeenCalledOnce();

    r.stop();
  });

  it('stays IDLE when marker is present but session_id cookie is missing', () => {
    setCookie('session_present=1');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    vi.advanceTimersByTime(3_000);
    expect(recordMock).not.toHaveBeenCalled();

    r.stop();
  });

  it('IDLE → ACTIVE when marker appears via watcher edge', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    setCookie(LOGGED_IN);
    vi.advanceTimersByTime(1_000);

    expect(recordMock).toHaveBeenCalledOnce();

    r.stop();
  });

  it('tags flushed batches with the session_id from the cookie', () => {
    setCookie('session_present=1; session_id=fixed-sid');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();
    expect(recordMock).toHaveBeenCalledOnce();

    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);

    const bodies = flushedBodies(fetchMock);
    expect(bodies.length).toBe(1);
    expect(bodies[0]!.session_id).toBe('fixed-sid');

    r.stop();
  });

  it('ACTIVE → IDLE when marker disappears: rrweb stops', () => {
    setCookie(LOGGED_IN);
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();
    expect(recordMock).toHaveBeenCalledOnce();

    setCookie('');
    vi.advanceTimersByTime(1_000);
    expect(recordStop).toHaveBeenCalledOnce();

    r.stop();
  });

  it('re-login picks up the new session_id minted by the backend', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    setCookie('session_present=1; session_id=id1');
    vi.advanceTimersByTime(1_000);
    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);

    setCookie('');
    vi.advanceTimersByTime(1_000);

    setCookie('session_present=1; session_id=id2');
    vi.advanceTimersByTime(1_000);
    recordMock.mock.calls[1]![0].emit({ type: 0, data: {}, timestamp: 2 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);

    const bodies = flushedBodies(fetchMock);
    expect(bodies[0]!.session_id).toBe('id1');
    expect(bodies[bodies.length - 1]!.session_id).toBe('id2');

    r.stop();
  });

  it('401 from transport transitions ACTIVE → IDLE and drops buffer', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie(LOGGED_IN);
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();
    expect(recordMock).toHaveBeenCalledOnce();

    const emit = recordMock.mock.calls[0]![0].emit;
    emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledOnce());

    r.stop();
  });

  it('below threshold: schedules a retry that re-activates while marker is still present', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    setCookie(LOGGED_IN);
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 1_000,
      unauthorizedThreshold: 5,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    r.stop();
  });

  it('after unauthorizedThreshold consecutive 401s, suppresses retry until cool-down expires', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie(LOGGED_IN);
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 1_000,
      unauthorizedThreshold: 2,
      unauthorizedCooldownMs: 10_000,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    recordMock.mock.calls[1]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(2));

    vi.advanceTimersByTime(5_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(5_000);
    expect(recordMock).toHaveBeenCalledTimes(3);

    r.stop();
  });

  it('concurrent 401s within one ACTIVE phase increment the counter only once', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie(LOGGED_IN);
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 60_000,
      unauthorizedThreshold: 2,
      unauthorizedCooldownMs: 10_000,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    const emit = recordMock.mock.calls[0]![0].emit;
    emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    emit({ type: 0, data: {}, timestamp: 2 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(60_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    r.stop();
  });

  it('resets unauthorizedCount when a batch succeeds with 200 (non-consecutive 401s)', async () => {
    setCookie(LOGGED_IN);
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 1_000,
      unauthorizedThreshold: 2,
      unauthorizedCooldownMs: 60_000,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    recordMock.mock.calls[1]![0].emit({ type: 0, data: {}, timestamp: 2 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    recordMock.mock.calls[1]![0].emit({ type: 0, data: {}, timestamp: 3 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(2));

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(3);

    r.stop();
  });
});
