/**
 * @pam/web-session-recorder — public API
 *
 * Usage (typically called by nginx-injected snippet):
 *   import { init } from '@pam/web-session-recorder';
 *   init({ endpoint: '/s/' });
 *
 * The recorder stays IDLE until the marker cookie (default `session_present`)
 * is observed, then reads the server-minted recording id from the `session_id`
 * cookie to tag batches. User identity is derived server-side from the HttpOnly
 * auth cookie — the client never generates an id nor accepts one as an argument.
 */

import { DEFAULT_CONFIG, type RecorderConfig } from './config';
import { Recorder } from './recorder';
import { parseDatasetConfig } from './script-config';

export type { RecorderConfig };

export interface InitOptions extends Partial<RecorderConfig> {}

let instance: Recorder | null = null;

export function init(options: InitOptions = {}): void {
  if (instance) return;
  const config: RecorderConfig = { ...DEFAULT_CONFIG, ...options };
  instance = new Recorder(config);
  instance.start();
}

export function stop(): void {
  instance?.stop();
  instance = null;
}

/**
 * Initialize from a proxy-injected <script>'s data-* attributes. Exported so the
 * wiring is unit-testable; null is a no-op (ESM import / tests). init() is
 * idempotent, so a redundant call is harmless.
 */
export function autoInit(script: HTMLScriptElement | null): void {
  if (script) init(parseDatasetConfig(script.dataset));
}

// When delivered as the nginx-injected <script>, document.currentScript is the
// bundle's own tag during synchronous load — read its data-* and start. For
// ESM imports / unit tests currentScript is null, so this is a no-op.
if (typeof document !== 'undefined') {
  autoInit(document.currentScript as HTMLScriptElement | null);
}
