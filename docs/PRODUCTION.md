# Porting to production

What the demo Node ingestion stub fakes versus what the real Go service has
to do. Read this before you point a real product at this code.

For the architecture-as-shipped, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Mental model: stub vs. production

The recorder, nginx config, demo page, and replayer are **production-shaped**.
They make assumptions about the backend contract — same-origin via nginx,
HttpOnly + marker cookies, opaque session token, `user_id` derived
server-side — and those assumptions match the design spec.

The Node service in [`ingestion/`](../ingestion) implements the **same
contract** with stub semantics, so the recorder loop, the lifecycle, and
the e2e tests are real, but identity, persistence, and security
hardening are deliberately fake. The list below is the explicit gap.

---

## 2. Auth & session

### Replace the user store

Today: [`ingestion/src/auth.ts`](../ingestion/src/auth.ts) hardcodes
`alice` and `bob` with bcryptjs hashes committed to the repo. The `users`
array is a `ReadonlyArray<DemoUser>`.

Production: integrate with the corporate identity provider (LDAP / SSO /
the existing auth backend that owns user records and password hashes).
The contract on `/auth/login` should accept the same `{user, password}`
shape and emit the same two cookies — beyond that, swap the
`verifyPassword` implementation.

### Replace the session store

Today: in-memory `Map<token, SessionEntry>` in
[`auth.ts`](../ingestion/src/auth.ts). No TTL, no eviction, no size cap;
restart wipes everyone out.

Production:

- Persist tokens (Redis / Postgres / Keydb) so restarts don't log
  everyone out.
- Enforce an absolute and an idle TTL. After expiry, `getSession` returns
  `null` → recorder's transport gets 401 → state machine deactivates.
- Enforce a max-sessions-per-user cap (defence in depth against token
  flooding).
- Audit-log token issuance and revocation.

### Use a real token format

Today: 32-byte random hex token, opaque, no embedded claims.

Production: either keep opaque tokens (simplest, requires lookup) or
switch to short-lived signed JWTs with a denylist for early revocation.
Either is fine for the recorder — it only ever sees the cookie value,
which is treated as an opaque string.

### Add `Secure` to the cookies

Today: `httpOnly: true, sameSite: 'lax', path: '/'`. No `Secure` flag
because the demo runs over HTTP localhost.

Production: add `secure: true` to **both** `res.cookie` calls in
[`ingestion/src/server.ts`](../ingestion/src/server.ts). The `TODO(prod)`
comments mark the exact lines. Once that flag is on, the browser will
refuse to send the cookie over plain HTTP — make sure nginx is doing
HTTPS termination first.

### Tighten CORS

Today: `cors({ credentials: true })` reflects the request `Origin` header
for any caller, with credentials allowed.

Production: pin `origin` to the list of known front-end hosts. CSRF
posture currently relies on (a) nginx serving recorder + app + ingestion
same-origin and (b) `SameSite=Lax`. Anything that breaks (a) — a separate
deployment domain for the ingestion service, for instance — needs a real
CSRF token on every state-changing request.

---

## 3. Known vulnerabilities to fix

These were caught by the post-implementation security review and are
**deliberately tracked here** rather than fixed in the stub:

### Path traversal in storage

