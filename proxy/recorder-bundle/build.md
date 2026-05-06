# How to build the IIFE bundle for proxy injection

The nginx proxy serves `/_rec/recorder.iife.js` as a static file.
This bundle is built from the SDK source using esbuild.

## Build steps

```bash
# From repo root
cd sdk
pnpm install
pnpm build:iife
# Output: sdk/dist/recorder.iife.js

# Copy to proxy bundle dir
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js
```

## What the bundle does

The IIFE bundle exports nothing globally except `PamRecorder`.
nginx injects a small inline script that reads `window.__REC_SESSION_ID`
and `window.__REC_DISTINCT_ID` (set by the injection snippet in nginx.conf),
then calls `PamRecorder.init({ ... })`.

The bundle auto-initializes when `window.__REC_SESSION_ID` is present:

```js
// recorder.iife.js auto-init tail (produced by esbuild)
(function() {
  if (window.__REC_SESSION_ID) {
    PamRecorder.init({
      endpoint: '/s/',
      sessionId: window.__REC_SESSION_ID,
      distinctId: window.__REC_DISTINCT_ID || 'anonymous',
    });
  }
})();
```

## placeholder

See `recorder.iife.placeholder.js` for the expected structure.
