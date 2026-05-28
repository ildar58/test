# @pam/web-session-recorder

A browser session recorder built on [rrweb](https://github.com/rrweb-io/rrweb).
An **nginx reverse proxy** injects the recorder into every HTML response — the
host application needs no source changes. Recording is **gated by authentication**:
the recorder stays idle until the backend sets a marker cookie on login, then
captures DOM mutations and user interactions and ships them to an ingestion service.

This is a study/reference implementation. The recorder, nginx, demo app, and
replayer are production-shaped. The ingestion service is an explicit Node stub
of the real Go service; see [`docs/PRODUCTION.md`](docs/PRODUCTION.md) for what
needs to change before shipping.

---

## At a glance

```
┌────────────────────────────────────────────────────────────────────────┐
│                            Browser                                      │
│                                                                         │
│   Angular SPA (or any HTML app) with /login route                       │
│   ┌──────────────────────────────────────────────────────────────┐      │
│   │ recorder.iife.js (injected by nginx into every page)         │      │
│   │   ┌─────────────────────────────────────────────────────┐    │      │
│   │   │ Idle until backend sets `session_present=1` cookie  │    │      │
│   │   │ → captures DOM events                                │    │      │
│   │   │ → POSTs gzip+base64 batches to /s/ with credentials  │    │      │
│   │   └─────────────────────────────────────────────────────┘    │      │
│   └──────────────────────────────────────────────────────────────┘      │
│   cookies: session (HttpOnly, opaque token), session_present (JS-readable) │
└──────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
                       ┌────────────────────────┐
                       │       nginx             │
                       │  /  → upstream app      │
                       │       (sub_filter       │
                       │        injects script)  │
                       │  /_rec/ → static bundle │
                       │  /s/    → ingestion     │
                       │  /auth/ → ingestion     │
                       │  /sessions → ingestion  │
                       └──────────┬─────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │  Node ingestion (stub)      │
                    │  POST /auth/login           │
                    │  POST /auth/logout          │
                    │  POST /s/    (cookie-gated) │
                    │  GET  /sessions[/:id]       │
                    │                             │
                    │  bcryptjs password verify   │
                    │  in-memory session store    │
                    │  data/<sid>.jsonl on disk   │
                    └─────────────────────────────┘
```

The recorder gates itself on a non-HttpOnly `session_present=1` marker cookie
set by the backend on login. The real auth token is a separate HttpOnly cookie
the JavaScript never touches. User identity is derived server-side from that
HttpOnly cookie — it never appears in the wire format.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full lifecycle, the
state machine, and what each cookie does.

---

## Quick start

You need Docker, Node ≥ 20 (Node 24 LTS recommended), and pnpm ≥ 9.

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Build the recorder bundle and copy it where nginx will serve it
pnpm build
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js

# 3. Start the full stack (nginx + demo app + ingestion)
pnpm dev:proxy
```

Open <http://localhost:8080>. You'll see a demo page with an Auth panel.
Click **Log in** (default creds `alice` / `alice`), interact with the page,
then click **Log out**.

To watch a recorded session: the JSONL files live in the `ingestion-data`
Docker volume and the session list is at <http://localhost:8080/sessions>.
A built-in replayer UI exists at <http://localhost:8081> but is not yet wired
up in the Docker image — see [Known limitations](#known-limitations).

For a step-by-step development walkthrough including troubleshooting see
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

---

## Repository layout

| Path | What it is |
|------|------------|
| [`sdk/`](sdk) | TypeScript source for the recorder IIFE bundle. Internal package; not published to npm. |
| [`ingestion/`](ingestion) | Express service — demo Node stub of the real Go auth/ingestion service. |
| [`proxy/`](proxy) | nginx configuration + Docker Compose for the local stack. |
| [`demo-app/`](demo-app) | Minimal HTML app sitting behind nginx as the recorded application. |
| [`replayer/`](replayer) | Single-file replayer UI built on rrweb-player. |
| [`e2e/`](e2e) | Playwright end-to-end tests that drive the full Docker stack. |
| [`docs/`](docs) | This documentation set; design specs and implementation plans for past changes. |

Each package has its own README with focused details. Start from this one.

---

## Documentation map

| Doc | When to read it |
|-----|-----------------|
| [`README.md`](README.md) | You are here. Overview, quick start. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the cookies, state machine, and data flow work in detail. Read this before touching the SDK. |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Local dev, hot-reload, troubleshooting Docker / Playwright / Node versions. Read this when something doesn't run. |
| [`docs/PRODUCTION.md`](docs/PRODUCTION.md) | What the demo stub fakes vs what the real Go service must do; security checklist; deployment posture. Read this when porting. |
| [`docs/superpowers/specs/`](docs/superpowers/specs) | Design specs for past architectural changes (auth gating, demo auth). Historical context. |
| [`docs/superpowers/plans/`](docs/superpowers/plans) | TDD implementation plans matching those specs. Useful if you want to replay how a change was built. |

---

## Recorder configuration

Sane privacy-first defaults (mirroring PostHog's preset):

| Option | Default | Notes |
|--------|---------|-------|
| `maskAllInputs` | `true` | All `<input>` values masked on every event. |
| `maskInputOptions` | `{ password: true }` | Password inputs always masked even if `maskAllInputs: false`. |
| `blockClass` | `'rec-no-capture'` | Add this class to an element to skip it and its subtree entirely. |
| `maskTextClass` | `'rec-mask'` | Add this class to replace text content with `***`. |
| `ignoreClass` | `'rec-ignore-input'` | Add to inputs to ignore typing entirely. |
| `inlineStylesheet` | `true` | Inline `<style>` content into the snapshot. |
| `collectFonts` | `false` | Don't capture web fonts (privacy + size). |
| `recordCrossOriginIframes` | `false` | Cross-origin iframes are not recorded. |
| `markerCookieName` | `'session_present'` | Non-HttpOnly companion cookie the backend sets on login. |
| `markerPollMs` | `5_000` | Marker observation cadence (also reacts to `focus` and `visibilitychange`). |
| `unauthorizedThreshold` | `3` | Consecutive 401-induced deactivations before cool-down. |
| `unauthorizedCooldownMs` | `60_000` | Cool-down window after the threshold is reached. |

These are passed through to `init({ ... })`. In the Variant A nginx flow, the
default snippet calls `init({ endpoint: '/s/' })` with no overrides — change
the snippet in [`proxy/nginx.conf`](proxy/nginx.conf) to override.

---

## Wire format

Batches sent by the recorder to `POST /s/`:

```ts
{
  session_id: string;        // UUID, generated client-side per ACTIVE phase
  batch_seq: number;         // monotonic per session, starts at 1
  events_b64_gzip: string;   // base64(gzip(JSON.stringify(eventWithTime[])))
}
```

The browser sends the auth cookies automatically (`credentials: 'include'`).
`user_id` is **not** in the wire format — the server derives it server-side
from the `session` HttpOnly cookie. Storage appends each batch as a line to
`data/<session_id>.jsonl`; the replayer reconstructs by ungzipping and
concatenating in order.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#wire-format) for the full
contract including the auth endpoints.

---

## Testing

```bash
pnpm test           # unit + integration (vitest) — fast, runs in CI
pnpm test:e2e       # Playwright + full Docker stack — local only
pnpm typecheck      # tsc --noEmit across all packages
```

E2E tests require Docker. Playwright installs its own headless Chromium on
first run; if you already have Chrome for Testing installed somewhere else,
see [`e2e/README.md`](e2e/README.md#using-an-already-installed-chrome) for
the `CHROME_EXECUTABLE` opt-in.

Current coverage: 33 SDK + 21 ingestion unit/integration tests, plus 5
Playwright scenarios exercising the full Variant A lifecycle.

---

## Known limitations

The following are **deliberate gaps** in this study implementation. Each is
covered in detail in [`docs/PRODUCTION.md`](docs/PRODUCTION.md):

- **Replayer UI behind Docker is broken** — the `replayer/` directory is not
  copied into the ingestion image. Working around it is one Docker volume
  mount in `proxy/docker-compose.yml`.
- **Path-traversal in `ingestion/src/storage.ts`** — `session_id` from the
  request body flows into a file path without validation. Authenticated
  attacker can write outside the data directory. Tracked.
- **`GET /sessions` and `GET /sessions/:id` are unauthenticated** — the
  design spec calls for an admin role guard. The Node stub never implemented
  it. Tracked.
- **In-memory session store has no TTL or cap** — restart wipes all sessions.
  Fine for the stub; production must add eviction.
- **Demo passwords are committed in plaintext-hash** — `alice/alice`,
  `bob/bob`. The whole `ingestion/src/auth.ts` users array is a fixture.

---

## License

MIT — see [LICENSE](LICENSE).
