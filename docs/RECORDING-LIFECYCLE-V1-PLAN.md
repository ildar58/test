# Recording Lifecycle V1 + Zero-Gap Activation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session recording start the instant the user logs in (no 5-second poll gap), with the recording `session_id` minted by the backend and delivered as a cookie.

**Architecture:** Variant 1 — the ingestion service sets cookies on `/auth/login` (`session`, `session_present`, and a new server-minted `session_id`). The injected SDK reads `session_present` to gate recording and `session_id` to tag batches. Activation latency is removed by subscribing to `cookieStore` change events (instant in Chromium) with a 1 s poll fallback. The proxy is unchanged. Spec: [RECORDING-LIFECYCLE-V1.md](RECORDING-LIFECYCLE-V1.md).

**Tech Stack:** TypeScript; ingestion = Express + vitest + supertest; SDK = rrweb + vitest (jsdom); E2E = Playwright + Docker.

---

## Pre-flight note (read before Task 3)

The SDK test suite is **currently red** for a reason unrelated to this feature: `sdk/src/__tests__/config.test.ts:6` asserts `maskAllInputs === true`, but `sdk/src/config.ts` was changed to `false` in an earlier session (select-masking fix). **Task 3 fixes this stale assertion** while it is editing that test file. Don't be surprised if `pnpm --filter @pam/web-session-recorder test` fails on `maskAllInputs` before Task 3.

## File structure

| File | Change |
|------|--------|
| `ingestion/src/auth.ts` | `SessionEntry` gains `sessionId`; `createSession` mints + returns it |
| `ingestion/src/server.ts` | `/auth/login` sets `session_id` cookie; `/auth/logout` clears it; `/s/` verifies `body.session_id === entry.sessionId` |
| `ingestion/src/__tests__/server.test.ts` | cookie + mismatch tests |
| `sdk/src/config.ts` | `markerPollMs` 5000→1000; add `sessionIdCookieName` |
| `sdk/src/__tests__/config.test.ts` | update defaults; fix stale `maskAllInputs` |
| `sdk/src/auth.ts` | add `readCookieValue`; subscribe `watchMarker` to `cookieStore` |
| `sdk/src/__tests__/auth.test.ts` | `readCookieValue` + cookieStore tests |
| `sdk/src/recorder.ts` | read `session_id` from cookie; stay IDLE if absent |
| `sdk/src/__tests__/recorder.test.ts` | rewrite around cookie-supplied `session_id` |
| `proxy/recorder-bundle/recorder.iife.js` | rebuilt artifact |
| `e2e/tests/variant-a.spec.ts` | assert start < 4 s; shorten poll-based waits |

Proxy code (`nginx.conf`) is **unchanged** — defaults already match (`session_present`, `session_id`, endpoint `/s/`).

---

### Task 1: Backend mints and sets the `session_id` cookie

