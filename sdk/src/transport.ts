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
  // base64 от уже сжатых байт; чанками, чтобы не упереться в лимит аргументов apply.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < compressed.length; i += CHUNK) {
    binary += String.fromCharCode(...compressed.subarray(i, i + CHUNK));
  }
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
    this.flushTimer = setInterval(() => void this.flush(sessionId), this.opts.flushIntervalMs);

    this.flushOnPageHide = () => this.beaconFlush(sessionId);
    this.flushOnVisibilityHide = () => {
      if (document.visibilityState === 'hidden') this.beaconFlush(sessionId);
    };
    document.addEventListener('visibilitychange', this.flushOnVisibilityHide);
    window.addEventListener('pagehide', this.flushOnPageHide);
  }

  push(event: eventWithTime, sessionId: string): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.opts.maxBufferSize) void this.flush(sessionId);
  }

  private buildBatch(sessionId: string, events: eventWithTime[]): Batch {
    this.batchSeq += 1;
    this.opts.onBatchSeqAdvance?.(this.batchSeq);
    return {
      session_id: sessionId,
      batch_seq: this.batchSeq,
      events_b64_gzip: encodeBatch(events),
    };
  }

  // Возвращает события в буфер на повтор при временной ошибке; держит жёсткий потолок.
  private requeue(events: eventWithTime[]): void {
    this.buffer = events.concat(this.buffer);
    const cap = this.opts.maxBufferSize * 4;
    if (this.buffer.length > cap) this.buffer.splice(0, this.buffer.length - cap);
  }

  async flush(sessionId: string): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    const batch = this.buildBatch(sessionId, events);
    try {
      const res = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        credentials: 'include',
      });
      if (res.status === 401) {
        this.opts.onUnauthorized?.();
      } else if (res.ok) {
        this.opts.onAuthorized?.();
      } else if (res.status >= 500) {
        // временная серверная ошибка — повторим следующим тиком
        this.requeue(events);
      }
      // 4xx (включая 400/403/413) — постоянная ошибка, повтор не поможет: дропаем
    } catch {
      // сеть недоступна — вернём события и повторим (с потолком против разрастания)
      this.requeue(events);
    }
  }

  /** sendBeacon доставляет последний батч при выгрузке страницы. */
  private beaconFlush(sessionId: string): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    const batch = this.buildBatch(sessionId, events);
    const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
    // sendBeacon вернёт false, если payload отклонён (например, слишком большой) —
    // тогда не теряем события: возвращаем в буфер. На visibilitychange-hidden вкладка
    // может ещё ожить и отправить их обычным flush. batch_seq при этом «сгорает», но
    // сервер не требует непрерывности, а replay упорядочивает события по таймстампам.
    if (!navigator.sendBeacon(this.opts.endpoint, blob)) this.requeue(events);
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
