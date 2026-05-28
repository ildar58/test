# Architecture

How the recorder, nginx, and ingestion service work together. Read this
before changing the SDK or the auth flow.

For the historical "why" and the brainstormed decision log, see the design
specs in [`docs/superpowers/specs/`](superpowers/specs).

---

## 1. Goals and constraints

The recorder must:

1. **Be zero-touch for the host app.** No source changes to the Angular SPA
   sitting behind nginx. The host can be a legacy app no one wants to
   modify.
2. **Start recording only after authentication.** Pre-login pages (login
   form, password reset) must never appear in recordings.
3. **Tie identity to the server, not the client.** Production auth uses
   HttpOnly cookies — the browser can't read them, and the SDK never tries.
   The server derives `user_id` from the cookie on every batch.
4. **Survive normal SPA navigation.** Logging in on an Angular route should
   activate the recorder without requiring a full page reload.
5. **Be defensible under realistic failure modes.** Network blips, auth
   cookie expiry mid-session, page reloads while logged in, tab focus
   changes — all should produce sensible behaviour rather than crashing or
   spamming the server.

---

## 2. Component map

| Component | Responsibility | Source |
|-----------|----------------|--------|
| **nginx** | Reverse proxy. Injects `<script src="/_rec/recorder.iife.js">` into every HTML response via `sub_filter`. Routes `/auth/*`, `/s/`, `/sessions` to ingestion. | [`proxy/nginx.conf`](../proxy/nginx.conf) |
| **Recorder SDK** | Loads as an IIFE bundle. Watches the marker cookie, drives an IDLE/ACTIVE state machine, runs rrweb when active, batches events, ships them with credentials. | [`sdk/src`](../sdk/src) |
| **Ingestion service** | Cookie-gated batch sink + auth stub. In production this is a Go service; in this repo it's an Express stub with bcryptjs + in-memory session store. | [`ingestion/src`](../ingestion/src) |
| **Demo app** | Plain HTML page behind nginx for the local demo and e2e. Has an Auth panel that calls the stub. | [`demo-app/index.html`](../demo-app/index.html) |
| **Replayer** | Single HTML page that loads `rrweb-player` from CDN and plays a session by id. | [`replayer/index.html`](../replayer/index.html) |

---

## 3. Cookies

Two cookies carry the auth state:

| Cookie | HttpOnly | Set by | Read by | Purpose |
|--------|----------|--------|---------|---------|
| `session` | **yes** | Backend on `POST /auth/login`; cleared on `/auth/logout` | Server only (browser sends it automatically with `credentials: 'include'`) | The actual auth token. In the demo stub it's a 32-byte random hex token stored in an in-memory `Map`; in production it'd be a JWT / opaque token validated cryptographically. |
| `session_present` | **no** | Same login response; cleared on logout | JS in the recorder via `document.cookie` | A boolean presence marker. Tells the SDK "the user is logged in" without exposing any secret. Value is always `1` when set. |

The split exists because **HttpOnly cookies are invisible to JavaScript by
design**. Without a companion marker the SDK has no way to know it's
authenticated until the next batch returns 200 or 401 — and we want the
state machine to activate *before* it sends any events.

Both cookies use `SameSite=Lax; Path=/`. Production must add `Secure` once
HTTPS is terminated at nginx (the demo runs over HTTP localhost).

---

## 4. Recorder state machine

```
                    marker cookie observed
              ┌─────────────────────────────────┐
              │                                  │
              ▼                                  │
        ┌──────────┐  marker observed   ┌──────────────┐
        │   IDLE   │ ─────────────────▶ │    ACTIVE    │
        │  (poll)  │                    │  (recording) │
        └──────────┘ ◀───────────────── └──────────────┘
              │      marker disappeared       │
              │      or batch returned 401    │
              │                                │
              │  stop()                        │  stop()
              ▼                                ▼
        ┌──────────┐                    ┌──────────────┐
        │ STOPPED  │ ◀───────────────── │   STOPPED    │
        └──────────┘                    └──────────────┘
```

States are owned by the `Recorder` class in [`sdk/src/recorder.ts`](../sdk/src/recorder.ts).

### Triggers

The SDK observes the marker cookie three ways:

1. **Synchronous check at `init()`** — covers the page-reload case where the
   user was already logged in when the page loaded. Without this, the
   watcher's edge detection would never fire because there's no transition.
2. **`setInterval` poll** every `markerPollMs` (default 5 s).
3. **Event listeners** on `visibilitychange` and `focus` — gives a fast
   reaction when the user switches back to the tab.

### IDLE → ACTIVE

1. Generate or reuse a `session_id` UUID.
2. Persist it to `sessionStorage['_pam_sid']` for reload continuity.
3. Create a fresh `Transport`, hook in `onAuthorized`/`onUnauthorized`
   callbacks.
4. Start `rrweb.record({ ... })` with the masking config.

### ACTIVE → IDLE

Triggered by either the marker disappearing **or** a batch returning 401.
The SDK:

1. Calls the rrweb stop handle.
2. Stops the `Transport` (clears the flush interval, removes listeners).
3. Drops the in-memory buffer (events captured but not yet flushed are
   discarded — this is intentional, to bound how much pre-logout activity
   can land in storage).
4. Clears `sessionStorage['_pam_sid']` so the next ACTIVE phase starts a
   new `session_id`.

### 401 cool-down

After **N consecutive** batches returning 401 (default `unauthorizedThreshold = 3`),
the SDK enters a cool-down for `unauthorizedCooldownMs` (default 60 s)
during which `tryActivate` is suppressed even if the marker is present.
The counter resets on the next successful batch (200 OK), not on
re-activation, so transient 401s don't accumulate over hours into a
false cool-down.

