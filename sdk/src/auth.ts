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

  return () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
  };
}
