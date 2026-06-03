import { record } from 'rrweb';
import type { eventWithTime, listenerHandler } from '@rrweb/types';
import type { RecorderConfig } from './config';
import { Transport } from './transport';
import { readMarker, watchMarker, readCookieValue } from './auth';

type RecordOptions = NonNullable<Parameters<typeof record>[0]>;

const SID_KEY = '_pam_sid';
const SEQ_KEY = '_pam_seq';

type State = 'IDLE' | 'ACTIVE' | 'STOPPED';

// Хранилище для сохранения session_id и batch_seq между перезагрузками.
// Очищается при выходе, чтобы следующая сессия начиналась чистой.
// Все обращения обёрнуты в try/catch: в приватном режиме и кросс-орижин iframe sessionStorage бросает.
const sessionIdStorage = {
  readId(): string | null {
    try { return sessionStorage.getItem(SID_KEY); }
    catch { return null; }
  },
  writeId(id: string): void {
    try { sessionStorage.setItem(SID_KEY, id); }
    catch { /* in-memory only */ }
  },
  readSeq(): number {
    try {
      const raw = sessionStorage.getItem(SEQ_KEY);
      const n = raw === null ? 0 : Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch { return 0; }
  },
  writeSeq(n: number): void {
    try { sessionStorage.setItem(SEQ_KEY, String(n)); }
    catch { /* ignore */ }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(SID_KEY);
      sessionStorage.removeItem(SEQ_KEY);
    } catch { /* ignore */ }
  },
};

function buildRrwebOptions(
  config: RecorderConfig,
  emit: (event: eventWithTime) => void
): RecordOptions {
  return {
    blockClass: config.blockClass,
    ignoreClass: config.ignoreClass,
    maskTextClass: config.maskTextClass,
    maskAllInputs: config.maskAllInputs,
    maskInputOptions: config.maskInputOptions,
    inlineStylesheet: config.inlineStylesheet,
    collectFonts: config.collectFonts,
    recordCrossOriginIframes: config.recordCrossOriginIframes,
    checkoutEveryNms: config.checkoutEveryNms,
    // rrweb типизирует emit как unknown для совместимости; расширяем здесь.
    emit: (event: unknown) => emit(event as eventWithTime),
  };
}

export class Recorder {
  private state: State = 'IDLE';
  private rrwebStop: listenerHandler | null = null;
  private transport: Transport | null = null;
  private disposeWatcher: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unauthorizedCount = 0;
  private cooldownUntil = 0;
  private activeSessionId: string | null = null;
  // session_id, по которому пришёл 401 — не реактивируем его, ждём новый (анти-loop)
  private failedSessionId: string | null = null;

  constructor(private readonly config: RecorderConfig) {}

  /** Идемпотентен. После stop() экземпляр не перезапускается, нужен новый. */
  start(): void {
    if (this.state !== 'IDLE') return;

    this.disposeWatcher = watchMarker(
      this.config.markerCookieName,
      (present) => (present ? this.tryActivate() : this.deactivate(true)),
      this.config.markerPollMs
    );

    // watchMarker реагирует только на изменения, поэтому при перезагрузке (маркер уже есть) запускаем вручную.
    if (readMarker(this.config.markerCookieName)) this.tryActivate();
  }

  private tryActivate(): void {
    if (this.state !== 'IDLE') return;
    if (Date.now() < this.cooldownUntil) return;

    // session_id выставляется бэкендом вместе с session_present; если куки ещё нет, ждём следующего фронта.
    const sessionId = readCookieValue(this.config.sessionIdCookieName);
    if (!sessionId) return;
    // не зацикливаемся на session_id, который сервер уже отверг (401): ждём новый.
    if (sessionId === this.failedSessionId) return;

    // Привязываем сохранённый batch_seq к session_id: для новой сессии сбрасываем,
    // для перезагрузки той же сессии — продолжаем нумерацию.
    if (sessionIdStorage.readId() !== sessionId) {
      sessionIdStorage.clear();
      sessionIdStorage.writeId(sessionId);
    }
    this.activeSessionId = sessionId;

    this.clearRetryTimer();
    this.transport = this.spawnTransport();
    this.transport.start(sessionId);
    this.rrwebStop =
      record(buildRrwebOptions(this.config, (event) =>
        this.transport?.push(event, sessionId)
      )) ?? null;

    this.state = 'ACTIVE';
  }

  private spawnTransport(): Transport {
    return new Transport({
      endpoint: this.config.endpoint,
      flushIntervalMs: this.config.flushIntervalMs,
      maxBufferSize: this.config.maxBufferSize,
      // Сохраняем batch_seq между перезагрузками, чтобы не сбрасывать порядковый номер.
      initialBatchSeq: sessionIdStorage.readSeq(),
      onBatchSeqAdvance: (seq) => sessionIdStorage.writeSeq(seq),
      onUnauthorized: () => this.onUnauthorized(),
      onAuthorized: () => this.onAuthorized(),
    });
  }

  // clearStorage=true только при настоящем выходе (маркер исчез): сбрасываем seq/sid.
  // При 401 храним их, чтобы перезагрузка той же сессии продолжила нумерацию seq.
  private deactivate(clearStorage: boolean): void {
    if (this.state !== 'ACTIVE') return;
    this.rrwebStop?.();
    this.rrwebStop = null;
    this.transport?.stop();
    this.transport = null;
    this.activeSessionId = null;
    if (clearStorage) sessionIdStorage.clear();
    this.state = 'IDLE';
  }

  // Несколько in-flight батчей могут вернуть 401 одновременно; guard сверху гарантирует однократное срабатывание.
  private onUnauthorized(): void {
    if (this.state !== 'ACTIVE') return;
    // запоминаем отвергнутый session_id (анти-loop) и НЕ сбрасываем хранилище.
    this.failedSessionId = this.activeSessionId;
    this.deactivate(false);
    this.unauthorizedCount += 1;

    // Watcher не даст фронт пока маркер не изменится, поэтому планируем retry явно.
    const delay = this.unauthorizedCount >= this.config.unauthorizedThreshold
      ? this.enterCooldown()
      : this.config.markerPollMs;
    this.scheduleRetry(delay);
  }

  /** Устанавливает срок cooldown и сбрасывает счётчик. Возвращает длительность. */
  private enterCooldown(): number {
    this.cooldownUntil = Date.now() + this.config.unauthorizedCooldownMs;
    this.unauthorizedCount = 0;
    return this.config.unauthorizedCooldownMs;
  }

  private onAuthorized(): void {
    // Успешный батч подтверждает валидность куки: сбрасываем счётчик 401 и анти-loop.
    this.unauthorizedCount = 0;
    this.failedSessionId = null;
  }

  private scheduleRetry(delayMs: number): void {
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.state === 'IDLE' && readMarker(this.config.markerCookieName)) {
        this.tryActivate();
      }
    }, delayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  stop(): void {
    this.deactivate(true);
    this.clearRetryTimer();
    this.disposeWatcher?.();
    this.disposeWatcher = null;
    this.state = 'STOPPED';
  }
}
