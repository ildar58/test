# @pam/web-session-recorder

Corporate web session recorder built on [rrweb](https://github.com/rrweb-io/rrweb).
A reverse proxy injects `<script src="/_rec/recorder.iife.js">` into HTML responses;
the recorder gates itself on a marker cookie and reports batches to the ingestion
service. The host app needs no source changes.

## Architecture

```
User browser
  │
  │  nginx proxy → sub_filter injects recorder.iife.js into </head>
  │  └── recorder → POST /s/ → ingestion
  │                                  │
  │                                  ▼
  │                         ./data/<session_id>.jsonl  (append-only)
  │                                  │
  │                                  ▼
  │                         GET /sessions/:id (Express)
  │                                  │
  │                                  ▼
  │                         replayer/index.html (rrweb-player)
```

The ingestion service treats user identity as server-derived: it reads the
`session` HttpOnly cookie from each batch and stores `user_id` server-side.
The recorder activates only after the backend sets a `session_present=1`
marker cookie on login, and stops when the marker disappears on logout.

See [docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md](docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md) for the full design.

## Requirements

- Node `>= 20`
- pnpm `>= 9`
- Docker (for the full proxy stack and the E2E test)

## Quick start

```bash
pnpm install
pnpm build                # builds the recorder IIFE bundle and ingestion
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js

pnpm dev:proxy            # http://localhost:8080 — demo app
                          # http://localhost:8081 — replayer admin UI
```

Open `http://localhost:8080/`, click "Log in", interact with the page, then open
the replayer UI to watch the session.

## Project structure

| Path | Purpose |
|------|---------|
| `sdk/` | TypeScript source for the recorder IIFE bundle (internal package; not published to npm) |
| `ingestion/` | Express service: `POST /s/` accepts batches (cookie-gated), `GET /sessions[/:id]` reads them, serves replayer at `/replay`. Treated as a stub of the production Go service. |
| `proxy/` | nginx config + `docker-compose.yml` |
| `replayer/` | Single-page replayer UI built on `rrweb-player` |
| `demo-app/` | Minimal SPA used as upstream behind the proxy for local demos |
| `e2e/` | Playwright E2E tests with the demo app + full Docker stack |

## Configuration (recorder)

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
| `markerCookieName` | `'session_present'` | Non-HttpOnly companion cookie the backend sets on login |
| `markerPollMs` | `5_000` | Marker observation cadence (also reacts to focus / visibility events) |
| `unauthorizedThreshold` | `3` | Consecutive 401-induced deactivations before cool-down |
| `unauthorizedCooldownMs` | `60_000` | Cool-down window after the threshold is reached |

Override via the `init({ ... })` call (or in production, by adjusting the snippet
inlined by `proxy/nginx.conf`).

## Testing

```bash
pnpm test           # unit + integration (vitest) — fast, runs in CI
pnpm test:e2e       # Playwright + full Docker stack — local only
pnpm typecheck      # tsc --noEmit across all packages
```

E2E tests require Docker. See [e2e/README.md](e2e/README.md) for details.

## Wire format

Batches sent by the recorder to `POST /s/`:

```ts
{
  session_id: string;        // UUID
  batch_seq: number;         // monotonic per session, starts at 1
  events_b64_gzip: string;   // base64(gzip(JSON.stringify(eventWithTime[])))
}
```

`user_id` is **not** in the wire format — the server derives it from the
HttpOnly `session` cookie. Storage appends each batch as a line to
`data/<session_id>.jsonl`. Replay reconstructs by ungzipping and concatenating.

## What's NOT in MVP (production checklist)

- **Real auth backend** — `POST /s/` requires a `session` cookie, but the included Node ingestion stub treats the cookie value as the user id and does not validate it. Production deployments must point recorder traffic at the real Go service whose middleware validates the auth cookie cryptographically.
- **Sampling / feature flags** — record always, no per-user gating.
- **Real database** — JSONL on local disk; replace with ClickHouse / S3 / PostgreSQL for production volumes.
- **Network plugin with deny-list** — outgoing fetch/XHR not recorded. If you add it later, **must** redact `Authorization`, `Cookie`, `x-api-key` etc. (see PostHog's `network-plugin.ts` for reference).
- **MutationThrottler / max-depth guard** — recorder will crash on pathological DOMs (deep React trees, SVG animations). Port these from `@posthog/rrweb` fork before production.
- **CSP nonce automation** — proxy serves recorder bundle from same origin (`'self'` works), but for strict CSP with per-request nonce you need nginx-plus / lua-nginx-module / Cloudflare Workers.
- **Multi-tenancy, retention, encryption-at-rest** — out of scope for v0.2.

## License

MIT — see [LICENSE](./LICENSE).
