export function readMarker(name: string): boolean {
  const raw = typeof document !== 'undefined' ? document.cookie : '';
  if (!raw) return false;
  const parts = raw.split(';');
  for (const part of parts) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=').length > 0;
  }
  return false;
}

/** Возвращает значение куки или null если кука отсутствует/пуста. */
export function readCookieValue(name: string): string | null {
  const raw = typeof document !== 'undefined' ? document.cookie : '';
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      const value = v.join('=');
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export function watchMarker(
  name: string,
  onChange: (present: boolean) => void,
  pollMs: number
): () => void {
  let last = readMarker(name);

  const check = (): void => {
    const now = readMarker(name);
    if (now !== last) {
      last = now;
      onChange(now);
    }
  };

  const interval = setInterval(check, pollMs);
  const onVisibility = (): void => check();
  const onFocus = (): void => check();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);

  // Chromium: cookieStore даёт мгновенную реакцию на Set-Cookie без ожидания pollMs.
  // Safari/Firefox не поддерживают, там работает поллинг выше.
  const cookieStore = (globalThis as typeof globalThis & {
    cookieStore?: {
      addEventListener(t: 'change', l: () => void): void;
      removeEventListener(t: 'change', l: () => void): void;
    };
  }).cookieStore;
  if (cookieStore) cookieStore.addEventListener('change', check);

  return () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    if (cookieStore) cookieStore.removeEventListener('change', check);
  };
}
