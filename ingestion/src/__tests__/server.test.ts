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
