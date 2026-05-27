import { record } from 'rrweb';
import type { eventWithTime, listenerHandler } from '@rrweb/types';
import type { RecorderConfig } from './config';
import { Transport } from './transport';
import { readMarker, watchMarker } from './auth';

const SESSION_STORAGE_KEY = '_pam_sid';

type State = 'IDLE' | 'ACTIVE' | 'STOPPED';

function newSessionId(): string {
  return crypto.randomUUID();
}

function readPersistedSessionId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistSessionId(id: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    // sessionStorage unavailable; fall through with in-memory only
  }
}

function clearSessionId(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export class Recorder {
  private state: State = 'IDLE';
  private sessionId: string | null = null;
  private rrwebStop: listenerHandler | null = null;
  private transport: Transport | null = null;
  private disposeWatcher: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unauthorizedCount = 0;
  private cooldownUntil = 0;

  constructor(private readonly config: RecorderConfig) {}

  start(): void {
    if (this.state !== 'IDLE') return;

    this.disposeWatcher = watchMarker(
      this.config.markerCookieName,
      (present) => {
        if (present) this.tryActivate();
        else this.deactivate();
      },
      this.config.markerPollMs
    );

    // watchMarker only fires on edges. If the marker is already present at
    // start() (e.g. page reload while logged in), kick off ACTIVE explicitly.
    if (readMarker(this.config.markerCookieName)) {
      this.tryActivate();
    }
  }

  private tryActivate(): void {
    if (this.state !== 'IDLE') return;
    if (Date.now() < this.cooldownUntil) return;

    this.clearRetryTimer();

    // Reload continuity: if a sessionStorage UUID survives this page load,
    // reuse it so the server appends to the existing <sid>.jsonl. New ACTIVE
    // phases after logout (deactivate clears sessionStorage) get a fresh UUID.
    const persisted = readPersistedSessionId();
    const sid = persisted ?? newSessionId();
    if (!persisted) persistSessionId(sid);
    this.sessionId = sid;

    this.transport = new Transport(
      this.config.endpoint,
      this.config.flushIntervalMs,
      this.config.maxBufferSize,
      () => this.onUnauthorized()
    );
    this.transport.start(sid);

    this.rrwebStop =
      record({
        blockClass: this.config.blockClass,
        ignoreClass: this.config.ignoreClass,
        maskTextClass: this.config.maskTextClass,
        maskAllInputs: this.config.maskAllInputs,
        maskInputOptions: this.config.maskInputOptions,
        inlineStylesheet: this.config.inlineStylesheet,
        collectFonts: this.config.collectFonts,
        recordCrossOriginIframes: this.config.recordCrossOriginIframes,
        checkoutEveryNms: this.config.checkoutEveryNms,
        emit: (event: eventWithTime) => {
          if (this.transport) this.transport.push(event, sid);
        },
      }) ?? null;

    this.state = 'ACTIVE';
  }

  private deactivate(): void {
    if (this.state !== 'ACTIVE') return;
    if (this.rrwebStop) {
      this.rrwebStop();
      this.rrwebStop = null;
    }
    if (this.transport) {
      this.transport.stop();
      this.transport = null;
    }
    clearSessionId();
    this.sessionId = null;
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

    const atThreshold = this.unauthorizedCount >= this.config.unauthorizedThreshold;
    let delay: number;
    if (atThreshold) {
      this.cooldownUntil = Date.now() + this.config.unauthorizedCooldownMs;
      this.unauthorizedCount = 0;
      delay = this.config.unauthorizedCooldownMs;
    } else {
      delay = this.config.markerPollMs;
    }

    // The watcher will not fire an edge while the marker stays present, so
    // schedule an explicit retry here. If logout happens in the meantime,
    // tryActivate's state guard or the watcher's edge callback handles it.
    this.scheduleRetry(delay);
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
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  stop(): void {
    this.deactivate();
    this.clearRetryTimer();
    if (this.disposeWatcher) {
      this.disposeWatcher();
      this.disposeWatcher = null;
    }
    this.state = 'STOPPED';
  }
}
