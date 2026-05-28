# E2E tests — `@pam/e2e`

Playwright tests that drive the full Docker stack (nginx + demo app +
Node ingestion stub) and verify the recorder lifecycle end-to-end.

For the broader development guide, see [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md).

---

## Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| Node | ≥ 22 (LTS 24 recommended) | pnpm v11 needs Node 22+. |
| pnpm | ≥ 11 | Workspace manager. |
| Docker Desktop | running | The stack uses `docker compose`. Tests auto-skip if Docker is down. |
| Disk space | ~500 MB | Chromium binaries. |

---

## First-time setup

```bash
# From repo root: build & sync the recorder bundle
pnpm install
pnpm build
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js

# Install Playwright's headless Chromium
pnpm --filter @pam/e2e exec playwright install chromium

# Run the suite
pnpm test:e2e
```

The first run takes ~40 seconds (Docker stack startup + 5 scenarios).
Subsequent runs are similar — the Docker stack is brought up fresh per
test session.

---

## What's tested

All five scenarios live in [`tests/variant-a.spec.ts`](tests/variant-a.spec.ts)
and use the same docker-compose stack:

| Scenario | What it asserts |
|----------|-----------------|
| recorder bundle is injected on every HTML response | `GET /` returns HTML containing `<script src="/_rec/recorder.iife.js">` |
| no `POST /s/` traffic while user is logged out | Loading the page + typing in inputs for 3.5 s produces zero `/s/` requests |
| login starts recording → batches appear in storage | After `#auth-login` click, `GET /sessions` shows ≥1 session with `user_id=alice` and `batch_count > 0` |
| logout stops recording within poll interval | After `#auth-logout` click + 7.5 s grace, no further `/s/` requests fire |
| logout → re-login produces two distinct session_ids for the same user | The full login → logout → login cycle yields ≥ 2 sessions tagged `user_id=alice` with different `session_id`s |

The login scenarios use `alice` / `alice` (default values in
[`demo-app/index.html`](../demo-app/index.html)).

---

## Running

```bash
pnpm test:e2e                                    # full suite, ~40s
pnpm --filter @pam/e2e exec playwright test \
  --grep "logout stops recording"                # single test
pnpm --filter @pam/e2e exec playwright test \
  --headed                                       # see the browser
pnpm --filter @pam/e2e exec playwright show-report  # last run's HTML report
```

---

## Using an already-installed Chrome

If you already have Chrome for Testing installed via
`@puppeteer/browsers install chrome@stable` (or anywhere else), point
Playwright at the binary instead of downloading its own:

```bash
export CHROME_EXECUTABLE='/Users/you/chrome/mac_arm-149.0.7827.22/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
pnpm test:e2e
```

The override is opt-in via [`playwright.config.ts`](playwright.config.ts).
Leave the env var unset and Playwright uses its own bundled
`chromium_headless_shell`. **Only set this when you know the path
exists** — a wrong path produces an opaque "Executable doesn't exist"
error on every test.

---

## Test infrastructure

```
e2e/
├── helpers/
│   └── docker-stack.ts      — docker compose up -d / health check / down
├── tests/
│   └── variant-a.spec.ts    — the five scenarios
├── playwright.config.ts     — projects, retries, CHROME_EXECUTABLE opt-in
└── package.json
```

The `startDockerStack` helper called from `beforeAll`:

1. Runs `docker info` and `test.skip`s the suite if Docker isn't running.
2. Runs `docker compose -f proxy/docker-compose.yml up -d`.
3. Polls `http://localhost:8080/` until it responds.
4. Returns a handle whose `stop()` runs `docker compose down`.

`afterAll` calls `stop()` so the suite leaves nothing behind.

---

## What's NOT tested

Deliberate gaps:

- **Replay accuracy.** No assertion that the recorded events round-trip
  visually correctly through the replayer. Manual check.
- **Cross-browser.** Chromium only.
- **Mobile viewports.** Not exercised.
- **Long sessions.** No scenario covers > 5 batches per session.
- **Authentication edge cases.** Wrong-password, lockout, expired-token
  mid-recording — covered by the ingestion vitest suite, not e2e.
- **Variant B (npm SDK consumer).** Removed in
  [5b6a751](https://github.com/) — only Variant A (nginx injection)
  is supported and tested.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| All tests `test.skip`'d | Docker Desktop isn't running. |
| "Executable doesn't exist at .../chrome-headless-shell" | `playwright install chromium` not run, or you set a bad `CHROME_EXECUTABLE`. |
| "Bundle not found at /_rec/recorder.iife.js" | You forgot `cp sdk/dist/recorder.iife.js proxy/recorder-bundle/` after `pnpm build`. |
| Tests pass locally, fail in CI | CI probably doesn't have Docker. Skip the suite there — variant-a should be local-only. |
| `EADDRINUSE` on 8080 | Another process holding the port. `lsof -i :8080` then kill, or change the port in `proxy/docker-compose.yml`. |
