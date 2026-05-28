import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { decodeJsonl, isValidSessionId } from '../decode';

let tmpDir: string;

function writeBatch(file: string, sessionId: string, batchSeq: number, events: unknown[]): void {
  const events_b64_gzip = zlib.gzipSync(Buffer.from(JSON.stringify(events), 'utf-8')).toString('base64');
  const batch = { session_id: sessionId, batch_seq: batchSeq, events_b64_gzip };
  fs.appendFileSync(file, JSON.stringify(batch) + '\n', 'utf-8');
}

describe('decodeJsonl', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-video-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('decodes a single-batch JSONL into a flat events array', () => {
    const file = path.join(tmpDir, 's.jsonl');
    const events = [
      { type: 0, data: { href: 'http://x' }, timestamp: 1 },
      { type: 2, data: { node: { id: 1 } }, timestamp: 2 },
    ];
    writeBatch(file, 's', 1, events);

    expect(decodeJsonl(file)).toEqual(events);
  });

  it('concatenates multiple batches preserving batch_seq order', () => {
    const file = path.join(tmpDir, 's.jsonl');
    writeBatch(file, 's', 1, [{ id: 1 }, { id: 2 }]);
    writeBatch(file, 's', 2, [{ id: 3 }]);
    writeBatch(file, 's', 3, [{ id: 4 }, { id: 5 }]);

    expect(decodeJsonl(file)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
  });

  it('reorders batches if the file was written out of order', () => {
    const file = path.join(tmpDir, 's.jsonl');
    writeBatch(file, 's', 2, [{ id: 'second' }]);
    writeBatch(file, 's', 1, [{ id: 'first' }]);

    expect(decodeJsonl(file)).toEqual([{ id: 'first' }, { id: 'second' }]);
  });

  it('throws a clear error when the file is missing', () => {
    expect(() => decodeJsonl(path.join(tmpDir, 'missing.jsonl'))).toThrow(/not found/i);
  });

  it('throws when a line is malformed', () => {
    const file = path.join(tmpDir, 's.jsonl');
    fs.writeFileSync(file, 'not-json\n', 'utf-8');
    expect(() => decodeJsonl(file)).toThrow();
  });
});

describe('isValidSessionId', () => {
  it('accepts a canonical UUID', () => {
    expect(isValidSessionId('8d551208-2474-4bf7-8b36-f375e09b2fd2')).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidSessionId('../etc/passwd')).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
  });

  it('rejects empty and undefined-ish strings', () => {
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('undefined')).toBe(false);
  });

  it('rejects uppercase hex (canonicalisation matters)', () => {
    expect(isValidSessionId('8D551208-2474-4BF7-8B36-F375E09B2FD2')).toBe(false);
  });
});
