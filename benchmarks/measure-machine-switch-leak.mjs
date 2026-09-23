/**
 * Measure how much memory a Kandelo tab retains per machine switch.
 *
 * Switching machines from the gallery is a full page navigation
 * (`navigateToGalleryItemUrl` calls `location.assign`), so the browser tears
 * the document down itself. On JavaScriptCore that does not reclaim workers
 * parked in `Atomics.wait` — see
 * docs/jsc-terminate-atomics-wait-workaround.md — and the tab grows until it
 * throws "Out of memory". This harness makes that growth a number.
 *
 * Usage, against a running `./run.sh browser --port <n> --strictPort`:
 *
 *   BASE=http://127.0.0.1:5781 ROUNDS=8 node benchmarks/measure-machine-switch-leak.mjs
 *
 * Env:
 *   BASE    dev server origin (default http://127.0.0.1:5781)
 *   DEMOS   comma-separated demo ids to alternate (default shell,modeset)
 *   ROUNDS  navigations to perform (default 8)
 *   ENGINE  webkit | chromium (default webkit — JSC is where this reproduces)
 *
 * Read the SAME-DEMO series, not the raw sequence: alternating demos have
 * different footprints, so consecutive rounds are not comparable. The script
 * prints a per-demo slope for that reason.
 */

import { chromium, webkit } from 'playwright';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:5781';
const DEMOS = (process.env.DEMOS || 'shell,modeset').split(',');
const ROUNDS = Number(process.env.ROUNDS || 8);
const ENGINE = process.env.ENGINE === 'chromium' ? chromium : webkit;
const ENGINE_NAME = process.env.ENGINE === 'chromium' ? 'chromium' : 'webkit';

/**
 * Resident memory of the browser this harness launched.
 *
 * Matches on the Playwright browser cache path so a developer's own Safari —
 * or a peer worktree's browser — is never counted. Getting this filter wrong
 * silently measures someone else's memory.
 */
function browserRssMiB() {
  const out = execSync(
    `ps -Ao rss,comm | grep ms-playwright | grep -i ${ENGINE_NAME} | grep -v grep || true`,
    { encoding: 'utf8' },
  );
  let rss = 0;
  let procs = 0;
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s/);
    if (m) {
      rss += Number(m[1]);
      procs++;
    }
  }
  return { rssMiB: Math.round(rss / 1024), procs };
}

const browser = await ENGINE.launch();
const page = await browser.newPage();
const rows = [];
for (let i = 0; i < ROUNDS; i++) {
  const demo = DEMOS[i % DEMOS.length];
  await page.goto(`${BASE}/?demo=${demo}`, { waitUntil: 'domcontentloaded' });
  // Wait until the machine is actually up: its workers only park in
  // Atomics.wait once they are serving syscalls, and that parked state is
  // what the leak is about. Measuring a half-booted machine measures nothing.
  let booted = true;
  try {
    await page.waitForFunction(
      () => /RUNNING|bash-|MODESET/.test(document.body.innerText),
      { timeout: 45_000 },
    );
  } catch {
    booted = false;
  }
  await page.waitForTimeout(2_500);
  rows.push({ round: i + 1, demo, booted, ...browserRssMiB() });
  console.log(JSON.stringify(rows.at(-1)));
}
await browser.close();

console.log('\n=== per-demo series (compare these, not raw rounds) ===');
for (const demo of DEMOS) {
  const series = rows.filter((r) => r.demo === demo).map((r) => r.rssMiB);
  if (series.length < 2) continue;
  const slope = (series.at(-1) - series[0]) / (series.length - 1);
  console.log(
    `${demo}: ${series.join(' -> ')} MiB  (${slope >= 0 ? '+' : ''}${slope.toFixed(0)} MiB per cycle)`,
  );
}
const notBooted = rows.filter((r) => !r.booted).length;
if (notBooted > 0) {
  console.log(`\nWARNING: ${notBooted} round(s) never reached a booted machine;`);
  console.log('those samples do not measure a parked-worker teardown.');
}
