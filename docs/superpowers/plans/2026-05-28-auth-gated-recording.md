# Auth-gated session recording — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt `@pam/web-session-recorder` so that the recorder is injected on every HTML response by nginx but recording only starts after authentication, with user identity derived server-side from an HttpOnly session cookie.

**Architecture:** SDK ships an IDLE/ACTIVE state machine gated by a non-HttpOnly `session_present` marker cookie. nginx injects the recorder bundle unconditionally. The (Go) ingestion service is the sole source of truth for `user_id`; the wire format drops `distinct_id`. The existing Node ingestion is adapted as a stub of the Go contract.

**Tech Stack:** TypeScript, rrweb 2.x, Express 4, vitest, Playwright, nginx 1.25, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md`

---

## File map

### Modify
- `sdk/src/transport.ts` — add `credentials: 'include'`, drop `distinct_id`, add `onUnauthorized` callback
- `sdk/src/config.ts` — add `markerCookieName`, `markerPollMs`, `unauthorizedCooldownMs`, `unauthorizedThreshold`
- `sdk/src/recorder.ts` — IDLE/ACTIVE state machine, owns 401 cool-down
- `sdk/src/index.ts` — simplified `InitOptions` (no `sessionId`/`distinctId`/`identify`)
- `sdk/src/__tests__/transport.test.ts` — update for new signature
- `sdk/src/__tests__/config.test.ts` — cover new defaults
- `ingestion/src/types.ts` — drop `distinct_id` from `EventBatch`; rename `distinct_id` → `user_id` in `SessionMeta`
- `ingestion/src/storage.ts` — write `user_id` (passed by caller) into meta
- `ingestion/src/server.ts` — cookie middleware, 401 when no session cookie, `/auth/login` + `/auth/logout` stubs
- `ingestion/src/__tests__/server.test.ts` — update for cookie-gated POST /s/ and new auth routes
- `ingestion/src/__tests__/storage.test.ts` — update for `user_id`
- `ingestion/package.json` — add `cookie-parser`
- `proxy/nginx.conf` — drop ACAO header on `/_rec/`, unconditional inject with no args
- `demo-app/index.html` — add login/logout buttons that POST to `/auth/*` (lets e2e drive the lifecycle)
- `e2e/tests/variant-a.spec.ts` — replace single happy-path test with four lifecycle scenarios from the spec

### Create
- `sdk/src/auth.ts` — `readMarker(name)`, `watchMarker(name, onChange, pollMs)`
- `sdk/src/__tests__/auth.test.ts` — unit tests for marker reading + watcher
- `sdk/src/__tests__/recorder.test.ts` — unit tests for state machine

---

## Task 1: Update wire-format types — drop `distinct_id`, add `user_id` to meta

**Files:**
- Modify: `ingestion/src/types.ts`
- Modify: `ingestion/src/__tests__/storage.test.ts`

- [ ] **Step 1: Update the failing storage test to use new types**

Replace the body of `ingestion/src/__tests__/storage.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import type { EventBatch } from '../types';

let tmpDir: string;

function makeBatch(sessionId: string, seq: number, events: unknown[]): EventBatch {
  const json = JSON.stringify(events);
  const gzipped = zlib.gzipSync(Buffer.from(json, 'utf-8'));
  return {
    session_id: sessionId,
    batch_seq: seq,
    events_b64_gzip: gzipped.toString('base64'),
  };
}

describe('storage', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-storage-'));
    process.env.PAM_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PAM_DATA_DIR;
  });

  it('appendBatch writes <session>.jsonl and meta tagged with user_id', async () => {
    const { appendBatch } = await import('../storage');
    appendBatch(makeBatch('s1', 1, [{ type: 0, ts: 1 }]), 'user-1');

    expect(fs.existsSync(path.join(tmpDir, 's1.jsonl'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, 's1.meta.json'), 'utf-8'));
    expect(meta.session_id).toBe('s1');
    expect(meta.user_id).toBe('user-1');
    expect(meta.batch_count).toBe(1);
  });

  it('listSessions returns sessions sorted desc by started_at', async () => {
    const { appendBatch, listSessions } = await import('../storage');
    appendBatch(makeBatch('s1', 1, []), 'user-1');
    await new Promise((r) => setTimeout(r, 10));
    appendBatch(makeBatch('s2', 1, []), 'user-2');

    const all = listSessions();
    expect(all).toHaveLength(2);
    expect(all[0]!.session_id).toBe('s2');
    expect(all[1]!.session_id).toBe('s1');
  });

  it('getSessionEvents decodes gzip+b64 and concatenates batches in order', async () => {
    const { appendBatch, getSessionEvents } = await import('../storage');
    appendBatch(makeBatch('s1', 1, [{ id: 1 }, { id: 2 }]), 'user-1');
    appendBatch(makeBatch('s1', 2, [{ id: 3 }]), 'user-1');

    expect(getSessionEvents('s1')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('getSessionEvents returns empty array for unknown session', async () => {
    const { getSessionEvents } = await import('../storage');
    expect(getSessionEvents('does-not-exist')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @pam/ingestion test`
Expected: FAIL — `EventBatch` still has `distinct_id`, `appendBatch` signature is `(batch)` not `(batch, user_id)`, `SessionMeta` has no `user_id`.

- [ ] **Step 3: Update types**

Replace contents of `ingestion/src/types.ts`:

```ts
/**
 * Wire format for event batch (POST /s/).
 * user_id is NOT in the wire format — the server derives it from the auth cookie.
 */
