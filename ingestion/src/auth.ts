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
  /** Server-minted recording session id, mirrored to the client as a cookie. */
  sessionId: string;
}

// Demo users — passwords are intentionally trivial and committed.
// Replace with a real identity provider when porting to the Go service.
export const users: ReadonlyArray<DemoUser> = [
  { username: 'alice', passwordHash: '$2b$10$lj1pA77VMRNz2bLzuvDAX.aTZSSgPVUcpm/.htO3KBUeDuZtI0q8K' },
  { username: 'bob',   passwordHash: '$2b$10$.tpof/zk3Lijpl9vLHJoj.4D54F5J981ITkqPW2IylqMzD4VvgOOO' },
];

/**
 * Used as a stand-in hash for unknown users so bcrypt.compare runs the same
 * number of rounds in both paths, removing the timing oracle that would
 * otherwise reveal whether the username exists.
 */
const DUMMY_HASH = users[0]!.passwordHash;

// TODO(prod): the real Go service must add TTL eviction and a hard size cap.
// In the stub this grows until process restart, which is acceptable for demo
// runs but would be a memory leak in production.
const sessions = new Map<string, SessionEntry>();

/**
 * Runs a bcrypt compare against DUMMY_HASH even for unknown users so the
 * dominant cost — the bcrypt round — is paid on both paths. The preceding
 * `users.find` is O(n) and not constant-time; with a two-user list this is
 * sub-microsecond noise, but a port to a real user table should swap the
 * linear search for a constant-time lookup before relying on this mitigation.
 */
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

/**
 * Test-only: wipes the in-memory session store. Not exported through any
 * production code path. Tests call this in `afterEach` to keep cases
 * independent of each other.
 */
export function _clearSessionsForTests(): void {
  sessions.clear();
}
