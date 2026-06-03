import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export interface DemoUser {
  username: string;
  /** bcryptjs хэш */
  passwordHash: string;
}

export interface SessionEntry {
  username: string;
  createdAt: number;
  /** id сессии записи, выдаётся сервером и отдаётся клиенту в куке */
  sessionId: string;
}

// демо-пользователи с тривиальными паролями
export const users: ReadonlyArray<DemoUser> = [
  { username: 'alice', passwordHash: '$2b$10$lj1pA77VMRNz2bLzuvDAX.aTZSSgPVUcpm/.htO3KBUeDuZtI0q8K' },
  { username: 'bob',   passwordHash: '$2b$10$.tpof/zk3Lijpl9vLHJoj.4D54F5J981ITkqPW2IylqMzD4VvgOOO' },
];

// заглушка, чтобы bcrypt.compare отрабатывал одинаковое время для неизвестных пользователей
const DUMMY_HASH = users[0]!.passwordHash;

// хранится до рестарта процесса
const sessions = new Map<string, SessionEntry>();

export async function verifyPassword(
  user: string,
  password: string
): Promise<boolean> {
  if (!user || !password) return false;
  const found = users.find((u) => u.username === user);
  const matches = await bcrypt.compare(password, found?.passwordHash ?? DUMMY_HASH);
  return !!found && matches;
}

export function createSession(username: string): { token: string; sessionId: string } {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomUUID();
  sessions.set(token, { username, createdAt: Date.now(), sessionId });
  return { token, sessionId };
}

export function getSession(token: string | undefined): SessionEntry | null {
  if (!token) return null;
  return sessions.get(token) ?? null;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  sessions.delete(token);
}

// только для тестов: сбрасывает сессии между кейсами
export function _clearSessionsForTests(): void {
  sessions.clear();
}