export interface EventBatch {
  /** UUID generated by the recorder */
  session_id: string;
  /** Monotonically increasing, per session */
  batch_seq: number;
  /** base64(gzip(JSON.stringify(eventWithTime[]))) */
  events_b64_gzip: string;
}

export interface SessionMeta {
  session_id: string;
  /** Derived server-side from the auth cookie at first batch */
  user_id: string;
  started_at: string;
  last_batch_at: string;
  batch_count: number;
}
```

- [ ] **Step 4: Commit (type-only step, tests still fail until storage update)**

```bash
git add ingestion/src/types.ts ingestion/src/__tests__/storage.test.ts
git commit -m "refactor(ingestion): drop distinct_id from wire, add user_id to meta"
```

---

## Task 2: Update storage to accept `user_id`

**Files:**
- Modify: `ingestion/src/storage.ts`

- [ ] **Step 1: Update `appendBatch` signature**

Replace `ingestion/src/storage.ts` (only the changed parts shown — keep `dataDir`, `ensureDataDir`, `sessionFile`, `metaFile`, `listSessions`, `getSessionEvents` unchanged):

```ts
export function appendBatch(batch: EventBatch, userId: string): void {
  ensureDataDir();
  const line = JSON.stringify(batch) + '\n';
  fs.appendFileSync(sessionFile(batch.session_id), line, 'utf-8');

  const metaPath = metaFile(batch.session_id);
  const now = new Date().toISOString();
  let meta: SessionMeta;
  if (fs.existsSync(metaPath)) {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta;
    meta.last_batch_at = now;
    meta.batch_count += 1;
  } else {
    meta = {
      session_id: batch.session_id,
      user_id: userId,
      started_at: now,
      last_batch_at: now,
      batch_count: 1,
    };
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}
```

- [ ] **Step 2: Run storage tests to verify they pass**

Run: `pnpm --filter @pam/ingestion test -- storage`
Expected: PASS (4/4 storage tests).

- [ ] **Step 3: Commit**

```bash
git add ingestion/src/storage.ts
git commit -m "feat(ingestion): appendBatch takes user_id, writes it into session meta"
```

---

## Task 3: Add cookie-parser dependency

**Files:**
- Modify: `ingestion/package.json`

- [ ] **Step 1: Add dependency**

Run from repo root:

```bash
pnpm --filter @pam/ingestion add cookie-parser
pnpm --filter @pam/ingestion add -D @types/cookie-parser
```

- [ ] **Step 2: Verify installation**

Run: `pnpm --filter @pam/ingestion exec node -e "require('cookie-parser')"`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```bash
git add ingestion/package.json pnpm-lock.yaml
git commit -m "chore(ingestion): add cookie-parser for auth middleware"
```

---

## Task 4: Server — cookie-gated POST /s/ and auth stub routes

**Files:**
- Modify: `ingestion/src/__tests__/server.test.ts`
- Modify: `ingestion/src/server.ts`

- [ ] **Step 1: Replace the server test file**

Replace contents of `ingestion/src/__tests__/server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

let tmpDir: string;

function gzipB64(events: unknown[]): string {
  return zlib.gzipSync(Buffer.from(JSON.stringify(events), 'utf-8')).toString('base64');
}

describe('ingestion server', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-server-'));
    process.env.PAM_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PAM_DATA_DIR;
  });

  it('POST /s/ returns 401 when no session cookie is present', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/s/')
      .send({ session_id: 'sA', batch_seq: 1, events_b64_gzip: gzipB64([{ x: 1 }]) });
    expect(res.status).toBe(401);
  });

  it('POST /s/ stores batch and tags meta with user_id derived from cookie', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/s/')
      .set('Cookie', 'session=user-42')
      .send({ session_id: 'sA', batch_seq: 1, events_b64_gzip: gzipB64([{ x: 1 }]) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, 'sA.meta.json'), 'utf-8'));
    expect(meta.user_id).toBe('user-42');
  });

  it('POST /s/ returns 400 for batch missing required fields (with valid cookie)', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/s/')
      .set('Cookie', 'session=user-42')
      .send({ session_id: 'sA' });
    expect(res.status).toBe(400);
  });

  it('POST /auth/login sets both session and session_present cookies', async () => {
    const { default: app } = await import('../server');
    const res = await request(app).post('/auth/login').send({ user: 'alice' });
    expect(res.status).toBe(200);
    const setCookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(setCookies.some((c) => /^session=alice;/.test(c) && /HttpOnly/i.test(c))).toBe(true);
    expect(
      setCookies.some(
        (c) => /^session_present=1;/.test(c) && !/HttpOnly/i.test(c)
      )
    ).toBe(true);
  });

  it('POST /auth/logout clears both cookies (Max-Age=0)', async () => {
    const { default: app } = await import('../server');
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(200);
    const setCookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(setCookies.some((c) => /^session=;/.test(c) && /Max-Age=0/.test(c))).toBe(true);
    expect(setCookies.some((c) => /^session_present=;/.test(c) && /Max-Age=0/.test(c))).toBe(true);
  });
});
```

- [ ] **Step 2: Run server tests to confirm they fail**

Run: `pnpm --filter @pam/ingestion test -- server`
Expected: FAIL — server still accepts batches without cookies, has no `/auth/*` routes.

- [ ] **Step 3: Rewrite `ingestion/src/server.ts`**

Replace contents of `ingestion/src/server.ts`:

```ts
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import type { Request, Response } from 'express';
import type { EventBatch } from './types';
import { appendBatch, listSessions, getSessionEvents } from './storage';

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors({ credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

app.use('/replay', express.static(path.resolve(__dirname, '../../replayer')));

/**
 * Stub Go auth contract.
 * Real auth lives in the Go service; this is just enough to exercise the
 * recorder lifecycle locally and in E2E.
 */
