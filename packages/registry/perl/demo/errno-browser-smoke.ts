/**
 * errno-browser-smoke.ts — kd-gtxa Perl `use Errno` smoke in a real browser
 * (headless Chromium via Playwright + the browser-demos test-runner page, which
 * drives BrowserKernel).
 *
 * Confirms the fix is host-agnostic: the same perl.wasm + generated Errno.pm
 * that pass under the Node kernel host also load under the browser kernel host.
 * Errno.pm is pure-perl constants; loading it is an @INC VFS file-read, the
 * identical path that loads Config/File::Spec/POSIX under both hosts. Here we
 * inject the minimal `use Errno` load-closure (empirically Errno.pm, Config.pm,
 * Config_heavy.pl, Exporter.pm, strict.pm, warnings.pm -- all flat in
 * perl-src/lib) into a PERL5LIB dir in the browser VFS and run the same
 * constant/tie assertions as the Node smoke.
 *
 * Runs the real thing when the browser asset bundle is present; otherwise
 * SKIPS with a reason (exit 0) rather than failing -- the full browser stdlib
 * bundle (kernel + dash/coreutils/grep/sed/gencat + perl.vfs) is tracked by
 * kd-yuef, the same boundary #821 defers browser/bottle acceptance to.
 *
 * Usage (needs playwright + a chromium build available):
 *   npx tsx packages/registry/perl/demo/errno-browser-smoke.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../../../..");
const BROWSER_DIR = resolve(repoRoot, "apps/browser-demos");
const LIB = resolve(repoRoot, "packages/registry/perl/perl-src/lib");
const VITE_PORT = 5208;

// The empirically-determined `use Errno` load closure (via %INC under Node).
// All flat in perl-src/lib; injected into /plib and reached via PERL5LIB=/plib.
const CLOSURE = [
  "Errno.pm", "Config.pm", "Config_heavy.pl",
  "Exporter.pm", "strict.pm", "warnings.pm",
];

// Assertions mirror the Node smoke (exact musl values + the %! tie). Constants
// are called via dynamic method dispatch (Errno->$name()) so there is no
// compile-time "called too early to check prototype" warning. In JS
// double-quoted strings $ and @ are literal; only " and perl's \n are escaped.
const PROG = [
  "use strict; no warnings 'prototype';",
  "require Errno;",
  "my @r;",
  "push @r, 'use_Errno=' . ($INC{'Errno.pm'} ? 'ok' : 'FAIL');",
  "for my $p ([EPERM=>1],[ENOENT=>2],[EACCES=>13],[EINVAL=>22],[EAGAIN=>11]) {",
  "  my ($n,$v) = @$p; my $g = Errno->can($n) ? Errno->$n() : -1;",
  "  push @r, \"$n=\" . ($g==$v ? 'ok' : \"FAIL($g)\");",
  "}",
  "my $c = grep { Errno->can($_) } @Errno::EXPORT_OK;",
  "push @r, 'count=' . ($c>=100 ? 'ok' : \"FAIL($c)\");",
  "{ local $! = Errno::ENOENT(); push @r, 'tie=' . (($!{ENOENT} && !$!{EACCES}) ? 'ok' : 'FAIL'); }",
  "print 'RESULTS=', join(',', @r), \"\\n\";",
  "print((grep { $_ !~ /=ok$/ } @r) ? \"PERL_ERRNO_BROWSER_SMOKE_FAIL\\n\" : \"PERL_ERRNO_BROWSER_SMOKE_PASS\\n\");",
].join("\n");

function skip(reason: string): never {
  console.log(`PERL_ERRNO_BROWSER_SMOKE_SKIP: ${reason}`);
  process.exit(0);
}

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

async function main() {
  const perlWasm = resolve(repoRoot, "packages/registry/perl/bin/perl.wasm");
  if (!existsSync(perlWasm)) skip("perl.wasm not built (run build-perl.sh)");
  const missing = CLOSURE.filter((f) => !existsSync(resolve(LIB, f)));
  if (missing.length) skip(`perl runtime lib missing ${missing.join(",")} (run build-perl.sh)`);

  // Playwright + chromium are optional in some environments.
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    skip("playwright not installed");
  }

  const perlBytes = readFileSync(perlWasm);
  const dataFiles = CLOSURE.map((f) => ({
    path: `/plib/${f}`,
    data: Array.from(readFileSync(resolve(LIB, f))),
  }));

  let vite: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    try {
      vite = await startVite();
    } catch (e) {
      skip(`vite dev server unavailable: ${String(e)}`);
    }
    try {
      browser = await chromium.launch();
    } catch (e) {
      skip(`chromium unavailable: ${String(e)}`);
    }
    const page = await browser!.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/pages/test-runner/`);
    try {
      await page.waitForFunction(() => (window as any).__testRunnerReady === true, {}, { timeout: 60_000 });
    } catch {
      skip("test-runner did not initialize (browser asset bundle incomplete: kernel/dash/coreutils/grep/sed/gencat wasm) -- tracked by kd-yuef");
    }

    const r: any = await page.evaluate(
      async ({ bytes, argv, env, files }) => {
        const ab = new Uint8Array(bytes).buffer;
        return await (window as any).__runTest(ab, argv, 60_000, { env, dataFiles: files });
      },
      {
        bytes: Array.from(perlBytes),
        argv: ["perl", "-e", PROG],
        env: ["PERL5LIB=/plib", "LC_ALL=C", "HOME=/tmp", "TMPDIR=/tmp"],
        files: dataFiles,
      },
    );

    const stdout = (r.stdout || "").trim();
    console.log(`exit=${r.exitCode}`);
    console.log(stdout);
    if (r.stderr) console.log("STDERR:", r.stderr.trim());
    const ok = r.exitCode === 0 && stdout.includes("PERL_ERRNO_BROWSER_SMOKE_PASS");
    console.log(ok ? "BROWSER_SMOKE_OK" : "BROWSER_SMOKE_FAIL");
    process.exit(ok ? 0 : 1);
  } finally {
    if (browser) await browser.close();
    if (vite) vite.kill();
  }
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
