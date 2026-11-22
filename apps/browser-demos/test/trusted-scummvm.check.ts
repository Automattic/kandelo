import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolveBinary } from '../../../host/src/binary-resolver';
import { expect, type Page } from '../playwright-test';
import { test } from './support/persistent-page';
import { CageSession } from './support/trusted-cage';
import { typePhysicalText } from './support/physical-typing';
import { setInternalsOpen } from './support/dock';
import { gotScenes, gotReadyColors, type GotSceneName, type GotSceneMask } from './fixtures/scummvm-got-scenes';

test.use({ headless: true, deviceScaleFactor: 1, viewport: { width: 1280, height: 840 } });

interface Pixels { width: number; height: number; data: Uint8Array }
const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as {
  PNG: { sync: { read(bytes: Buffer): Pixels } };
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

for (const scene of Object.values(gotScenes)) {
  if (!Number.isInteger(scene.w) || !Number.isInteger(scene.h) || scene.w <= 0 || scene.h <= 0
      || scene.rows.length !== Math.ceil(scene.w * scene.h / 4) || !/^[0-9a-f]+$/.test(scene.rows)) {
    throw new Error('Invalid authored God of Thunder scene mask');
  }
}

function foreground(pixels: Pixels, x: number, y: number, kind: GotSceneMask['kind']): boolean {
  const at = (y * pixels.width + x) * 4;
  const r = pixels.data[at], g = pixels.data[at + 1], b = pixels.data[at + 2];
  switch (kind) {
    case 'dark': return r < 100 && g < 100 && b < 100;
    case 'red': return r > 140 && r > g * 1.5 && r > b * 1.5;
    case 'blue': return b > 70 && b > r * 1.3 && b > g * 1.2;
    case 'yellow': return r > 100 && g > 100 && b < g * 0.7;
    case 'white': return r > 200 && g > 180 && b > 140;
  }
}

function sceneScore(bytes: Buffer, name: GotSceneName): number {
  const pixels = PNG.sync.read(bytes), scene = gotScenes[name];
  if (pixels.width !== 1280 || pixels.height !== 840 || scene.x + scene.w > pixels.width || scene.y + scene.h > pixels.height) {
    throw new Error('God of Thunder scene fixtures require the unscaled 1280×840 Cage viewport');
  }
  // Text already matches its mask during fade-in, before the next key is
  // accepted. These static full-color pixels distinguish the ready story.
  const anchors = gotReadyColors[name];
  if (anchors && !anchors.every(({ x, y, rgb }) => rgb.every((value, channel) =>
    Math.abs(value - pixels.data[(y * pixels.width + x) * 4 + channel]) <= 2))) return 0;
  let same = 0;
  for (let y = 0; y < scene.h; y++) for (let x = 0; x < scene.w; x++) {
    const bit = y * scene.w + x;
    const expected = (parseInt(scene.rows[bit >> 2], 16) & (8 >> (bit & 3))) !== 0;
    if (foreground(pixels, scene.x + x, scene.y + y, scene.kind) === expected) same++;
  }
  return same / (scene.w * scene.h);
}

function playerPosition(bytes: Buffer): number {
  const pixels = PNG.sync.read(bytes);
  let sum = 0, count = 0;
  for (let y = 295; y < 345; y++) for (let x = 500; x < 850; x++) {
    const at = (y * pixels.width + x) * 4;
    if (pixels.data[at] > 140 && pixels.data[at + 1] < 90 && pixels.data[at + 2] < 90) {
      sum += x; count++;
    }
  }
  if (count < 30 || count > 1000) throw new Error(`Missing or ambiguous red player hat: ${count}`);
  return sum / count;
}

async function readExitStatus(page: Page): Promise<string | null> {
  const row = page.locator('.ktable tbody tr').filter({
    has: page.locator('td:first-child', { hasText: /^scummvm-exit$/ }),
  }).first();
  const close = page.getByRole('button', { name: 'close', exact: true });
  if (await close.isVisible()) await close.click();
  // Every observation refreshes actual state. A single directory snapshot can
  // precede the foreground shell's asynchronous wait/echo handoff.
  await page.getByRole('button', { name: 'refresh', exact: true }).click();
  if (!await row.isVisible()) return null;
  await row.click();
  await expect(page.locator('pre')).toBeVisible();
  return page.locator('pre').textContent();
}

test('static ScummVM plays a game and quits cleanly through the normal Cage app', async ({ page }, info) => {
  test.setTimeout(300_000);
  const session = new CageSession(page, info);
  const consoleLog: string[] = [], kernelResponses: { url: string; sha256: string }[] = [], responseErrors: string[] = [];
  const phases: { name: string; at: number }[] = [];
  const expectedKernel = hash(readFileSync(resolveBinary('kernel.wasm')));
  let failure: unknown, gamePid = 0, retired = false;
  const phase = (name: string, details: Record<string, unknown> = {}) => {
    phases.push({ name, at: Date.now() });
    session.record({ stage: name, phases, ...details });
  };
  page.on('console', message => {
    if (consoleLog.length < 400) consoleLog.push(`${message.type()}: ${message.text().slice(0, 3000)}`);
  });
  page.on('response', response => {
    // Also accept hashed .wasm asset names used by normal production bundles.
    if (!new URL(response.url()).pathname.endsWith('.wasm')) return;
    void response.body().then(bytes => {
      if (bytes[0] === 0 && bytes[1] === 97 && bytes[2] === 115 && bytes[3] === 109 && kernelResponses.length < 64) {
        kernelResponses.push({ url: response.url(), sha256: hash(bytes) });
      }
    }).catch(error => responseErrors.push(String(error)));
  });
  const scene = async (name: GotSceneName) => {
    phase(`wait-${name}`);
    await expect.poll(async () => sceneScore(await page.screenshot({ timeout: 10_000 }), name),
      { timeout: 90_000 }).toBeGreaterThan(0.995);
    await session.screenshot(name);
    phase(`scene-${name}`);
  };
  const key = async (name: string, hold = 100) => {
    await session.graphics();
    await page.keyboard.down(name);
    try { await page.waitForTimeout(hold); }
    finally { await page.keyboard.up(name); }
  };
  try {
    phase('boot');
    await session.boot();
    await expect.poll(() => kernelResponses.map(response => response.sha256), { timeout: 30_000 }).toContain(expectedKernel);
    phase('launch-game', { expectedKernel, kernelResponses, responseErrors,
      scope: 'Normal SDK/package/image/Cage game, physical input, native exit status and cleanup; no audio or performance claim' });
    const foot = await page.screenshot({ timeout: 10_000 });
    expect(sceneScore(foot, 'world')).toBeLessThan(0.95);
    expect(sceneScore(foot, 'title')).toBeLessThan(0.95);
    await typePhysicalText(page, 'scummvm-static-play god-of-thunder; echo scummvm-exit-$? > /tmp/scummvm-exit');
    await page.keyboard.press('Enter');
    await expect.poll(async () => {
      const process = (await session.processes()).find(process => /\/usr\/libexec\/scummvm-static(?:\s|$)/.test(process.command)
        && !process.command.includes('--add') && / got(?:\s|$)/.test(process.command));
      return gamePid = process?.pid ?? 0;
    }, { timeout: 180_000 }).toBeGreaterThan(0);
    await session.graphics();
    await scene('title'); await key('Escape');
    await scene('main'); await key('Enter');
    await scene('parts'); await key('Enter');
    await scene('story1'); await key('Enter');
    await scene('story2'); await key('Enter');
    await scene('partTitle'); await scene('world');
    const before = playerPosition(await page.screenshot({ timeout: 10_000 }));
    await page.waitForTimeout(700); // No-input control for the movement oracle.
    const still = playerPosition(await page.screenshot({ timeout: 10_000 }));
    expect(Math.abs(still - before)).toBeLessThan(5);
    await key('ArrowRight', 700);
    let right = 0;
    await expect.poll(async () => right = playerPosition(await page.screenshot({ timeout: 10_000 })),
      { timeout: 10_000 }).toBeGreaterThan(before + 15);
    await session.screenshot('move-right');
    await key('ArrowLeft', 700);
    let left = 0;
    await expect.poll(async () => left = playerPosition(await page.screenshot({ timeout: 10_000 })),
      { timeout: 10_000 }).toBeLessThan(right - 15);
    await session.screenshot('move-left');
    phase('native-quit', { physicalMovement: { before, still, right, left }, gamePid });
    await key('Escape'); await scene('options');
    await key('ArrowUp'); await key('Enter'); await scene('quit');
    await key('ArrowUp'); await key('Enter'); await scene('save');
    await key('ArrowDown'); await key('Enter');
    await expect.poll(async () => (await session.processes()).some(process => process.pid === gamePid),
      { timeout: 60_000 }).toBe(false);
    retired = true;
    await setInternalsOpen(page, true);
    await page.getByRole('tab', { name: 'Syslog', exact: true }).click();
    phase('native-status', { guestDmesg: await page.locator('.ksys-line').allInnerTexts() });
    await session.graphics(); await session.screenshot('native-exit');
    await setInternalsOpen(page, true);
    await page.getByRole('tab', { name: 'VFS', exact: true }).click();
    await page.locator('.ktable tbody tr').filter({
      has: page.locator('td:first-child', { hasText: /^tmp\/$/ }),
    }).first().click();
    await expect.poll(async () => {
      const exitStatus = await readExitStatus(page);
      phase('native-status', { exitStatus, consoleLog });
      return exitStatus;
    }, { timeout: 30_000 }).toBe('scummvm-exit-0\n');
  } catch (error) {
    failure = error;
    phase('primary-failure', { primaryError: String(error), consoleLog, kernelResponses, responseErrors });
  }
  if (retired) {
    try {
      await session.graphics(); await session.typeProofAndExitFoot(); await session.assertQuiet();
      phase('cleanup-complete', { cleanup: 'physical Foot proof, exact process removal and Cage exit' });
    } catch (error) {
      phase('cleanup-failure', { cleanupError: String(error) });
      failure ??= error;
    }
  }
  await page.screenshot({ path: info.outputPath('last.png'), timeout: 5000 }).catch(() => {});
  if (failure) throw failure;
});
