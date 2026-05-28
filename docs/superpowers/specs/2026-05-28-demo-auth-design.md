# Demo auth backend — design

**Date:** 2026-05-28
**Status:** Approved (autonomous)
**Scope:** Replace the no-password stub in `ingestion/src/server.ts` with a minimal real auth flow: username + password, bcrypt-hashed, opaque session token, in-memory session store. Strictly demo-grade — explicit hardcoded users, no persistence across restarts.

---

## 1. Problem

The current `ingestion/src/server.ts` ships a placeholder `POST /auth/login` that accepts any username with no password check and uses the raw username as the `session` cookie value (and thereby as `user_id`). That was acceptable for driving E2E tests during the auth-gated-recording migration, but it is not a credible demo of the recorder pipeline — anyone visiting the demo page can become any user.

We want to make the auth path look like real auth: a credential check, an opaque token, a server-side session store. The recorder, nginx, and demo UI must keep working without changes (other than collecting a password on the login form).

Real auth (production) lives in the Go service; this is the Node stub upgraded to "demo-grade" so the local demo is convincing.

## 2. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | Use **`bcryptjs`** (pure JS) for password hashing rather than the native `bcrypt` module. | No C++ build step, identical hash format, fine for demo workloads. |
| D2 | Hardcode demo users in `ingestion/src/auth.ts` as a `const` array with bcrypt hashes. Passwords match usernames (`alice`/`alice`, `bob`/`bob`). | Demo-only. No user-management UX needed. |
| D3 | Session store is an **in-memory `Map<token, { username, createdAt }>`**. Restart wipes all sessions. | Matches "minimal demo" scope; persistence has no demo value. |
| D4 | Session token is **32 random bytes hex-encoded** via `crypto.randomBytes(32).toString('hex')`. | Opaque, unguessable, no parsing needed. |
| D5 | Cookies stay HttpOnly + SameSite=Lax + Path=/ exactly as today; only the cookie **value** changes from username to token. The companion `session_present` marker cookie is untouched. | Recorder, nginx, and front-end need no changes beyond the demo HTML form. |
| D6 | On any login failure (unknown user, wrong password, missing field) return **`401 { success: false, error: 'invalid credentials' }`** — same status code & shape regardless. | Avoids user-enumeration via response timing/shape. |
| D7 | `POST /auth/logout` deletes the session entry from the in-memory store before clearing cookies. | Logout actually invalidates the token, not just the browser cookie. |
| D8 | `POST /s/` middleware looks up the cookie token in the store. If absent or the entry is missing → 401. | One single auth check across login & ingestion. |

## 3. Architecture

```
                Browser
                  │
                  │ POST /auth/login { user, password }
                  ▼
        ┌──────────────────────────────┐
        │     ingestion/src/server.ts  │
        │  ┌────────────────────────┐  │
        │  │ /auth/login            │  │
        │  │   verifyPassword(...)  │──┼─▶ ingestion/src/auth.ts
        │  │   createSession(user)  │  │     ┌────────────────────┐
        │  │   set cookies          │  │     │ users[]            │
        │  └────────────────────────┘  │     │ sessions: Map<...> │
        │  ┌────────────────────────┐  │     │                    │
        │  │ /auth/logout           │  │     │ verifyPassword     │
        │  │   destroySession(tok)  │──┼─▶   │ createSession      │
        │  │   clear cookies        │  │     │ getSession         │
        │  └────────────────────────┘  │     │ destroySession     │
        │  ┌────────────────────────┐  │     └────────────────────┘
        │  │ /s/  (cookie-gated)    │  │
        │  │   getSession(tok)      │──┼─▶
        │  │   → req.userId         │  │
        │  └────────────────────────┘  │
        └──────────────────────────────┘
```

The recorder, nginx, and demo `auth-status` JS are unchanged. The only externally visible difference is that the demo login form now also requires a password (and the cookie value is opaque rather than the username).

## 4. Components

### 4.1 `ingestion/src/auth.ts` (new)

```ts
export interface DemoUser {
  username: string;
  passwordHash: string;
}

export interface SessionEntry {
  username: string;
  createdAt: number;
}

export const users: ReadonlyArray<DemoUser>;        // hardcoded demo users

export function verifyPassword(user: string, password: string): Promise<boolean>;
export function createSession(username: string): string;   // returns token
export function getSession(token: string | undefined): SessionEntry | null;
export function destroySession(token: string | undefined): void;
```

