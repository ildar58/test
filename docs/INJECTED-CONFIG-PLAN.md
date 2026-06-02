# Injected Recorder Config (data-*) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator configure the recorder (endpoint, cookie names, timings, …) via `data-*` attributes on the nginx-injected `<script>` tag — no bundle rebuild needed per deployment.

**Architecture:** nginx injects a single `<script src="/_rec/recorder.iife.js" data-endpoint="/s/">`. On load the bundle reads its own tag (`document.currentScript`), parses `data-*` into a `Partial<RecorderConfig>` via a pure allowlist parser, and calls `init()` (merges over `DEFAULT_CONFIG`). `init`/`stop` stay public; `init` is idempotent.

**Tech Stack:** TypeScript, esbuild (IIFE bundle), vitest (jsdom), nginx `sub_filter`, Playwright (E2E).

Spec: [docs/INJECTED-CONFIG.md](INJECTED-CONFIG.md).

---

## File structure

| File | Responsibility |
|------|----------------|
| `sdk/src/script-config.ts` (new) | `ATTR_MAP` allowlist + `parseDatasetConfig(dataset)` — pure, DOM-free |
| `sdk/src/__tests__/script-config.test.ts` (new) | parser unit tests |
| `sdk/src/index.ts` (modify) | export `autoInit(script)`; auto-init from `document.currentScript` on load |
| `sdk/src/__tests__/index.test.ts` (new) | auto-init wiring test (mocks `../recorder`) |
| `proxy/nginx.conf` (modify) | single-tag injection + supported-attrs comment |
| `proxy/recorder-bundle/recorder.iife.js` (rebuild) | shipped bundle |
| `e2e/tests/variant-a.spec.ts` (modify) | update injection assertion to single-tag form |

---

### Task 1: `script-config.ts` — data-* parser

**Files:**
- Create: `sdk/src/script-config.ts`
- Test: `sdk/src/__tests__/script-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `sdk/src/__tests__/script-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseDatasetConfig } from '../script-config';

