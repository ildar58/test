import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export interface DemoUser {
  username: string;
  /** bcryptjs hash, $2b$10$… */
  passwordHash: string;
}

export interface SessionEntry {
  username: string;
  createdAt: number;
}

// Demo users — passwords are intentionally trivial and committed.
// Replace with a real identity provider when porting to the Go service.
export const users: ReadonlyArray<DemoUser> = [
  { username: 'alice', passwordHash: '$2b$10$lj1pA77VMRNz2bLzuvDAX.aTZSSgPVUcpm/.htO3KBUeDuZtI0q8K' },
  { username: 'bob',   passwordHash: '$2b$10$.tpof/zk3Lijpl9vLHJoj.4D54F5J981ITkqPW2IylqMzD4VvgOOO' },
];

const sessions = new Map<string, SessionEntry>();

/**
 * Always runs a bcrypt compare even for unknown users so login response
 * timing does not trivially leak which usernames exist.
 */
export async function verifyPassword(
  user: string,
  password: string
): Promise<boolean> {
  if (!user || !password) return false;
  const found = users.find((u) => u.username === user);
  // Compare against a real-shape dummy hash when the user is missing so the
  // path is the same length. The dummy hash is one of the real ones — that
  // is fine because we never return its result.
  const hashToCompare = found?.passwordHash ?? users[0]!.passwordHash;
  const matches = await bcrypt.compare(password, hashToCompare);
  return !!found && matches;
}

export function createSession(username: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, createdAt: Date.now() });
  return token;
}

export function getSession(token: string | undefined): SessionEntry | null {
  if (!token) return null;
  return sessions.get(token) ?? null;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  sessions.delete(token);
}
