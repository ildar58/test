# Viewing recorded sessions — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session storage discoverable from the host filesystem, fix the replayer UI in the Docker stack, and ship a CLI for exporting a session to video via rrvideo.

**Architecture:** Bind-mount `ingestion/data` and `replayer/` from the host. New `tools/video/` workspace with a TypeScript CLI that decodes the on-disk JSONL, writes a temp events JSON, and spawns the `rrvideo` binary.

**Tech Stack:** TypeScript, pnpm workspaces, Docker Compose, `rrvideo@2.0.0-alpha.20`, Playwright (pulled in transitively by rrvideo), vitest.

**Spec:** `docs/superpowers/specs/2026-05-28-view-recordings-design.md`

---

## File map

### Modify
- `proxy/docker-compose.yml` — switch to bind-mounts for `ingestion/data` and `replayer/`
- `.gitignore` (repo root) — add `ingestion/data/`
- `pnpm-workspace.yaml` — add `tools/video`
- `package.json` (root) — add `"video"` script
- `README.md` — new "Viewing recordings" section
- `docs/DEVELOPMENT.md` — drop the replayer-404 troubleshooting entry
- `docs/PRODUCTION.md` — flip the replayer-mount entry to "Fixed"

### Create
- `tools/video/package.json`
- `tools/video/tsconfig.json`
- `tools/video/src/decode.ts` — JSONL → events array helper, unit-tested
- `tools/video/src/export.ts` — CLI entrypoint
- `tools/video/src/__tests__/decode.test.ts`

---

## Task 1 — Storage bind-mount

**Files:** `proxy/docker-compose.yml`, `.gitignore`

- [ ] **Step 1: Update docker-compose to bind-mount the data directory**

Edit `proxy/docker-compose.yml`. Replace the ingestion `volumes:` block and remove the top-level `volumes:` declaration:

```yaml
  ingestion:
    build:
      context: ../ingestion
      dockerfile: Dockerfile
    volumes:
      - ../ingestion/data:/app/data
    expose:
      - "3001"
    environment:
      PORT: "3001"

# (remove the bottom-of-file)
# volumes:
#   ingestion-data:
```

- [ ] **Step 2: Ensure host data directory exists**

```bash
mkdir -p ingestion/data
```

- [ ] **Step 3: Update .gitignore**

Append to repo-root `.gitignore` (create if absent — currently each workspace has its own):

```
# Recorded sessions land here when the Docker stack is running.
ingestion/data/
```

If `.gitignore` already has `ingestion/data/`-ish entry, no-op.

