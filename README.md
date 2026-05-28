# @pam/web-session-recorder

Corporate web session recorder built on [rrweb](https://github.com/rrweb-io/rrweb).
Two integration paths — pick the one that fits your app, both feed the same ingestion endpoint.

- **Variant A — nginx proxy injection.** Zero-touch: a reverse proxy injects `<script src="/_rec/recorder.iife.js">` into HTML responses. Works on any legacy app without source changes.
- **Variant B — npm SDK.** Modern apps import the package, call `init()` once. Best with CSP and hydration-aware frameworks.

## Architecture

```
User browser
  │
  ├── Variant A (legacy apps, no source changes)
  │     nginx proxy → sub_filter injects recorder.iife.js into </head>
  │     └── recorder → POST /s/ → ingestion
  │
  └── Variant B (modern apps)
        import { init } from '@pam/web-session-recorder' → init()
        └── recorder → POST /s/ → ingestion
                                        │
                                        ▼
                               ./data/<session_id>.jsonl  (append-only)
                                        │
                                        ▼
                               GET /sessions/:id (Express)
                                        │
                                        ▼
                               replayer/index.html (rrweb-player)
```

## Requirements

- Node `>= 20`
- pnpm `>= 9`
- Docker (only for Variant A nginx stack and the variant-a E2E test)

## Quick start

### One-time setup

```bash
pnpm install
pnpm build                # builds SDK (ESM + IIFE) and ingestion
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js
```

### Variant B — SDK in your app

```bash
# Terminal 1: ingestion + replayer UI
pnpm dev:ingestion
# → http://localhost:3001/s/         (POST batches here)
# → http://localhost:3001/sessions   (GET sessions list)
# → http://localhost:3001/replay     (replayer UI)
```

In your app:

```ts
import { init } from '@pam/web-session-recorder';

// User identity is derived server-side from the auth cookie.
// The recorder stays idle until the backend sets `session_present=1` after login.
init({ endpoint: 'http://localhost:3001/s/' });
```

### Variant A — full proxy stack via Docker

```bash
# Terminal 1
pnpm dev:proxy
# → http://localhost:8080/   (demo app, recorder auto-injected by nginx)
# → http://localhost:8081/   (replayer admin UI on separate vhost)
```

Open `http://localhost:8080/`, click around, then open the replayer to watch the session.

## Project structure

| Path | Purpose |
|------|---------|
| `sdk/` | `@pam/web-session-recorder` — TypeScript SDK; source for both ESM (npm) and IIFE (proxy) bundles |
| `ingestion/` | Express service: `POST /s/` accepts batches, `GET /sessions[/:id]` reads them, serves replayer at `/replay` |
| `proxy/` | nginx config + `docker-compose.yml` for Variant A |
| `replayer/` | Single-page replayer UI built on `rrweb-player` |
| `demo-app/` | Minimal SPA used as upstream behind the proxy for local demos |
| `e2e/` | Playwright E2E tests with a real Angular app fixture (local-only, not CI) |

## Configuration (SDK)

Sane production defaults (mirroring PostHog's preset):

| Option | Default | Notes |
|--------|---------|-------|
| `maskAllInputs` | `true` | All `<input>` content masked |
| `maskInputOptions` | `{ password: true }` | Passwords always masked even if `maskAllInputs: false` |
| `blockClass` | `'rec-no-capture'` | Add this class to elements to skip them entirely |
| `maskTextClass` | `'rec-mask'` | Add this class to mask text content |
| `ignoreClass` | `'rec-ignore-input'` | Add to inputs to ignore typing entirely |
| `inlineStylesheet` | `true` | Inline `<style>` content into snapshot |
| `collectFonts` | `false` | Don't capture web fonts (privacy + size) |
| `recordCrossOriginIframes` | `false` | Cross-origin iframes are NOT recorded |

Override via `init({ ... })` options.

## Testing

```bash
pnpm test           # unit + integration (vitest) — fast, runs in CI
pnpm test:e2e       # E2E with real Angular + Playwright — local only, slower
pnpm typecheck      # tsc --noEmit across all packages
```

E2E tests require Docker (for Variant A) and ~5 minutes for the first cold Angular install. See `e2e/README.md` for details.

## Wire format

Batches sent by the SDK to `POST /s/`:

```ts
{
  session_id: string;        // UUID
  batch_seq: number;         // monotonic per session, starts at 0
  events_b64_gzip: string;   // base64(gzip(JSON.stringify(eventWithTime[])))
}
```

Storage: append each batch as a line to `data/<session_id>.jsonl`. Replay reconstructs by ungzipping and concatenating.

## What's NOT in MVP (production checklist)

- **Auth on ingestion** — `POST /s/` is open. Add mTLS / JWT / shared secret in your gateway.
- **Sampling / feature flags** — record always, no per-user gating.
- **Real database** — JSONL on local disk; replace with ClickHouse / S3 / PostgreSQL for production volumes.
- **Network plugin with deny-list** — outgoing fetch/XHR not recorded. If you add it later, **must** redact `Authorization`, `Cookie`, `x-api-key` etc. (see PostHog's `network-plugin.ts` for reference).
- **MutationThrottler / max-depth guard** — recorder will crash on pathological DOMs (deep React trees, SVG animations). Port these from `@posthog/rrweb` fork before production.
- **CSP nonce automation** — proxy serves recorder bundle from same origin (`'self'` works), but for strict CSP with per-request nonce you need nginx-plus / lua-nginx-module / Cloudflare Workers.
- **Multi-tenancy, retention, encryption-at-rest** — out of scope for v0.1.

## License

MIT — see [LICENSE](./LICENSE).
