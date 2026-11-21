import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../playwright-test';
import { typePhysicalText } from './support/physical-typing';

test('keeps existing terminals usable after a launch budget refusal', async ({ page }, info) => {
  const out = process.env.KANDELO_GROUPED_DESKTOP_EVIDENCE;
  if (!out) throw Error('Select retained desktop evidence');
  mkdirSync(out, { recursive: true });
  const errors: string[] = [], samples: unknown[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const pages = Number(process.env.KANDELO_GROUPED_DESKTOP_GROUP_PAGES ?? 8192);
  const tracing = process.env.KANDELO_GROUPED_DESKTOP_TRACE !== '0';
  await page.goto(`/grouped-desktop.html?width=1280&height=720&groupPages=${pages}${tracing ? '&trace=1' : ''}`);
  await page.getByRole('button', { name: 'Start shared desktop' }).click();
  const terminals = () => page.evaluate(async () => {
    const processes = await (window as any).groupedDesktop.kernel.enumProcs();
    return processes.filter((process: any) => process.comm === 'foot' && processes.some((child: any) =>
      child.ppid === process.pid && (child.comm === 'sh' || child.comm === 'bash'))).length;
  });
  const command = (...args: string[]) => page.evaluate(async args => {
    const desktop = (window as any).groupedDesktop;
    try { return { result: await desktop.command(...args) }; }
    catch (error) { return { error: String(error), last: desktop.state.commands.at(-1), diagnostics: desktop.state.diagnostics }; }
  }, args);
  try {
    await page.waitForFunction(() => (window as any).groupedDesktop?.state.ready
      || document.querySelector('#status')?.getAttribute('data-error') === 'true', undefined, { timeout: 180000 });
    await expect(page.locator('#status')).not.toHaveAttribute('data-error', 'true');
    let refused = false;
    capacity: for (let index = 0; index < 16; index++) {
      const before = await terminals();
      const stderrStart = await page.evaluate(() => (window as any).groupedDesktop.state.stderr.length);
      const launch = await command('exec foot --config=/usr/share/kandelo/sway/foot.ini');
      samples.push({ index, before, launch });
      if ('error' in launch) {
        // Inspect the actual Sway IPC failure. An IPC timeout or a kernel
        // diagnostic is not a successful capacity-refusal result.
        expect(launch.diagnostics).toEqual([]);
        if (!/Grouped root admission: errno 11$/.test(launch.error ?? '')) {
          expect(launch.last?.code).toBe(2);
          expect(JSON.parse(launch.last.stdout)).toContainEqual(expect.objectContaining({ success: false, error: 'fork() failed' }));
        }
        refused = true; break;
      }
      let outcome = '';
      await expect.poll(async () => {
        const state = await page.evaluate(start => {
          const state = (window as any).groupedDesktop.state;
          return { diagnostics: state.diagnostics, stderr: state.stderr.slice(start) };
        }, stderrStart);
        expect(state.diagnostics).toEqual([]);
        if (await terminals() === before + 1) outcome = 'started';
        else if (/(?:execve failed|\/usr\/bin\/foot): Out of memory/.test(state.stderr)) outcome = 'guest-refused';
        return outcome;
      }, { timeout: 30000 }).toMatch(/^(started|guest-refused)$/);
      samples.push({ index, outcome });
      if (outcome === 'guest-refused') { refused = true; break; }
      for (const workspace of [index + 2, 1]) {
        for (const args of [[`move container to workspace number ${workspace}`], [`workspace number ${workspace}`]]) {
          const result = await command(...args);
          if ('error' in result) {
            expect(result.diagnostics).toEqual([]);
            expect(result.error).toMatch(/Grouped root admission: errno 11$/);
            samples.push({ index, args, refusal: result.error });
            refused = true; break capacity;
          }
        }
      }
    }
    expect(refused).toBe(true);
    expect(errors).toEqual([]);
    const count = await terminals();
    expect(count).toBeGreaterThan(1);
    await page.locator('.desktop').click({ position: { x: 500, y: 300 } });
    await typePhysicalText(page, 'echo live > /tmp/grouped-pressure-proof\n', { delay: 20 });
    await expect.poll(() => page.evaluate(async () => {
      const bytes = await (window as any).groupedDesktop.kernel.readFileFromVfs('/tmp/grouped-pressure-proof');
      return bytes ? new TextDecoder().decode(bytes) : null;
    }), { timeout: 30000 }).toBe('live\n');
    await page.keyboard.press('Control+d');
    await expect.poll(terminals, { timeout: 30000 }).toBe(count - 1);
    // The freed slot admits the real IPC client. Reopening the terminal
    // can consume that slot again, so a further root is not guaranteed.
    const tree = await command('-t', 'get_tree');
    expect(tree, JSON.stringify(tree)).not.toHaveProperty('error');
    expect(JSON.parse(tree.result.stdout).type).toBe('root');
    const reopened = await command('exec foot --config=/usr/share/kandelo/sway/foot.ini');
    expect(reopened, JSON.stringify(reopened)).not.toHaveProperty('error');
    await expect.poll(terminals, { timeout: 30000 }).toBe(count);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('#status')).toContainText('Stopped.', { timeout: 30000 });
    expect(errors).toEqual([]);
  } finally {
    const state = await page.evaluate(async () => {
      const desktop = (window as any).groupedDesktop;
      if (!desktop) return null;
      return { ...desktop.state, processes: desktop.state.stopping ? [] : await desktop.kernel.enumProcs().catch(String), stats: Array.from(desktop.stats) };
    }).catch(String);
    writeFileSync(join(out, `${info.project.name}-pressure.json`), JSON.stringify({ pages, tracing, state, samples, errors }, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    await page.screenshot({ path: join(out, `${info.project.name}-pressure.png`) });
  }
});