- [ ] **Step 4: Verify nothing is staged from data/**

```bash
git status --short ingestion/data
```

Expected: empty output.

- [ ] **Step 5: Commit**

```bash
git add proxy/docker-compose.yml .gitignore
git commit -m "feat(proxy): bind-mount ingestion/data so sessions appear on the host filesystem"
```

---

## Task 2 — Replayer bind-mount

**Files:** `proxy/docker-compose.yml`

- [ ] **Step 1: Add a second bind-mount for the replayer directory**

In `proxy/docker-compose.yml`, extend the ingestion `volumes:` list:

```yaml
  ingestion:
    build:
      context: ../ingestion
      dockerfile: Dockerfile
    volumes:
      - ../ingestion/data:/app/data
      - ../replayer:/app/replayer:ro
    expose:
      - "3001"
    environment:
      PORT: "3001"
```

- [ ] **Step 2: Bring the stack up and verify the replayer route**

```bash
docker compose -f proxy/docker-compose.yml up -d --build
until curl -sf http://localhost:8080/ >/dev/null; do sleep 1; done
curl -sI http://localhost:8081/ | head -3
```

Expected: `HTTP/1.1 200 OK`, served from the replayer page. (Was 404 before this task.)

Then tear down:

```bash
docker compose -f proxy/docker-compose.yml down
```

- [ ] **Step 3: Commit**

```bash
git add proxy/docker-compose.yml
git commit -m "fix(proxy): bind-mount replayer/ so the Docker stack serves /replay"
```

---

## Task 3 — Scaffold tools/video workspace

**Files:** new `tools/video/package.json`, `tools/video/tsconfig.json`, `pnpm-workspace.yaml`

- [ ] **Step 1: Register the new workspace**

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - sdk
  - ingestion
  - e2e
  - tools/video
allowBuilds:
  esbuild: false
```

- [ ] **Step 2: Create the package**

Create `tools/video/package.json`:

```json
{
  "name": "@pam/video",
  "version": "0.1.0",
  "private": true,
  "description": "CLI for exporting a recorded session to a video file via rrvideo",
  "type": "commonjs",
  "scripts": {
    "export": "tsx src/export.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  },
  "dependencies": {
    "rrvideo": "2.0.0-alpha.20"
  }
}
```

Create `tools/video/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install — rrvideo pulls Playwright**

From repo root:

```bash
pnpm install
```

Expected: pnpm picks up the new workspace, installs `rrvideo` + transitive `playwright` (the workspace's existing `@playwright/test` is unaffected). No errors.

- [ ] **Step 4: Commit**

```bash
git add pnpm-workspace.yaml tools/video/package.json tools/video/tsconfig.json pnpm-lock.yaml
git commit -m "chore(tools/video): scaffold @pam/video workspace with rrvideo dep"
```

---

## Task 4 — JSONL decoder + unit tests

**Files:** new `tools/video/src/decode.ts`, `tools/video/src/__tests__/decode.test.ts`

- [ ] **Step 1: Write failing tests at `tools/video/src/__tests__/decode.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { decodeJsonl, isValidSessionId } from '../decode';

let tmpDir: string;

function writeBatch(file: string, sessionId: string, batchSeq: number, events: unknown[]): void {
  const events_b64_gzip = zlib.gzipSync(Buffer.from(JSON.stringify(events), 'utf-8')).toString('base64');
  const batch = { session_id: sessionId, batch_seq: batchSeq, events_b64_gzip };
  fs.appendFileSync(file, JSON.stringify(batch) + '\n', 'utf-8');
}

describe('decodeJsonl', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-video-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('decodes a single-batch JSONL into a flat events array', () => {
    const file = path.join(tmpDir, 's.jsonl');
    const events = [
      { type: 0, data: { href: 'http://x' }, timestamp: 1 },
      { type: 2, data: { node: { id: 1 } }, timestamp: 2 },
    ];
    writeBatch(file, 's', 1, events);

    expect(decodeJsonl(file)).toEqual(events);
  });

  it('concatenates multiple batches preserving batch_seq order', () => {
    const file = path.join(tmpDir, 's.jsonl');
    writeBatch(file, 's', 1, [{ id: 1 }, { id: 2 }]);
    writeBatch(file, 's', 2, [{ id: 3 }]);
    writeBatch(file, 's', 3, [{ id: 4 }, { id: 5 }]);

    expect(decodeJsonl(file)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
  });

  it('reorders batches if the file was written out of order', () => {
    const file = path.join(tmpDir, 's.jsonl');
    writeBatch(file, 's', 2, [{ id: 'second' }]);
    writeBatch(file, 's', 1, [{ id: 'first' }]);

    expect(decodeJsonl(file)).toEqual([{ id: 'first' }, { id: 'second' }]);
  });

  it('throws a clear error when the file is missing', () => {
    expect(() => decodeJsonl(path.join(tmpDir, 'missing.jsonl'))).toThrow(/not found/i);
  });

  it('throws when a line is malformed', () => {
    const file = path.join(tmpDir, 's.jsonl');
    fs.writeFileSync(file, 'not-json\n', 'utf-8');
    expect(() => decodeJsonl(file)).toThrow();
  });
});

describe('isValidSessionId', () => {
  it('accepts a canonical UUID', () => {
    expect(isValidSessionId('8d551208-2474-4bf7-8b36-f375e09b2fd2')).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidSessionId('../etc/passwd')).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
  });

  it('rejects empty and undefined-ish strings', () => {
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('undefined')).toBe(false);
  });

  it('rejects uppercase hex (canonicalisation matters)', () => {
    expect(isValidSessionId('8D551208-2474-4BF7-8B36-F375E09B2FD2')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @pam/video test
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `tools/video/src/decode.ts`**

```ts
import fs from 'fs';
import zlib from 'zlib';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

interface RawBatch {
  session_id: string;
  batch_seq: number;
  events_b64_gzip: string;
}

/**
 * Reads a recording's on-disk JSONL, decodes every batch, and returns a flat
 * events array ordered by batch_seq. Throws on a missing file or any malformed
 * line — neither is recoverable for the video pipeline.
 */