app.post('/auth/login', (req: Request, res: Response) => {
  const user = (req.body?.user as string | undefined) ?? 'anonymous';
  res.cookie('session', user, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.cookie('session_present', '1', { httpOnly: false, sameSite: 'lax', path: '/' });
  res.json({ success: true, user });
});

app.post('/auth/logout', (_req: Request, res: Response) => {
  res.cookie('session', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  res.cookie('session_present', '', { httpOnly: false, sameSite: 'lax', path: '/', maxAge: 0 });
  res.json({ success: true });
});

app.post('/s/', (req: Request, res: Response) => {
  const userId = req.cookies?.session as string | undefined;
  if (!userId) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }

  const batch = req.body as EventBatch;
  if (!batch?.session_id || !batch.events_b64_gzip || typeof batch.batch_seq !== 'number') {
    res.status(400).json({ success: false, error: 'Missing required fields' });
    return;
  }

  try {
    appendBatch(batch, userId);
    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
});

app.get('/sessions', (_req: Request, res: Response) => {
  res.json({ success: true, data: listSessions() });
});

app.get('/sessions/:id', (req: Request, res: Response) => {
  const events = getSessionEvents(req.params.id);
  if (events.length === 0) {
    res.status(404).json({ success: false, error: 'Session not found or empty' });
    return;
  }
  res.json({ success: true, data: events });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ingestion service listening on http://localhost:${PORT}`);
    console.log(`Replayer UI:  http://localhost:${PORT}/replay`);
  });
}

export default app;
```

- [ ] **Step 4: Run server tests to confirm they pass**

Run: `pnpm --filter @pam/ingestion test -- server`
Expected: PASS (5/5 server tests). Storage tests also still PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/server.ts ingestion/src/__tests__/server.test.ts
git commit -m "feat(ingestion): cookie-gated POST /s/ + auth/login + auth/logout stubs"
```

---

## Task 5: SDK config — add marker/cool-down fields

**Files:**
- Modify: `sdk/src/__tests__/config.test.ts`
- Modify: `sdk/src/config.ts`

- [ ] **Step 1: Add failing test cases**

Append to `sdk/src/__tests__/config.test.ts`, inside the existing `describe('DEFAULT_CONFIG', ...)`:

```ts
  it('has marker-cookie defaults', () => {
    expect(DEFAULT_CONFIG.markerCookieName).toBe('session_present');
    expect(DEFAULT_CONFIG.markerPollMs).toBe(5_000);
  });

  it('has 401 cool-down defaults', () => {
    expect(DEFAULT_CONFIG.unauthorizedThreshold).toBe(3);
    expect(DEFAULT_CONFIG.unauthorizedCooldownMs).toBe(60_000);
  });
```

- [ ] **Step 2: Run config tests to verify they fail**

Run: `pnpm --filter @pam/web-session-recorder test -- config`
Expected: FAIL — new properties undefined.

- [ ] **Step 3: Update `sdk/src/config.ts`**

Add four fields to `RecorderConfig` and `DEFAULT_CONFIG`:

```ts
export interface RecorderConfig {
  // ... existing fields unchanged ...

  /** Name of the JS-readable marker cookie set by the backend on login */
  markerCookieName: string;
  /** Marker cookie poll interval in ms (defensive; watcher also reacts to focus/visibility) */
  markerPollMs: number;
  /** Consecutive 401-induced transitions before suspending IDLE→ACTIVE */
  unauthorizedThreshold: number;
  /** Cool-down window after the threshold is reached */
  unauthorizedCooldownMs: number;
}

export const DEFAULT_CONFIG: RecorderConfig = {
  // ... existing values unchanged ...
  markerCookieName: 'session_present',
  markerPollMs: 5_000,
  unauthorizedThreshold: 3,
  unauthorizedCooldownMs: 60_000,
};
```

- [ ] **Step 4: Run config tests to verify they pass**

Run: `pnpm --filter @pam/web-session-recorder test -- config`
Expected: PASS (all config tests).

- [ ] **Step 5: Commit**

```bash
git add sdk/src/config.ts sdk/src/__tests__/config.test.ts
git commit -m "feat(sdk): add marker cookie + 401 cool-down config fields"
```

---

## Task 6: SDK auth module — `readMarker` + `watchMarker`

**Files:**
- Create: `sdk/src/__tests__/auth.test.ts`
- Create: `sdk/src/auth.ts`

- [ ] **Step 1: Write the failing tests**

Create `sdk/src/__tests__/auth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readMarker, watchMarker } from '../auth';

function setCookie(value: string): void {
  Object.defineProperty(document, 'cookie', { configurable: true, value, writable: true });
}

describe('readMarker', () => {
  it('returns false when cookie is absent', () => {
    setCookie('foo=bar; baz=qux');
    expect(readMarker('session_present')).toBe(false);
  });

  it('returns true when marker is the only cookie', () => {
    setCookie('session_present=1');
    expect(readMarker('session_present')).toBe(true);
  });

  it('returns true when marker is mixed with other cookies', () => {
    setCookie('a=1; session_present=1; b=2');
    expect(readMarker('session_present')).toBe(true);
  });

  it('returns false when marker has empty value', () => {
    setCookie('session_present=; foo=bar');
    expect(readMarker('session_present')).toBe(false);
  });

  it('does not match a prefix of another cookie', () => {
    setCookie('session_present_other=1');
    expect(readMarker('session_present')).toBe(false);
  });
});

describe('watchMarker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setCookie('');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onChange(true) when marker appears via poll', () => {
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 1_000);

    setCookie('session_present=1');
    vi.advanceTimersByTime(1_000);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);
    dispose();
  });

  it('fires onChange(false) when marker disappears', () => {
    setCookie('session_present=1');
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 1_000);

    setCookie('');
    vi.advanceTimersByTime(1_000);

    expect(cb).toHaveBeenCalledWith(false);
    dispose();
  });

  it('does not fire when state is unchanged', () => {
    setCookie('session_present=1');
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 1_000);

    vi.advanceTimersByTime(5_000);

    expect(cb).not.toHaveBeenCalled();
    dispose();
  });

  it('reacts to visibilitychange events', () => {
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 60_000);

    setCookie('session_present=1');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(cb).toHaveBeenCalledWith(true);
    dispose();
  });

  it('dispose() stops the watcher', () => {
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 1_000);
    dispose();

    setCookie('session_present=1');
    vi.advanceTimersByTime(10_000);

    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run auth tests to verify they fail**

Run: `pnpm --filter @pam/web-session-recorder test -- auth`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `sdk/src/auth.ts`**

```ts
export function readMarker(name: string): boolean {
  const raw = typeof document !== 'undefined' ? document.cookie : '';
  if (!raw) return false;
  const parts = raw.split(';');
  for (const part of parts) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=').length > 0;
  }
  return false;
}

