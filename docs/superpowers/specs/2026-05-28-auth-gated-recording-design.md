# Auth-gated session recording (Variant A) — design

**Date:** 2026-05-28
**Status:** Approved
**Scope:** Adapt `@pam/web-session-recorder` to start recording only after authentication, identify users via security cookies, and continue zero-touch nginx injection.

---

## 1. Problem

Current MVP (`d9058af`) injects the recorder unconditionally via nginx `sub_filter` and auto-starts on every page load. Identity is passed by the host app via `init({ distinctId })` or defaults to `'anonymous'`. This does not match the target deployment:

- The host is an Angular SPA with a Go backend. Authentication is performed inside the SPA (the `/login` view is an Angular route, not a separate HTML page).
- Authentication uses **HttpOnly security cookies** issued by Go. JavaScript cannot read them.
- Recording must start **only after the user is logged in** and must carry a verifiable user identity to the Go ingestion service.
- Variant A (nginx injection) must remain — no source changes in the Angular app.

## 2. Decisions (settled in brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Do **not** fork or patch `rrweb` | Auth/identity is not rrweb's concern. Forking adds maintenance debt with no payoff for this task. |
| D2 | nginx injects the recorder bundle on **every** HTML response (unconditional) | The Angular auth page is in-SPA. Conditional injection by cookie would fail SPA navigation (post-login transition does not re-fetch HTML). |
| D3 | Recording is gated by a **non-HttpOnly companion marker cookie** `session_present=1` set by Go alongside the real `session` HttpOnly cookie | JS can observe the marker without ever holding the auth secret. Logout clears the marker → SDK halts within the next poll tick. |
| D4 | Identity is **server-derived**. Client never sends `distinct_id`; Go reads `user_id` from the HttpOnly `session` cookie and attaches it to every persisted batch | Source-of-truth is the auth cookie. Removes a category of spoofing and removes the need for the Angular app to call `identify()`. |
| D5 | Logout → next login on the same tab produces a **new `session_id`** (new UUID) | One replay session corresponds to one authenticated user. Avoids cross-identity event mixing in a single file. |
| D6 | Ingestion service stays same-origin (behind the same nginx). No CORS, no SameSite=None | Simplifies cookie flow and CSRF stance. |
| D7 | Go service remains a black box for this work. The existing Node ingestion is adapted as a stub that emulates the contract (cookie presence ⇒ 401/200) | Spec covers backend contract; implementation is left to the Go team. |

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Browser (tab)                          │
│  Angular SPA (incl. /login route)                                │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ recorder.iife.js (always injected into <head>)             │   │
│  │   state machine: IDLE ⇄ ACTIVE                             │   │
│  │     gated by document.cookie 'session_present'             │   │
│  │   in ACTIVE: rrweb.record → buffer → POST /s/              │   │
│  │              fetch credentials:'include'                    │   │
│  └───────────────────────────────────────────────────────────┘   │
│       cookies: session (HttpOnly), session_present (JS-readable) │
└────────────────────────────────────┬────────────────────────────┘
                                      │ POST /s/  + cookies
                                      ▼
                        ┌──────────────────────────┐
                        │           nginx           │
                        │  /         → Angular app  │
                        │             + sub_filter  │
                        │               (always)    │
                        │  /_rec/     → static JS   │
                        │  /s/        → Go ingestion│
                        │  /auth/*    → Go auth     │
                        └──────────────┬───────────┘
                ┌───────────────────────┴───────────────────────┐
                ▼                                                ▼
   ┌─────────────────────────┐                ┌──────────────────────────┐
   │  Go auth/api (external) │                │ Go ingestion (external)  │
   │  POST /auth/login →     │                │  validates HttpOnly       │
   │    Set-Cookie session   │                │  cookie → user_id         │
   │    Set-Cookie           │                │  401 if missing/invalid   │
   │      session_present=1  │                │  append (session_id,      │
   │  POST /auth/logout →    │                │     batch_seq, user_id)   │
   │    clear both           │                │  stores append-only       │
   └─────────────────────────┘                └──────────────────────────┘
```

### Invariants

- `recorder.iife.js` loads on every page response, but `rrweb.record` only runs while the marker cookie is present.
- The login page is never recorded — no marker, no recording.
- The HttpOnly `session` cookie never touches JavaScript; the marker is a boolean presence flag with no security material.
- `session_id` is a per-recording UUID, generated by the SDK on each IDLE→ACTIVE transition, persisted in `sessionStorage` for the duration of one ACTIVE phase.
- `user_id` is attached server-side. It is **not** part of the wire payload.

## 4. Component changes

### 4.1 nginx (`proxy/nginx.conf`)

Diff against current config:

- Remove the `Access-Control-Allow-Origin: *` header from `/_rec/` (same-origin → not needed).
- Keep `sub_filter` unconditional. Inline init script with no arguments:
  ```nginx
  sub_filter '</head>'
      '<script src="/_rec/recorder.iife.js"></script>'
      '<script>window.PamRecorder&&window.PamRecorder.init({endpoint:"/s/"})</script>'
      '</head>';
  ```
- Keep `/s/` and `/sessions` as today. Cookies flow automatically (same-origin).
- Add `/auth/*` location (stub in the demo stack; in production it maps to the Go auth upstream).

### 4.2 SDK (`sdk/src`)

#### New module `auth.ts`

```ts
export function readMarker(name: string): boolean;
export function watchMarker(name: string, onChange: (present: boolean) => void, pollMs: number): () => void;
```

- `readMarker` parses `document.cookie` for `name=...`. Returns `true` if any non-empty value is present.
- `watchMarker` checks the marker on `visibilitychange`, `focus`, and a `setInterval` tick. Calls `onChange` only on edges. Returns a disposer.

#### `index.ts` — public API simplification

- `InitOptions` no longer accepts `sessionId` or `distinctId`. Only `endpoint` plus `RecorderConfig` overrides.
- `identify()` is removed from the public surface — identity is owned by the server.
- `init()` creates the Recorder and starts the marker watcher. The Recorder begins in IDLE.

#### `recorder.ts` — state machine

States: `IDLE`, `ACTIVE`, `STOPPED`.

- IDLE → ACTIVE (marker observed):
  1. `sessionId = crypto.randomUUID()`, write to `sessionStorage['_pam_sid']`.
  2. Start `rrweb.record({ ... })`.
  3. Start `Transport` flush timer.
- ACTIVE → IDLE (marker disappeared OR transport got 401):
  1. Stop `rrweb.record`.
  2. Stop transport timer, drop the buffer.
  3. Remove `sessionStorage['_pam_sid']`.
- `stop()` → STOPPED (programmatic teardown). Instance is discarded.

#### `transport.ts` — credentials + 401 handling

- All `fetch` calls add `credentials: 'include'`. `sendBeacon` sends cookies automatically.
- Batch wire format **drops `distinct_id`**:
  ```ts
  type Batch = {
    session_id: string;
    batch_seq: number;
    events_b64_gzip: string;
  };
  ```
- On `response.status === 401`, call an `onUnauthorized` callback supplied by `Recorder`. The Recorder transitions ACTIVE → IDLE.
- Recorder owns the 401 cool-down (see §6); transport does not retry on its own.

#### `config.ts`

Add:
```ts
markerCookieName: string;        // default 'session_present'
markerPollMs: number;            // default 5000
unauthorizedCooldownMs: number;  // default 60_000 (see §6)
unauthorizedThreshold: number;   // default 3       (see §6)
```

### 4.3 Go service contract (external, not implemented here)

| Endpoint | Behavior |
|----------|----------|
| `POST /auth/login` | Validates credentials. On success: `Set-Cookie: session=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/` **and** `Set-Cookie: session_present=1; Secure; SameSite=Lax; Path=/`. |
| `POST /auth/logout` | Clears both cookies (`Max-Age=0`). |
| `POST /s/` | Reads `session` cookie. Without a valid session ⇒ `401`. With a valid session ⇒ parse body, append events to storage tagged with the derived `user_id`. |
| `GET /sessions[/:id]` | Admin-only (separate role guard). |

### 4.4 Ingestion stub (current Node service)

To exercise the lifecycle locally and in E2E:

- `POST /s/` middleware: reject with `401` if `session` cookie is missing. Otherwise treat cookie value as `user_id` and persist it alongside the batch (`storage.ts` schema gains an optional `user_id` column / per-session metadata).
- New routes `POST /auth/login` (sets both cookies) and `POST /auth/logout` (clears them). Credentials are not validated — this is a stub.

## 5. Lifecycle / state machine

```
              marker observed
   ┌─────────┐ ────────────────▶ ┌──────────┐
   │  IDLE   │                    │  ACTIVE  │
   │ (poll)  │ ◀──────────────── │ (record) │
   └─────────┘ marker gone OR     └──────────┘
                batch 401              │
                                       │ stop()
                                       ▼
                                  ┌──────────┐
                                  │ STOPPED  │
                                  └──────────┘
```

Buffer policy: events are buffered only in ACTIVE. IDLE keeps no buffer and runs no rrweb — there is no pre-auth leak path.

Multi-tab: each tab runs an independent state machine. The marker is domain-scoped, so logout in one tab is observed by every other tab within ≤ `markerPollMs`. Each tab has its own `session_id`.

## 6. Error handling

| Situation | Behavior |
|-----------|----------|
| No marker cookie at init | IDLE, marker watcher ticks every `markerPollMs` (default 5s). |
| Marker present but `/s/` returns 401 | Buffer dropped, state → IDLE. Recorder counts consecutive 401-induced transitions. While the count is `< 3`, the next marker-observation tick retries ACTIVE. At `≥ 3`, the IDLE→ACTIVE transition is suppressed for a cool-down window (default 60s) even if the marker is still present; the count resets on the next successful batch. The marker watcher itself keeps polling normally — only the reaction to "marker observed" is suspended. |
| Network error on flush | Batch dropped silently (matches current MVP). Retry/queueing is out of scope. |
| `sessionStorage` unavailable (private mode, SSR) | Fall back to per-pageload in-memory UUID (existing `index.ts` behavior). |
| Logout in another tab | Marker watcher in this tab observes absence within ≤ `markerPollMs`, transitions ACTIVE → IDLE. |
| Marker present but no HttpOnly session (skew / debugger) | Server returns 401 on first batch → SDK lands in IDLE, backs off. |

## 7. Testing

| Layer | Coverage |
|-------|----------|
| Unit (vitest) | `readMarker` parsing across cookie shapes; state-machine transitions on each trigger; transport batch shape excludes `distinct_id`. |
| Integration (vitest) | Ingestion stub: `POST /s/` returns 401 with no cookie, 200 with cookie; `user_id` lands in stored metadata. |
| E2E (Playwright, Angular fixture) | (a) Open `/login` — `recorder.iife.js` loads but **no** `POST /s/` is observed. (b) Successful login → `POST /s/` traffic begins within ≤ `markerPollMs`; a session file appears in `data/`. (c) Logout → `POST /s/` traffic stops within ≤ `markerPollMs`. (d) Logout-then-login produces two distinct `session_id`s in storage. |

## 8. Out of scope

- Implementation of the Go auth and ingestion services.
- Auth guards on the replayer admin UI.
- `MutationThrottler`, network plugin with deny-list, max-depth guard — tracked separately (potential `@posthog/rrweb` migration).
- Retry/queue on network errors, sampling, CSP nonce automation, multi-tenancy, encryption at rest — all already flagged out of MVP in [README.md](../../../README.md).

## 9. Backwards compatibility

Breaking changes to the SDK public API:

- `init({ sessionId, distinctId })` — both options removed from `InitOptions`.
- `identify(userId, traits?)` — removed.
- Wire format: `distinct_id` removed from batches.

No external consumers yet (single repo, single integration). Bumping to `0.2.0` is sufficient.
