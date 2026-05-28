# Viewing recorded sessions — design

**Date:** 2026-05-28
**Status:** Approved (autonomous)
**Scope:** Make it obvious where session data lives, fix the replayer UI in Docker, and add an opt-in CLI for exporting a session to video via rrvideo.

---

## 1. Problem

Three operational gaps make the recorder hard to use today:

1. **Storage is invisible.** In Docker the JSONL files live in a named volume (`ingestion-data`). Inspecting them needs `docker volume inspect` + `docker exec` or `docker cp` — undiscoverable from the repo.
2. **The replayer UI returns 404 in the Docker stack.** `ingestion/Dockerfile` copies only `src/` into the image, so `express.static(path.resolve(__dirname, '../../replayer'))` resolves to a non-existent path. Visiting `http://localhost:8081` or `http://localhost:8080/replay/` shows nothing.
3. **No way to export to a video format.** Stakeholders without rrweb tooling can't watch sessions. There's no MP4 / WebM artefact, only the raw event stream.

All three are needed for the recorder to be useful. They're closely linked: the video export uses the replayer page as its rendering surface, and the replayer needs visible storage to know what sessions exist.

## 2. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | Switch the ingestion Docker volume from a named volume to a **bind mount of `./ingestion/data`** | Sessions appear in the host filesystem immediately — `ls ingestion/data` from the repo root is the answer to "where are the recordings?". Persists across `docker compose down`, gitignored. |
| D2 | Mount the **`replayer/` directory into the ingestion container** via `proxy/docker-compose.yml`, not via a Dockerfile rebuild | The replayer is plain HTML — no build step — so a `:ro` bind-mount has no downside. Avoids Dockerfile churn and lets local replayer changes take effect with a container restart, not a rebuild. |
| D3 | Add a **CLI script `tools/video/`** as a new workspace package rather than a route in the ingestion service | Video export is heavyweight: pulls Playwright + rrvideo into the install. Keeping it as a separate workspace means the production ingestion image is unaffected. Devs run `pnpm video <session_id>` from the repo root. |
| D4 | The CLI reads `ingestion/data/<sid>.jsonl` directly off disk, decodes events, writes a temp JSON, invokes `rrvideo` CLI | No HTTP round-trip needed; `rrvideo` already knows how to consume a JSON events array. The replayer fix in D2 is for human viewers, not for the video pipeline. |
| D5 | Output format is whatever **`rrvideo` produces by default** (`.webm` via Playwright's `recordVideo`). No transcode step. | YAGNI. If a stakeholder needs MP4 they can ffmpeg-transcode later; the demo's job is to prove the pipeline works. |
| D6 | Use **`rrvideo@2.0.0-alpha.20`** (latest alpha, Feb 2026), which depends on `playwright` and `rrweb-player` — both compatible with the rest of the workspace. | Newest version; matches the rrweb 2.0.0-alpha generation we use. |

## 3. Component changes

### 3.1 Storage visibility — `proxy/docker-compose.yml`

Replace the named volume with a bind mount:

```diff
 ingestion:
   build:
     context: ../ingestion
     dockerfile: Dockerfile
   volumes:
-    - ingestion-data:/app/data
+    - ../ingestion/data:/app/data
   expose:
     - "3001"
   environment:
     PORT: "3001"
```

And drop the now-unused volume declaration:

```diff
-volumes:
-  ingestion-data:
```

Add `ingestion/data/` to `.gitignore` (currently only `dist`, `node_modules` are ignored at workspace level — verify).

### 3.2 Replayer in Docker — `proxy/docker-compose.yml`

Add a read-only mount for the replayer directory:

```diff
 ingestion:
   build:
     context: ../ingestion
     dockerfile: Dockerfile
   volumes:
     - ../ingestion/data:/app/data
+    - ../replayer:/app/replayer:ro
```

`server.ts` already resolves `path.resolve(__dirname, '../../replayer')`, which inside the container is `/app/replayer` (the binary runs from `/app/dist/server.js`). The mount makes that path exist.

### 3.3 Video export — new `tools/video/` workspace

New package `@pam/video` under `tools/video/`:

```
tools/video/
├── package.json          — name @pam/video, scripts.export
├── tsconfig.json
└── src/
    └── export.ts         — CLI entrypoint
```

`src/export.ts` does:

1. Read CLI arg: session id (UUID). Reject if missing or doesn't match UUID regex.
2. Compute path: `path.resolve(__dirname, '../../../ingestion/data', `${sid}.jsonl`)`. Error if missing.
3. Stream-read the JSONL line by line, parse each line as `EventBatch`, base64-decode + gunzip + JSON-parse the events, concatenate into a single ordered array.
4. Write the array to a temp file: `path.join(os.tmpdir(), `${sid}.events.json`)`.
5. Invoke `rrvideo`:
   - resolved binary: `node_modules/.bin/rrvideo`
   - args: `--input <temp> --output ingestion/data/<sid>.webm`
   - stream stdout/stderr to the parent's terminal
6. Clean up the temp file.
7. Print the absolute output path on success.

Wire into root `package.json`:

```diff
 "scripts": {
   "build": "pnpm -r build",
   "test": "...",
   "test:e2e": "...",
   "typecheck": "...",
   "dev:ingestion": "...",
   "dev:proxy": "...",
+  "video": "pnpm --filter @pam/video export --"
 }
```

So the user runs:

```bash
pnpm video <session_id>
# → ingestion/data/<session_id>.webm
```

### 3.4 Documentation

- Root [`README.md`](../../README.md): add a "Viewing recordings" section after "Quick start" with three subsections (filesystem / replayer UI / video export).
- [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md): remove the "Replayer UI returns 404" troubleshooting entry (no longer applies).
- [`docs/PRODUCTION.md`](../PRODUCTION.md): update the "Replayer not mounted in Docker" entry to "Fixed in this PR".

## 4. Wire / data contract

No changes to recorder wire format or backend API. This entire change is operational tooling around the existing data.

The CLI's only contract is with the on-disk `.jsonl` format, which is already stable (see [`ingestion/src/storage.ts`](../../ingestion/src/storage.ts)).

## 5. Testing

| Layer | What it covers |
|-------|----------------|
| Unit (vitest, in `tools/video/`) | `decodeJsonl(path)` returns a flat `eventWithTime[]` from a synthetic 2-batch JSONL fixture. Order matches `batch_seq` ascending. Gunzip + base64 round-trips a known event payload. UUID validation rejects malformed input. |
| Integration | Out of scope for vitest — the rrvideo CLI invocation requires a real Playwright browser and ~5 seconds per session, too heavy for the unit suite. The e2e test below provides the integration signal. |
| E2E (Playwright, opt-in via `RRVIDEO_E2E=1`) | Adds one variant-a scenario: drive the demo, generate a recording, run `pnpm video <sid>`, assert the `.webm` file exists and has non-zero size. Tagged `@slow`; default suite skips it. |
| Manual check | After fixing the Docker mounts, open `http://localhost:8081/`, pick a session id, verify the replayer plays it. Documented in `docs/DEVELOPMENT.md`. |

## 6. Out of scope

- Transcoding to MP4 / HLS / other formats.
- Streaming export (current rrvideo is one-shot only — fine for sessions up to a few minutes).
- Server-side `GET /sessions/:id/video` endpoint. Could be added later; for the study repo the CLI is sufficient and cheaper to keep working.
- Authentication on the replayer UI. The admin auth gap on `GET /sessions[/:id]` is tracked in `docs/PRODUCTION.md` and unchanged here.
- A web UI for browsing the recordings list. The plain `GET /sessions` JSON is enough for a study demo.
- The video CLI assumes one stack instance writing to `ingestion/data/`. Multi-instance / distributed storage is a production concern (see PRODUCTION.md).

## 7. Risk + rollback

- The bind-mount change for storage **loses data in the existing named volume**. The Docker volume `ingestion-data` is left behind on disk; users can manually `docker volume rm proxy_ingestion-data` after migrating any sessions they care about. The migration command is one `docker cp` and is documented in the changelog of this commit.
- `rrvideo` 2.0.0-alpha is pre-1.0. If it breaks against our event stream, the CLI script is isolated to `tools/video/` and adds no required deps elsewhere — disabling is `rm -rf tools/video && remove the workspaces entry`.
