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

  it('POST /auth/login returns 401 with no body', async () => {
    const { default: app } = await import('../server');
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'invalid credentials' });
  });

  it('POST /auth/login returns 401 for an unknown user', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/auth/login')
      .send({ user: 'mallory', password: 'mallory' });
    expect(res.status).toBe(401);
  });

  it('POST /auth/login returns 401 for a known user with the wrong password', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/auth/login')
      .send({ user: 'alice', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('POST /auth/login with valid credentials sets a hex token in session cookie + session_present', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/auth/login')
      .send({ user: 'alice', password: 'alice' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, user: 'alice' });

    const setCookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const sessionCookie = setCookies.find((c) => c.startsWith('session='));
    expect(sessionCookie).toBeDefined();
    expect(/^session=([0-9a-f]{64});/.test(sessionCookie!)).toBe(true);
    expect(/HttpOnly/i.test(sessionCookie!)).toBe(true);

    expect(
      setCookies.some(
        (c) => /^session_present=1;/.test(c) && !/HttpOnly/i.test(c)
      )
    ).toBe(true);
  });

  it('POST /s/ returns 401 when no session cookie is present', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/s/')
      .send({ session_id: 'sA', batch_seq: 1, events_b64_gzip: gzipB64([{ x: 1 }]) });
    expect(res.status).toBe(401);
  });

  it('POST /s/ returns 401 for a token that is not in the session store', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/s/')
      .set('Cookie', 'session=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
      .send({ session_id: 'sA', batch_seq: 1, events_b64_gzip: gzipB64([{ x: 1 }]) });
    expect(res.status).toBe(401);
  });

  it('POST /s/ stores batch under the minted session_id, tagged with username', async () => {
    const { default: app } = await import('../server');
    const agent = request.agent(app);

    const login = await agent.post('/auth/login').send({ user: 'alice', password: 'alice' });
    const sid = /session_id=([0-9a-f-]{36})/.exec(
      ([] as string[]).concat(login.headers['set-cookie'] ?? []).join(';')
    )?.[1];
    expect(sid).toBeTruthy();

    const ingest = await agent
      .post('/s/')
      .send({ session_id: sid, batch_seq: 1, events_b64_gzip: gzipB64([{ x: 1 }]) });
    expect(ingest.status).toBe(200);

    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, `${sid}.meta.json`), 'utf-8'));
    expect(meta.user_id).toBe('alice');
  });

  it('POST /s/ returns 403 when body.session_id != the minted session_id', async () => {
    const { default: app } = await import('../server');
    const agent = request.agent(app);
    await agent.post('/auth/login').send({ user: 'alice', password: 'alice' });

    const res = await agent
      .post('/s/')
      .send({ session_id: 'forged-id', batch_seq: 1, events_b64_gzip: gzipB64([{ x: 1 }]) });
    expect(res.status).toBe(403);
  });

  it('POST /auth/logout invalidates the session and clears both cookies', async () => {
    const { default: app } = await import('../server');
    const agent = request.agent(app);

    await agent.post('/auth/login').send({ user: 'alice', password: 'alice' });

    const logout = await agent.post('/auth/logout');
    expect(logout.status).toBe(200);
    const setCookies = ([] as string[]).concat(logout.headers['set-cookie'] ?? []);
    expect(setCookies.some((c) => /^session=;/.test(c) && /Max-Age=0/.test(c))).toBe(true);
    expect(setCookies.some((c) => /^session_present=;/.test(c) && /Max-Age=0/.test(c))).toBe(true);

    // токен инвалидирован, запрос должен вернуть 401
    const ingest = await agent
      .post('/s/')
      .send({ session_id: 'sB', batch_seq: 1, events_b64_gzip: gzipB64([{ x: 1 }]) });
    expect(ingest.status).toBe(401);
  });

  it('POST /s/ returns 400 for malformed batch with valid session', async () => {
    const { default: app } = await import('../server');
    const agent = request.agent(app);
    await agent.post('/auth/login').send({ user: 'alice', password: 'alice' });

    const res = await agent.post('/s/').send({ session_id: 'sA' });
    expect(res.status).toBe(400);
  });

  it('POST /auth/login sets a non-HttpOnly session_id cookie (uuid)', async () => {
    const { default: app } = await import('../server');
    const res = await request(app)
      .post('/auth/login')
      .send({ user: 'alice', password: 'alice' });
    expect(res.status).toBe(200);

    const setCookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const sid = setCookies.find((c) => c.startsWith('session_id='));
    expect(sid).toBeDefined();
    expect(/^session_id=[0-9a-f-]{36};/.test(sid!)).toBe(true);
    expect(/HttpOnly/i.test(sid!)).toBe(false);
  });

  it('POST /auth/logout clears the session_id cookie', async () => {
    const { default: app } = await import('../server');
    const agent = request.agent(app);
    await agent.post('/auth/login').send({ user: 'alice', password: 'alice' });

    const logout = await agent.post('/auth/logout');
    const setCookies = ([] as string[]).concat(logout.headers['set-cookie'] ?? []);
    expect(setCookies.some((c) => /^session_id=;/.test(c) && /Max-Age=0/.test(c))).toBe(true);
  });
});