**Files:**
- Modify: `ingestion/src/auth.ts`
- Modify: `ingestion/src/server.ts`
- Test: `ingestion/src/__tests__/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the `describe('ingestion server', …)` block in `ingestion/src/__tests__/server.test.ts`:

```ts
  it('POST /auth/login sets a non-HttpOnly session_id cookie (uuid)', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/auth/login')
      .send({ user: 'alice', password: 'alice' });
    expect(res.status).toBe(200);

    const setCookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const sid = setCookies.find((c) => c.startsWith('session_id='));
    expect(sid).toBeDefined();
    expect(/^session_id=[0-9a-f-]{36};/.test(sid!)).toBe(true);
    expect(/HttpOnly/i.test(sid!)).toBe(false);
  });

  it('POST /auth/logout clears the session_id cookie', async () => {
    const { default: app } = await import('../server');
    const agent = request.agent(app);
    await agent.post('/auth/login').send({ user: 'alice', password: 'alice' });

    const logout = await agent.post('/auth/logout');
    const setCookies = ([] as string[]).concat(logout.headers['set-cookie'] ?? []);
    expect(setCookies.some((c) => /^session_id=;/.test(c) && /Max-Age=0/.test(c))).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ingestion && npx vitest run src/__tests__/server.test.ts -t "session_id"`
Expected: 2 FAIL — no `session_id` cookie is set.

- [ ] **Step 3: Mint the id in `auth.ts`**

In `ingestion/src/auth.ts`, replace the `SessionEntry` interface and `createSession` function:

```ts
export interface SessionEntry {
  username: string;
  createdAt: number;
  /** Server-minted recording session id, mirrored to the client as a cookie. */
  sessionId: string;
}
```

```ts
export function createSession(username: string): { token: string; sessionId: string } {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomUUID();
  sessions.set(token, { username, createdAt: Date.now(), sessionId });
  return { token, sessionId };
}
```

- [ ] **Step 4: Set/clear the cookie in `server.ts`**

In `ingestion/src/server.ts`, change the `/auth/login` handler body (the part after the 401 guard):

```ts
  const { token, sessionId } = createSession(user);
  res.cookie('session',         token,     SESSION_COOKIE);
  res.cookie('session_present', '1',       MARKER_COOKIE);
  res.cookie('session_id',      sessionId, MARKER_COOKIE);
  res.json({ success: true, user });
```

And in `/auth/logout`, add the third clear line:

```ts
  res.cookie('session',         '', { ...SESSION_COOKIE, maxAge: 0 });
  res.cookie('session_present', '', { ...MARKER_COOKIE,  maxAge: 0 });
  res.cookie('session_id',      '', { ...MARKER_COOKIE,  maxAge: 0 });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ingestion && npx vitest run src/__tests__/server.test.ts -t "session_id"`
Expected: 2 PASS.

- [ ] **Step 6: Commit**

```bash
git add ingestion/src/auth.ts ingestion/src/server.ts ingestion/src/__tests__/server.test.ts
git commit -m "feat(ingestion): mint server-side session_id cookie on login"
```

---

### Task 2: `/s/` verifies the batch `session_id` matches the minted id

**Files:**
- Modify: `ingestion/src/server.ts:91-110` (the `/s/` handler)
- Test: `ingestion/src/__tests__/server.test.ts`

- [ ] **Step 1: Write the failing tests**

In `ingestion/src/__tests__/server.test.ts`, **replace** the existing test
`'POST /s/ stores batch tagged with the logged-in username after /auth/login'`
with the two tests below (it hard-codes `session_id: 'sA'`, which the new check rejects):

```ts
  it('POST /s/ stores batch under the minted session_id, tagged with username', async () => {
    const { default: app } = await import('../server');
    const agent = request.agent(app);

    const login = await agent.post('/auth/login').send({ user: 'alice', password: 'alice' });
    const sid = /session_id=([0-9a-f-]{36})/.exec(
      ([] as string[]).concat(login.headers['set-cookie'] ?? []).join(';')
    )?.[1];
    expect(sid).toBeTruthy();

    const ingest = await agent
      .post('/s/')
      .send({ session_id: sid, batch_seq: 1, events_b64_gzip: gzipB64([{ x: 1 }]) });
    expect(ingest.status).toBe(200);

    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, `${sid}.meta.json`), 'utf-8'));
    expect(meta.user_id).toBe('alice');
  });

  it('POST /s/ returns 403 when body.session_id != the minted session_id', async () => {
    const { default: app } = await import('../server');
    const agent = request.agent(app);
    await agent.post('/auth/login').send({ user: 'alice', password: 'alice' });

    const res = await agent
      .post('/s/')
      .send({ session_id: 'forged-id', batch_seq: 1, events_b64_gzip: gzipB64([{ x: 1 }]) });
    expect(res.status).toBe(403);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ingestion && npx vitest run src/__tests__/server.test.ts -t "session_id|403"`
Expected: the 403 test FAILS (server returns 200 for any id); the "minted session_id" test may pass or fail depending on append — both must pass after Step 3.

- [ ] **Step 3: Add the mismatch guard**

In `ingestion/src/server.ts`, the `/s/` handler — insert the check between the `isValidBatch` guard and the `try`:

```ts
app.post('/s/', (req: Request, res: Response) => {
  const entry = getSession(req.cookies?.session as string | undefined);
  if (!entry) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }

  if (!isValidBatch(req.body)) {
    res.status(400).json({ success: false, error: 'Missing required fields' });
    return;
  }

  // The session_id is JS-readable (non-HttpOnly), so it could be forged. It is
  // NOT the auth key — the HttpOnly session token above is. Here we only assert
  // the client is writing under the id we actually minted for this session.
  if (req.body.session_id !== entry.sessionId) {
    res.status(403).json({ success: false, error: 'session_id mismatch' });
    return;
  }

  try {
    appendBatch(req.body, entry.username);
    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
});
```

- [ ] **Step 4: Run the full server suite**

Run: `cd ingestion && npx vitest run src/__tests__/server.test.ts`
Expected: ALL PASS (the existing 400/401/logout tests still hold — their guards run before the mismatch check).

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/server.ts ingestion/src/__tests__/server.test.ts
git commit -m "feat(ingestion): /s/ rejects batches whose session_id != minted id"
```

---

### Task 3: SDK config — 1 s poll, `sessionIdCookieName`, fix stale test

**Files:**
- Modify: `sdk/src/config.ts`
- Test: `sdk/src/__tests__/config.test.ts`

- [ ] **Step 1: Update the config tests**

In `sdk/src/__tests__/config.test.ts`:

(a) Fix the stale assertion on line 6 — change `true` to `false`:

```ts
    expect(DEFAULT_CONFIG.maskAllInputs).toBe(false);
```

(b) Replace the `'has marker-cookie defaults'` test:

```ts
  it('has marker-cookie defaults', () => {
    expect(DEFAULT_CONFIG.markerCookieName).toBe('session_present');
    expect(DEFAULT_CONFIG.sessionIdCookieName).toBe('session_id');
    expect(DEFAULT_CONFIG.markerPollMs).toBe(1_000);
  });
```

- [ ] **Step 2: Run config tests to verify they fail**

Run: `cd sdk && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL — `sessionIdCookieName` is undefined and `markerPollMs` is still 5000.

- [ ] **Step 3: Update `config.ts`**

In `sdk/src/config.ts`, add to the `RecorderConfig` interface (next to `markerCookieName`):

```ts
  /** Name of the JS-readable cookie holding the server-minted recording session id */
  sessionIdCookieName: string;
```

In `DEFAULT_CONFIG`, add the field and lower the poll interval:

```ts
  markerCookieName: 'session_present',
  sessionIdCookieName: 'session_id',
  markerPollMs: 1_000,
```

- [ ] **Step 4: Run config tests to verify they pass**

Run: `cd sdk && npx vitest run src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/config.ts sdk/src/__tests__/config.test.ts
git commit -m "feat(sdk): 1s marker poll + sessionIdCookieName config"
```

---

### Task 4: SDK auth — `readCookieValue` + instant `cookieStore` activation

**Files:**
- Modify: `sdk/src/auth.ts`
- Test: `sdk/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing tests**

In `sdk/src/__tests__/auth.test.ts`, update the import line and add the tests below.

Change line 2 to:

```ts
import { readMarker, watchMarker, readCookieValue } from '../auth';
```

Add a new `describe` block (e.g. after the `readMarker` block):

```ts
describe('readCookieValue', () => {
  it('returns the value when present among other cookies', () => {
    setCookie('a=1; session_id=abc-123; b=2');
    expect(readCookieValue('session_id')).toBe('abc-123');
  });

  it('returns null when the cookie is absent', () => {
    setCookie('a=1');
    expect(readCookieValue('session_id')).toBeNull();
  });

  it('returns null for an empty value', () => {
    setCookie('session_id=');
    expect(readCookieValue('session_id')).toBeNull();
  });
});
```

Add this test inside the existing `describe('watchMarker', …)` block:

```ts
  it('fires onChange via cookieStore change event without waiting for the poll', () => {
    const listeners: Array<() => void> = [];
    vi.stubGlobal('cookieStore', {
      addEventListener: (_t: string, l: () => void) => listeners.push(l),
      removeEventListener: () => {},
    });

    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 60_000);

    setCookie('session_present=1');
    listeners.forEach((l) => l()); // simulate the browser firing 'change'

    expect(cb).toHaveBeenCalledWith(true);
    // Timers are NOT advanced and the poll is 60 s away — this proves the
    // cookieStore path, not the poll, delivered the edge.
    dispose();
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run auth tests to verify they fail**

Run: `cd sdk && npx vitest run src/__tests__/auth.test.ts`
Expected: FAIL — `readCookieValue` is not exported and the cookieStore listener isn't wired.

- [ ] **Step 3: Implement in `auth.ts`**

Add `readCookieValue` (after `readMarker`):

```ts
/** Returns the value of cookie `name`, or null when absent/empty. */
export function readCookieValue(name: string): string | null {
  const raw = typeof document !== 'undefined' ? document.cookie : '';
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      const value = v.join('=');
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
```

Wire `cookieStore` into `watchMarker` — add the listener before the `return`, and remove it in the disposer:

```ts
  const interval = setInterval(check, pollMs);
  const onVisibility = (): void => check();
  const onFocus = (): void => check();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);

  // Instant edge in Chromium: react the moment the browser applies a Set-Cookie
  // (login/logout), instead of waiting up to pollMs. Safari/Firefox lack
  // cookieStore and fall back to the poll above.
  const cookieStore = (globalThis as typeof globalThis & {
    cookieStore?: {
      addEventListener(t: 'change', l: () => void): void;
      removeEventListener(t: 'change', l: () => void): void;
    };
  }).cookieStore;
  if (cookieStore) cookieStore.addEventListener('change', check);

  return () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    if (cookieStore) cookieStore.removeEventListener('change', check);
  };
```

- [ ] **Step 4: Run auth tests to verify they pass**

Run: `cd sdk && npx vitest run src/__tests__/auth.test.ts`
Expected: PASS (existing poll/visibility tests still pass — no cookieStore is stubbed there, so the guard skips it).

- [ ] **Step 5: Commit**

```bash
git add sdk/src/auth.ts sdk/src/__tests__/auth.test.ts
git commit -m "feat(sdk): readCookieValue + instant cookieStore marker activation"
```

---

### Task 5: SDK recorder — use the cookie-supplied `session_id`

**Files:**
- Modify: `sdk/src/recorder.ts`
- Test: `sdk/src/__tests__/recorder.test.ts` (full rewrite — pervasive change)

- [ ] **Step 1: Rewrite the recorder tests**

Replace the **entire contents** of `sdk/src/__tests__/recorder.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Recorder } from '../recorder';
import { DEFAULT_CONFIG } from '../config';

