/**
 * Default recorder config — mirrors PostHog's production preset.
 * Class names are corp-specific (rec-* prefix instead of ph-* prefix).
 */

export interface RecorderConfig {
  /** Endpoint to POST batches to. Must be absolute or root-relative. */
  endpoint: string;

  /** CSS class that blocks capture of an element and its children */
  blockClass: string;

  /** CSS class that makes the recorder ignore input events */
  ignoreClass: string;

  /** CSS class for masking text content */
  maskTextClass: string;

  /** Replace all input values with * */
  maskAllInputs: boolean;

  /** Per-input-type mask options */
  maskInputOptions: { password: boolean; [key: string]: boolean };

  /** Inline stylesheets into the snapshot */
  inlineStylesheet: boolean;

  /** Whether to download and inline fonts */
  collectFonts: boolean;

  /** Whether to record cross-origin iframes */
  recordCrossOriginIframes: boolean;

  /** Full-page checkout interval in ms */
  checkoutEveryNms: number;

  /** Flush buffer to server every N milliseconds */
  flushIntervalMs: number;

  /** Max events buffered before forced flush */
  maxBufferSize: number;

  /** Name of the JS-readable marker cookie set by the backend on login */
  markerCookieName: string;

  /** Marker cookie poll interval in ms (defensive; watcher also reacts to focus/visibility) */
  markerPollMs: number;

  /** Consecutive 401-induced transitions before suspending IDLE→ACTIVE */
  unauthorizedThreshold: number;

  /** Cool-down window after the threshold is reached */
  unauthorizedCooldownMs: number;
}

export const DEFAULT_CONFIG: RecorderConfig = {
  endpoint: '/s/',
  blockClass: 'rec-no-capture',
  ignoreClass: 'rec-ignore-input',
  maskTextClass: 'rec-mask',
  maskAllInputs: true,
  maskInputOptions: { password: true },
  inlineStylesheet: true,
  collectFonts: false,
  recordCrossOriginIframes: false,
  checkoutEveryNms: 30 * 60 * 1000, // 30 min
  flushIntervalMs: 2_000,
  maxBufferSize: 500,
  markerCookieName: 'session_present',
  markerPollMs: 5_000,
  unauthorizedThreshold: 3,
  unauthorizedCooldownMs: 60_000,
};
