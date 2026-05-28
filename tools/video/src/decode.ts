import fs from 'fs';
import zlib from 'zlib';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

interface RawBatch {
  session_id: string;
  batch_seq: number;
  events_b64_gzip: string;
}

/**
 * Reads a recording's on-disk JSONL, decodes every batch, and returns a flat
 * events array ordered by batch_seq. Throws on a missing file or any malformed
 * line — neither is recoverable for the video pipeline.
 */
export function decodeJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const batches: RawBatch[] = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as RawBatch;
      } catch (cause) {
        throw new Error(
          `Malformed batch on line ${i + 1} of ${filePath}: ${(cause as Error).message}`
        );
      }
    });

  batches.sort((a, b) => a.batch_seq - b.batch_seq);

  const events: unknown[] = [];
  for (const batch of batches) {
    const gzipped = Buffer.from(batch.events_b64_gzip, 'base64');
    const json = zlib.gunzipSync(gzipped).toString('utf-8');
    events.push(...(JSON.parse(json) as unknown[]));
  }
  return events;
}