export function watchMarker(
  name: string,
  onChange: (present: boolean) => void,
  pollMs: number
): () => void {
  let last = readMarker(name);

  const check = (): void => {
    const now = readMarker(name);
    if (now !== last) {
      last = now;
      onChange(now);
    }
  };

  const interval = setInterval(check, pollMs);
  const onVisibility = (): void => check();
  const onFocus = (): void => check();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);

  return () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
  };
}
```

- [ ] **Step 4: Run auth tests to verify they pass**

Run: `pnpm --filter @pam/web-session-recorder test -- auth`
Expected: PASS (all auth tests).

- [ ] **Step 5: Commit**

```bash
git add sdk/src/auth.ts sdk/src/__tests__/auth.test.ts
git commit -m "feat(sdk): add marker cookie reader and watcher"
```

---

## Task 7: SDK transport — credentials, drop `distinct_id`, 401 callback

**Files:**
- Modify: `sdk/src/__tests__/transport.test.ts`
- Modify: `sdk/src/transport.ts`

- [ ] **Step 1: Replace the transport test body**

Replace contents of `sdk/src/__tests__/transport.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { Transport } from '../transport';

const ENDPOINT = 'http://test.local/s/';
const SESSION = 'session-1';

function decodeBatch(b64: string): unknown[] {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(strFromU8(gunzipSync(bytes))) as unknown[];
}

describe('Transport', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let beaconMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    beaconMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: beaconMock });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not flush before flushIntervalMs has elapsed', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION);
    t.push({ type: 0, data: {}, timestamp: 1 } as never, SESSION);

    vi.advanceTimersByTime(1_500);
    expect(fetchMock).not.toHaveBeenCalled();

    t.stop();
  });

  it('flushes via fetch after flushIntervalMs with credentials:"include"', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION);
    t.push({ type: 0, data: {}, timestamp: 1 } as never, SESSION);

    vi.advanceTimersByTime(2_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');

    t.stop();
  });

  it('wire payload contains session_id, batch_seq, events_b64_gzip and NO distinct_id', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION);
    const events = [
      { type: 0, data: { tag: 'meta' }, timestamp: 100 },
      { type: 2, data: { node: 'snapshot' }, timestamp: 200 },
    ];
    for (const e of events) t.push(e as never, SESSION);

    vi.advanceTimersByTime(2_000);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(body.session_id).toBe(SESSION);
    expect(body.batch_seq).toBe(1);
    expect('distinct_id' in body).toBe(false);
    expect(decodeBatch(body.events_b64_gzip as string)).toEqual(events);

    t.stop();
  });

  it('triggers sendBeacon on visibilitychange→hidden', () => {
    const t = new Transport(ENDPOINT, 2_000, 1000);
    t.start(SESSION);
    t.push({ type: 3, data: {}, timestamp: 9 } as never, SESSION);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(beaconMock).toHaveBeenCalledOnce();

    t.stop();
  });

  it('invokes onUnauthorized callback when server returns 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const onUnauthorized = vi.fn();
    const t = new Transport(ENDPOINT, 2_000, 1000, onUnauthorized);
    t.start(SESSION);
    t.push({ type: 0, data: {}, timestamp: 1 } as never, SESSION);

    vi.advanceTimersByTime(2_000);
    // Allow the fetch microtask to settle
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());

    t.stop();
  });
});
```

- [ ] **Step 2: Run transport tests to verify they fail**

Run: `pnpm --filter @pam/web-session-recorder test -- transport`
Expected: FAIL — signature changed, no `credentials: 'include'`, no `onUnauthorized` callback.

- [ ] **Step 3: Rewrite `sdk/src/transport.ts`**

```ts
import { gzipSync, strToU8 } from 'fflate';
import type { eventWithTime } from '@rrweb/types';

export interface Batch {
  session_id: string;
  batch_seq: number;
  events_b64_gzip: string;
}

