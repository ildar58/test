import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Recorder } from '../recorder';
import { DEFAULT_CONFIG } from '../config';

const { recordStop, recordMock } = vi.hoisted(() => {
  const stop = vi.fn();
  const mock = vi.fn(() => stop);
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

  it('activates immediately when marker is present at start() (reload while logged in)', () => {
    setCookie('session_present=1');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();

    expect(recordMock).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('_pam_sid')).toMatch(/^[0-9a-f-]{36}$/);

    r.stop();
  });

  it('IDLE → ACTIVE when marker appears via watcher edge', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    setCookie('session_present=1');
    vi.advanceTimersByTime(1_000);

    expect(recordMock).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('_pam_sid')).toMatch(/^[0-9a-f-]{36}$/);

    r.stop();
  });

  it('reuses persisted sessionId across reload (sessionStorage continuity)', () => {
    sessionStorage.setItem('_pam_sid', 'persisted-uuid');
    setCookie('session_present=1');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();

    expect(recordMock).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('_pam_sid')).toBe('persisted-uuid');

    r.stop();
  });

  it('ACTIVE → IDLE when marker disappears: rrweb stops, sessionId cleared', () => {
    setCookie('session_present=1');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();
    expect(recordMock).toHaveBeenCalledOnce();
    const firstSid = sessionStorage.getItem('_pam_sid');
    expect(firstSid).toBeTruthy();

    setCookie('');
    vi.advanceTimersByTime(1_000);
    expect(recordStop).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('_pam_sid')).toBeNull();

    r.stop();
  });

  it('re-login after logout produces a new session_id (D5)', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    setCookie('session_present=1');
    vi.advanceTimersByTime(1_000);
    const first = sessionStorage.getItem('_pam_sid');

    setCookie('');
    vi.advanceTimersByTime(1_000);

    setCookie('session_present=1');
    vi.advanceTimersByTime(1_000);
    const second = sessionStorage.getItem('_pam_sid');

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    r.stop();
  });

  it('401 from transport transitions ACTIVE → IDLE and drops buffer', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie('session_present=1');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();
    expect(recordMock).toHaveBeenCalledOnce();

    const emit = recordMock.mock.calls[0]![0].emit;
    emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledOnce());

    expect(sessionStorage.getItem('_pam_sid')).toBeNull();

    r.stop();
  });

  it('below threshold: schedules a retry that re-activates while marker is still present', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    setCookie('session_present=1');
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 1_000,
      unauthorizedThreshold: 5,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    // First 401 → deactivate → schedule retry after markerPollMs
    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));

    // Subsequent flushes succeed
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    r.stop();
  });

  it('after unauthorizedThreshold consecutive 401s, suppresses retry until cool-down expires', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie('session_present=1');
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 1_000,
      unauthorizedThreshold: 2,
      unauthorizedCooldownMs: 10_000,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    // First 401 (count=1, below threshold) → retry scheduled at 1s
    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    // Second 401 (count=2, at threshold) → cool-down (10s) instead of retry
    recordMock.mock.calls[1]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(2));

    // Within cool-down: no re-activation even though marker is still present
    vi.advanceTimersByTime(5_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    // Server recovers; cool-down expires → retry fires → re-activate
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(5_000);
    expect(recordMock).toHaveBeenCalledTimes(3);

    r.stop();
  });

  it('concurrent 401s within one ACTIVE phase increment counter only once', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie('session_present=1');
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 60_000,
      unauthorizedThreshold: 2,
      unauthorizedCooldownMs: 10_000,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    // Push two events into the buffer and fire two flushes back-to-back —
    // both fetches resolve with 401; counter must increment only once.
    const emit = recordMock.mock.calls[0]![0].emit;
    emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    emit({ type: 0, data: {}, timestamp: 2 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));

    // count=1, below threshold=2 → retry at markerPollMs (60s away).
    // If the race had counted twice (=2), cool-down would block this retry.
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(60_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    r.stop();
  });
});
