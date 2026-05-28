import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { Transport } from '../transport';

const ENDPOINT = 'http://test.local/s/';
const SESSION = 'session-1';

function decodeBatch(b64: string): unknown[] {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(strFromU8(gunzipSync(bytes))) as unknown[];
}

describe('Transport', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let beaconMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    beaconMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: beaconMock });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not flush before flushIntervalMs has elapsed', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION);
    t.push({ type: 0, data: {}, timestamp: 1 } as never, SESSION);

    vi.advanceTimersByTime(1_500);
    expect(fetchMock).not.toHaveBeenCalled();

    t.stop();
  });

  it('flushes via fetch after flushIntervalMs with credentials:"include"', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION);
    t.push({ type: 0, data: {}, timestamp: 1 } as never, SESSION);

    vi.advanceTimersByTime(2_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');

    t.stop();
  });

  it('wire payload contains session_id, batch_seq, events_b64_gzip and NO distinct_id', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION);
    const events = [
      { type: 0, data: { tag: 'meta' }, timestamp: 100 },
      { type: 2, data: { node: 'snapshot' }, timestamp: 200 },
    ];
    for (const e of events) t.push(e as never, SESSION);

    vi.advanceTimersByTime(2_000);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(body.session_id).toBe(SESSION);
    expect(body.batch_seq).toBe(1);
    expect('distinct_id' in body).toBe(false);
    expect(decodeBatch(body.events_b64_gzip as string)).toEqual(events);

    t.stop();
  });

  it('triggers sendBeacon on visibilitychange→hidden', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION);
    t.push({ type: 3, data: {}, timestamp: 9 } as never, SESSION);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(beaconMock).toHaveBeenCalledOnce();

    t.stop();
  });

  it('invokes onUnauthorized callback when server returns 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const onUnauthorized = vi.fn();
    const t = new Transport(ENDPOINT, 2_000, 1000, onUnauthorized);
    t.start(SESSION);
    t.push({ type: 0, data: {}, timestamp: 1 } as never, SESSION);

    vi.advanceTimersByTime(2_000);
    // Allow the fetch microtask to settle
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());

    t.stop();
  });

  it('invokes onAuthorized callback when server returns 200', async () => {
    const onAuthorized = vi.fn();
    const t = new Transport(ENDPOINT, 2_000, 1000, undefined, onAuthorized);
    t.start(SESSION);
    t.push({ type: 0, data: {}, timestamp: 1 } as never, SESSION);

    vi.advanceTimersByTime(2_000);
    await vi.waitFor(() => expect(onAuthorized).toHaveBeenCalledOnce());

    t.stop();
  });
});
