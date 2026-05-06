import { execa } from 'execa';
import getPort from 'get-port';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const INGESTION_SERVER = path.resolve(
  import.meta.dirname,
  '../../ingestion/dist/server.js'
);

const READY_TIMEOUT_MS = 15_000;

export interface IngestionHandle {
  port: number;
  dataDir: string;
  kill: () => Promise<void>;
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/sessions`);
      if (res.ok || res.status < 500) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Ingestion server did not become ready within ${timeoutMs}ms`);
}

export async function startIngestion(): Promise<IngestionHandle> {
  const uid = crypto.randomUUID();
  const dataDir = path.join(os.tmpdir(), `pam-e2e-${uid}`);
  fs.mkdirSync(dataDir, { recursive: true });

  const port = await getPort();

  const proc = execa('node', [INGESTION_SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      PAM_DATA_DIR: dataDir,
    },
    stdio: 'pipe',
    reject: false,
  });

  // Surface server stderr to console for debugging
  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[ingestion] ${chunk.toString()}`);
  });

  await waitForPort(port, READY_TIMEOUT_MS);

  const kill = async (): Promise<void> => {
    if (proc.pid) {
      try {
        process.kill(proc.pid, 'SIGTERM');
        await proc;
      } catch {
        // already exited
      }
    }
    // Clean up temp dir
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return { port, dataDir, kill };
}
