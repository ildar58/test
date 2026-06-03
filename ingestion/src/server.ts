import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction, CookieOptions } from 'express';
import type { EventBatch } from './types';
import { appendBatch, listSessions, getSessionEvents, isValidSessionId } from './storage';
import { verifyPassword, createSession, getSession, destroySession } from './auth';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const MAX_BATCH_BYTES = '10mb';
const IS_PROD = process.env.NODE_ENV === 'production';

// За nginx: доверяем X-Forwarded-* (нужно для корректных secure-cookie за прокси).
app.set('trust proxy', 1);

// CORS выключен по умолчанию — в стеке всё same-origin через nginx. Для кросс-домена
// задать PAM_CORS_ORIGINS (через запятую); рефлексия произвольного Origin недопустима.
const corsOrigins = (process.env.PAM_CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins, credentials: true } : { origin: false }));

app.use(cookieParser());
app.use(express.json({ limit: MAX_BATCH_BYTES }));

// secure включается в проде (за TLS-терминацией nginx).
const cookieOpts = (httpOnly: boolean): CookieOptions => ({
  httpOnly,
  sameSite: 'lax',
  path: '/',
  secure: IS_PROD,
});
const SESSION_COOKIE = cookieOpts(true);
const MARKER_COOKIE = cookieOpts(false);

// dev: __dirname=ingestion/src; docker: /app/dist. Первый найденный побеждает.
function findReplayerDir(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../replayer'),
    path.resolve(__dirname, '../replayer'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const replayerDir = findReplayerDir();
if (replayerDir) app.use('/replay', express.static(replayerDir));

// безопасное чтение строкового поля из тела запроса
function pickString(body: unknown, key: string): string {
  const v = (body as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : '';
}

app.post('/auth/login', async (req: Request, res: Response) => {
  const user = pickString(req.body, 'user');
  const password = pickString(req.body, 'password');

  if (!(await verifyPassword(user, password))) {
    res.status(401).json({ success: false, error: 'invalid credentials' });
    return;
  }

  const { token, sessionId } = createSession(user);
  res.cookie('session', token, SESSION_COOKIE);
  res.cookie('session_present', '1', MARKER_COOKIE);
  res.cookie('session_id', sessionId, MARKER_COOKIE);
  res.json({ success: true, user });
});

app.post('/auth/logout', (req: Request, res: Response) => {
  destroySession(req.cookies?.session as string | undefined);
  res.cookie('session', '', { ...SESSION_COOKIE, maxAge: 0 });
  res.cookie('session_present', '', { ...MARKER_COOKIE, maxAge: 0 });
  res.cookie('session_id', '', { ...MARKER_COOKIE, maxAge: 0 });
  res.json({ success: true });
});

function isValidBatch(b: unknown): b is EventBatch {
  const o = b as EventBatch | null;
  return (
    !!o &&
    isValidSessionId(o.session_id) &&
    typeof o.events_b64_gzip === 'string' &&
    Number.isInteger(o.batch_seq) &&
    (o.batch_seq as number) >= 0
  );
}

app.post('/s/', (req: Request, res: Response) => {
  const entry = getSession(req.cookies?.session as string | undefined);
  if (!entry) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }

  if (!isValidBatch(req.body)) {
    res.status(400).json({ success: false, error: 'invalid batch' });
    return;
  }

  // session_id — не ключ авторизации (им служит HttpOnly-токен выше); проверяем
  // соответствие выданному серверу id, чтобы клиент не писал в чужую сессию.
  if (req.body.session_id !== entry.sessionId) {
    res.status(403).json({ success: false, error: 'session_id mismatch' });
    return;
  }

  try {
    appendBatch(req.body, entry.username);
    res.json({ success: true });
  } catch (err: unknown) {
    console.error('[ingestion] appendBatch failed:', err);
    res.status(500).json({ success: false, error: 'storage error' });
  }
});

// Список/чтение сессий доступны только на внутреннем порту реплеера (nginx не
// публикует /sessions на корп-порту). UUID-валидация ниже блокирует traversal.
app.get('/sessions', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: listSessions() });
  } catch (err: unknown) {
    console.error('[ingestion] listSessions failed:', err);
    res.status(500).json({ success: false, error: 'read error' });
  }
});

app.get('/sessions/:id', (req: Request, res: Response) => {
  if (!isValidSessionId(req.params.id)) {
    res.status(400).json({ success: false, error: 'invalid session id' });
    return;
  }
  try {
    const events = getSessionEvents(req.params.id);
    if (events.length === 0) {
      res.status(404).json({ success: false, error: 'Session not found or empty' });
      return;
    }
    res.json({ success: true, data: events });
  } catch (err: unknown) {
    console.error('[ingestion] getSessionEvents failed:', err);
    res.status(500).json({ success: false, error: 'read error' });
  }
});

// Глобальный обработчик: логируем внутреннюю причину, наружу — без деталей.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[ingestion] unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ success: false, error: 'internal error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ingestion service listening on http://localhost:${PORT}`);
    console.log(`Replayer UI:                   http://localhost:${PORT}/replay`);
  });
}

export default app;
