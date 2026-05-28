# @pam/web-session-recorder (internal)

Source for the recorder IIFE bundle injected by the nginx proxy.

This package is **not published to npm** — it exists only to produce
`dist/recorder.iife.js`, which `proxy/nginx.conf` serves at `/_rec/recorder.iife.js`.

## Build

```bash
pnpm --filter @pam/web-session-recorder build
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js
```

## Runtime contract

`init({ endpoint })` registers the recorder. It stays IDLE until the
backend sets a `session_present=1` marker cookie on login; on logout,
when the marker disappears, the recorder stops and clears its session id.

User identity is **not** part of the wire format — the server derives it
from the HttpOnly `session` cookie that browsers send automatically with
each batch.

See [`docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md`](../docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md)
for the full architecture.

## Config defaults

See `src/config.ts`. Key privacy defaults:
- `maskAllInputs: true`
- `blockClass: 'rec-no-capture'`
- `maskTextClass: 'rec-mask'`
- `collectFonts: false`
