import express from 'express';
import cors from 'cors';
import path from 'path';
import type { Request, Response } from 'express';
import type { EventBatch } from './types';
import { appendBatch, listSessions, getSessionEvents } from './storage';

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve replayer UI
app.use('/replay', express.static(path.resolve(__dirname, '../../replayer')));

/**
 * POST /s/  — ingest a batch from Variant A or Variant B
 */
app.post('/s/', (req: Request, res: Response) => {
  const batch = req.body as EventBatch;
  if (!batch.session_id || !batch.events_b64_gzip) {
    res.status(400).json({ success: false, error: 'Missing required fields' });
    return;
  }
  try {
    appendBatch(batch);
    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /sessions — list all recorded sessions
 */
app.get('/sessions', (_req: Request, res: Response) => {
  res.json({ success: true, data: listSessions() });
});

/**
 * GET /sessions/:id — get full event array for a session (for replayer)
 */
app.get('/sessions/:id', (req: Request, res: Response) => {
  const events = getSessionEvents(req.params.id);
  if (events.length === 0) {
    res.status(404).json({ success: false, error: 'Session not found or empty' });
    return;
  }
  res.json({ success: true, data: events });
});

// Only start listening when run directly, not when imported (e.g. by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ingestion service listening on http://localhost:${PORT}`);
    console.log(`Replayer UI:  http://localhost:${PORT}/replay`);
  });
}

export default app;
