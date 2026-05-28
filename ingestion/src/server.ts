import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import type { EventBatch } from './types';
import { appendBatch, listSessions, getSessionEvents } from './storage';
import {
  verifyPassword,
  createSession,
  getSession,
  destroySession,
} from './auth';

const app = express();
const PORT = process.env.PORT ?? 3001;

// CSRF posture for this stub relies on (a) the nginx proxy serving recorder,
// app, and ingestion same-origin in production, and (b) SameSite=Lax on the
// session cookies. CORS is enabled with credentials only to support local
// dev where the demo HTML may be opened from a non-proxied origin; the real
// Go service should pin `origin` to the known list of allowed front-ends.
app.use(cors({ credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// Resolve the replayer directory across both dev (tsx → __dirname=ingestion/src,
// real replayer at repo-root/replayer = '../../replayer') and the compiled
// Docker image (node → __dirname=/app/dist, replayer bind-mounted at
// /app/replayer = '../replayer'). Try the dev-correct path FIRST so an
// accidentally-created ingestion/replayer/ dir can't silently shadow it.
const replayerDir = [
  path.resolve(__dirname, '../../replayer'),
  path.resolve(__dirname, '../replayer'),
].find((p) => fs.existsSync(p));
if (replayerDir) {
  app.use('/replay', express.static(replayerDir));
}

/**
 * Demo auth backend.
 * Real auth lives in the Go service; this is just enough to drive the
 * recorder lifecycle locally and in E2E with a real-looking flow.
 */
app.post('/auth/login', async (req: Request, res: Response) => {
  const user = (req.body?.user as string | undefined) ?? '';
  const password = (req.body?.password as string | undefined) ?? '';

  const ok = await verifyPassword(user, password);
  if (!ok) {
    res.status(401).json({ success: false, error: 'invalid credentials' });
    return;
  }

  const token = createSession(user);
  // TODO(prod): set `secure: true` on both cookies once nginx terminates HTTPS.
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.cookie('session_present', '1', { httpOnly: false, sameSite: 'lax', path: '/' });
  res.json({ success: true, user });
});

app.post('/auth/logout', (req: Request, res: Response) => {
  destroySession(req.cookies?.session as string | undefined);
  // TODO(prod): set `secure: true` on both cookies once nginx terminates HTTPS.
  res.cookie('session', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  res.cookie('session_present', '', { httpOnly: false, sameSite: 'lax', path: '/', maxAge: 0 });
  res.json({ success: true });
});

app.post('/s/', (req: Request, res: Response) => {
  const entry = getSession(req.cookies?.session as string | undefined);
  if (!entry) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }

  const batch = req.body as EventBatch;
  if (!batch?.session_id || !batch.events_b64_gzip || typeof batch.batch_seq !== 'number') {
    res.status(400).json({ success: false, error: 'Missing required fields' });
    return;
  }

  try {
    appendBatch(batch, entry.username);
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
    console.log(`Replayer UI:  http://localhost:${PORT}/replay`);
  });
}

export default app;
