#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { decodeJsonl, isValidSessionId } from './decode';

/** Extra wall-clock margin on top of playbackMs before the finish-event watchdog fires. */
const FINISH_TIMEOUT_BUFFER_MS = 10_000;

function fail(msg: string): never {
  console.error(`[video] ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`[video] ${msg}`);
}

/**
 * Playwright on macOS arm64 ships an unsigned `ffmpeg-mac` binary that
 * Gatekeeper refuses to spawn (recordVideo dies with `spawn Unknown system
 * error -88` / exit 137). If we detect that state, replace the binary with
 * a Gatekeeper-friendly system ffmpeg (brew, MacPorts, anything in $PATH).
 * Once-per-machine; idempotent.
 */
function healPlaywrightFfmpegOnMacIfBroken(): void {
  if (process.platform !== 'darwin') return;

  const homePw = path.join(process.env['HOME'] ?? '', 'Library/Caches/ms-playwright');
  if (!fs.existsSync(homePw)) return;

  const ffmpegDir = fs
    .readdirSync(homePw)
    .find((d) => d.startsWith('ffmpeg-'));
  if (!ffmpegDir) return;

  const target = path.join(homePw, ffmpegDir, 'ffmpeg-mac');
  if (!fs.existsSync(target)) return;

  // Probe — if it runs to completion (exit 0) we're done.
  const probe = spawnSync(target, ['-version'], { stdio: 'pipe' });
  if (probe.status === 0) return;

  // It's broken (typically exit 137 from Gatekeeper). Find a system ffmpeg.
  let systemFfmpeg: string | null = null;
  try {
    systemFfmpeg = execSync('command -v ffmpeg', { encoding: 'utf-8' }).trim() || null;
  } catch {
    /* not in PATH */
  }
  if (!systemFfmpeg || !fs.existsSync(systemFfmpeg)) {
    console.error(
      '[video] Playwright ffmpeg is broken (exit 137 = unsigned binary blocked by Gatekeeper).\n' +
        '[video] Install a system ffmpeg and try again:  brew install ffmpeg'
    );
    return;
  }

  log(`healing Playwright ffmpeg: copying ${systemFfmpeg} → ${target}`);
  fs.copyFileSync(systemFfmpeg, target);
  fs.chmodSync(target, 0o755);
}

function findChromeExecutable(): string {
  if (process.env['CHROME_EXECUTABLE']) {
    if (!fs.existsSync(process.env['CHROME_EXECUTABLE'])) {
      fail(`CHROME_EXECUTABLE points to a missing file: ${process.env['CHROME_EXECUTABLE']}`);
    }
    return process.env['CHROME_EXECUTABLE'];
  }

  // Auto-detect Chrome for Testing installed via `npx @puppeteer/browsers install chrome@stable`.
  // The default install path on macOS is ~/chrome/mac_<arch>-<version>/chrome-mac-<arch>/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing.
  const home = process.env['HOME'] ?? '/Users/' + process.env['USER'];
  const chromeRoot = path.join(home, 'chrome');
  if (fs.existsSync(chromeRoot)) {
    const versions = fs.readdirSync(chromeRoot);
    for (const v of versions) {
      const arch = v.startsWith('mac_arm') ? 'arm64' : v.startsWith('mac_x64') ? 'x64' : null;
      if (!arch) continue;
      const candidate = path.join(
        chromeRoot,
        v,
        `chrome-mac-${arch}`,
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing'
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  fail(
    'No Chrome executable found.\n' +
      'Either set CHROME_EXECUTABLE=/path/to/chrome, or install Chrome for Testing:\n' +
      '  npx @puppeteer/browsers install chrome@stable'
  );
}

function readRrwebPlayerAssets(): { umd: string; css: string } {
  // rrweb-player ships its UMD bundle and CSS at predictable paths within the
  // installed package. Resolve them via require.resolve so pnpm's nested layout
  // doesn't bite us.
  const pkgEntry = require.resolve('rrweb-player');
  const umdPath = path.resolve(pkgEntry, '../../dist/rrweb-player.umd.cjs');
  const cssPath = path.resolve(umdPath, '../style.css');
  return {
    umd: fs.readFileSync(umdPath, 'utf-8'),
    css: fs.readFileSync(cssPath, 'utf-8'),
  };
}

function getMaxViewport(events: Array<{ type: number; data?: { width?: number; height?: number } }>): {
  width: number;
  height: number;
} {
  let width = 1024;
  let height = 768;
  for (const ev of events) {
    if (ev.type !== 4) continue; // EventType.Meta = 4
    const w = ev.data?.width;
    const h = ev.data?.height;
    if (typeof w === 'number' && w > width) width = w;
    if (typeof h === 'number' && h > height) height = h;
  }
  return { width, height };
}

function buildHtml(events: unknown[], viewport: { width: number; height: number }, umd: string, css: string): string {
  const eventsJson = JSON.stringify(events).replace(/<\/script>/g, '<\\/script>');
  // The replayer wrapper transform centres the player in the viewport.
  return `<!doctype html>
<html>
  <head>
    <style>${css}</style>
    <style>html, body { padding: 0; margin: 0; border: none; }</style>
  </head>
  <body>
    <script>${umd}</script>
    <script>
      const events = ${eventsJson};
      window.replayer = new rrwebPlayer.Player({
        target: document.body,
        props: {
          events,
          width: ${viewport.width},
          height: ${viewport.height},
          showController: false,
        },
      });
      window.replayer.addEventListener('finish', () => window.onReplayFinish());
    </script>
  </body>
</html>`;
}

async function main(): Promise<void> {
  // pnpm passes the `--` separator through when invoked via the root wrapper.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const sid = args[0];
  if (!sid) fail('Usage: pnpm video <session_id>');
  if (!isValidSessionId(sid)) fail(`Not a valid UUID session id: ${sid}`);

  const dataDir = path.resolve(__dirname, '../../../ingestion/data');
  const jsonlPath = path.join(dataDir, `${sid}.jsonl`);
  if (!fs.existsSync(jsonlPath)) {
    fail(
      `Session not found: ${jsonlPath}\n` +
        `Hint: run pnpm dev:proxy, log in, interact with the demo, then check ingestion/data/.`
    );
  }

  log(`decoding ${jsonlPath}…`);
  const events = decodeJsonl(jsonlPath) as Array<{
    type: number;
    timestamp?: number;
    data?: { width?: number; height?: number };
  }>;
  log(`${events.length} events to render`);

  healPlaywrightFfmpegOnMacIfBroken();

  const chromePath = findChromeExecutable();
  log(`using chrome: ${chromePath}`);

  const { umd, css } = readRrwebPlayerAssets();
  const viewport = getMaxViewport(events);
  log(`viewport ${viewport.width}×${viewport.height}`);

  const videoDir = path.join(dataDir, '.__rrvideo_tmp__');
  fs.mkdirSync(videoDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: videoDir, size: viewport },
  });
  const page = await context.newPage();

  // Surface page-side problems instead of dying silently inside setContent().
  page.on('pageerror', (err) => console.error('[video] page error:', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.error(`[video] page ${msg.type()}:`, msg.text());
    }
  });

  // exposeFunction must happen before setContent so the replayer can call back.
  // Await it so a registration error surfaces here instead of being swallowed.
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  await page.exposeFunction('onReplayFinish', () => resolveFinished());

  log(`launching replayer…`);
  await page.setContent(buildHtml(events, viewport, umd, css), { waitUntil: 'domcontentloaded' });

  await waitForReplayFinish(finished, events);

  const tmpVideoPath = (await page.video()?.path()) ?? '';
  await context.close();
  await browser.close();

  if (!tmpVideoPath || !fs.existsSync(tmpVideoPath)) {
    fail(`Playwright did not produce a video file (expected at ${tmpVideoPath}).`);
  }

  const outPath = path.join(dataDir, `${sid}.webm`);
  fs.renameSync(tmpVideoPath, outPath);
  try {
    fs.rmdirSync(videoDir);
  } catch {
    /* best-effort */
  }

  const size = fs.statSync(outPath).size;
  log(`done → ${outPath} (${size} bytes)`);
}

/**
 * rrweb-player calls 'finish' when playback ends, but if the event stream is
 * malformed it might never fire — bound the wait at playbackMs + buffer.
 */
async function waitForReplayFinish(
  finished: Promise<void>,
  events: Array<{ timestamp?: number }>
): Promise<void> {
  const firstTs = events[0]?.timestamp ?? 0;
  const lastTs = events[events.length - 1]?.timestamp ?? 0;
  const playbackMs = Math.max(lastTs - firstTs, 0);
  const cap = playbackMs + FINISH_TIMEOUT_BUFFER_MS;
  await Promise.race([
    finished,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        console.error(`[video] timed out waiting for replay finish (after ${cap}ms) — finalising anyway`);
        resolve();
      }, cap)
    ),
  ]);
}

void main().catch((err) => {
  console.error('[video] fatal:', err);
  process.exit(1);
});
