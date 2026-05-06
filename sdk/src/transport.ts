import { gzipSync, strToU8 } from 'fflate';
import type { eventWithTime } from '@rrweb/types';

export interface Batch {
  session_id: string;
  distinct_id: string;
  batch_seq: number;
  events_b64_gzip: string;
}

function encodeBatch(events: eventWithTime[]): string {
  const json = JSON.stringify(events);
  const u8 = strToU8(json);
  const compressed = gzipSync(u8, { level: 6 });
  // base64 encode
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
  private onVisibilityChange: (() => void) | null = null;
  private onPageHide: (() => void) | null = null;

  constructor(
    endpoint: string,
    flushIntervalMs: number,
    maxBufferSize: number
  ) {
    this.endpoint = endpoint;
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
  }

  start(sessionId: string, distinctId: string): void {
    this.timer = setInterval(
      () => this.flush(sessionId, distinctId),
      this.flushIntervalMs
    );

    // Final flush on page hide/unload — track handlers so we can remove them in stop()
    this.onPageHide = () => this.beaconFlush(sessionId, distinctId);
    this.onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this.beaconFlush(sessionId, distinctId);
    };
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
  }

  push(event: eventWithTime, sessionId: string, distinctId: string): void {
    this.buffer = [...this.buffer, event];
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush(sessionId, distinctId);
    }
  }

  flush(sessionId: string, distinctId: string): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    const batch: Batch = {
      session_id: sessionId,
      distinct_id: distinctId,
      batch_seq: ++this.batchSeq,
      events_b64_gzip: encodeBatch(events),
    };
    fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      keepalive: true,
    }).catch(() => {
      // silently drop on error — add retry logic in production
    });
  }

  private beaconFlush(sessionId: string, distinctId: string): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    const batch: Batch = {
      session_id: sessionId,
      distinct_id: distinctId,
      batch_seq: ++this.batchSeq,
      events_b64_gzip: encodeBatch(events),
    };
    const blob = new Blob([JSON.stringify(batch)], {
      type: 'application/json',
    });
    // sendBeacon is fire-and-forget, max ~64KB
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
