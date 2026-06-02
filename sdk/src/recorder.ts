import { record } from 'rrweb';
import type { eventWithTime, listenerHandler } from '@rrweb/types';
import type { RecorderConfig } from './config';
import { Transport } from './transport';
import { readMarker, watchMarker, readCookieValue } from './auth';

type RecordOptions = NonNullable<Parameters<typeof record>[0]>;

const SID_KEY = '_pam_sid';
const SEQ_KEY = '_pam_seq';

type State = 'IDLE' | 'ACTIVE' | 'STOPPED';

/**
 * sessionStorage wrapper for reload-continuity. Survives reload (so we keep
 * the same session_id AND the monotonic batch_seq), but is cleared on logout
 * so the next ACTIVE phase starts a fresh session. Every access is guarded —
 * sessionStorage can throw in private-browsing modes and inside cross-origin
 * iframes.
 */
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
    // rrweb types emit as `unknown` for forward-compat; widen here once.
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

  constructor(private readonly config: RecorderConfig) {}

  /**
   * Idempotent. No-op if the recorder is already ACTIVE or has been stop()ped
   * — a single Recorder instance is single-use; create a new one if you need
   * to restart after stop().
   */
  start(): void {
    if (this.state !== 'IDLE') return;

    this.disposeWatcher = watchMarker(
      this.config.markerCookieName,
      (present) => (present ? this.tryActivate() : this.deactivate()),
      this.config.markerPollMs
    );

    // watchMarker only fires on edges. If the marker is already present at
    // start() (e.g. page reload while logged in), kick off ACTIVE explicitly.
    if (readMarker(this.config.markerCookieName)) this.tryActivate();
  }

  private tryActivate(): void {
    if (this.state !== 'IDLE') return;
    if (Date.now() < this.cooldownUntil) return;

    // V1: the recording session id is minted by the backend and delivered as a
    // cookie alongside session_present. If it isn't readable yet, stay IDLE —
    // the backend sets both atomically, so the next auth edge will carry it.
    const sessionId = readCookieValue(this.config.sessionIdCookieName);
    if (!sessionId) return;

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
      // Keep batch_seq monotonic across reloads. Without persistence the
      // counter would reset to 1 every time the page reloads while logged in,
      // violating the per-session_id ordering contract documented in
      // ARCHITECTURE.md.
      initialBatchSeq: sessionIdStorage.readSeq(),
      onBatchSeqAdvance: (seq) => sessionIdStorage.writeSeq(seq),
      onUnauthorized: () => this.onUnauthorized(),
      onAuthorized: () => this.onAuthorized(),
    });
  }

  private deactivate(): void {
    if (this.state !== 'ACTIVE') return;
    this.rrwebStop?.();
    this.rrwebStop = null;
    this.transport?.stop();
    this.transport = null;
    sessionIdStorage.clear();
    this.state = 'IDLE';
  }

  /**
   * Called by Transport when a batch returns 401. Multiple in-flight batches
   * can race here, so the state guard at the top ensures the counter advances
   * at most once per ACTIVE phase.
   */
  private onUnauthorized(): void {
    if (this.state !== 'ACTIVE') return;
    this.deactivate();
    this.unauthorizedCount += 1;

    // The watcher will not fire an edge while the marker stays present, so
    // schedule an explicit retry here. If logout happens in the meantime,
    // tryActivate's state guard or the watcher's edge callback handles it.
    const delay = this.unauthorizedCount >= this.config.unauthorizedThreshold
      ? this.enterCooldown()
      : this.config.markerPollMs;
    this.scheduleRetry(delay);
  }

  /** Sets the cooldown deadline and resets the counter. Returns the cooldown duration. */
  private enterCooldown(): number {
    this.cooldownUntil = Date.now() + this.config.unauthorizedCooldownMs;
    this.unauthorizedCount = 0;
    return this.config.unauthorizedCooldownMs;
  }

  private onAuthorized(): void {
    // A successful batch confirms the auth cookie is valid — reset the
    // consecutive-401 counter so future transient failures get the full
    // threshold of retries again.
    this.unauthorizedCount = 0;
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
    this.deactivate();
    this.clearRetryTimer();
    this.disposeWatcher?.();
    this.disposeWatcher = null;
    this.state = 'STOPPED';
  }
}