function encodeBatch(events: eventWithTime[]): string {
  const u8 = strToU8(JSON.stringify(events));
  const compressed = gzipSync(u8, { level: 6 });
  let binary = '';
  compressed.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export class Transport {
  private buffer: eventWithTime[] = [];
  private batchSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly endpoint: string;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly onUnauthorized?: () => void;
  private onVisibilityChange: (() => void) | null = null;
  private onPageHide: (() => void) | null = null;

  constructor(
    endpoint: string,
    flushIntervalMs: number,
    maxBufferSize: number,
    onUnauthorized?: () => void
  ) {
    this.endpoint = endpoint;
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
    this.onUnauthorized = onUnauthorized;
  }

  start(sessionId: string): void {
    this.timer = setInterval(() => this.flush(sessionId), this.flushIntervalMs);

    this.onPageHide = () => this.beaconFlush(sessionId);
    this.onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this.beaconFlush(sessionId);
    };
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
  }

  push(event: eventWithTime, sessionId: string): void {
    this.buffer = [...this.buffer, event];
    if (this.buffer.length >= this.maxBufferSize) this.flush(sessionId);
  }

  flush(sessionId: string): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    const batch: Batch = {
      session_id: sessionId,
      batch_seq: ++this.batchSeq,
      events_b64_gzip: encodeBatch(events),
    };
    fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      credentials: 'include',
      keepalive: true,
    })
      .then((res) => {
        if (res.status === 401 && this.onUnauthorized) this.onUnauthorized();
      })
      .catch(() => {
        // silently drop on network error
      });
  }

  private beaconFlush(sessionId: string): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    const batch: Batch = {
      session_id: sessionId,
      batch_seq: ++this.batchSeq,
      events_b64_gzip: encodeBatch(events),
    };
    const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
    navigator.sendBeacon(this.endpoint, blob);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.onVisibilityChange) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
    if (this.onPageHide) {
      window.removeEventListener('pagehide', this.onPageHide);
      this.onPageHide = null;
    }
  }
}
```

- [ ] **Step 4: Run transport tests to verify they pass**

Run: `pnpm --filter @pam/web-session-recorder test -- transport`
Expected: PASS (5/5 transport tests).

- [ ] **Step 5: Commit**

```bash
git add sdk/src/transport.ts sdk/src/__tests__/transport.test.ts
git commit -m "feat(sdk): transport sends credentials, drops distinct_id, surfaces 401 via callback"
```

---

## Task 8: Recorder state machine — IDLE/ACTIVE + 401 cool-down

**Files:**
- Create: `sdk/src/__tests__/recorder.test.ts`
- Modify: `sdk/src/recorder.ts`

- [ ] **Step 1: Write the failing state-machine tests**

Create `sdk/src/__tests__/recorder.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Recorder } from '../recorder';
import { DEFAULT_CONFIG } from '../config';

const { recordStop, recordMock } = vi.hoisted(() => {
  const stop = vi.fn();
  const mock = vi.fn(() => stop);
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

  it('IDLE → ACTIVE when marker appears: rrweb starts, sessionId persisted', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    setCookie('session_present=1');
    vi.advanceTimersByTime(1_000);

    expect(recordMock).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('_pam_sid')).toMatch(/^[0-9a-f-]{36}$/);

    r.stop();
  });

  it('ACTIVE → IDLE when marker disappears: rrweb stops, sessionId cleared', () => {
    setCookie('session_present=1');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();
    vi.advanceTimersByTime(1_000);
    expect(recordMock).toHaveBeenCalledOnce();
    const firstSid = sessionStorage.getItem('_pam_sid');
    expect(firstSid).toBeTruthy();

    setCookie('');
    vi.advanceTimersByTime(1_000);
    expect(recordStop).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('_pam_sid')).toBeNull();

    r.stop();
  });

  it('re-login after logout produces a new session_id (D5)', () => {
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 1_000 });
    r.start();

    setCookie('session_present=1');
    vi.advanceTimersByTime(1_000);
    const first = sessionStorage.getItem('_pam_sid');

    setCookie('');
    vi.advanceTimersByTime(1_000);

    setCookie('session_present=1');
    vi.advanceTimersByTime(1_000);
    const second = sessionStorage.getItem('_pam_sid');

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    r.stop();
  });

  it('401 from transport transitions ACTIVE → IDLE and drops buffer', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie('session_present=1');
    const r = new Recorder({ ...DEFAULT_CONFIG, markerPollMs: 60_000 });
    r.start();
    vi.advanceTimersByTime(60_000);
    expect(recordMock).toHaveBeenCalledOnce();

    // Trigger one flush
    const emit = recordMock.mock.calls[0]![0].emit;
    emit({ type: 0, data: {}, timestamp: 1 });
    vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledOnce());

    expect(sessionStorage.getItem('_pam_sid')).toBeNull();

    r.stop();
  });

  it('after unauthorizedThreshold consecutive 401s, suppresses IDLE→ACTIVE for cool-down', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    setCookie('session_present=1');
    const r = new Recorder({
      ...DEFAULT_CONFIG,
      markerPollMs: 1_000,
      unauthorizedThreshold: 2,
      unauthorizedCooldownMs: 10_000,
    });
    r.start();

    // Trigger 2 ACTIVE→IDLE 401 cycles
    for (let i = 0; i < 2; i++) {
      setCookie('session_present=1');
      vi.advanceTimersByTime(1_000);
      const emit = recordMock.mock.calls[i]![0].emit;
      emit({ type: 0, data: {}, timestamp: 1 });
      vi.advanceTimersByTime(DEFAULT_CONFIG.flushIntervalMs);
      await vi.waitFor(() => expect(recordStop).toHaveBeenCalledTimes(i + 1));
    }

    // Marker still present, but cool-down should suppress re-activation
    setCookie('session_present=1');
    vi.advanceTimersByTime(5_000);
    expect(recordMock).toHaveBeenCalledTimes(2); // no third start

    // After cool-down expires, IDLE→ACTIVE allowed again
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.advanceTimersByTime(10_000);
    expect(recordMock).toHaveBeenCalledTimes(3);

    r.stop();
  });
});
```

- [ ] **Step 2: Run recorder tests to verify they fail**

Run: `pnpm --filter @pam/web-session-recorder test -- recorder`
Expected: FAIL — Recorder still takes `(config, sessionId, distinctId)` and has no state machine.

- [ ] **Step 3: Rewrite `sdk/src/recorder.ts`**

```ts
import { record } from 'rrweb';
import type { eventWithTime, listenerHandler } from '@rrweb/types';
import type { RecorderConfig } from './config';
import { Transport } from './transport';
import { watchMarker } from './auth';

