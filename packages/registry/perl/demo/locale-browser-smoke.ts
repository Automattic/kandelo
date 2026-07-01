/**
 * locale-browser-smoke.ts — kd-dvph Perl default-locale startup smoke in a real
 * browser (headless Chromium via Playwright + the browser-demos test-runner
 * page, which drives BrowserKernel).
 *
 * Confirms the fix is host-agnostic: the same perl.wasm that no longer panics
 * under the Node kernel host also starts cleanly under the browser kernel host
 * with the browser's default locale env. Runs `perl -e 'print "R=",2+3'` with:
 *   - no locale env (the disparate musl composite that used to panic), and
 *   - LANG=en_US.UTF-8 (the exact env live-setup.ts / browser-kernel-host.ts
 *     pass in the browser UI).
 *
 * Usage (needs playwright + a chromium build available):
 *   npx tsx packages/registry/perl/demo/locale-browser-smoke.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../../../..");
const BROWSER_DIR = resolve(repoRoot, "apps/browser-demos");
const VITE_PORT = 5207;
const ARITH = 'print "R=", 2 + 3, "\\n"';

interface Case { name: string; env: string[]; }
const CASES: Case[] = [
  { name: "unset-locale (no LC_ALL/LANG)", env: [] },
  { name: "LANG=en_US.UTF-8 (browser default)", env: ["LANG=en_US.UTF-8"] },
];

function startVite(): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "npx",
      ["vite", "--config", resolve(BROWSER_DIR, "vite.config.ts"), "--port", String(VITE_PORT)],
      { cwd: BROWSER_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    let started = false;
    const timer = setTimeout(() => { if (!started) { proc.kill(); reject(new Error("Vite did not start in 60s")); } }, 60_000);
    proc.stdout!.on("data", (d: Buffer) => {
      if (!started && d.toString().includes("Local:")) {
        started = true; clearTimeout(timer); setTimeout(() => resolvePromise(proc), 500);
      }
    });
    proc.on("exit", (code) => { if (!started) { clearTimeout(timer); reject(new Error(`Vite exited ${code}`)); } });
  });
}

async function runCase(page: Page, perlBytes: Buffer, c: Case) {
  return page.evaluate(
    async ({ bytes, argv, env }) => {
      const ab = new Uint8Array(bytes).buffer;
      return await (window as any).__runTest(ab, argv, 60_000, { env });
    },
    { bytes: Array.from(perlBytes), argv: ["perl", "-e", ARITH], env: c.env },
  );
}

async function main() {
  const perlWasm = resolve(repoRoot, "packages/registry/perl/bin/perl.wasm");
  if (!existsSync(perlWasm)) {
    console.error("perl.wasm not found. Run: bash packages/registry/perl/build-perl.sh");
    process.exit(1);
  }
  const perlBytes = readFileSync(perlWasm);

  let vite: ChildProcess | undefined;
  let browser: Browser | undefined;
  const passed: string[] = [];
  const failed: string[] = [];
  try {
    vite = await startVite();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/pages/test-runner/`);
    await page.waitForFunction(() => (window as any).__testRunnerReady === true, {}, { timeout: 60_000 });

    for (const c of CASES) {
      let r: any;
      try {
        r = await runCase(page, perlBytes, c);
      } catch (err) {
        failed.push(`${c.name}: threw ${String(err)}`);
        continue;
      }
      const ok = r.exitCode === 0 && (r.stdout || "").includes("R=5");
      const detail = `exit=${r.exitCode} stdout=${JSON.stringify((r.stdout || "").trim())} stderr=${JSON.stringify((r.stderr || "").trim())}`;
      (ok ? passed : failed).push(`${c.name}: ${detail}`);
    }
  } finally {
    if (browser) await browser.close();
    if (vite) vite.kill();
  }

  console.log("=== PASSED (browser) ===");
  for (const p of passed) console.log("  " + p);
  if (failed.length) { console.log("=== FAILED (browser) ==="); for (const f of failed) console.log("  " + f); }
  const ok = failed.length === 0 && passed.length === CASES.length;
  console.log(ok ? "PERL_LOCALE_BROWSER_SMOKE_PASS" : "PERL_LOCALE_BROWSER_SMOKE_FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