export function decodeJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const batches: RawBatch[] = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as RawBatch;
      } catch (cause) {
        throw new Error(
          `Malformed batch on line ${i + 1} of ${filePath}: ${(cause as Error).message}`
        );
      }
    });

  batches.sort((a, b) => a.batch_seq - b.batch_seq);

  const events: unknown[] = [];
  for (const batch of batches) {
    const gzipped = Buffer.from(batch.events_b64_gzip, 'base64');
    const json = zlib.gunzipSync(gzipped).toString('utf-8');
    events.push(...(JSON.parse(json) as unknown[]));
  }
  return events;
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm --filter @pam/video test
```

Expected: PASS — 9/9 (5 decodeJsonl + 4 isValidSessionId).

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @pam/video typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add tools/video/src/decode.ts tools/video/src/__tests__/decode.test.ts
git commit -m "feat(tools/video): JSONL decoder + UUID validator"
```

---

## Task 5 — Video export CLI

**Files:** new `tools/video/src/export.ts`

- [ ] **Step 1: Implement `tools/video/src/export.ts`**

```ts
#!/usr/bin/env node
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decodeJsonl, isValidSessionId } from './decode';

function fail(msg: string): never {
  console.error(`[video] ${msg}`);
  process.exit(1);
}

function main(): void {
  const sid = process.argv[2];
  if (!sid) fail('Usage: pnpm video <session_id>');
  if (!isValidSessionId(sid)) fail(`Not a valid UUID session id: ${sid}`);

  const dataDir = path.resolve(__dirname, '../../../ingestion/data');
  const jsonlPath = path.join(dataDir, `${sid}.jsonl`);
  if (!fs.existsSync(jsonlPath)) {
    fail(
      `Session not found: ${jsonlPath}\n` +
        `Hint: run pnpm dev:proxy, log in, interact with the demo, then check ingestion/data/.`
    );
  }

  console.log(`[video] decoding ${jsonlPath}…`);
  const events = decodeJsonl(jsonlPath);
  console.log(`[video] ${events.length} events to render`);

  const tmpEvents = path.join(os.tmpdir(), `${sid}.events.json`);
  fs.writeFileSync(tmpEvents, JSON.stringify(events), 'utf-8');

  const outPath = path.join(dataDir, `${sid}.webm`);
  console.log(`[video] running rrvideo → ${outPath}`);

  const rrvideoBin = path.resolve(__dirname, '../node_modules/.bin/rrvideo');
  const result = spawnSync(rrvideoBin, ['--input', tmpEvents, '--output', outPath], {
    stdio: 'inherit',
  });

  // Best-effort cleanup whether rrvideo succeeded or failed.
  try {
    fs.unlinkSync(tmpEvents);
  } catch {
    /* ignore */
  }

  if (result.status !== 0) {
    fail(`rrvideo exited with code ${result.status}`);
  }

  console.log(`[video] done → ${outPath}`);
}

main();
```

- [ ] **Step 2: Wire root script**

Edit repo-root `package.json`. Append to the `"scripts"` object:

```json
"video": "pnpm --filter @pam/video export --"
```

The trailing `--` is the pnpm convention for passing positional args through to the underlying script. Users run `pnpm video <session_id>`.

- [ ] **Step 3: Smoke test with an existing recording**

