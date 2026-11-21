import { test, expect } from '../playwright-test';
import { typePhysicalText } from './support/physical-typing';
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures, memoryBoundaryRealmId } from './support/browser-memory-boundary';
import { waitForDesktopComposition } from './support/desktop-composition';

function observeErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || /force-terminating|terminated the kernel worker realm|incomplete graceful generation detach|retirement.*timed out/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function start(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Start shared desktop', exact: true }).click();
  await page.waitForFunction(() => (window as any).groupedDesktop?.state.ready
    || document.querySelector('#status')?.getAttribute('data-error') === 'true', undefined, { timeout: 120000 });
  await expect(page.locator('#status')).not.toHaveAttribute('data-error', 'true');
  expect(await page.evaluate(() => (window as any).groupedDesktop.state.ready)).toBe(true);
}

async function stop(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Stopped.', { timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Start shared desktop', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).groupedDesktop.kernel === undefined)).toBe(true);
  expect(await page.evaluate(() => (window as any).groupedDesktop.state.diagnostics)).toEqual([]);
}

async function cleanup(page: import('@playwright/test').Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Stop', exact: true });
  if (await button.isEnabled().catch(() => false)) await button.click({ timeout: 10000 }).catch(() => {});
}

test('restarts four grouped desktops in the same loaded page', async ({ page }, info) => {
  const errors = observeErrors(page), requests: string[] = [];
  const cycles: unknown[] = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await installBrowserMemoryBoundaryProbe(page);
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto('/grouped-desktop.html?width=1280&height=720');
  const realm = await memoryBoundaryRealmId(page);
  const entry = await page.locator('script[type=module][src]').getAttribute('src');
  expect(entry).toBeTruthy();
  const command = (...args: string[]) => page.evaluate(async args => (window as any).groupedDesktop.command(...args), args);
  const windows = async () => {
    const tree = JSON.parse((await command('-t', 'get_tree')).stdout), result: any[] = [];
    const visit = (node: any) => {
      if (node.app_id === 'foot') result.push(node);
      for (const child of [...node.nodes ?? [], ...node.floating_nodes ?? []]) visit(child);
    };
    visit(tree); return result;
  };
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      await start(page);
      await expect.poll(async () => (await windows()).length, { timeout: 30000 }).toBe(1);
      expect(await page.evaluate(() => (window as any).groupedDesktop.kernel.readFileFromVfs('/tmp/restart-input'))).toBeNull();
      await page.locator('.desktop').click({ position: { x: 500, y: 300 } });
      await typePhysicalText(page, `echo cycle-${cycle} > /tmp/restart-input\n`, { delay: 20 });
      await expect.poll(() => page.evaluate(async () => {
        const bytes = await (window as any).groupedDesktop.kernel.readFileFromVfs('/tmp/restart-input');
        return bytes ? new TextDecoder().decode(bytes) : null;
      }), { timeout: 30000 }).toBe(`cycle-${cycle}\n`);
      await page.getByRole('button', { name: 'New terminal', exact: true }).click();
      await expect.poll(async () => (await windows()).filter(w => w.visible).length, { timeout: 30000 }).toBe(2);
      await command('move container to workspace number 2'); await command('workspace number 1');
      await expect.poll(async () => (await windows()).filter(w => w.visible).length, { timeout: 30000 }).toBe(1);
      await command('workspace number 2'); await command('move container to workspace number 1'); await command('workspace number 1');
      await expect.poll(async () => (await windows()).filter(w => w.visible).length, { timeout: 30000 }).toBe(2);
      const composition = await waitForDesktopComposition(page, '.desktop');
      const active = await page.evaluate(async () => {
        const d = (window as any).groupedDesktop;
        const processes = await d.kernel.enumProcs();
        const roots = [...new Set<number>(d.state.processEvents.filter((e: any) =>
          e.kind === 'spawn' && e.ppid === undefined && e.pid !== d.state.rootPid).map((e: any) => e.pid))];
        const rootRecords = [];
        for (const pid of roots) rootRecords.push({ pid, stat: await d.kernel.readFileFromVfs(`/proc/${pid}/stat`) });
        return { processes, rootRecords, diagnostics: d.state.diagnostics, stats: Array.from(d.stats) };
      });
      expect(active.processes.filter((p: any) => p.comm === 'foot')).toHaveLength(2);
      const extent = active.processes.find((p: any) => p.comm === 'sway')?.memoryBytes;
      expect(extent).toBeGreaterThan(0); expect(extent).toBeLessThanOrEqual(8192 * 65536);
      if (info.project.name === 'webkit') expect(extent).toBe(8192 * 65536);
      expect(active.rootRecords.length).toBeGreaterThan(0);
      expect(active.rootRecords.every(record => record.stat === null)).toBe(true);
      expect(active.diagnostics).toEqual([]);
      await stop(page);
      expect(requests.filter(path => path === entry)).toHaveLength(1);
      expect(await memoryBoundaryRealmId(page)).toBe(realm);
      expect(await memoryBoundaryFailures(page)).toEqual([]);
      expect(errors).toEqual([]);
      cycles.push({ cycle, composition, active });
    }
  } finally {
    await info.attach('restart-cycles', { body: JSON.stringify({ cycles, errors }, null, 2), contentType: 'application/json' });
    await cleanup(page);
  }
});

test('cancels image loading and starts a fresh grouped desktop', async ({ page }, info) => {
  test.setTimeout(180000);
  const errors = observeErrors(page);
  await installBrowserMemoryBoundaryProbe(page);
  await page.setViewportSize({ width: 1280, height: 840 });
  let release!: () => void, handlerFinished = false;
  const released = new Promise<void>(resolve => { release = resolve; });
  const handler = async (route: import('@playwright/test').Route) => {
    await released;
    // The browser has already cancelled this request when Stop completes.
    try { await route.continue(); } catch { /* An aborted held request has no live route. */ }
    finally { handlerFinished = true; }
  };
  await page.route('**/__grouped_preview/image.vfs.zst', handler);
  try {
    await page.goto('/grouped-desktop.html?width=1280&height=720');
    const realm = await memoryBoundaryRealmId(page);
    const reached = page.waitForRequest('**/__grouped_preview/image.vfs.zst', { timeout: 30000 });
    await page.getByRole('button', { name: 'Start shared desktop', exact: true }).click();
    await reached;
    await expect(page.getByRole('button', { name: 'Start shared desktop', exact: true })).toBeDisabled();
    await stop(page);
    release();
    await expect.poll(() => handlerFinished, { timeout: 10000 }).toBe(true);
    await page.unroute('**/__grouped_preview/image.vfs.zst', handler);
    await start(page);
    await page.locator('.desktop').click({ position: { x: 500, y: 300 } });
    await typePhysicalText(page, 'echo restarted > /tmp/cancel-restart-proof\n', { delay: 20 });
    await expect.poll(() => page.evaluate(async () => {
      const bytes = await (window as any).groupedDesktop.kernel.readFileFromVfs('/tmp/cancel-restart-proof');
      return bytes ? new TextDecoder().decode(bytes) : null;
    }), { timeout: 30000 }).toBe('restarted\n');
    await stop(page);
    expect(await memoryBoundaryRealmId(page)).toBe(realm);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    release(); await page.unroute('**/__grouped_preview/image.vfs.zst', handler).catch(() => {});
    await info.attach('cancel-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
    await cleanup(page);
  }
});
