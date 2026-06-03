import type { eventWithTime } from '@rrweb/types';

export async function loadSession(url: string): Promise<eventWithTime[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadSession failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return (json && json.data) || [];
}
