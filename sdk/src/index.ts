/**
 * @pam/web-session-recorder — public API
 *
 * Usage:
 *   import { init } from '@pam/web-session-recorder';
 *   init({ endpoint: '/s/', sessionId: 'abc', distinctId: 'user@example.com' });
 *
 * Angular/React/Vue: call init() once in your bootstrap / ngOnInit / onMounted.
 * Call stop() on ngOnDestroy / component unmount if SPA navigation.
 */

import { DEFAULT_CONFIG, type RecorderConfig } from './config';
import { Recorder } from './recorder';

export type { RecorderConfig };

export interface InitOptions extends Partial<RecorderConfig> {
  /** Optional: unique session ID. If omitted, a UUID is generated and persisted in sessionStorage. */
  sessionId?: string;
  /** Optional: user identifier. Defaults to 'anonymous'. Can be updated later via identify(). */
  distinctId?: string;
}

let instance: Recorder | null = null;

const SESSION_STORAGE_KEY = '_pam_sid';

function resolveSessionId(provided?: string): string {
  if (provided) return provided;
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // sessionStorage unavailable (privacy mode, SSR) — fall back to per-pageload UUID
    return crypto.randomUUID();
  }
}

/**
 * Initialize and start recording.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function init(options: InitOptions): void {
  if (instance) return;

  const { sessionId, distinctId, ...overrides } = options;
  const config: RecorderConfig = { ...DEFAULT_CONFIG, ...overrides };
  const resolvedSessionId = resolveSessionId(sessionId);
  const resolvedDistinctId = distinctId ?? 'anonymous';

  instance = new Recorder(config, resolvedSessionId, resolvedDistinctId);
  instance.start();
}

/**
 * Stop recording and flush remaining events.
 */
export function stop(): void {
  instance?.stop();
  instance = null;
}

/**
 * Update the user identity mid-session.
 * Sends a custom event so the replayer can annotate.
 */
export function identify(userId: string, traits?: Record<string, unknown>): void {
  instance?.addCustomEvent('identify', { userId, ...traits });
}

/**
 * Emit a named custom event visible in the replayer timeline.
 */
export function addCustomEvent(
  tag: string,
  payload: Record<string, unknown>
): void {
  instance?.addCustomEvent(tag, payload);
}
