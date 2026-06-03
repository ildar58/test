import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { EventBatch, SessionMeta } from './types';

/** session_id выдаётся сервером как crypto.randomUUID() — строго проверяем форму. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

// PAM_DATA_DIR можно переопределить через env; иначе ../data рядом с пакетом.
function dataDir(): string {
  return process.env.PAM_DATA_DIR ?? path.resolve(__dirname, '../data');
}

function ensureDataDir(): void {
  const d = dataDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Строит путь внутри data/ и структурно гарантирует, что он не выходит за её
// пределы: невалидный id отвергается, а итоговый путь проверяется на containment.
function safeFile(sid: string, suffix: string): string {
  if (!isValidSessionId(sid)) throw new Error('invalid session id');
  const root = path.resolve(dataDir());
  const file = path.resolve(root, `${sid}${suffix}`);
  if (file !== path.join(root, `${sid}${suffix}`)) throw new Error('path traversal blocked');
  return file;
}

const sessionFile = (sid: string): string => safeFile(sid, '.jsonl');
const metaFile = (sid: string): string => safeFile(sid, '.meta.json');

export function appendBatch(batch: EventBatch, userId: string): void {
  ensureDataDir();
  fs.appendFileSync(sessionFile(batch.session_id), JSON.stringify(batch) + '\n', 'utf-8');

  const metaPath = metaFile(batch.session_id);
  const now = new Date().toISOString();
  let meta: SessionMeta;
  if (fs.existsSync(metaPath)) {
    meta = bumpMeta(readMeta(metaPath, batch.session_id, userId, now), now);
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

function readMeta(metaPath: string, sid: string, userId: string, now: string): SessionMeta {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta;
  } catch {
    // повреждённый meta — пересоздаём, чтобы запись не падала
    return { session_id: sid, user_id: userId, started_at: now, last_batch_at: now, batch_count: 0 };
  }
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
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dataDir(), f), 'utf-8')) as SessionMeta;
      } catch {
        return null;
      }
    })
    .filter((m): m is SessionMeta => m !== null)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function getSessionEvents(sessionId: string): unknown[] {
  if (!isValidSessionId(sessionId)) return [];
  const file = sessionFile(sessionId);
  if (!fs.existsSync(file)) return [];

  // Потолок на распакованный размер одного батча: сильно сжимаемый payload (напр.
  // нули) при ~11 МБ на входе раздулся бы в гигабайты, заморозив event loop и уронив
  // процесс по OOM. gunzipSync кидает RangeError при превышении — ловим построчно,
  // чтобы один битый/аномальный батч не ронял воспроизведение всей записи.
  const MAX_DECOMPRESSED = 64 * 1024 * 1024; // 64 MiB на батч
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const events: unknown[] = [];
  for (const line of lines) {
    try {
      const batch = JSON.parse(line) as EventBatch;
      const gzipped = Buffer.from(batch.events_b64_gzip, 'base64');
      const json = zlib.gunzipSync(gzipped, { maxOutputLength: MAX_DECOMPRESSED }).toString('utf-8');
      events.push(...(JSON.parse(json) as unknown[]));
    } catch (err: unknown) {
      console.error('[ingestion] skipping unreadable batch line in', sessionId, err);
    }
  }
  return events;
}
