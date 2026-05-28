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
  // pnpm passes the `--` separator through to the inner script when the root
  // wrapper is `pnpm --filter @pam/video export --`. Drop it here so the user
  // can run `pnpm video <sid>` from the repo root naturally.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const sid = args[0];
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