describe('parseDatasetConfig', () => {
  it('returns {} for an empty dataset', () => {
    expect(parseDatasetConfig({})).toEqual({});
  });

  it('maps string attributes to their config keys', () => {
    expect(
      parseDatasetConfig({
        endpoint: '/custom/s/',
        markerCookie: 'pres',
        sessionIdCookie: 'sid',
        blockClass: 'no-rec',
        ignoreClass: 'no-input',
        maskTextClass: 'masked',
      })
    ).toEqual({
      endpoint: '/custom/s/',
      markerCookieName: 'pres',
      sessionIdCookieName: 'sid',
      blockClass: 'no-rec',
      ignoreClass: 'no-input',
      maskTextClass: 'masked',
    });
  });

  it('coerces number attributes', () => {
    expect(
      parseDatasetConfig({
        flushIntervalMs: '500',
        markerPollMs: '2000',
        maxBufferSize: '100',
        checkoutEveryMs: '60000',
        unauthorizedThreshold: '5',
        unauthorizedCooldownMs: '30000',
      })
    ).toEqual({
      flushIntervalMs: 500,
      markerPollMs: 2000,
      maxBufferSize: 100,
      checkoutEveryNms: 60000,
      unauthorizedThreshold: 5,
      unauthorizedCooldownMs: 30000,
    });
  });

  it('coerces boolean attributes', () => {
    expect(
      parseDatasetConfig({
        maskAllInputs: 'true',
        inlineStylesheet: 'false',
        collectFonts: 'true',
        recordCrossOriginIframes: 'false',
      })
    ).toEqual({
      maskAllInputs: true,
      inlineStylesheet: false,
      collectFonts: true,
      recordCrossOriginIframes: false,
    });
  });

  it('ignores unknown attributes', () => {
    expect(parseDatasetConfig({ foo: 'bar', endpoint: '/s/' })).toEqual({ endpoint: '/s/' });
  });

  it('drops malformed / empty numbers', () => {
    expect(parseDatasetConfig({ flushIntervalMs: 'abc', markerPollMs: '' })).toEqual({});
  });

  it('drops malformed booleans (not exactly "true"/"false")', () => {
    expect(parseDatasetConfig({ maskAllInputs: 'yes', collectFonts: '1' })).toEqual({});
  });

  it('drops empty string values', () => {
    expect(parseDatasetConfig({ endpoint: '' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sdk && npx vitest run src/__tests__/script-config.test.ts`
Expected: FAIL — `../script-config` does not exist.

- [ ] **Step 3: Implement `sdk/src/script-config.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sdk && npx vitest run src/__tests__/script-config.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add sdk/src/script-config.ts sdk/src/__tests__/script-config.test.ts
git commit -m "feat(sdk): parse recorder config from script data-* attributes"
```

---

### Task 2: auto-init from the injected `<script>` tag

**Files:**
- Modify: `sdk/src/index.ts`
- Test: `sdk/src/__tests__/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `sdk/src/__tests__/index.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ctorConfigs, startMock, stopMock } = vi.hoisted(() => ({
  ctorConfigs: [] as Array<Record<string, unknown>>,
  startMock: vi.fn(),
  stopMock: vi.fn(),
}));
vi.mock('../recorder', () => ({
  Recorder: vi.fn().mockImplementation((config: Record<string, unknown>) => {
    ctorConfigs.push(config);
    return { start: startMock, stop: stopMock };
  }),
}));

import { autoInit, stop } from '../index';
import { DEFAULT_CONFIG } from '../config';

describe('autoInit', () => {
  beforeEach(() => {
    ctorConfigs.length = 0;
    startMock.mockClear();
    stopMock.mockClear();
    stop(); // reset the init singleton between tests
  });

  it('does not construct a Recorder when the script is null', () => {
    autoInit(null);
    expect(ctorConfigs).toHaveLength(0);
  });

  it('merges data-* overrides over DEFAULT_CONFIG and starts', () => {
    const s = document.createElement('script');
    s.dataset.endpoint = '/custom/s/';
    s.dataset.flushIntervalMs = '500';
    autoInit(s);

    expect(ctorConfigs).toHaveLength(1);
    expect(ctorConfigs[0]!.endpoint).toBe('/custom/s/');
    expect(ctorConfigs[0]!.flushIntervalMs).toBe(500);
    expect(ctorConfigs[0]!.markerCookieName).toBe(DEFAULT_CONFIG.markerCookieName);
    expect(startMock).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sdk && npx vitest run src/__tests__/index.test.ts`
Expected: FAIL — `autoInit` is not exported from `../index`.

- [ ] **Step 3: Add `autoInit` + the load-time hook to `sdk/src/index.ts`**

Add `parseDatasetConfig` to the imports (after the `Recorder` import on line 15):

```ts
import { parseDatasetConfig } from './script-config';
```

Then append, after the existing `stop()` function (end of file):

```ts
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
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd sdk && npx vitest run src/__tests__/index.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/index.ts sdk/src/__tests__/index.test.ts
git commit -m "feat(sdk): auto-init from injected script data-* attributes"
```

---

### Task 3: nginx single-tag injection

**Files:**
- Modify: `proxy/nginx.conf` (the `sub_filter '</head>'` line, currently line 71)

- [ ] **Step 1: Replace the injection**

In `proxy/nginx.conf`, replace this line:

```nginx
            sub_filter '</head>' '<script src="/_rec/recorder.iife.js"></script><script>window.PamRecorder&&window.PamRecorder.init({endpoint:"/s/"});</script></head>';
```

with (note the comment block documenting supported attributes):

```nginx
            # Recorder config via data-* on the injected tag (read by the bundle
            # on load). Supported: data-endpoint, data-marker-cookie,
            # data-session-id-cookie, data-flush-interval-ms, data-marker-poll-ms,
            # data-max-buffer-size, data-checkout-every-ms,
            # data-unauthorized-threshold, data-unauthorized-cooldown-ms,
            # data-block-class, data-ignore-class, data-mask-text-class,
            # data-mask-all-inputs, data-inline-stylesheet, data-collect-fonts,
            # data-record-cross-origin-iframes. Omitted -> SDK DEFAULT_CONFIG.
            sub_filter '</head>' '<script src="/_rec/recorder.iife.js" data-endpoint="/s/"></script></head>';
```

- [ ] **Step 2: Validate nginx config syntax (optional, if Docker is available)**

Run: `docker run --rm -v "$PWD/proxy/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$PWD/proxy/proxy_defaults.conf:/etc/nginx/snippets/proxy_defaults.conf:ro" nginx:1.25-alpine nginx -t`
Expected: `syntax is ok` / `test is successful`.

- [ ] **Step 3: Commit**

```bash
git add proxy/nginx.conf
git commit -m "feat(proxy): inject single recorder tag configurable via data-* attrs"
```

---

### Task 4: rebuild the injected bundle

**Files:**
- Modify (regenerated): `proxy/recorder-bundle/recorder.iife.js`

- [ ] **Step 1: Rebuild and copy**

Run:
```bash
cd sdk && pnpm build && cp dist/recorder.iife.js ../proxy/recorder-bundle/recorder.iife.js
```
Expected: esbuild prints `dist/recorder.iife.js` with a size; copy succeeds.

- [ ] **Step 2: Sanity-check the new bundle contains the parser + auto-init**

Run: `grep -c 'parseDatasetConfig\|currentScript' proxy/recorder-bundle/recorder.iife.js`
Expected: a non-zero count.

- [ ] **Step 3: Commit**

```bash
git add proxy/recorder-bundle/recorder.iife.js
git commit -m "build(sdk): rebuild IIFE bundle with data-* config + auto-init"
```

---

### Task 5: update the E2E injection assertion

**Files:**
- Modify: `e2e/tests/variant-a.spec.ts` (the injection assertion, currently line 55)

- [ ] **Step 1: Update the assertion**

In `e2e/tests/variant-a.spec.ts`, replace:

```ts
    expect(html).toContain('<script src="/_rec/recorder.iife.js">');
```

with:

```ts
    expect(html).toContain('<script src="/_rec/recorder.iife.js" data-endpoint="/s/"></script>');
```

- [ ] **Step 2: Run the variant-a E2E suite against a fresh stack**

The injected tag (nginx.conf) and the bundle are both bind-mounted, so no image rebuild is needed — but a running nginx must re-read the mounted config. Recreate nginx, then run:
```bash
docker compose -f proxy/docker-compose.yml up -d --force-recreate nginx
pnpm --filter @pam/e2e test:a
```
Expected: all variant-a tests PASS, including `recorder bundle is injected on every HTML response` (now asserting the single data-* tag) and the recording/zero-gap tests. (If Docker isn't running, the suite skips.)

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/variant-a.spec.ts
git commit -m "test(e2e): assert single data-* recorder injection tag"
```

---

## Final verification

- [ ] **Whole-repo gate**

Run:
```bash
pnpm -r exec tsc --noEmit
pnpm test
```
Expected: typecheck clean; SDK + ingestion unit suites green (SDK now includes `script-config.test.ts` + `index.test.ts`).

---

## Self-review (planner)

**Spec coverage:**
- §2 mechanism (single tag, currentScript auto-init, parser module) → Tasks 1, 2, 3, 4.
- §3 attribute contract + coercion rules → Task 1 (`ATTR_MAP`, `parseDatasetConfig`, tests).
- §4 component changes (script-config.ts, index.ts auto-init, nginx.conf, rebuild) → Tasks 1–4.
- §5 error handling (null currentScript, malformed values, unknown attrs, endpoint default) → Task 1 tests + Task 2 null-script test.
- §6 testing (parser unit, auto-init wiring, E2E injection) → Tasks 1, 2, 5.
- §7 compatibility (init/stop public; default behaviour identical: `data-endpoint="/s/"`) → Task 2 (init/stop untouched) + Task 3 (`data-endpoint="/s/"`).

**Placeholder scan:** none — every step has concrete code/commands and expected output.

**Type/name consistency:** `parseDatasetConfig` (script-config.ts) is imported by index.ts and tested in script-config.test.ts; `autoInit` exported from index.ts and tested in index.test.ts; `ATTR_MAP` datasetKeys (camelCase) match the DOM mapping of the `data-*` names in the nginx comment and E2E tag (`data-endpoint` ↔ `dataset.endpoint` ↔ `endpoint`). `checkoutEveryMs` (attr) → `checkoutEveryNms` (config) is intentional and consistent across the table and tests.

**Out of scope (per spec §1):** envsubst/env-driven values, `maskInputOptions` object attribute, config endpoint. Not in any task.
