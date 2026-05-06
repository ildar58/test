import { test, expect } from '@playwright/test';
import { execa } from 'execa';
import { startDockerStack } from '../helpers/docker-stack';

type DockerStackHandle = Awaited<ReturnType<typeof startDockerStack>>;

let stack: DockerStackHandle;

test.describe('variant-a: nginx proxy injection', () => {
  test.beforeAll(async () => {
    // Skip entire suite if Docker is unavailable
    try {
      await execa('docker', ['info'], { stdio: 'pipe' });
    } catch {
      test.skip(true, 'Docker is not running — skipping variant-a tests');
      return;
    }
    stack = await startDockerStack();
  });

  test.afterAll(async () => {
    await stack?.stop();
  });

  test('nginx-injected HTML contains recorder script tag', async () => {
    const res = await fetch(stack.url + '/');
    expect(res.ok).toBe(true);

    const html = await res.text();
    expect(html).toContain('<script src="/_rec/recorder.iife.js">');
  });

  test('records interactions via proxy-injected SDK and persists to ingestion', async ({
    page,
  }) => {
    await page.goto(stack.url);
    await page.waitForLoadState('networkidle');

    // Trigger a few interactions
    const inputs = page.locator('input[type="text"]');
    const count = await inputs.count();
    if (count > 0) {
      await inputs.first().fill('variant-a test');
    }

    // Wait for batches to be flushed
    await page.waitForTimeout(3000);

    // Verify ingestion received batches (via nginx /sessions proxy on same port)
    const res = await fetch(`${stack.url}/sessions`);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ session_id: string; batch_count: number }>;
    };

    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]!.batch_count).toBeGreaterThan(0);
  });
});
