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

  /** Forces a full DOM snapshot every N ms; bounds replay buffer size */
  checkoutEveryNms: number;

  /** Flush buffer to server every N ms */
  flushIntervalMs: number;

  /** Max events buffered before forced flush */
  maxBufferSize: number;

  /** Name of the JS-readable marker cookie set by the backend on login */
  markerCookieName: string;

  /** Name of the JS-readable cookie holding the server-minted recording session id */
  sessionIdCookieName: string;

  /** Marker cookie poll interval in ms (watcher also reacts to focus/visibility) */
  markerPollMs: number;

  /** Consecutive 401-induced transitions before entering cooldown */
  unauthorizedThreshold: number;

  /** Cooldown window after the threshold is reached */
  unauthorizedCooldownMs: number;
}

const MINUTE_MS = 60_000;

export const DEFAULT_CONFIG: RecorderConfig = {
  endpoint: '/s/',
  blockClass: 'rec-no-capture',
  ignoreClass: 'rec-ignore-input',
  maskTextClass: 'rec-mask',
  // Don't blanket-mask every input: maskAllInputs:true also masks <select>,
  // <radio>, <checkbox> — controls whose values come from a fixed option set,
  // not free user text. rrweb still records their change events, but the value
  // is stored as asterisks, so on replay `select.value = "*****"` matches no
  // <option> and the control silently reverts to its default — the selection
  // looks lost. Mask only free-text-bearing inputs (password here; the auth
  // block is also wrapped in blockClass `rec-no-capture`). PROD NOTE: tighten
  // this for PII — add text/email/tel/etc. to maskInputOptions before shipping.
  maskAllInputs: false,
  maskInputOptions: { password: true },
  inlineStylesheet: true,
  collectFonts: false,
  recordCrossOriginIframes: false,
  checkoutEveryNms: 30 * MINUTE_MS,
  flushIntervalMs: 2_000,
  maxBufferSize: 500,
  markerCookieName: 'session_present',
  sessionIdCookieName: 'session_id',
  markerPollMs: 1_000,
  unauthorizedThreshold: 3,
  unauthorizedCooldownMs: MINUTE_MS,
};
