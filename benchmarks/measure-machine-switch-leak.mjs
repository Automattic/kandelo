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
 *   ROUNDS  switches to perform (default 8)
 *   ENGINE  webkit | chromium (default webkit — JSC is where this reproduces)
 *   GALLERY_INDEX  pin one gallery item (gallery mode) so each round repeats
 *                  an identical boot; omit to rotate through the gallery
 *   SETTLE_MS      ms to wait before sampling (default 25000; see below)
 *   MODE    navigate | gallery (default navigate)
 *             navigate — page.goto each round, i.e. what typing a URL or
 *                        reloading does. Still expected to leak.
 *             gallery  — drive the in-page gallery launch, which is the path
 *                        the product uses. Expected to hold flat.
 *
 * WATCH THREAD COUNT, NOT RSS. A leaked worker never releases its OS thread,
 * so thread count rises monotonically; RSS wobbles because ordinary heap is
 * still collected around it. Reading RSS alone produced non-monotonic series
 * that looked like noise and hid the signal.
 *
 * For RSS, read the SAME-DEMO series rather than the raw sequence: alternating
 * demos have different footprints, so consecutive rounds are not comparable.
 */

import { chromium, webkit } from 'playwright';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:5781';
const DEMOS = (process.env.DEMOS || 'shell,modeset').split(',');
const ROUNDS = Number(process.env.ROUNDS || 8);
const ENGINE = process.env.ENGINE === 'chromium' ? chromium : webkit;
const ENGINE_NAME = process.env.ENGINE === 'chromium' ? 'chromium' : 'webkit';
const MODE = process.env.MODE === 'gallery' ? 'gallery' : 'navigate';
/**
 * Settle time before sampling, in ms.
 *
 * CRITICAL: reclamation of a torn-down machine's workers is SLOW — measured at
 * roughly 13 seconds after a switch on WebKit. Sampling sooner measures both
 * machines at once and reports a leak that is really a transient. The default
 * is deliberately generous; lower it only if you have re-established that
 * reclamation has landed by then.
 */
const SETTLE_MS = Number(process.env.SETTLE_MS || 25_000);
// Pin one gallery item so every round boots the same machine. Rotating items
// changes the worker count between rounds, which makes thread counts
// incomparable — the comparison against `navigate` mode only means something
// when both repeat an identical boot.
const GALLERY_INDEX = process.env.GALLERY_INDEX === undefined
  ? null
  : Number(process.env.GALLERY_INDEX);

/**
 * Resident memory of the browser this harness launched.
 *
 * Matches on the Playwright browser cache path so a developer's own Safari —
 * or a peer worktree's browser — is never counted. Getting this filter wrong
 * silently measures someone else's memory.
 */
/**
 * Threads in the page's content process — the number that actually moves.
 *
 * Pinned to the largest web process so a later sample cannot silently
 * describe a different one. Excludes the networking and GPU processes, which
 * stayed flat in every run.
 */
function pageProcess() {
  const out = execSync(
    `ps -Ao pid,rss,comm | grep ms-playwright | grep -i ${ENGINE_NAME} | grep -iv networking | grep -iv gpu | grep -v grep || true`,
    { encoding: 'utf8' },
  );
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s/);
    if (m) list.push({ pid: Number(m[1]), mib: Math.round(Number(m[2]) / 1024) });
  }
  list.sort((a, b) => b.mib - a.mib);
  const top = list[0];
  if (!top) return { pid: -1, mib: 0, threads: -1 };
  const threads = Number(
    execSync(`ps -M ${top.pid} | tail -n +2 | wc -l`, { encoding: 'utf8' }).trim(),
  );
  return { ...top, threads };
}

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
// `gallery` mode needs a machine to start from before it can switch.
if (MODE === 'gallery') {
  await page.goto(`${BASE}/?demo=${DEMOS[0]}`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => /RUNNING|bash-|MODESET/.test(document.body.innerText), {
      timeout: 60_000,
    })
    .catch(() => {});
  await page.waitForTimeout(2_500);
}

for (let i = 0; i < ROUNDS; i++) {
  const demo = DEMOS[i % DEMOS.length];
  if (MODE === 'gallery') {
    await page.locator('button', { hasText: /^New$/ }).first().click();
    await page.waitForTimeout(1_200);
    const launches = page.locator('button', { hasText: /^Launch$/ });
    const n = await launches.count();
    if (n === 0) throw new Error('gallery mode: no Launch buttons found');
    await launches.nth(GALLERY_INDEX ?? i % n).click();
  } else {
    await page.goto(`${BASE}/?demo=${demo}`, { waitUntil: 'domcontentloaded' });
  }
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
  await page.waitForTimeout(SETTLE_MS);
  const proc = pageProcess();
  rows.push({
    round: i + 1,
    demo,
    booted,
    threads: proc.threads,
    pagePid: proc.pid,
    ...browserRssMiB(),
  });
  console.log(JSON.stringify(rows.at(-1)));
}
await browser.close();

const threads = rows.map((r) => r.threads);
const monotonic = threads.every((v, i) => i === 0 || v >= threads[i - 1]);
const pinned = new Set(rows.map((r) => r.pagePid)).size === 1;
console.log('\n=== threads in the page process (the signal) ===');
console.log(`  ${threads.join(' -> ')}`);
console.log(
  `  ${threads.at(-1) - threads[0] >= 0 ? '+' : ''}${
    ((threads.at(-1) - threads[0]) / Math.max(1, threads.length - 1)).toFixed(1)
  } per switch, monotonic=${monotonic}, same process throughout=${pinned}`,
);
if (!pinned) {
  console.log('  NOTE: the page process changed mid-run; thread counts across');
  console.log('  rounds describe different processes and are not comparable.');
}
console.log(monotonic && threads.at(-1) > threads[0]
  ? '  VERDICT: leaking — workers are not being released.'
  : '  VERDICT: flat — no thread leak detected in this run.');

console.log('\n=== per-demo RSS (noisy; secondary to thread count) ===');
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
