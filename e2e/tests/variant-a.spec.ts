import { test, expect, type Page } from '@playwright/test';
import { execa } from 'execa';
import { startDockerStack } from '../helpers/docker-stack';

type DockerStackHandle = Awaited<ReturnType<typeof startDockerStack>>;

let stack: DockerStackHandle;

async function countBatchPosts(page: Page, durationMs: number): Promise<number> {
  let count = 0;
  const handler = (req: import('@playwright/test').Request) => {
    if (req.method() === 'POST' && req.url().endsWith('/s/')) count += 1;
  };
  page.on('request', handler);
  await page.waitForTimeout(durationMs);
  page.off('request', handler);
  return count;
}

test.describe('variant-a: auth-gated nginx injection', () => {
  test.beforeAll(async () => {
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

  test('recorder bundle is injected on every HTML response', async () => {
    const res = await fetch(stack.url + '/');
    const html = await res.text();
    expect(html).toContain('<script src="/_rec/recorder.iife.js">');
  });

  test('no POST /s/ traffic while user is logged out', async ({ page }) => {
    await page.goto(stack.url);
    await page.waitForLoadState('networkidle');

    // Trigger some DOM activity to exercise rrweb listeners (they should NOT be attached)
    const inputs = page.locator('input[type="text"]');
    if (await inputs.count()) await inputs.first().fill('pre-auth typing');

    const posts = await countBatchPosts(page, 3_500);
    expect(posts).toBe(0);
  });

  test('login starts recording → batches appear in storage', async ({ page }) => {
    await page.goto(stack.url);
    await page.locator('#auth-login').click();
    await expect(page.locator('#auth-status')).toHaveText('logged in');

    const inputs = page.locator('input[type="text"]');
    await inputs.first().fill('post-auth typing');

    // Wait for at least one flush window
    await page.waitForTimeout(3_000);

    const res = await fetch(`${stack.url}/sessions`);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ session_id: string; user_id: string; batch_count: number }>;
    };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]!.user_id).toBe('alice');
    expect(body.data[0]!.batch_count).toBeGreaterThan(0);
  });

  test('logout stops recording within poll interval', async ({ page }) => {
    await page.goto(stack.url);
    await page.locator('#auth-login').click();
    await expect(page.locator('#auth-status')).toHaveText('logged in');
    await page.waitForTimeout(3_000);

    await page.locator('#auth-logout').click();
    await expect(page.locator('#auth-status')).toHaveText('logged out');

    // Allow up to markerPollMs + flushIntervalMs (= 5s + 2s) for the SDK to react
    await page.waitForTimeout(7_500);

    const posts = await countBatchPosts(page, 3_500);
    expect(posts).toBe(0);
  });

  test('logout → re-login produces two distinct session_ids for the same user', async ({ page }) => {
    await page.goto(stack.url);

    await page.locator('#auth-login').click();
    await page.waitForTimeout(3_000);
    await page.locator('#auth-logout').click();
    await page.waitForTimeout(7_500);
    await page.locator('#auth-login').click();
    await page.waitForTimeout(3_000);

    const res = await fetch(`${stack.url}/sessions`);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ session_id: string; user_id: string }>;
    };
    const sessions = body.data.filter((s) => s.user_id === 'alice');
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const uniqueIds = new Set(sessions.map((s) => s.session_id));
    expect(uniqueIds.size).toBeGreaterThanOrEqual(2);
  });
});
