/**
 * @pam/web-session-recorder — public API
 *
 * Usage (typically called by nginx-injected snippet):
 *   import { init } from '@pam/web-session-recorder';
 *   init({ endpoint: '/s/' });
 *
 * The recorder stays IDLE until the marker cookie (default `session_present`)
 * is observed. Identity is derived server-side from the auth cookie — no
 * distinct_id or sessionId is accepted on the client.
 */

import { DEFAULT_CONFIG, type RecorderConfig } from './config';
import { Recorder } from './recorder';

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
