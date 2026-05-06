import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { EventBatch, SessionMeta } from './types';

function dataDir(): string {
  return process.env.PAM_DATA_DIR ?? path.resolve(__dirname, '../data');
}

function ensureDataDir(): void {
  if (!fs.existsSync(dataDir())) {
    fs.mkdirSync(dataDir(), { recursive: true });
  }
}

function sessionFile(sessionId: string): string {
  return path.join(dataDir(), `${sessionId}.jsonl`);
}

function metaFile(sessionId: string): string {
  return path.join(dataDir(), `${sessionId}.meta.json`);
}

export function appendBatch(batch: EventBatch): void {
  ensureDataDir();
  const line = JSON.stringify(batch) + '\n';
  fs.appendFileSync(sessionFile(batch.session_id), line, 'utf-8');

  // Upsert meta
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
      distinct_id: batch.distinct_id,
      started_at: now,
      last_batch_at: now,
      batch_count: 1,
    };
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

export function listSessions(): SessionMeta[] {
  ensureDataDir();
  return fs
    .readdirSync(dataDir())
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dataDir(), f), 'utf-8')) as SessionMeta)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function getSessionEvents(sessionId: string): unknown[] {
  const file = sessionFile(sessionId);
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const allEvents: unknown[] = [];

  for (const line of lines) {
    const batch = JSON.parse(line) as EventBatch;
    // Decode base64 → gzip buffer → JSON
    const gzipBuf = Buffer.from(batch.events_b64_gzip, 'base64');
    const json = zlib.gunzipSync(gzipBuf).toString('utf-8');
    const events = JSON.parse(json) as unknown[];
    allEvents.push(...events);
  }

  return allEvents;
}
