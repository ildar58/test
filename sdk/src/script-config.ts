import type { RecorderConfig } from './config';

type Coerce = 'string' | 'number' | 'boolean';

interface AttrSpec {
  /** Key as exposed on HTMLElement.dataset (camelCase of the data-* name). */
  datasetKey: string;
  /** Target RecorderConfig field. */
  configKey: keyof RecorderConfig;
  type: Coerce;
}

/**
 * Allowlist mapping a script tag's data-* attribute (via `dataset`) to a
 * RecorderConfig field. `data-marker-cookie` is exposed by the DOM as
 * `dataset.markerCookie`, etc. Only scalar fields are configurable; complex
 * fields (e.g. maskInputOptions) stay at DEFAULT_CONFIG.
 */
export const ATTR_MAP: ReadonlyArray<AttrSpec> = [
  { datasetKey: 'endpoint', configKey: 'endpoint', type: 'string' },
  { datasetKey: 'markerCookie', configKey: 'markerCookieName', type: 'string' },
  { datasetKey: 'sessionIdCookie', configKey: 'sessionIdCookieName', type: 'string' },
  { datasetKey: 'flushIntervalMs', configKey: 'flushIntervalMs', type: 'number' },
  { datasetKey: 'markerPollMs', configKey: 'markerPollMs', type: 'number' },
  { datasetKey: 'maxBufferSize', configKey: 'maxBufferSize', type: 'number' },
  { datasetKey: 'checkoutEveryMs', configKey: 'checkoutEveryNms', type: 'number' },
  { datasetKey: 'unauthorizedThreshold', configKey: 'unauthorizedThreshold', type: 'number' },
  { datasetKey: 'unauthorizedCooldownMs', configKey: 'unauthorizedCooldownMs', type: 'number' },
  { datasetKey: 'blockClass', configKey: 'blockClass', type: 'string' },
  { datasetKey: 'ignoreClass', configKey: 'ignoreClass', type: 'string' },
  { datasetKey: 'maskTextClass', configKey: 'maskTextClass', type: 'string' },
  { datasetKey: 'maskAllInputs', configKey: 'maskAllInputs', type: 'boolean' },
  { datasetKey: 'inlineStylesheet', configKey: 'inlineStylesheet', type: 'boolean' },
  { datasetKey: 'collectFonts', configKey: 'collectFonts', type: 'boolean' },
  { datasetKey: 'recordCrossOriginIframes', configKey: 'recordCrossOriginIframes', type: 'boolean' },
];

/**
 * Parses recorder-config overrides from a <script> tag's data-* attributes.
 * Unknown attributes are ignored; empty strings, non-finite numbers, and
 * booleans other than exactly "true"/"false" are dropped — so the result only
 * contains valid overrides to merge over DEFAULT_CONFIG.
 */
export function parseDatasetConfig(
  dataset: Record<string, string | undefined>
): Partial<RecorderConfig> {
  const out: Record<string, unknown> = {};
  for (const spec of ATTR_MAP) {
    const raw = dataset[spec.datasetKey];
    if (raw === undefined) continue;

    if (spec.type === 'string') {
      if (raw.length > 0) out[spec.configKey] = raw;
    } else if (spec.type === 'number') {
      const n = Number(raw);
      if (raw.trim() !== '' && Number.isFinite(n)) out[spec.configKey] = n;
    } else {
      if (raw === 'true') out[spec.configKey] = true;
      else if (raw === 'false') out[spec.configKey] = false;
    }
  }
  return out as Partial<RecorderConfig>;
}
