import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import type { Request, Response, CookieOptions } from 'express';
import type { EventBatch } from './types';
import { appendBatch, listSessions, getSessionEvents } from './storage';
import {
  verifyPassword,
  createSession,
  getSession,
  destroySession,
} from './auth';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const MAX_BATCH_BYTES = '10mb';

// CSRF posture for this stub relies on (a) the nginx proxy serving recorder,
// app, and ingestion same-origin in production, and (b) SameSite=Lax on the
// session cookies. CORS is enabled with credentials only to support local
// dev where the demo HTML may be opened from a non-proxied origin; the real
// Go service should pin `origin` to the known list of allowed front-ends.
app.use(cors({ credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: MAX_BATCH_BYTES }));

// TODO(prod): set `secure: true` on both cookies once nginx terminates HTTPS.
const SESSION_COOKIE: CookieOptions = { httpOnly: true,  sameSite: 'lax', path: '/' };
const MARKER_COOKIE:  CookieOptions = { httpOnly: false, sameSite: 'lax', path: '/' };

/**
 * Locate the replayer directory across both layouts:
 *   - dev: tsx → __dirname=ingestion/src, replayer at <repo>/replayer
 *   - docker: node → __dirname=/app/dist, replayer bind-mounted at /app/replayer
 * The dev-correct path is tried FIRST so an accidentally-created
 * ingestion/replayer/ directory can't silently shadow the real one.
 */
function findReplayerDir(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../replayer'),
    path.resolve(__dirname, '../replayer'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const replayerDir = findReplayerDir();
if (replayerDir) app.use('/replay', express.static(replayerDir));

/** Best-effort string extractor for untrusted JSON bodies. */
function pickString(body: unknown, key: string): string {
  const v = (body as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Demo auth backend.
 * Real auth lives in the Go service; this is just enough to drive the
 * recorder lifecycle locally and in E2E with a real-looking flow.
 */
app.post('/auth/login', async (req: Request, res: Response) => {
  const user = pickString(req.body, 'user');
  const password = pickString(req.body, 'password');

  if (!(await verifyPassword(user, password))) {
    res.status(401).json({ success: false, error: 'invalid credentials' });
    return;
  }

  const { token, sessionId } = createSession(user);
  res.cookie('session',         token,     SESSION_COOKIE);
  res.cookie('session_present', '1',       MARKER_COOKIE);
  res.cookie('session_id',      sessionId, MARKER_COOKIE);
  res.json({ success: true, user });
});

app.post('/auth/logout', (req: Request, res: Response) => {
  destroySession(req.cookies?.session as string | undefined);
  res.cookie('session',         '', { ...SESSION_COOKIE, maxAge: 0 });
  res.cookie('session_present', '', { ...MARKER_COOKIE,  maxAge: 0 });
  res.cookie('session_id',      '', { ...MARKER_COOKIE,  maxAge: 0 });
  res.json({ success: true });
});

function isValidBatch(b: unknown): b is EventBatch {
  const o = b as EventBatch | null;
  return !!o && typeof o.session_id === 'string'
    && typeof o.events_b64_gzip === 'string'
    && typeof o.batch_seq === 'number';
}

app.post('/s/', (req: Request, res: Response) => {
  const entry = getSession(req.cookies?.session as string | undefined);
  if (!entry) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }

  if (!isValidBatch(req.body)) {
    res.status(400).json({ success: false, error: 'Missing required fields' });
    return;
  }

  // The session_id is JS-readable (non-HttpOnly), so it could be forged. It is
  // NOT the auth key — the HttpOnly session token above is. Here we only assert
  // the client is writing under the id we actually minted for this session.
  if (req.body.session_id !== entry.sessionId) {
    res.status(403).json({ success: false, error: 'session_id mismatch' });
    return;
  }

  try {
    appendBatch(req.body, entry.username);
    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
});

app.get('/sessions', (_req: Request, res: Response) => {
  res.json({ success: true, data: listSessions() });
});

app.get('/sessions/:id', (req: Request, res: Response) => {
  const events = getSessionEvents(req.params.id);
  if (events.length === 0) {
    res.status(404).json({ success: false, error: 'Session not found or empty' });
    return;
  }
  res.json({ success: true, data: events });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ingestion service listening on http://localhost:${PORT}`);
    console.log(`Replayer UI:                   http://localhost:${PORT}/replay`);
  });
}

export default app;