const { recordStop, recordMock } = vi.hoisted(() => {
  const stop = vi.fn<[], void>();
  const mock = vi.fn<[opts: { emit: (e: unknown) => void }], () => void>(() => stop);
  return { recordStop: stop, recordMock: mock };
});
vi.mock('rrweb', () => ({
  record: Object.assign(
    (opts: { emit: (e: unknown) => void }) => recordMock(opts),
    { addCustomEvent: vi.fn() }
  ),
}));

function setCookie(value: string): void {
  Object.defineProperty(document, 'cookie', { configurable: true, value, writable: true });
}

// Backend sets session_present AND session_id together on login.
const LOGGED_IN = 'session_present=1; session_id=sid-1';

/** Parsed bodies of every batch POST the transport has flushed so far. */
function flushedBodies(fetchMock: ReturnType<typeof vi.fn>): Array<{ session_id: string }> {
  return fetchMock.mock.calls.map(
    (c) => JSON.parse((c[1] as RequestInit).body as string) as { session_id: string }
  );
}

describe('Recorder state machine', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    setCookie('');
    sessionStorage.clear();
    recordMock.mockClear();
    recordStop.mockClear();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(true) });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts in IDLE — no rrweb.record while marker is absent', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    vi.advanceTimersByTime(3_000);
    expect(recordMock).not.toHaveBeenCalled();

    r.stop();
  });

  it('activates immediately when marker + session_id are present at start()', () => {
    setCookie(LOGGED_IN);
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();

    expect(recordMock).toHaveBeenCalledOnce();

    r.stop();
  });

  it('stays IDLE when marker is present but session_id cookie is missing', () => {
    setCookie('session_present=1');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    vi.advanceTimersByTime(3_000);
    expect(recordMock).not.toHaveBeenCalled();

    r.stop();
  });

  it('IDLE → ACTIVE when marker appears via watcher edge', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    setCookie(LOGGED_IN);
    vi.advanceTimersByTime(1_000);

    expect(recordMock).toHaveBeenCalledOnce();

    r.stop();
  });

  it('tags flushed batches with the session_id from the cookie', () => {
    setCookie('session_present=1; session_id=fixed-sid');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();
    expect(recordMock).toHaveBeenCalledOnce();

    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);

    const bodies = flushedBodies(fetchMock);
    expect(bodies.length).toBe(1);
    expect(bodies[0]!.session_id).toBe('fixed-sid');

    r.stop();
  });

  it('ACTIVE → IDLE when marker disappears: rrweb stops', () => {
    setCookie(LOGGED_IN);
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();
    expect(recordMock).toHaveBeenCalledOnce();

    setCookie('');
    vi.advanceTimersByTime(1_000);
    expect(recordStop).toHaveBeenCalledOnce();

    r.stop();
  });

  it('re-login picks up the new session_id minted by the backend', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    setCookie('session_present=1; session_id=id1');
    vi.advanceTimersByTime(1_000);
    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);

    setCookie('');
    vi.advanceTimersByTime(1_000);

    setCookie('session_present=1; session_id=id2');
    vi.advanceTimersByTime(1_000);
    recordMock.mock.calls[1]![0].emit({ type: 0, data: {}, timestamp: 2 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);

    const bodies = flushedBodies(fetchMock);
    expect(bodies[0]!.session_id).toBe('id1');
    expect(bodies[bodies.length - 1]!.session_id).toBe('id2');

    r.stop();
  });

  it('401 from transport transitions ACTIVE → IDLE and drops buffer', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie(LOGGED_IN);
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();
    expect(recordMock).toHaveBeenCalledOnce();

    const emit = recordMock.mock.calls[0]![0].emit;
    emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledOnce());

    r.stop();
  });

  it('below threshold: schedules a retry that re-activates while marker is still present', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    setCookie(LOGGED_IN);
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 1_000,
      unauthorizedThreshold: 5,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    r.stop();
  });

  it('after unauthorizedThreshold consecutive 401s, suppresses retry until cool-down expires', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie(LOGGED_IN);
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 1_000,
      unauthorizedThreshold: 2,
      unauthorizedCooldownMs: 10_000,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    recordMock.mock.calls[1]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(2));

    vi.advanceTimersByTime(5_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(5_000);
    expect(recordMock).toHaveBeenCalledTimes(3);

    r.stop();
  });

  it('concurrent 401s within one ACTIVE phase increment the counter only once', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie(LOGGED_IN);
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 60_000,
      unauthorizedThreshold: 2,
      unauthorizedCooldownMs: 10_000,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    const emit = recordMock.mock.calls[0]![0].emit;
    emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    emit({ type: 0, data: {}, timestamp: 2 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(60_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    r.stop();
  });

  it('resets unauthorizedCount when a batch succeeds with 200 (non-consecutive 401s)', async () => {
    setCookie(LOGGED_IN);
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 1_000,
      unauthorizedThreshold: 2,
      unauthorizedCooldownMs: 60_000,
    });
    r.start();
    expect(recordMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    recordMock.mock.calls[0]![0].emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    recordMock.mock.calls[1]![0].emit({ type: 0, data: {}, timestamp: 2 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    recordMock.mock.calls[1]![0].emit({ type: 0, data: {}, timestamp: 3 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(2));

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledTimes(3);

    r.stop();
  });
});
```

- [ ] **Step 2: Run the recorder tests to verify they fail**

Run: `cd sdk && npx vitest run src/__tests__/recorder.test.ts`
Expected: FAIL — the recorder still mints a UUID and ignores the `session_id` cookie (the "stays IDLE when session_id missing" and "tags batches with cookie session_id" tests fail).

- [ ] **Step 3: Read the session_id from the cookie in `recorder.ts`**

In `sdk/src/recorder.ts`, change the import on line 5:

```ts
import { readMarker, watchMarker, readCookieValue } from './auth';
```

Replace the `tryActivate` method and **delete** the `resumeOrCreateSessionId` method (and its doc comment) entirely:

```ts
  private tryActivate(): void {
    if (this.state !== 'IDLE') return;
    if (Date.now() < this.cooldownUntil) return;

    // V1: the recording session id is minted by the backend and delivered as a
    // cookie alongside session_present. If it isn't readable yet, stay IDLE —
    // the backend sets both atomically, so the next auth edge will carry it.
    const sessionId = readCookieValue(this.config.sessionIdCookieName);
    if (!sessionId) return;

    this.clearRetryTimer();
    this.transport = this.spawnTransport();
    this.transport.start(sessionId);
    this.rrwebStop =
      record(buildRrwebOptions(this.config, (event) =>
        this.transport?.push(event, sessionId)
      )) ?? null;

    this.state = 'ACTIVE';
  }
```

> Note: leave the `sessionIdStorage` object as-is. Its `readSeq`/`writeSeq`/`clear`
> are still used for `batch_seq` continuity; `readId`/`writeId` are now unused but
> harmless, and `deactivate()`'s `sessionIdStorage.clear()` still correctly resets
> the batch sequence on logout.

- [ ] **Step 4: Run the recorder tests to verify they pass**

Run: `cd sdk && npx vitest run src/__tests__/recorder.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full SDK suite**

Run: `cd sdk && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all SDK tests PASS.

- [ ] **Step 6: Commit**

```bash
git add sdk/src/recorder.ts sdk/src/__tests__/recorder.test.ts
git commit -m "feat(sdk): use backend-minted session_id cookie, gate activation on it"
```

---

### Task 6: Rebuild the injected bundle

**Files:**
- Modify (regenerated): `proxy/recorder-bundle/recorder.iife.js`

- [ ] **Step 1: Rebuild and copy**

Run:
```bash
cd sdk && pnpm build && cp dist/recorder.iife.js ../proxy/recorder-bundle/recorder.iife.js
```
Expected: esbuild prints `dist/recorder.iife.js` with a size; copy succeeds.

- [ ] **Step 2: Sanity-check the new defaults are in the bundle**

Run: `grep -o 'markerPollMs: [0-9]*\|sessionIdCookieName: "[a-z_]*"' proxy/recorder-bundle/recorder.iife.js | sort -u`
Expected: includes `markerPollMs: 1000` and `sessionIdCookieName: "session_id"`.

- [ ] **Step 3: Commit**

```bash
git add proxy/recorder-bundle/recorder.iife.js
git commit -m "build(sdk): rebuild IIFE bundle with cookie session_id + 1s poll"
```

---

### Task 7: E2E — recording starts without the 5 s gap

**Files:**
- Modify: `e2e/tests/variant-a.spec.ts`

- [ ] **Step 1: Add the zero-gap helper + test, and shorten poll-based waits**

In `e2e/tests/variant-a.spec.ts`, add this helper after `countBatchPosts` (around line 24):

```ts
async function msUntilFirstBatch(page: Page, action: () => Promise<void>): Promise<number> {
  const t0 = Date.now();
  const firstBatch = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/s/'),
    { timeout: 6_000 }
  );
  await action();
  await firstBatch;
  return Date.now() - t0;
}
```

Add this test inside the `test.describe('variant-a: …')` block:

```ts
  test('recording starts within 4s of login (no 5s poll gap)', async ({ page }) => {
    await page.goto(stack.url);

    const elapsed = await msUntilFirstBatch(page, async () => {
      await login(page);
      await expect(page.locator('#auth-status')).toHaveText('logged in');
      const inputs = page.locator('input[type="text"]');
      await inputs.first().fill('post-auth typing');
    });

    // Old behaviour waited up to markerPollMs=5s for the cookie poll.
    // With cookieStore + 1s poll the first batch (full snapshot) arrives
    // within one flush interval (~2s) of login.
    expect(elapsed).toBeLessThan(4_000);
  });
```

Then shorten the existing poll-based waits, which assumed `markerPollMs=5s`:
- In `'login starts recording → batches appear in storage'`, change `await page.waitForTimeout(8_000);` to `await page.waitForTimeout(3_000);` and update the comment to "markerPollMs=1s + flush 2s".
- In `'logout stops recording within poll interval'`, change `await page.waitForTimeout(7_500);` to `await page.waitForTimeout(3_500);`.
- In `'logout → re-login produces two distinct session_ids…'`, change each `waitForTimeout(8_000)` to `waitForTimeout(3_000)` and each `waitForTimeout(7_500)` to `waitForTimeout(3_500)`.

- [ ] **Step 2: Rebuild the Docker images (service change) — bundle is mounted**

The `docker-stack` helper runs `docker compose up -d` **without `--build`**, so build first. The ingestion image must be rebuilt (its source changed); the recorder bundle is bind-mounted read-only, so Task 6's copy is already live.

Run:
```bash
docker compose -f proxy/docker-compose.yml build ingestion
```
Expected: ingestion image rebuilds successfully.

- [ ] **Step 3: Run the variant-a E2E suite**

Run: `pnpm --filter @pam/e2e test:a`
Expected: all variant-a tests PASS, including `recording starts within 4s of login`. (If Docker isn't running, the suite skips — start Docker Desktop first.)

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/variant-a.spec.ts
git commit -m "test(e2e): assert recording starts <4s after login; shorten poll waits"
```

---

## Final verification

- [ ] **Whole-repo gate**

Run:
```bash
pnpm -r exec tsc --noEmit
pnpm test
```
Expected: typecheck clean across workspaces; SDK + ingestion unit suites green.

---

## Self-review (planner)

**Spec coverage:**
- §3 cookie contract (`session_id` server-minted) → Tasks 1, 6.
- §4 instant start (cookieStore + 1 s poll) → Tasks 3, 4; E2E Task 7.
- §5 lifecycle (login activates, logout stops, reload continuity via cookie) → Tasks 4, 5; E2E Task 7.
- §6 component changes: service → Tasks 1–2; SDK config/auth/recorder → Tasks 3–5; proxy unchanged (no task — defaults match, called out in File structure).
- §7 server-minted id + anti-forgery verify → Tasks 1–2, 5.
- §8 error handling: 401 cool-down preserved → recorder tests in Task 5; missing-`session_id` → IDLE covered in Task 5.
- §9 tests: unit (config/auth/recorder/server) + E2E start-latency → Tasks 1–5, 7.

**Placeholder scan:** none — every step has concrete code/commands and expected output.

**Type/name consistency:** `sessionIdCookieName` (config) is read in `recorder.ts` and asserted in `config.test.ts`; `createSession` returns `{ token, sessionId }` and is destructured in `server.ts`; `SessionEntry.sessionId` is set in `auth.ts` and compared in `server.ts` `/s/`; `readCookieValue` is exported in `auth.ts`, imported in `recorder.ts`, tested in `auth.test.ts`. Consistent.

**Out of scope (per spec §1):** proxy auth-interception (V2), `Authorization`/`localStorage` detection, different-domain recording service. Not in any task.
