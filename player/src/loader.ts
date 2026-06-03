import type { eventWithTime } from '@rrweb/types';

export async function loadSession(url: string): Promise<eventWithTime[]> {
  const res = await fetch(url);
  const json = await res.json();
  return (json && json.data) || [];
}
