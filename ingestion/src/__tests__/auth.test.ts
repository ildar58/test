import { describe, it, expect, afterEach } from 'vitest';
import {
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  _clearSessionsForTests,
} from '../auth';

afterEach(() => {
  _clearSessionsForTests();
});

describe('verifyPassword', () => {
  it('returns true for the right user with the right password', async () => {
    expect(await verifyPassword('alice', 'alice')).toBe(true);
    expect(await verifyPassword('bob', 'bob')).toBe(true);
  });

  it('returns false for a known user with the wrong password', async () => {
    expect(await verifyPassword('alice', 'wrong')).toBe(false);
  });

  it('returns false for an unknown user', async () => {
    expect(await verifyPassword('mallory', 'whatever')).toBe(false);
  });

  it('returns false when password is empty', async () => {
    expect(await verifyPassword('alice', '')).toBe(false);
  });
});

describe('session store', () => {
  it('createSession returns a 64-char hex token and a uuid sessionId', () => {
    const { token, sessionId } = createSession('alice');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('getSession returns the entry for a live token, null for an unknown one', () => {
    const { token } = createSession('alice');
    const entry = getSession(token);
    expect(entry?.username).toBe('alice');
    expect(typeof entry?.createdAt).toBe('number');

    expect(getSession('deadbeef')).toBeNull();
    expect(getSession(undefined)).toBeNull();
  });

  it('destroySession makes a subsequent getSession return null', () => {
    const { token } = createSession('alice');
    destroySession(token);
    expect(getSession(token)).toBeNull();
  });

  it('destroySession is idempotent on unknown tokens', () => {
    destroySession('unknown');
    destroySession(undefined);
    // no throw
  });
});