If `ingestion/data/` contains a recording from a previous session, run:

```bash
pnpm video <existing-uuid>
```

Expected: a `.webm` file appears next to the `.jsonl`. If `ingestion/data/` is empty (first time), generate a recording first via the Docker stack:

```bash
docker compose -f proxy/docker-compose.yml up -d --build
# open http://localhost:8080, log in as alice/alice, click around
docker compose -f proxy/docker-compose.yml down
ls ingestion/data/*.jsonl
pnpm video <uuid-from-ls>
ls ingestion/data/*.webm
```

If rrvideo fails because Playwright wants to download a browser, set `CHROME_EXECUTABLE` to the existing binary or run `pnpm --filter @pam/video exec playwright install chromium` once.

- [ ] **Step 4: Commit**

```bash
git add tools/video/src/export.ts package.json
git commit -m "feat(tools/video): export CLI — pnpm video <sid> → .webm"
```

---

## Task 6 — Documentation

**Files:** `README.md`, `docs/DEVELOPMENT.md`, `docs/PRODUCTION.md`

- [ ] **Step 1: Add "Viewing recordings" section to root README**

In `README.md`, insert a new H2 between "Quick start" and "Repository layout":

```markdown
## Viewing recordings

After interacting with the demo as a logged-in user, recordings land in
`ingestion/data/` on the host filesystem (one `<sid>.jsonl` + one
`<sid>.meta.json` per session). Three ways to inspect them:

```bash
# 1. List sessions via the HTTP API
curl http://localhost:8080/sessions | jq

# 2. Play a session in the in-browser replayer
open http://localhost:8081
# (pick a session_id, paste it in the input)

# 3. Export a session to a .webm video file
pnpm video <session_id>
# → ingestion/data/<session_id>.webm
```

The video export uses [`rrvideo`](https://www.npmjs.com/package/rrvideo)
under the hood (Playwright-based rendering, no external ffmpeg). First
run downloads ~200 MB of Chromium; subsequent runs are seconds.
```

(Use the exact backticks shown.)

- [ ] **Step 2: Drop the stale troubleshooting entry from DEVELOPMENT.md**

In `docs/DEVELOPMENT.md`, find the "Replayer UI returns 404" entry and delete it (subsection + heading). The replayer works now.

- [ ] **Step 3: Flip the known-limitation in PRODUCTION.md**

In `docs/PRODUCTION.md`, find the "Replayer not mounted in Docker" subsection. Replace its body with:

```markdown
### Replayer mounted (fixed)

The replayer is now bind-mounted from `replayer/` into the ingestion
container via `proxy/docker-compose.yml`. The route is reachable at
`http://localhost:8081/` in the local stack. The auth gap on
`GET /sessions[/:id]` is still tracked above.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/DEVELOPMENT.md docs/PRODUCTION.md
git commit -m "docs: viewing-recordings section + drop the resolved replayer-404 notes"
```

---

## Task 7 — Cross-package verification

- [ ] **Step 1: Typecheck**

```bash
pnpm typecheck
```

Expected: clean across **5** workspaces (sdk, ingestion, e2e, tools/video, root).

- [ ] **Step 2: Unit + integration tests**

```bash
pnpm test
```

Expected: still 33 SDK + 21 ingestion = 54 tests. The new `@pam/video` tests are not part of the root `test` script unless we explicitly add them — verify the root `package.json` `"test"` script. If desired, extend it to include `@pam/video`; otherwise the package's `pnpm --filter @pam/video test` is the only way to run them.

- [ ] **Step 3: Smoke the full stack one more time**

```bash
docker compose -f proxy/docker-compose.yml up -d --build
until curl -sf http://localhost:8080/ >/dev/null; do sleep 1; done
curl -sI http://localhost:8081/ | head -3  # 200, not 404
docker compose -f proxy/docker-compose.yml down
ls -la ingestion/data/  # confirm the host directory is populated and readable
```

- [ ] **Step 4: No commit (verification only)**

If anything fails, fix in a follow-up commit or revisit the corresponding task.
