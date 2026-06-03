import { gzipSync, strToU8 } from 'fflate';
import type { eventWithTime } from '@rrweb/types';

export interface Batch {
  session_id: string;
  batch_seq: number;
  events_b64_gzip: string;
}

export interface TransportOptions {
  endpoint: string;
  flushIntervalMs: number;
  maxBufferSize: number;
  /** Начальное значение batch_seq (для сохранения монотонности между перезагрузками). */
  initialBatchSeq?: number;
  /** Вызывается при инкременте batch_seq, чтобы вызывающий мог сохранить значение. */
  onBatchSeqAdvance?: (seq: number) => void;
  onUnauthorized?: () => void;
  onAuthorized?: () => void;
}

function encodeBatch(events: eventWithTime[]): string {
  const u8 = strToU8(JSON.stringify(events));
  const compressed = gzipSync(u8, { level: 6 });
  let binary = '';
  compressed.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export class Transport {
  private readonly opts: TransportOptions;
  private buffer: eventWithTime[] = [];
  private batchSeq: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushOnVisibilityHide: (() => void) | null = null;
  private flushOnPageHide: (() => void) | null = null;

  constructor(opts: TransportOptions) {
    this.opts = opts;
    this.batchSeq = opts.initialBatchSeq ?? 0;
  }

  start(sessionId: string): void {
    this.flushTimer = setInterval(
      () => this.flush(sessionId),
      this.opts.flushIntervalMs
    );

    this.flushOnPageHide = () => this.beaconFlush(sessionId);
    this.flushOnVisibilityHide = () => {
      if (document.visibilityState === 'hidden') this.beaconFlush(sessionId);
    };
    document.addEventListener('visibilitychange', this.flushOnVisibilityHide);
    window.addEventListener('pagehide', this.flushOnPageHide);
  }

  push(event: eventWithTime, sessionId: string): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.opts.maxBufferSize) this.flush(sessionId);
  }

  /** Атомарно забирает и очищает буфер, формируя батч. */
  private takeBatch(sessionId: string): Batch | null {
    if (this.buffer.length === 0) return null;
    const events = this.buffer;
    this.buffer = [];
    this.batchSeq += 1;
    this.opts.onBatchSeqAdvance?.(this.batchSeq);
    return {
      session_id: sessionId,
      batch_seq: this.batchSeq,
      events_b64_gzip: encodeBatch(events),
    };
  }

  async flush(sessionId: string): Promise<void> {
    const batch = this.takeBatch(sessionId);
    if (!batch) return;
    try {
      const res = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        credentials: 'include',
        keepalive: true,
      });
      if (res.status === 401) this.opts.onUnauthorized?.();
      else if (res.ok) this.opts.onAuthorized?.();
    } catch {
      // Сетевая ошибка: события уже извлечены из буфера и не возвращаются обратно.
      // Повторная постановка устаревших событий породила бы всплеск в следующем батче.
    }
  }

  /** sendBeacon гарантирует доставку при выгрузке страницы. */
  private beaconFlush(sessionId: string): void {
    const batch = this.takeBatch(sessionId);
    if (!batch) return;
    const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
    navigator.sendBeacon(this.opts.endpoint, blob);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushOnVisibilityHide) {
      document.removeEventListener('visibilitychange', this.flushOnVisibilityHide);
      this.flushOnVisibilityHide = null;
    }
    if (this.flushOnPageHide) {
      window.removeEventListener('pagehide', this.flushOnPageHide);
      this.flushOnPageHide = null;
    }
  }
}
