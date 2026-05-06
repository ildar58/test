import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { Transport } from '../transport';

const ENDPOINT = 'http://test.local/s/';
const SESSION = 'session-1';
const DISTINCT = 'user-1';

function decodeBatch(b64: string): unknown[] {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const decompressed = gunzipSync(bytes);
  return JSON.parse(strFromU8(decompressed)) as unknown[];
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
    t.start(SESSION, DISTINCT);
    t.push({ type: 0, data: {}, timestamp: 1 } as never, SESSION, DISTINCT);

    vi.advanceTimersByTime(1_500);
    expect(fetchMock).not.toHaveBeenCalled();

    t.stop();
  });

  it('flushes via fetch after 2 seconds', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION, DISTINCT);
    t.push({ type: 0, data: {}, timestamp: 1 } as never, SESSION, DISTINCT);
    t.push({ type: 1, data: {}, timestamp: 2 } as never, SESSION, DISTINCT);

    vi.advanceTimersByTime(2_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');

    t.stop();
  });

  it('encodes events via gzip + base64; round-trip recovers original', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION, DISTINCT);
    const events = [
      { type: 0, data: { tag: 'meta' }, timestamp: 100 },
      { type: 2, data: { node: 'snapshot' }, timestamp: 200 },
    ];
    for (const e of events) t.push(e as never, SESSION, DISTINCT);

    vi.advanceTimersByTime(2_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      events_b64_gzip: string;
      session_id: string;
      batch_seq: number;
    };
    expect(body.session_id).toBe(SESSION);
    expect(body.batch_seq).toBe(1);
    expect(decodeBatch(body.events_b64_gzip)).toEqual(events);

    t.stop();
  });

  it('triggers sendBeacon on visibilitychange→hidden', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION, DISTINCT);
    t.push({ type: 3, data: {}, timestamp: 9 } as never, SESSION, DISTINCT);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(beaconMock).toHaveBeenCalledOnce();
    const [url, blob] = beaconMock.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(blob).toBeInstanceOf(Blob);

    t.stop();
  });
});
