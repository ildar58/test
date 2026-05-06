import { execa } from 'execa';
import getPort from 'get-port';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const NG_APP_DIR = path.resolve(import.meta.dirname, '../fixtures/ng-app');
const MAIN_TS = path.join(NG_APP_DIR, 'src/main.ts');
const CACHE_FILE = path.join(NG_APP_DIR, '.pam-build-cache.json');
const PLACEHOLDER = '__PAM_ENDPOINT__';

interface BuildCache {
  hash: string;
  distDir: string;
}

function computeHash(endpoint: string): string {
  const mtime = fs.existsSync(MAIN_TS)
    ? String(fs.statSync(MAIN_TS).mtimeMs)
    : '0';
  return crypto
    .createHash('sha256')
    .update(endpoint + mtime)
    .digest('hex')
    .slice(0, 16);
}

function readCache(): BuildCache | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as BuildCache;
  } catch {
    return null;
  }
}

function writeCache(cache: BuildCache): void {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

export async function prepareNgApp(opts: {
  endpoint: string;
}): Promise<{ distDir: string }> {
  if (!fs.existsSync(NG_APP_DIR)) {
    throw new Error(
      `ng-app fixture not found at ${NG_APP_DIR}. Run: pnpm -F e2e setup`
    );
  }

  const hash = computeHash(opts.endpoint);
  const cache = readCache();

  const distDir = path.join(
    NG_APP_DIR,
    'dist',
    'ng-app',
    'browser'
  );

  if (cache?.hash === hash && fs.existsSync(distDir)) {
    console.log('[ng-build] cache hit — skipping ng build');
    return { distDir };
  }

  // Replace placeholder with actual endpoint
  const original = fs.readFileSync(MAIN_TS, 'utf8');
  const patched = original.replace(
    new RegExp(PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    opts.endpoint
  );
  fs.writeFileSync(MAIN_TS, patched);

  console.log('[ng-build] running ng build --configuration production...');
  try {
    await execa('npx', ['ng', 'build', '--configuration', 'production'], {
      cwd: NG_APP_DIR,
      stdio: 'inherit',
    });
  } finally {
    // Restore placeholder so cache hash is stable for next run
    fs.writeFileSync(MAIN_TS, original);
  }

  writeCache({ hash, distDir });
  return { distDir };
}

export interface StaticServer {
  url: string;
  close: () => Promise<void>;
}

export async function serveStatic(distDir: string): Promise<StaticServer> {
  const port = await getPort();

  const server = http.createServer((req, res) => {
    let urlPath = req.url?.split('?')[0] ?? '/';
    if (urlPath === '/') urlPath = '/index.html';

    // Angular uses pushState routing — fallback to index.html
    let filePath = path.join(distDir, urlPath);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(distDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    const contentType = mimeTypes[ext] ?? 'application/octet-stream';

    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`[ng-build] static server listening at http://localhost:${port}`);

  const close = (): Promise<void> =>
    new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );

  return { url: `http://localhost:${port}`, close };
}