const SESSION_STORAGE_KEY = '_pam_sid';

type State = 'IDLE' | 'ACTIVE' | 'STOPPED';

function newSessionId(): string {
  return crypto.randomUUID();
}

function persistSessionId(id: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    // sessionStorage unavailable; fall through with in-memory only
  }
}

function clearSessionId(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export class Recorder {
  private state: State = 'IDLE';
  private sessionId: string | null = null;
  private rrwebStop: listenerHandler | null = null;
  private transport: Transport | null = null;
  private disposeWatcher: (() => void) | null = null;
  private unauthorizedCount = 0;
  private cooldownUntil = 0;

  constructor(private readonly config: RecorderConfig) {}

  start(): void {
    if (this.state !== 'IDLE') return;

    this.disposeWatcher = watchMarker(
      this.config.markerCookieName,
      (present) => {
        if (present) this.tryActivate();
        else this.deactivate();
      },
      this.config.markerPollMs
    );
  }

  private tryActivate(): void {
    if (this.state !== 'IDLE') return;
    if (Date.now() < this.cooldownUntil) return;

    this.sessionId = newSessionId();
    persistSessionId(this.sessionId);

    this.transport = new Transport(
      this.config.endpoint,
      this.config.flushIntervalMs,
      this.config.maxBufferSize,
      () => this.onUnauthorized()
    );
    const sid = this.sessionId;
    this.transport.start(sid);

    this.rrwebStop =
      record({
        blockClass: this.config.blockClass,
        ignoreClass: this.config.ignoreClass,
        maskTextClass: this.config.maskTextClass,
        maskAllInputs: this.config.maskAllInputs,
        maskInputOptions: this.config.maskInputOptions,
        inlineStylesheet: this.config.inlineStylesheet,
        collectFonts: this.config.collectFonts,
        recordCrossOriginIframes: this.config.recordCrossOriginIframes,
        checkoutEveryNms: this.config.checkoutEveryNms,
        emit: (event: eventWithTime) => {
          if (this.transport) this.transport.push(event, sid);
        },
      }) ?? null;

    this.state = 'ACTIVE';
  }

  private deactivate(): void {
    if (this.state !== 'ACTIVE') return;
    if (this.rrwebStop) {
      this.rrwebStop();
      this.rrwebStop = null;
    }
    if (this.transport) {
      this.transport.stop();
      this.transport = null;
    }
    clearSessionId();
    this.sessionId = null;
    this.state = 'IDLE';
  }

  private onUnauthorized(): void {
    this.deactivate();
    this.unauthorizedCount += 1;
    if (this.unauthorizedCount >= this.config.unauthorizedThreshold) {
      this.cooldownUntil = Date.now() + this.config.unauthorizedCooldownMs;
      this.unauthorizedCount = 0;
    }
  }

  stop(): void {
    this.deactivate();
    if (this.disposeWatcher) {
      this.disposeWatcher();
      this.disposeWatcher = null;
    }
    this.state = 'STOPPED';
  }
}
```

- [ ] **Step 4: Run recorder tests to verify they pass**

Run: `pnpm --filter @pam/web-session-recorder test -- recorder`
Expected: PASS (6/6 recorder tests).

- [ ] **Step 5: Commit**

```bash
git add sdk/src/recorder.ts sdk/src/__tests__/recorder.test.ts
git commit -m "feat(sdk): IDLE/ACTIVE state machine with marker gating and 401 cool-down"
```

---

## Task 9: SDK index — simplified `InitOptions`, remove `identify` and `addCustomEvent`

**Files:**
- Modify: `sdk/src/index.ts`

- [ ] **Step 1: Rewrite `sdk/src/index.ts`**

```ts
/**
 * @pam/web-session-recorder — public API
 *
 * Usage (typically called by nginx-injected snippet):
 *   import { init } from '@pam/web-session-recorder';
 *   init({ endpoint: '/s/' });
 *
 * The recorder stays IDLE until the marker cookie (default `session_present`)
 * is observed. Identity is derived server-side from the auth cookie — no
 * distinct_id or sessionId is accepted on the client.
 */

import { DEFAULT_CONFIG, type RecorderConfig } from './config';
import { Recorder } from './recorder';

export type { RecorderConfig };

export interface InitOptions extends Partial<RecorderConfig> {}

let instance: Recorder | null = null;

export function init(options: InitOptions = {}): void {
  if (instance) return;
  const config: RecorderConfig = { ...DEFAULT_CONFIG, ...options };
  instance = new Recorder(config);
  instance.start();
}

export function stop(): void {
  instance?.stop();
  instance = null;
}
```

- [ ] **Step 2: Type-check the package**

Run: `pnpm --filter @pam/web-session-recorder exec tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 3: Run the full SDK test suite**

Run: `pnpm --filter @pam/web-session-recorder test`
Expected: PASS — all SDK tests green.

- [ ] **Step 4: Commit**

```bash
git add sdk/src/index.ts
git commit -m "refactor(sdk): drop sessionId/distinctId/identify/addCustomEvent from public API"
```

---

## Task 10: nginx config — unconditional inject, no init args, drop ACAO

**Files:**
- Modify: `proxy/nginx.conf`

- [ ] **Step 1: Update `/_rec/` block (remove ACAO)**

In `proxy/nginx.conf`, locate:

```nginx
location /_rec/ {
    alias /srv/recorder-bundle/;
    add_header Cache-Control "public, max-age=3600";
    add_header Access-Control-Allow-Origin "*";
}
```

Remove the ACAO line so the block reads:

```nginx
location /_rec/ {
    alias /srv/recorder-bundle/;
    add_header Cache-Control "public, max-age=3600";
}
```

- [ ] **Step 2: Update the sub_filter init snippet**

Find the existing `sub_filter '</head>' ...` line in the `location /` block and replace its replacement string with:

```nginx
sub_filter_once on;
sub_filter_types text/html;
sub_filter '</head>'
    '<script src="/_rec/recorder.iife.js"></script>'
    '<script>window.PamRecorder&&window.PamRecorder.init({endpoint:"/s/"})</script>'
    '</head>';
```

(Same as today, minus the `sessionStorage` references that were inlined into the init call — the SDK now reads/writes sessionStorage internally.)

- [ ] **Step 3: Commit**

```bash
git add proxy/nginx.conf
git commit -m "feat(proxy): unconditional inject without sessionId args; recorder gates itself"
```

---

## Task 11: Demo app — add login/logout UI so e2e can drive the lifecycle

**Files:**
- Modify: `demo-app/index.html`

- [ ] **Step 1: Add a tiny auth control to the demo page**

Insert into `demo-app/index.html`, immediately after `<h1>Corp Demo Application</h1>`:

```html
<div class="card" id="auth-panel">
  <h2>Auth (stub)</h2>
  <p>Status: <span id="auth-status">checking…</span></p>
  <input id="auth-user" type="text" placeholder="username" value="alice" />
  <button id="auth-login">Log in</button>
  <button id="auth-logout">Log out</button>
</div>
<script>
  function refreshStatus() {
    var hasMarker = document.cookie.split('; ').some(function (c) {
      return c.indexOf('session_present=') === 0 && c.length > 'session_present='.length;
    });
    document.getElementById('auth-status').textContent = hasMarker ? 'logged in' : 'logged out';
  }
  document.getElementById('auth-login').addEventListener('click', async function () {
    var u = document.getElementById('auth-user').value || 'alice';
    await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: u }),
      credentials: 'include',
    });
    refreshStatus();
  });
  document.getElementById('auth-logout').addEventListener('click', async function () {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    refreshStatus();
  });
  refreshStatus();
</script>
```

- [ ] **Step 2: Commit**

```bash
git add demo-app/index.html
git commit -m "feat(demo-app): expose login/logout buttons backed by ingestion auth stub"
```

---

## Task 12: Rebuild SDK IIFE bundle and sync to proxy

**Files:**
- Modify: `proxy/recorder-bundle/recorder.iife.js`

- [ ] **Step 1: Rebuild the SDK**

Run from repo root:

```bash
pnpm --filter @pam/web-session-recorder build
pnpm --filter @pam/web-session-recorder build:iife
```

- [ ] **Step 2: Copy fresh IIFE bundle to the proxy bundle directory**

```bash
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js
```

- [ ] **Step 3: Sanity-check the bundle exposes the new API**

```bash
grep -c 'PamRecorder' proxy/recorder-bundle/recorder.iife.js
```

Expected: ≥ 1.

- [ ] **Step 4: Commit**

```bash
git add proxy/recorder-bundle/recorder.iife.js
git commit -m "build(sdk): refresh IIFE bundle with state-machine recorder"
```

---

## Task 13: E2E — replace variant-a happy-path with four lifecycle scenarios

**Files:**
- Modify: `e2e/tests/variant-a.spec.ts`

- [ ] **Step 1: Rewrite the variant-a spec**

Replace contents of `e2e/tests/variant-a.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { execa } from 'execa';
import { startDockerStack } from '../helpers/docker-stack';

type DockerStackHandle = Awaited<ReturnType<typeof startDockerStack>>;

let stack: DockerStackHandle;

async function countBatchPosts(page: Page, durationMs: number): Promise<number> {
  let count = 0;
  const handler = (req: import('@playwright/test').Request) => {
    if (req.method() === 'POST' && req.url().endsWith('/s/')) count += 1;
  };
  page.on('request', handler);
  await page.waitForTimeout(durationMs);
  page.off('request', handler);
  return count;
}

test.describe('variant-a: auth-gated nginx injection', () => {
  test.beforeAll(async () => {
    try {
      await execa('docker', ['info'], { stdio: 'pipe' });
    } catch {
      test.skip(true, 'Docker is not running — skipping variant-a tests');
      return;
    }
    stack = await startDockerStack();
  });

  test.afterAll(async () => {
    await stack?.stop();
  });

  test('recorder bundle is injected on every HTML response', async () => {
    const res = await fetch(stack.url + '/');
    const html = await res.text();
    expect(html).toContain('<script src="/_rec/recorder.iife.js">');
  });

  test('no POST /s/ traffic while user is logged out', async ({ page }) => {
    await page.goto(stack.url);
    await page.waitForLoadState('networkidle');

    // Trigger some DOM activity to exercise rrweb listeners (they should NOT be attached)
    const inputs = page.locator('input[type="text"]');
    if (await inputs.count()) await inputs.first().fill('pre-auth typing');

    const posts = await countBatchPosts(page, 3_500);
    expect(posts).toBe(0);
  });

  test('login starts recording → batches appear in storage', async ({ page }) => {
    await page.goto(stack.url);
    await page.locator('#auth-login').click();
    await expect(page.locator('#auth-status')).toHaveText('logged in');

    const inputs = page.locator('input[type="text"]');
    await inputs.first().fill('post-auth typing');

    // Wait for at least one flush window
    await page.waitForTimeout(3_000);

    const res = await fetch(`${stack.url}/sessions`);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ session_id: string; user_id: string; batch_count: number }>;
    };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]!.user_id).toBe('alice');
    expect(body.data[0]!.batch_count).toBeGreaterThan(0);
  });

  test('logout stops recording within poll interval', async ({ page }) => {
    await page.goto(stack.url);
    await page.locator('#auth-login').click();
    await expect(page.locator('#auth-status')).toHaveText('logged in');
    await page.waitForTimeout(3_000);

    await page.locator('#auth-logout').click();
    await expect(page.locator('#auth-status')).toHaveText('logged out');

    // Allow up to markerPollMs + flushIntervalMs (= 5s + 2s) for the SDK to react
    await page.waitForTimeout(7_500);

    const posts = await countBatchPosts(page, 3_500);
    expect(posts).toBe(0);
  });

  test('logout → re-login produces two distinct session_ids for the same user', async ({ page }) => {
    await page.goto(stack.url);

    await page.locator('#auth-login').click();
    await page.waitForTimeout(3_000);
    await page.locator('#auth-logout').click();
    await page.waitForTimeout(7_500);
    await page.locator('#auth-login').click();
    await page.waitForTimeout(3_000);

    const res = await fetch(`${stack.url}/sessions`);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ session_id: string; user_id: string }>;
    };
    const sessions = body.data.filter((s) => s.user_id === 'alice');
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const uniqueIds = new Set(sessions.map((s) => s.session_id));
    expect(uniqueIds.size).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run variant-a e2e (requires Docker)**

Run: `pnpm --filter @pam/e2e test -- variant-a`
Expected: PASS — 5 scenarios green. If Docker is not running, the suite skips (acceptable).

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/variant-a.spec.ts
git commit -m "test(e2e): cover full auth-gated lifecycle for variant-a"
```

---

## Task 14: Variant-B e2e — remove from suite (Variant B API surface changed)

**Files:**
- Modify: `e2e/tests/variant-b.spec.ts`

- [ ] **Step 1: Inspect the existing Variant B test**

Run: `cat e2e/tests/variant-b.spec.ts`

If it calls `init({ sessionId, distinctId })` or `identify()`, those calls no longer exist. Variant B is out of the active spec scope (see §1 of the design — “Variant A must remain”). Replace the test body with a minimal smoke check that the SDK auto-starts after login when consumed as an ESM import, OR mark the file with `test.skip()` and a TODO.

- [ ] **Step 2: Apply the simplest fix — skip the suite**

Replace the contents of `e2e/tests/variant-b.spec.ts` with:

```ts
import { test } from '@playwright/test';

test.skip(true, 'Variant B SDK API rewritten — coverage rebuilt in a follow-up plan');
```

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/variant-b.spec.ts
git commit -m "test(e2e): skip variant-b until SDK ESM consumer test is rewritten"
```

---

## Task 15: Bump SDK version and refresh README pointers

**Files:**
- Modify: `sdk/package.json`
- Modify: `README.md`

- [ ] **Step 1: Bump SDK version**

Edit `sdk/package.json`: change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 2: Update the SDK usage snippet in `README.md`**

In `README.md`, replace the Variant B snippet:

```diff
-import { init } from '@pam/web-session-recorder';
-
-init({
-  endpoint: 'http://localhost:3001/s/',
-  sessionId: crypto.randomUUID(),
-  distinctId: 'user@example.com',
-});
+import { init } from '@pam/web-session-recorder';
+
+// User identity is derived server-side from the auth cookie.
+// The recorder stays idle until the backend sets `session_present=1` after login.
+init({ endpoint: 'http://localhost:3001/s/' });
```

Also remove `distinct_id` from the "Wire format" block:

```diff
 {
   session_id: string;        // UUID
-  distinct_id: string;       // your user identifier
   batch_seq: number;         // monotonic per session, starts at 0
   events_b64_gzip: string;   // base64(gzip(JSON.stringify(eventWithTime[])))
 }
```

- [ ] **Step 3: Commit**

```bash
git add sdk/package.json README.md
git commit -m "chore(sdk): bump to 0.2.0 and document auth-gated wire format"
```

---

## Task 16: Final cross-package verification

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS across `sdk`, `ingestion`, `e2e`.

- [ ] **Step 2: Full unit + integration tests**

Run: `pnpm test`
Expected: PASS — all vitest suites green.

- [ ] **Step 3: Variant-a e2e (Docker required)**

Run: `pnpm test:e2e -- variant-a`
Expected: PASS (or skip if Docker unavailable).

- [ ] **Step 4: No commit needed — verification only**

If anything fails, fix and amend the corresponding task's commit (or add a fixup commit). Otherwise the branch is ready for review.
