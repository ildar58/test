import { test, expect } from '@playwright/test';
import { startIngestion } from '../helpers/ingestion-server';
import { prepareNgApp, serveStatic } from '../helpers/ng-build';

type IngestionHandle = Awaited<ReturnType<typeof startIngestion>>;
type StaticServerHandle = Awaited<ReturnType<typeof serveStatic>>;

let ingestion: IngestionHandle;
let app: StaticServerHandle;

test.describe('variant-b: SDK in Angular', () => {
  test.beforeAll(async () => {
    ingestion = await startIngestion();
    const { distDir } = await prepareNgApp({
      endpoint: `http://localhost:${ingestion.port}/s/`,
    });
    app = await serveStatic(distDir);
  });

  test.afterAll(async () => {
    await app?.close();
    await ingestion?.kill();
  });

  test('records form interactions and persists to ingestion', async ({
    page,
  }) => {
    await page.goto(app.url);
    await page.waitForLoadState('networkidle');

    // Trigger interactions that rrweb will record
    await page.fill('input[type="text"]', 'hello');
    await page.click('text=List');

    // Wait for at least 2 batches (FullSnapshot + IncrementalSnapshot)
    await page.waitForTimeout(3000);

    // Verify ingestion received batches
    const res = await fetch(`http://localhost:${ingestion.port}/sessions`);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ session_id: string; batch_count: number }>;
    };

    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]!.batch_count).toBeGreaterThan(0);
  });

  test('replayer UI loads and displays the recorded session', async ({
    page,
  }) => {
    const list = (await fetch(
      `http://localhost:${ingestion.port}/sessions`
    ).then((r) => r.json())) as {
      data: Array<{ session_id: string }>;
    };

    const sessionId = list.data[0]!.session_id;

    await page.goto(
      `http://localhost:${ingestion.port}/replay/?id=${sessionId}`
    );
    await page.waitForSelector('.rr-player', { timeout: 10_000 });
    expect(await page.locator('.rr-player').isVisible()).toBe(true);
  });
});
