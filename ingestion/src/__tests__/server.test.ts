import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

let tmpDir: string;

function gzipB64(events: unknown[]): string {
  const json = JSON.stringify(events);
  return zlib.gzipSync(Buffer.from(json, 'utf-8')).toString('base64');
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

  it('POST /s/ accepts a valid batch and returns 200', async () => {
    const { default: app } = await import('../server');
    const batch = {
      session_id: 'sess-A',
      distinct_id: 'user-A',
      batch_seq: 1,
      events_b64_gzip: gzipB64([{ type: 0, ts: 1 }]),
    };

    const res = await request(app).post('/s/').send(batch);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(fs.existsSync(path.join(tmpDir, 'sess-A.jsonl'))).toBe(true);
  });

  it('POST /s/ returns 400 for batch missing required fields', async () => {
    const { default: app } = await import('../server');
    const res = await request(app).post('/s/').send({ session_id: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
