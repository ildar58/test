# E2E Tests — @pam/e2e

Playwright end-to-end tests covering two integration variants of `@pam/web-session-recorder`.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 20 | Required |
| pnpm | ≥ 9 | Workspace manager |
| Docker Desktop | any | Required for variant-a only |
| Free disk space | ~5 GB | Cold Angular install |

## First-time setup

```bash
# 1. Install workspace dependencies (from repo root)
pnpm install

# 2. Install Playwright browser
pnpm -F e2e exec playwright install chromium

# 3. Scaffold the Angular fixture app (idempotent)
pnpm -F e2e setup
```

Step 3 takes 2-5 minutes on first run (Angular CLI scaffold + npm install).
Subsequent runs skip the scaffold automatically.

## Running tests

```bash
# All tests (both variants)
pnpm test:e2e

# Only variant-b (no Docker needed)
pnpm -F e2e test:b

# Only variant-a (requires Docker)
pnpm -F e2e test:a

# Open HTML report
pnpm -F e2e report
```

## What's tested

| Test | File | Assertion |
|------|------|-----------|
| SDK records form interactions | variant-b.spec.ts | `GET /sessions` returns ≥1 session with batch_count > 0 |
| Replayer UI renders session | variant-b.spec.ts | `.rr-player` element is visible in replayer page |
| Nginx injects recorder script | variant-a.spec.ts | Response HTML contains `<script src="/_rec/recorder.iife.js">` |
| Proxy-injected SDK records and persists | variant-a.spec.ts | `GET /sessions` returns ≥1 session with batch_count > 0 |

## What's NOT tested

- Recording fidelity / pixel-perfect replay accuracy (manual check required)
- Cross-browser compatibility (Safari, Firefox) — see test-plan
- Mobile viewport recording
- Long-session chunking (>100 batches)
- Authentication / RBAC flows
- Performance under high event volume

For manual test cases see the project test-plan document (16 - Тест-план).

## Architecture

```
variant-b (no Docker)
  └─ ingestion-server.ts  — spawns ingestion/dist/server.js on random port
  └─ ng-build.ts          — runs ng build + serves dist/ via Node http.createServer
  └─ tests/variant-b.spec.ts

variant-a (Docker required)
  └─ docker-stack.ts      — docker compose up proxy/docker-compose.yml
  └─ tests/variant-a.spec.ts
```

## Troubleshooting

**`ng-app fixture not found`**
Run `pnpm -F e2e setup` first.

**`Ingestion server did not become ready`**
Check that `ingestion/dist/server.js` exists: `pnpm -F ingestion build`.

**variant-a tests skipped**
Docker Desktop is not running. Start it and retry.

**`ng build` fails with module not found**
The SDK may not be linked. Re-run `pnpm -F e2e setup` (it re-installs from scratch only if ng-app is missing, otherwise manually run `npm install file:../../../sdk` inside `fixtures/ng-app/`).

**Port conflicts**
Ports are allocated dynamically via `get-port`. If tests fail with EADDRINUSE, another process is holding the port — restart and retry.
