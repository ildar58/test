# Local development guide

Step-by-step from `git clone` to seeing a recording. Covers the common
failure modes you'll hit on a fresh machine.

For the architecture itself see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Prerequisites

| Tool | Minimum | Recommended | Why |
|------|---------|-------------|-----|
| Node | 20 | **24 LTS** | Project's `engines.node` is `>=20`, but `pnpm` v11 requires Node ≥ 22. If you only have Node 20, downgrade pnpm or upgrade Node. |
| pnpm | 9 | **11.x** | Workspace and the lockfile expect modern pnpm. |
| Docker Desktop | running | latest | The proxy stack and E2E need it. |
| macOS / Linux | — | macOS arm64 / Linux x64 | Tested on macOS arm64; should work on Linux x64. Windows untested. |

If you use `nvm`, switch before doing anything else:

```bash
nvm use 24
```

---

## 2. Install + first build

```bash
git clone <this-repo>
cd rrweb-testing
pnpm install
pnpm build
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js
```

The last line copies the freshly built IIFE bundle to where nginx serves
it from. It's manual on purpose so you can also bring your own bundle
(see "Bring your own Chromium / your own bundle" below).

---

## 3. Run the full stack

```bash
pnpm dev:proxy
```

This brings up three containers via Docker Compose:

- **nginx** on `localhost:8080` — serves the demo app with the recorder
  injected, proxies `/auth/*`, `/s/`, `/sessions` to ingestion.
- **demo-app** — static nginx serving [`demo-app/index.html`](../demo-app/index.html).
- **ingestion** — the Node stub from [`ingestion/`](../ingestion).

Open <http://localhost:8080>:

1. The page loads with the Auth panel showing "logged out".
2. Type `alice` / `alice` (or `bob`/`bob`), click **Log in**. Status flips
   to "logged in".
3. Interact with the page — type in inputs, click buttons. The recorder
   is capturing.
4. After ~2 seconds you'll see `POST /s/` calls in the network tab
   returning 200.
5. Click **Log out**. The status flips back to "logged out" and `/s/`
   traffic stops.

To see what's been stored: `curl http://localhost:8080/sessions | jq`.
To stop the stack: `Ctrl+C` then `docker compose -f proxy/docker-compose.yml down`.

---

## 4. Run only the ingestion service (no Docker)

Useful for backend changes:

```bash
pnpm --filter @pam/ingestion dev
```

Runs `tsx watch src/server.ts` on `localhost:3001`. Hot-reloads on source
changes. Use `curl` to drive it:

```bash
# Login
curl -c /tmp/jar -X POST http://localhost:3001/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"user":"alice","password":"alice"}'

# Ingest a batch
EVENTS=$(node -e "console.log(require('zlib').gzipSync(JSON.stringify([{type:0,timestamp:1,data:{}}])).toString('base64'))")
curl -b /tmp/jar -X POST http://localhost:3001/s/ \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$(uuidgen)\",\"batch_seq\":1,\"events_b64_gzip\":\"$EVENTS\"}"

# List sessions
curl http://localhost:3001/sessions | jq
```

---

## 5. Tests

```bash
pnpm test           # unit + integration (vitest), no Docker — 54 tests, ~2s
pnpm typecheck      # tsc --noEmit across all 4 workspaces
pnpm test:e2e       # Playwright + full Docker stack, ~40s
```

The unit tests cover the SDK state machine, auth module, transport, and
the ingestion server. The E2E tests run real Chromium against the live
Docker stack — see [`e2e/README.md`](../e2e/README.md).

---

## 6. Common problems

### "Docker is not running"

Start Docker Desktop and wait until `docker info` succeeds.
`pnpm test:e2e` auto-skips variant-a if Docker is down.

### Playwright complains "Executable doesn't exist at .../chrome-headless-shell"

You haven't run `pnpm --filter @pam/e2e exec playwright install chromium`.
On a fresh machine this downloads ~200 MB of Chromium.

If `playwright install` itself fails with `proper-lockfile` errors, the
cache has stale lock files from an aborted install:

```bash
rm -rf ~/Library/Caches/ms-playwright   # macOS
# then retry
pnpm --filter @pam/e2e exec playwright install chromium
```

### Bring your own Chromium

If you already have Chrome for Testing installed via `@puppeteer/browsers`
(or any other source), point Playwright at it without polluting its own
cache:

```bash
export CHROME_EXECUTABLE='/path/to/Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
pnpm test:e2e
```

The override is opt-in via [`e2e/playwright.config.ts`](../e2e/playwright.config.ts).

### `pnpm install` fails on Node 20

`pnpm` v11 needs Node ≥ 22 (it imports `node:sqlite`). Either:

- Upgrade Node: `nvm use 24`.
- Or pin an older pnpm: `corepack prepare pnpm@10.0.0 --activate`.

### Port conflicts on 8080 / 8081 / 3001

Something else on your machine is holding the port. `lsof -i :8080`
shows what. Stop it, or edit the port mapping in
[`proxy/docker-compose.yml`](../proxy/docker-compose.yml).

### `appendBatch is not a function` / TypeScript errors after pull

Run `pnpm install` again to refresh workspace links. If still broken,
nuke `node_modules` and reinstall:

```bash
pnpm -r exec rm -rf node_modules
rm -rf node_modules
pnpm install
```

### Recording doesn't start after login

Check the browser console for errors loading
`http://localhost:8080/_rec/recorder.iife.js`. If 404, you forgot step 2
(`cp sdk/dist/recorder.iife.js …`).

If the bundle loads but you still see no `POST /s/` traffic:

1. Open DevTools → Application → Cookies. After login you should see
   **both** `session` (HttpOnly checked) and `session_present` (HttpOnly
   unchecked). If only one is set, the backend didn't issue both.
2. The SDK polls the marker every `markerPollMs` (default 5 s). If you
   logged in less than 5 s ago and there's no `visibilitychange` or
   `focus` event, wait a tick.

---

## 7. Editing workflow

| What you're changing | Run | After |
|----------------------|-----|-------|
| `sdk/src/**` | `pnpm --filter @pam/web-session-recorder dev` (esbuild watch) | `cp sdk/dist/recorder.iife.js proxy/recorder-bundle/`, then refresh page |
| `ingestion/src/**` | `pnpm --filter @pam/ingestion dev` (tsx watch) | Hot-reloaded |
| `demo-app/index.html` | none | Refresh page |
| `proxy/nginx.conf` | `docker compose -f proxy/docker-compose.yml restart nginx` | — |
| Tests | `pnpm --filter @pam/web-session-recorder test:watch` etc. | — |

---

## 8. Where to ask "where does X live?"

| You're looking for | Look in |
|--------------------|---------|
| How the state machine works | [`sdk/src/recorder.ts`](../sdk/src/recorder.ts) + [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Auth flow contract | [`docs/superpowers/specs/2026-05-28-demo-auth-design.md`](superpowers/specs/2026-05-28-demo-auth-design.md) |
| Why a thing was built that way | [`docs/superpowers/specs/`](superpowers/specs/) |
| The exact steps taken | [`docs/superpowers/plans/`](superpowers/plans/) |
| What's missing for prod | [`PRODUCTION.md`](PRODUCTION.md) |
