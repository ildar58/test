import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { EventBatch, SessionMeta } from './types';

// вызывается каждый раз, чтобы тесты могли подменять PAM_DATA_DIR через beforeEach
function dataDir(): string {
  return process.env.PAM_DATA_DIR ?? path.resolve(__dirname, '../data');
}

function inDataDir(name: string): string {
  return path.join(dataDir(), name);
}

function ensureDataDir(): void {
  const d = dataDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const sessionFile = (sid: string): string => inDataDir(`${sid}.jsonl`);
const metaFile    = (sid: string): string => inDataDir(`${sid}.meta.json`);

export function appendBatch(batch: EventBatch, userId: string): void {
  ensureDataDir();
  fs.appendFileSync(sessionFile(batch.session_id), JSON.stringify(batch) + '\n', 'utf-8');

  const metaPath = metaFile(batch.session_id);
  const now = new Date().toISOString();
  const meta: SessionMeta = fs.existsSync(metaPath)
    ? bumpMeta(JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta, now)
    : {
        session_id: batch.session_id,
        user_id: userId,
        started_at: now,
        last_batch_at: now,
        batch_count: 1,
      };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

function bumpMeta(meta: SessionMeta, now: string): SessionMeta {
  meta.last_batch_at = now;
  meta.batch_count += 1;
  return meta;
}

export function listSessions(): SessionMeta[] {
  ensureDataDir();
  return fs
    .readdirSync(dataDir())
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => JSON.parse(fs.readFileSync(inDataDir(f), 'utf-8')) as SessionMeta)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function getSessionEvents(sessionId: string): unknown[] {
  const file = sessionFile(sessionId);
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const events: unknown[] = [];
  for (const line of lines) {
    const batch = JSON.parse(line) as EventBatch;
    const gzipped = Buffer.from(batch.events_b64_gzip, 'base64');
    const json = zlib.gunzipSync(gzipped).toString('utf-8');
    events.push(...(JSON.parse(json) as unknown[]));
  }
  return events;
}