- `users` is a `const` array with two entries (`alice`, `bob`). Hashes are pre-computed with `bcryptjs.hashSync(pwd, 10)` at module load — no async setup, no env vars.
- `verifyPassword` returns `false` if the user is unknown or the hash mismatches. It must do the bcrypt compare even for unknown users (constant-time-ish at the auth layer to avoid user enumeration).
- `createSession` writes a fresh token into the in-memory `Map` and returns it.
- `getSession` returns `null` for missing or unknown tokens; tokens have no expiry in this demo.
- `destroySession` is idempotent.

### 4.2 `ingestion/src/server.ts` (modify)

- `POST /auth/login` reads `{ user, password }`, calls `verifyPassword`, on success calls `createSession`, sets the two cookies with the token as the `session` value. On failure: `401 { success: false, error: 'invalid credentials' }`.
- `POST /auth/logout` reads the token from `req.cookies?.session`, calls `destroySession`, then clears both cookies as today. Returns `200 { success: true }` regardless.
- `POST /s/` derives `userId` from `getSession(req.cookies?.session)?.username` instead of using the raw cookie value. `null` → 401 as today. The same change applies wherever the username was previously pulled from the cookie value (only the `/s/` handler).

### 4.3 Demo app (`demo-app/index.html`)

Add a `password` input next to the existing `username` input; default value `alice`. Submit handler sends `{ user, password }` instead of `{ user }`. `refreshStatus()` still keys off the `session_present` cookie — unchanged.

### 4.4 E2E (`e2e/tests/variant-a.spec.ts`)

Whichever scenarios click `#auth-login` must also fill `#auth-password` first. The default values in the demo HTML mean the test can rely on them, but for clarity tests should fill explicitly. Adjust the four scenarios that hit `#auth-login`.

## 5. Wire format

### `POST /auth/login`
Request: `{ "user": string, "password": string }`
Response success: `200 { "success": true, "user": string }`
Response failure: `401 { "success": false, "error": "invalid credentials" }`

### `POST /auth/logout`
Request body: ignored
Response: `200 { "success": true }`

### `POST /s/`
Wire format unchanged from the auth-gated-recording spec (no `distinct_id`). The middleware change is internal — same 401 on missing/invalid session.

## 6. Lifecycle

```
fresh page          marker cookie       /s/ batches       logout
   │                  appears              flow              │
   ▼                    │                    │               ▼
[anonymous] ─login─▶ [authenticated] ─work─▶ ... ─logout─▶ [anonymous]
                       │ token in map        │              token removed
                       │ token in cookie     │              cookies cleared
                                                            recorder sees marker gone → IDLE
```

Restart: in-memory `sessions` Map is empty → the next batch that arrives with a stale cookie value returns 401 → recorder transitions IDLE → user is forced through login again.

## 7. Testing

| Layer | Coverage |
|-------|----------|
| Unit (vitest) | `verifyPassword`: correct user+password ⇒ `true`; correct user wrong password ⇒ `false`; unknown user ⇒ `false`. `createSession` returns a 64-char hex token. `getSession` returns entry; `destroySession` makes subsequent lookup return `null`. |
| Integration (vitest + supertest) | `POST /auth/login` returns 401 for missing fields, wrong password, unknown user; returns 200 with cookies for valid credentials and the `session` cookie value matches a 64-char hex. `POST /auth/logout` invalidates the token (subsequent `POST /s/` with the same cookie returns 401). `POST /s/` with a valid token stores meta with the correct `user_id`. |
| E2E (Playwright, Docker required) | The four lifecycle scenarios from the auth-gated-recording plan continue to pass after the password field is added. |

## 8. Out of scope

- **Path-traversal hardening in `storage.ts`**, **auth on `GET /sessions[/:id]`**, **`cors({ credentials: true })` origin restriction**, **port 8080 firewall posture** — these are real backend findings from the final security review, but they belong to a separate hardening pass and are not what "minimal demo auth" means.
- User registration / password change / email verification.
- Token expiry / refresh.
- Persistence of users or sessions across restarts.
- Rate limiting on `/auth/login`.
- Audit logging.
- Migration of identity from username → user-id record (the demo conflates the two; production Go service would not).
