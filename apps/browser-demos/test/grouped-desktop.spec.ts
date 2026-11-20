import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '../playwright-test';
import { typePhysicalText } from './support/physical-typing';
import { DesktopCompositionError, waitForDesktopComposition } from './support/desktop-composition';

test('rejects a black desktop despite a visible page header', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.setContent('<style>body{margin:0}header{height:48px;background:white}canvas{display:block}</style><header>Visible controls</header><canvas id="composition-control" width="400" height="300"></canvas>');
  await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
  });
  let failure: unknown;
  try { await waitForDesktopComposition(page, '#composition-control', 700); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DesktopCompositionError);
  const samples = (failure as DesktopCompositionError).samples;
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.every(sample => sample.nonBlackFraction === 0)).toBe(true);
  await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#242424'; context.fillRect(0, 0, canvas.width, canvas.height);
  });
  expect((await waitForDesktopComposition(page, '#composition-control')).slice(-3)
    .every(sample => sample.nonBlackFraction === 1)).toBe(true);
});

test('boots the integrated grouped Sway desktop and a real terminal', async ({ page }, info) => {
  const out = process.env.KANDELO_GROUPED_DESKTOP_EVIDENCE;
  if (!out) throw Error('Select retained grouped desktop evidence directory');
  mkdirSync(out, { recursive: true });
  const evidenceStem = `${info.project.name}-repeat${info.repeatEachIndex}`;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const width = Number(process.env.KANDELO_GROUPED_DESKTOP_WIDTH ?? 1920);
  const height = Number(process.env.KANDELO_GROUPED_DESKTOP_HEIGHT ?? 1080);
  await page.setViewportSize({ width, height: height + 120 });
  const trace = process.env.KANDELO_GROUPED_DESKTOP_TRACE === '0' ? '' : '&trace=1';
  await page.goto(`/grouped-desktop.html?width=${width}&height=${height}${trace}`);
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
    writeFileSync(resolve(out, `${evidenceStem}-startup.json`), JSON.stringify({ state, errors }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    expect(state.rootExit, JSON.stringify(state, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).toBeUndefined();
    expect(state.ready, JSON.stringify(state, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).toBe(true);
    if (info.project.name === 'webkit') {
      // The group must reach its admitted fixed physical extent before any
      // participant can retire while another participant allocates.
      expect(state.processes.find((process: any) => process.comm === 'sway')?.memoryBytes)
        .toBe(8192 * 65536);
    }
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
    const mappedTerminals = () => page.evaluate(async () => {
      const desktop = (window as any).groupedDesktop, result = await desktop.command('-t', 'get_tree');
      const processes = await desktop.kernel.enumProcs(), windows: any[] = [];
      const visit = (node: any) => {
        if (node.app_id === 'foot' && node.visible) {
          const shell = processes.find((process: any) => process.ppid === node.pid && (process.comm === 'sh' || process.comm === 'bash'));
          if (shell) windows.push({ ...node.rect, shellPid: shell.pid, focused: node.focused });
        }
        for (const child of [...node.nodes ?? [], ...node.floating_nodes ?? []]) visit(child);
      };
      visit(JSON.parse(result.stdout)); return windows.sort((a, b) => a.x - b.x);
    });
    await expect.poll(async () => (await mappedTerminals()).length, { timeout: 30000 }).toBe(2);
    const windows = await mappedTerminals();
    for (const [index, terminalWindow] of windows.entries()) {
      await page.locator('.desktop').click({ position: { x: terminalWindow.x + terminalWindow.width / 2, y: terminalWindow.y + 100 } });
      await expect.poll(async () => (await mappedTerminals()).find((terminal: any) => terminal.focused)?.shellPid, { timeout: 30000 }).toBe(terminalWindow.shellPid);
      await typePhysicalText(page, `echo $$ > /tmp/grouped-pointer-${index}\n`, { delay: 20 });
      await expect.poll(() => page.evaluate(async path => {
        const bytes = await (window as any).groupedDesktop.kernel.readFileFromVfs(path);
        return bytes ? new TextDecoder().decode(bytes).trim() : null;
      }, `/tmp/grouped-pointer-${index}`), { timeout: 30000 }).toBe(String(terminalWindow.shellPid));
    }
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
    const composition = await waitForDesktopComposition(page, '.desktop');
    writeFileSync(resolve(out, `${evidenceStem}-composition.json`), JSON.stringify(composition, null, 2) + '\n');
    await page.screenshot({ path: resolve(out, `${evidenceStem}-desktop.png`) });
    const active = await page.evaluate(async () => {
      const desktop = (window as any).groupedDesktop;
      return { ...desktop.state, stats: Array.from(desktop.stats), processes: await desktop.kernel.enumProcs() };
    });
    writeFileSync(resolve(out, `${evidenceStem}-active.json`), JSON.stringify(active, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    expect(active.diagnostics).toEqual([]);
    for (const terminal of active.processes.filter((process: any) => process.comm === 'foot')) {
      expect(active.processEvents).toContainEqual({ kind: 'spawn', pid: terminal.pid,
        ppid: terminal.ppid, receivedAt: expect.any(Number) });
    }
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
    writeFileSync(resolve(out, `${evidenceStem}-final.json`), JSON.stringify(final, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    await page.screenshot({ path: resolve(out, `${evidenceStem}-last.png`) }).catch(() => {});
    writeFileSync(resolve(out, `${evidenceStem}-errors.json`), JSON.stringify(errors, null, 2) + '\n');
  }
});
