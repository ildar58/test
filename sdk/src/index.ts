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
  /** Required: unique session ID (generate with crypto.randomUUID()) */
  sessionId: string;
  /** Required: user identifier for your system */
  distinctId: string;
}

let instance: Recorder | null = null;

/**
 * Initialize and start recording.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function init(options: InitOptions): void {
  if (instance) return;

  const { sessionId, distinctId, ...overrides } = options;
  const config: RecorderConfig = { ...DEFAULT_CONFIG, ...overrides };

  instance = new Recorder(config, sessionId, distinctId);
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
