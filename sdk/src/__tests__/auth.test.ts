import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readMarker, watchMarker, readCookieValue } from '../auth';

function setCookie(value: string): void {
  Object.defineProperty(document, 'cookie', { configurable: true, value, writable: true });
}

describe('readMarker', () => {
  it('returns false when cookie is absent', () => {
    setCookie('foo=bar; baz=qux');
    expect(readMarker('session_present')).toBe(false);
  });

  it('returns true when marker is the only cookie', () => {
    setCookie('session_present=1');
    expect(readMarker('session_present')).toBe(true);
  });

  it('returns true when marker is mixed with other cookies', () => {
    setCookie('a=1; session_present=1; b=2');
    expect(readMarker('session_present')).toBe(true);
  });

  it('returns false when marker has empty value', () => {
    setCookie('session_present=; foo=bar');
    expect(readMarker('session_present')).toBe(false);
  });

  it('does not match a prefix of another cookie', () => {
    setCookie('session_present_other=1');
    expect(readMarker('session_present')).toBe(false);
  });
});

describe('readCookieValue', () => {
  it('returns the value when present among other cookies', () => {
    setCookie('a=1; session_id=abc-123; b=2');
    expect(readCookieValue('session_id')).toBe('abc-123');
  });

  it('returns null when the cookie is absent', () => {
    setCookie('a=1');
    expect(readCookieValue('session_id')).toBeNull();
  });

  it('returns null for an empty value', () => {
    setCookie('session_id=');
    expect(readCookieValue('session_id')).toBeNull();
  });
});

describe('watchMarker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setCookie('');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onChange(true) when marker appears via poll', () => {
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 1_000);

    setCookie('session_present=1');
    vi.advanceTimersByTime(1_000);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);
    dispose();
  });

  it('fires onChange(false) when marker disappears', () => {
    setCookie('session_present=1');
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 1_000);

    setCookie('');
    vi.advanceTimersByTime(1_000);

    expect(cb).toHaveBeenCalledWith(false);
    dispose();
  });

  it('does not fire when state is unchanged', () => {
    setCookie('session_present=1');
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 1_000);

    vi.advanceTimersByTime(5_000);

    expect(cb).not.toHaveBeenCalled();
    dispose();
  });

  it('reacts to visibilitychange events', () => {
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 60_000);

    setCookie('session_present=1');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(cb).toHaveBeenCalledWith(true);
    dispose();
  });

  it('dispose() stops the watcher', () => {
    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 1_000);
    dispose();

    setCookie('session_present=1');
    vi.advanceTimersByTime(10_000);

    expect(cb).not.toHaveBeenCalled();
  });

  it('fires onChange via cookieStore change event without waiting for the poll', () => {
    const listeners: Array<() => void> = [];
    vi.stubGlobal('cookieStore', {
      addEventListener: (_t: string, l: () => void) => listeners.push(l),
      removeEventListener: () => {},
    });

    const cb = vi.fn();
    const dispose = watchMarker('session_present', cb, 60_000);

    setCookie('session_present=1');
    listeners.forEach((l) => l()); // simulate the browser firing 'change'

    expect(cb).toHaveBeenCalledWith(true);
    // таймер не тикал, сработал cookieStore
    dispose();
    vi.unstubAllGlobals();
  });
});