**File:** [`ingestion/src/storage.ts:17`](../ingestion/src/storage.ts#L17)
**Severity:** High in a production deployment.

`session_id` from the request body flows directly into
`path.join(dataDir(), sessionId + '.jsonl')` without format validation.
An authenticated client can submit `session_id: "../etc/cron.d/x"` and
write outside the data directory.

Fix: validate `session_id` against the UUID format in the server handler
before calling `appendBatch`. If you keep the JSONL-on-disk persistence
in prod, additionally assert
`path.resolve(file).startsWith(path.resolve(dataDir()) + path.sep)`
inside `appendBatch` as defence in depth.

### Path traversal in GET /sessions/:id

**File:** [`ingestion/src/server.ts:78`](../ingestion/src/server.ts#L78)
**Severity:** High in a production deployment.

`req.params.id` passes the same gauntlet via `getSessionEvents`. Express
URL-decodes path params, so `%2F` slashes survive the route matcher and
land in `path.join` as traversal. The route is also unauthenticated
(see next item), so the read primitive is reachable to anonymous
attackers.

Fix: same UUID-format check.

### Unauthenticated read endpoints

**File:** [`ingestion/src/server.ts:74,78`](../ingestion/src/server.ts#L74)
**Severity:** Critical in a production deployment.

`GET /sessions` and `GET /sessions/:id` have no auth check. The
[design spec §4.3](superpowers/specs/2026-05-28-auth-gated-recording-design.md#43-go-service-contract)
mandates "Admin-only role guard" but the stub never implemented it.
nginx exposes `/sessions` on the public port 80, so anonymous attackers
can list and download all recordings.

Fix: add an admin-role guard to both handlers. The guard is best
implemented as an Express middleware that:

1. Reads the `session` cookie via the same `getSession` lookup.
2. Verifies the username belongs to an admin role.
3. Returns 401 / 403 otherwise.

In nginx, also consider removing the `location /sessions` block from
the public port-80 server and serving session reads only from the
restricted admin port (currently `8081`).

---

## 4. Storage

### Replace JSONL-on-disk

Today: every batch is appended as a JSON line to `data/<sid>.jsonl`, with
metadata in `data/<sid>.meta.json`. Storage lives in the
`ingestion-data` Docker volume.

Production:

- Pick a real store. ClickHouse for analytics + S3 for blobs is one
  shape; pure-S3 keyed by `<user>/<session_id>/<batch_seq>` is simpler
  for replay-only workloads.
- Make `appendBatch` idempotent on `(session_id, batch_seq)` so a
  network retry doesn't double-store events.
- Add retention. Sessions shouldn't live forever; pick a TTL aligned
  with your DPIA / GDPR posture.
- Encrypt at rest.

### Make the replayer scale

The replayer at [`replayer/index.html`](../replayer/index.html) calls
`GET /sessions/:id` and pulls the full event stream into memory. For
long sessions this is fine (rrweb compresses well) but for hour-long
captures you'll want chunked or paginated reads.

### Replayer mounted (fixed)

The replayer is now bind-mounted from `replayer/` into the ingestion
container via [`proxy/docker-compose.yml`](../proxy/docker-compose.yml).
The route is reachable at `http://localhost:8081/` in the local stack
and at `http://localhost:8080/replay/` via the main port. The admin
auth gap on `GET /sessions[/:id]` is still tracked above.

---

## 5. Recorder hardening

The recorder bundle is production-shaped already, but a few things are
deliberately not in MVP:

- **No `MutationThrottler`.** rrweb 2.0-alpha can crash on pathological
  DOMs (deep React trees, SVG animations). PostHog's fork has a throttler
  + max-depth guard — port them before production.
- **No network plugin.** `fetch`/`XHR` calls are not recorded. If you
  add the plugin later, you **must** redact `Authorization`, `Cookie`,
  `x-api-key` and any other secret-bearing headers in the deny-list.
  See PostHog's `network-plugin.ts` for reference.
- **No CSP nonce automation.** The nginx config injects an inline
  `<script>` calling `init({...})`. With a strict CSP that disallows
  inline scripts you need per-request nonces. Options:
  - `nginx-plus` with `set_secure_random_alphanum`.
  - `lua-nginx-module` with `resty.random`.
  - Upstream app generates the nonce server-side, passes it via response
    header, nginx reads it with `$upstream_http_x_csp_nonce`.
- **Cross-origin iframes not recorded.** Default is intentional.
  Per-iframe opt-in via `recordCrossOriginIframes: true` requires you
  to inject the bundle inside each iframe origin too.

---

## 6. Operational concerns

### Multi-tenancy

The recorder + ingestion design assumes a single tenant. Multi-tenant
deployments need:

- Tenant id in the cookie (or derived from the auth token's claims).
- Tenant id as part of the storage key.
- Per-tenant rate-limits + storage quotas.
- Tenant-isolated admin role guards.

### Rate limiting

The stub has none. Production needs limits on:

- `POST /auth/login` per IP and per username (lockout after N failed
  attempts).
- `POST /s/` per session_id (cap on batches-per-second and total batches
  per session).
- `GET /sessions/:id` per admin role (replay endpoint is heavy).

### Observability

The stub has zero. At minimum:

- Structured request logs (without bodies — events contain PII even
  when masked).
- Metrics on the SDK side via the existing `onUnauthorized` / cool-down
  pathway: how many sessions enter cool-down per hour tells you about
  cookie-expiry races.
- A health endpoint on the ingestion service.

---

## 7. Migration checklist

If you're porting today's stub to a real Go service, here's a sane
order:

1. ✅ Recorder, nginx, demo, e2e — already done, no change required.
2. **Implement the Go auth backend** — match the wire contract in
   [`ARCHITECTURE.md`](ARCHITECTURE.md#6-wire-format). Add the
   `Secure` cookie flag and the bullet-list cookie-store changes.
3. **Implement the Go ingestion handler** — same contract for `POST /s/`,
   but with UUID validation on `session_id` and a real storage backend.
4. **Add the admin-role guard** to the read endpoints.
5. **Add observability + rate limiting + audit logs.**
6. Point nginx at the Go service (replace the `ingestion` upstream in
   [`proxy/nginx.conf`](../proxy/nginx.conf)).
7. Delete the Node `ingestion/` package — once the Go service serves the
   same contract, the stub has no purpose. The recorder doesn't change.

The recorder's wire format and lifecycle are explicitly designed so step
7 is a drop-in replacement: as long as the Go service issues the same
two cookies and gates `POST /s/` on them, the SDK won't notice.