### Reload continuity

If the user reloads while ACTIVE, the recorder is re-injected and `init()`
runs again. Because `sessionStorage['_pam_sid']` survives the reload, the
SDK reuses the existing UUID — the server appends to the same
`<session_id>.jsonl` file and the replayer sees one continuous session.

---

## 5. Data flow

### Login

```
Browser                    nginx                  ingestion (Go in prod)
   │                         │                              │
   │ POST /auth/login        │                              │
   │  { user, password }     │                              │
   ├────────────────────────▶│                              │
   │                         │ POST /auth/login             │
   │                         ├─────────────────────────────▶│
   │                         │                              │ bcrypt.compare
   │                         │                              │ createSession(user)
   │                         │ 200                          │
   │                         │ Set-Cookie:                  │
   │                         │   session=<token> HttpOnly   │
   │                         │   session_present=1          │
   │                         │◀─────────────────────────────┤
   │ 200 + cookies           │                              │
   │◀────────────────────────┤                              │
   │                                                        │
   │ marker watcher observes session_present=1              │
   │ → Recorder transitions IDLE → ACTIVE                   │
   │ → rrweb starts capturing                               │
```

### Recording

```
Browser                                          ingestion
   │                                                  │
   │ rrweb emit → Transport.push → buffer             │
   │ (flushes every flushIntervalMs = 2 s)            │
   │                                                  │
   │ POST /s/                                         │
   │  Cookie: session=<token>; session_present=1      │
   │  body: {session_id, batch_seq, events_b64_gzip}  │
   ├─────────────────────────────────────────────────▶│
   │                                                  │ getSession(token)
   │                                                  │ → entry.username
   │                                                  │ appendBatch(batch, username)
   │                                                  │ data/<sid>.jsonl
   │ 200                                              │
   │◀─────────────────────────────────────────────────┤
   │                                                  │
   │ Transport.onAuthorized() resets unauthorizedCount│
```

### Logout

```
Browser                                          ingestion
   │                                                  │
   │ POST /auth/logout                                │
   ├─────────────────────────────────────────────────▶│
   │                                                  │ destroySession(token)
   │                                                  │ Set-Cookie: …; Max-Age=0
   │ 200, cookies cleared                             │
   │◀─────────────────────────────────────────────────┤
   │                                                  │
   │ marker watcher observes session_present absent   │
   │ → Recorder transitions ACTIVE → IDLE             │
   │ → rrweb stops, in-flight buffer dropped          │
```

If a batch is in flight when logout happens, it might land in storage
*after* the cookie is cleared. That's fine — it carries the cookie that
was set when the request was queued, and the token still maps to the
user in the in-memory store until the logout request is processed. Once
`destroySession` runs, any further attempt to use the cookie returns 401
→ the SDK transitions to IDLE if it hasn't already.

---

## 6. Wire format

### `POST /auth/login`

Request: `{ user: string, password: string }`
Response success: `200 { success: true, user: string }`
Response failure: `401 { success: false, error: "invalid credentials" }`

The same 401 shape is returned for missing fields, unknown user, and wrong
password — the bcrypt compare runs even for unknown users so login timing
doesn't trivially leak existence.

### `POST /auth/logout`

Request body: ignored.
Response: `200 { success: true }` (always — destroying a session is
idempotent).

### `POST /s/`

Headers: `Cookie: session=<token>` required.
Body:

```ts
{
  session_id: string;        // UUID generated by the SDK
  batch_seq: number;         // 1-based, monotonic within one session_id
  events_b64_gzip: string;   // base64(gzip(JSON.stringify(eventWithTime[])))
}
```

Response success: `200 { success: true }`
Response 401: `{ success: false, error: "unauthorized" }` — no session
cookie, or cookie value not in the in-memory store.
Response 400: `{ success: false, error: "Missing required fields" }`.

`user_id` is never in the wire format. The server derives it via
`getSession(req.cookies.session).username` and persists it in
`data/<session_id>.meta.json`.

### `GET /sessions`

Lists all session metadata. **Currently unauthenticated** — see
[`docs/PRODUCTION.md`](PRODUCTION.md#unauthenticated-read-endpoints).

### `GET /sessions/:id`

Returns the decoded event array for a single session. Same auth gap as
above. `:id` is not currently validated against a UUID format — see
[`docs/PRODUCTION.md`](PRODUCTION.md#path-traversal).

---

## 7. File system layout

The ingestion stub stores everything under `data/` (Docker volume in the
compose stack, `./ingestion/data/` locally if you run `pnpm dev:ingestion`):

```
data/
├── 8d551208-2474-4bf7-8b36-f375e09b2fd2.jsonl       # one line per batch
└── 8d551208-2474-4bf7-8b36-f375e09b2fd2.meta.json   # session metadata
```

Each `.jsonl` line is the raw batch as sent by the SDK — `session_id`,
`batch_seq`, and the gzip+base64-encoded events. The replayer concatenates
the events from each line in order to reconstruct the full event stream.

`.meta.json` shape:

```json
{
  "session_id": "8d551208-…",
  "user_id": "alice",
  "started_at": "2026-05-28T02:29:48.951Z",
  "last_batch_at": "2026-05-28T02:29:50.947Z",
  "batch_count": 2
}
```

`user_id` is written on the first batch and is intentionally **not**
updated by subsequent batches — one session belongs to one user. If
a different user authenticates on the same tab, a new `session_id` is
generated, so cross-user contamination of a single file is structurally
impossible.

---

## 8. Why no nightly cleanup, no DB, no sampling?

These are all production concerns; this is a study implementation. See
[`docs/PRODUCTION.md`](PRODUCTION.md) for the gap analysis.
