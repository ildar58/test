import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import type { Request, Response } from 'express';
import type { EventBatch } from './types';
import { appendBatch, listSessions, getSessionEvents } from './storage';

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors({ credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

app.use('/replay', express.static(path.resolve(__dirname, '../../replayer')));

/**
 * Stub Go auth contract.
 * Real auth lives in the Go service; this is just enough to exercise the
 * recorder lifecycle locally and in E2E.
 */
app.post('/auth/login', (req: Request, res: Response) => {
  const user = (req.body?.user as string | undefined) ?? 'anonymous';
  res.cookie('session', user, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.cookie('session_present', '1', { httpOnly: false, sameSite: 'lax', path: '/' });
  res.json({ success: true, user });
});

app.post('/auth/logout', (_req: Request, res: Response) => {
  res.cookie('session', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  res.cookie('session_present', '', { httpOnly: false, sameSite: 'lax', path: '/', maxAge: 0 });
  res.json({ success: true });
});

app.post('/s/', (req: Request, res: Response) => {
  const userId = req.cookies?.session as string | undefined;
  if (!userId) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }

  const batch = req.body as EventBatch;
  if (!batch?.session_id || !batch.events_b64_gzip || typeof batch.batch_seq !== 'number') {
    res.status(400).json({ success: false, error: 'Missing required fields' });
    return;
  }

  try {
    appendBatch(batch, userId);
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
