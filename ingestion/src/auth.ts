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

// TODO(prod): the real Go service must add TTL eviction and a hard size cap.
// In the stub this grows until process restart, which is acceptable for demo
// runs but would be a memory leak in production.
const sessions = new Map<string, SessionEntry>();

/**
 * Runs a bcrypt compare against a real-shape dummy hash even for unknown
 * users so the dominant cost — the bcrypt round — is paid on both paths.
 * The preceding `users.find` is O(n) over the demo user list and is not
 * constant-time itself; with a two-user list this is sub-microsecond noise,
 * but for any port to a real user table swap the linear search for a
 * constant-time lookup (e.g. hashed-username index) before relying on this
 * mitigation.
 */
export async function verifyPassword(
  user: string,
  password: string
): Promise<boolean> {
  if (!user || !password) return false;
  const found = users.find((u) => u.username === user);
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

/**
 * Test-only: wipes the in-memory session store. Not exported through any
 * production code path. Tests call this in `afterEach` to keep cases
 * independent of each other.
 */
export function _clearSessionsForTests(): void {
  sessions.clear();
}
