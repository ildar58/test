# How to build the IIFE bundle for proxy injection

The nginx proxy serves `/_rec/recorder.iife.js` as a static file.
This bundle is built from the SDK source using esbuild.

## Build steps

```bash
# From repo root
cd sdk
pnpm install
pnpm build
# Output: sdk/dist/recorder.iife.js

# Copy to proxy bundle dir
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js
```

## What the bundle does

The IIFE exports a single global `PamRecorder` with two methods: `init` and `stop`.
nginx injects a small inline script that calls `PamRecorder.init({ endpoint: '/s/' })`
unconditionally on every HTML response.

The recorder begins in IDLE. It activates only when the backend sets the
non-HttpOnly `session_present=1` marker cookie on login, and deactivates when
that cookie disappears on logout. The session UUID is managed inside the SDK
via `sessionStorage` — no identity is passed in from the host page.

See [`docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md`](../../docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md)
for the full contract.
