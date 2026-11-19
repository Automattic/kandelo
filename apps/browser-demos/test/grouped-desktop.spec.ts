import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '../playwright-test';
import { typePhysicalText } from './support/physical-typing';

test('boots the integrated grouped Sway desktop and a real terminal', async ({ page }, info) => {
  const out = process.env.KANDELO_GROUPED_DESKTOP_EVIDENCE;
  if (!out) throw Error('Select retained grouped desktop evidence directory');
  mkdirSync(out, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const width = Number(process.env.KANDELO_GROUPED_DESKTOP_WIDTH ?? 1920);
  const height = Number(process.env.KANDELO_GROUPED_DESKTOP_HEIGHT ?? 1080);
  await page.setViewportSize({ width, height: height + 120 });
  await page.goto(`/grouped-desktop.html?width=${width}&height=${height}&trace=1`);
  await page.getByRole('button', { name: 'Start shared desktop' }).click();
  try {
    await page.waitForFunction(() => {
      const desktop = (window as any).groupedDesktop;
      return desktop?.state.ready || desktop?.state.rootExit !== undefined || document.querySelector('#status')?.getAttribute('data-error') === 'true';
    }, undefined, { timeout: 180000 });
    const state = await page.evaluate(async () => {
      const desktop = (window as any).groupedDesktop;
      return desktop ? { ...desktop.state, stats: Array.from(desktop.stats), processes: await desktop.kernel.enumProcs() } : { ready: false, bootStatus: document.querySelector('#status')?.textContent };
    });
    writeFileSync(resolve(out, `${info.project.name}-startup.json`), JSON.stringify({ state, errors }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    expect(state.rootExit, JSON.stringify(state, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).toBeUndefined();
    expect(state.ready, JSON.stringify(state, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).toBe(true);
    await page.locator('.desktop').click({ position: { x: 500, y: 300 } });
    await typePhysicalText(page, 'echo shared > /tmp/grouped-input-proof\n', { delay: 20 });
    await expect.poll(() => page.evaluate(async () => {
      const bytes = await (window as any).groupedDesktop.kernel.readFileFromVfs('/tmp/grouped-input-proof');
      return bytes ? new TextDecoder().decode(bytes) : null;
    }), { timeout: 30000 }).toBe('shared\n');
    await page.getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => {
      const processes = await (window as any).groupedDesktop.kernel.enumProcs();
      return processes.filter((process: any) => process.comm === 'foot' && processes.some((child: any) =>
        child.ppid === process.pid && (child.comm === 'sh' || child.comm === 'bash'))).length;
    }), { timeout: 30000 }).toBe(2);
    const clickCommand = async (name: string) => {
      const button = page.getByRole('button', { name, exact: true });
      await button.click(); await expect(button).toBeEnabled({ timeout: 30000 });
      await expect(page.locator('#status')).not.toHaveAttribute('data-error', 'true');
    };
    for (let cycle = 0; cycle < 6; cycle++) {
      for (const workspace of [2, 1]) {
        await clickCommand(`Move to ${workspace}`);
        await clickCommand(`Workspace ${workspace}`);
        const result = await page.evaluate(() => (window as any).groupedDesktop.command('-t', 'get_workspaces'));
        expect(JSON.parse(result.stdout).find((entry: any) => entry.focused)?.num).toBe(workspace);
      }
    }
    await page.screenshot({ path: resolve(out, `${info.project.name}-desktop.png`) });
    const active = await page.evaluate(async () => {
      const desktop = (window as any).groupedDesktop;
      return { ...desktop.state, stats: Array.from(desktop.stats), processes: await desktop.kernel.enumProcs() };
    });
    writeFileSync(resolve(out, `${info.project.name}-active.json`), JSON.stringify(active, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    expect(active.diagnostics).toEqual([]);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('#status')).toContainText('Stopped.', { timeout: 30000 });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as any).groupedDesktop.state.diagnostics)).toEqual([]);
  } finally {
    const final = await page.evaluate(async () => {
      const desktop = (window as any).groupedDesktop;
      if (!desktop) return null;
      const queries: unknown[] = [];
      if (desktop.state.ready) for (const type of ['get_inputs', 'get_tree']) {
        try { await desktop.command('-t', type); } catch (error) { queries.push({ type, error: String(error) }); }
      }
      return { ...desktop.state, stats: Array.from(desktop.stats), processes: desktop.state.ready ? await desktop.kernel.enumProcs() : [],
        activeElement: document.activeElement?.className, hasFocus: document.hasFocus(), queries };
    }).catch(error => ({ error: String(error) }));
    writeFileSync(resolve(out, `${info.project.name}-final.json`), JSON.stringify(final, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    await page.screenshot({ path: resolve(out, `${info.project.name}-last.png`) }).catch(() => {});
    writeFileSync(resolve(out, `${info.project.name}-errors.json`), JSON.stringify(errors, null, 2) + '\n');
  }
});
