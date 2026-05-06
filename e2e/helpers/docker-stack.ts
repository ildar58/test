import { execa } from 'execa';
import * as path from 'node:path';

const COMPOSE_FILE = path.resolve(
  import.meta.dirname,
  '../../proxy/docker-compose.yml'
);

const STACK_URL = 'http://localhost:8080';
const INGESTION_PORT = 3001;
const HEALTHCHECK_TIMEOUT_MS = 30_000;

export interface DockerStackHandle {
  url: string;
  ingestionPort: number;
  stop: () => Promise<void>;
}

async function checkDockerAvailable(): Promise<void> {
  try {
    await execa('docker', ['info'], { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Docker is not running or not installed. ' +
        'Start Docker Desktop and retry, or skip variant-a tests.'
    );
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Docker stack at ${url} did not become healthy within ${timeoutMs}ms`
  );
}

export async function startDockerStack(): Promise<DockerStackHandle> {
  await checkDockerAvailable();

  console.log('[docker-stack] docker compose up -d...');
  await execa('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d'], {
    stdio: 'inherit',
  });

  await waitForHttp(STACK_URL, HEALTHCHECK_TIMEOUT_MS);
  console.log(`[docker-stack] stack healthy at ${STACK_URL}`);

  const stop = async (): Promise<void> => {
    console.log('[docker-stack] docker compose down...');
    await execa('docker', ['compose', '-f', COMPOSE_FILE, 'down'], {
      stdio: 'inherit',
    });
  };

  return { url: STACK_URL, ingestionPort: INGESTION_PORT, stop };
}
