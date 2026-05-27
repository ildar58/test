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
