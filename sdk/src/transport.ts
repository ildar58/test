import { gzipSync, strToU8 } from 'fflate';
import type { eventWithTime } from '@rrweb/types';

export interface Batch {
  session_id: string;
  batch_seq: number;
  events_b64_gzip: string;
}

function encodeBatch(events: eventWithTime[]): string {
  const u8 = strToU8(JSON.stringify(events));
  const compressed = gzipSync(u8, { level: 6 });
  let binary = '';
  compressed.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export class Transport {
  private buffer: eventWithTime[] = [];
  private batchSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly endpoint: string;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly onUnauthorized?: () => void;
  private readonly onAuthorized?: () => void;
  private onVisibilityChange: (() => void) | null = null;
  private onPageHide: (() => void) | null = null;

  constructor(
    endpoint: string,
    flushIntervalMs: number,
    maxBufferSize: number,
    onUnauthorized?: () => void,
    onAuthorized?: () => void
  ) {
    this.endpoint = endpoint;
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
    this.onUnauthorized = onUnauthorized;
    this.onAuthorized = onAuthorized;
  }

  start(sessionId: string): void {
    this.timer = setInterval(() => this.flush(sessionId), this.flushIntervalMs);

    this.onPageHide = () => this.beaconFlush(sessionId);
    this.onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this.beaconFlush(sessionId);
    };
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
  }

  push(event: eventWithTime, sessionId: string): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBufferSize) this.flush(sessionId);
  }

  flush(sessionId: string): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    const batch: Batch = {
      session_id: sessionId,
      batch_seq: ++this.batchSeq,
      events_b64_gzip: encodeBatch(events),
    };
    fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      credentials: 'include',
      keepalive: true,
    })
      .then((res) => {
        if (res.status === 401 && this.onUnauthorized) this.onUnauthorized();
        else if (res.ok && this.onAuthorized) this.onAuthorized();
      })
      .catch(() => {
        // silently drop on network error
      });
  }

  private beaconFlush(sessionId: string): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    const batch: Batch = {
      session_id: sessionId,
      batch_seq: ++this.batchSeq,
      events_b64_gzip: encodeBatch(events),
    };
    const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
    navigator.sendBeacon(this.endpoint, blob);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.onVisibilityChange) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
    if (this.onPageHide) {
      window.removeEventListener('pagehide', this.onPageHide);
      this.onPageHide = null;
    }
  }
}
