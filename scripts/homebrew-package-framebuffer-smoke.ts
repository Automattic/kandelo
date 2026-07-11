/**
 * Framebuffer/device browser smoke for Kandelo Homebrew package sidecars.
 *
 * Sibling to homebrew-package-browser-smoke.ts, but for graphical/device
 * programs that render through /dev/fb0 (fbdoom) or /dev/dri/card0 (modeset)
 * rather than a terminal. It pours the Homebrew VFS for the requested package
 * (injecting the DOOM shareware IWAD for fbdoom), boots it through
 * BrowserKernel in headless Chromium, and observes the FramebufferRegistry for
 * bind + pixel-write activity. A program that binds a framebuffer and pushes
 * writes has reached the browser display path.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { ABI_VERSION } from "../host/src/generated/abi";
import type {
  HomebrewBottleArch,
  HomebrewTapMetadata,
  HomebrewVfsPackagePlan,
} from "../host/src/homebrew-vfs-planner";
import {
  countOutcomes,
  SkipCase,
  writeOutcomeLists,
  type SmokeOutcome,
} from "./homebrew-smoke-outcomes";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const browserDemoDir = join(repoRoot, "apps", "browser-demos");
const publicSmokeRoot = join(browserDemoDir, "public", "__kandelo-homebrew-fb-smoke");
const publicSmokePath = "/__kandelo-homebrew-fb-smoke";

interface FbSpec {
  argv: string[];
  device: string;
  mode: "fb" | "kms";
  needsWad: boolean;
  minWrites: number;
  description: string;
}

const FB_SPECS: Record<string, FbSpec> = {
  fbdoom: {
    argv: ["/home/linuxbrew/.linuxbrew/bin/fbdoom", "-iwad", "/doom1.wad"],
    device: "/dev/fb0",
    mode: "fb",
    needsWad: true,
    minWrites: 1,
    description: "fbdoom renders DOOM to /dev/fb0 from the poured Homebrew keg + shareware IWAD.",
  },
  modeset: {
    argv: ["/home/linuxbrew/.linuxbrew/bin/modeset"],
    device: "/dev/dri/card0",
    mode: "kms",
    needsWad: false,
    minWrites: 1,
    description: "modeset drives an EGL/GLES fluid sim through /dev/dri/card0 page flips.",
  },
};

interface CliOptions {
  resultDir: string;
  tapRoot: string;
  formulas: string[];
  arch: HomebrewBottleArch;
  bottleCache: string;
  wadFile: string;
  observeMs: number;
  maxBytes: number;
  beadId: string;
  port: number;
  runId: string;
  browserChannel: string;
}

interface FbSmokeResult {
  mode: "fb" | "kms";
  binds: number;
  unbinds: number;
  writes: number;
  writeBytes: number;
  kmsBlits: number;
  kmsCommits: number;
  boundPid: number | null;
  width: number;
  height: number;
  fmt: string | null;
  canvasNonBlankPixels: number;
  exitedEarly: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    usage(2, `${flag} requires a value`);
  }
  return value;
}

function usage(code: number, message?: string): never {
  if (message) process.stderr.write(`homebrew-package-framebuffer-smoke: ${message}\n`);
  process.stderr.write(
    "usage: npx tsx scripts/homebrew-package-framebuffer-smoke.ts --tap-root <dir> " +
      "--formula <fbdoom|modeset> [--formula ...] --arch wasm32 --result-dir <dir> " +
      "[--bottle-cache <dir>] [--wad-file <doom1.wad>] [--observe-ms N] [--port N] [--bead-id ID]\n",
  );
  process.exit(code);
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    resultDir: "",
    tapRoot: "",
    formulas: [],
    arch: "wasm32",
    bottleCache: "",
    wadFile: "",
    observeMs: 12_000,
    maxBytes: 256 * 1024 * 1024,
    beadId: process.env.KANDELO_BEAD_ID || "kd-k3l9",
    port: Number(process.env.KANDELO_PLAYWRIGHT_PORT ?? 5411),
    runId: "",
    browserChannel: process.env.KANDELO_PLAYWRIGHT_CHANNEL || "chromium",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--result-dir": options.resultDir = requireValue(argv, ++i, arg); break;
      case "--tap-root": options.tapRoot = requireValue(argv, ++i, arg); break;
      case "--formula": options.formulas.push(requireValue(argv, ++i, arg)); break;
      case "--arch": options.arch = requireValue(argv, ++i, arg) as HomebrewBottleArch; break;
      case "--bottle-cache": options.bottleCache = requireValue(argv, ++i, arg); break;
      case "--wad-file": options.wadFile = requireValue(argv, ++i, arg); break;
      case "--observe-ms": options.observeMs = Number(requireValue(argv, ++i, arg)); break;
      case "--bead-id": options.beadId = requireValue(argv, ++i, arg); break;
      case "--port": options.port = Number(requireValue(argv, ++i, arg)); break;
      case "--run-id": options.runId = requireValue(argv, ++i, arg); break;
      case "--browser-channel": options.browserChannel = requireValue(argv, ++i, arg); break;
      case "-h": case "--help": usage(0); break;
      default: usage(2, `unexpected argument ${arg}`);
    }
  }
  if (!options.tapRoot) usage(2, "--tap-root is required");
  if (!options.resultDir) usage(2, "--result-dir is required");
  if (options.formulas.length === 0) usage(2, "at least one --formula is required");
  for (const f of options.formulas) {
    if (!(f in FB_SPECS)) usage(2, `unsupported --formula ${f}; supported: ${Object.keys(FB_SPECS).join(", ")}`);
  }
  if (options.arch !== "wasm32") usage(2, "framebuffer smoke only supports --arch wasm32");
  options.resultDir = resolve(options.resultDir);
  options.tapRoot = resolve(options.tapRoot);
  options.bottleCache = options.bottleCache ? resolve(options.bottleCache) : join(options.resultDir, "bottle-cache");
  if (options.wadFile) options.wadFile = resolve(options.wadFile);
  options.runId ||= `${options.beadId}-fb-${process.pid}`;
  return options;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function createFs(
  MemoryFileSystemCtor: { create(sab: SharedArrayBuffer, maxBytes?: number): unknown },
  maxBytes: number,
): unknown {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  return MemoryFileSystemCtor.create(new SharedArrayBufferCtor(maxBytes, { maxByteLength: maxBytes }), maxBytes);
}

async function loadBottleBytes(pkg: HomebrewVfsPackagePlan, options: CliOptions): Promise<Uint8Array> {
  if (pkg.url.startsWith("file://")) {
    return new Uint8Array(readFileSync(fileURLToPath(pkg.url)));
  }
  const cachePath = join(options.bottleCache, `${pkg.sha256}.tar.gz`);
  if (existsSync(cachePath)) return new Uint8Array(readFileSync(cachePath));
  if (!pkg.url.startsWith("https://")) {
    throw new Error(`package ${pkg.name}@${pkg.version} bottle URL must be https:// or file://, got ${pkg.url}`);
  }
  const { fetchHomebrewBottleBytes } = await import("../host/src/homebrew-vfs-fetch");
  const bytes = await fetchHomebrewBottleBytes(pkg.url);
  mkdirSync(options.bottleCache, { recursive: true });
  writeFileSync(cachePath, bytes);
  return bytes;
}

interface BuiltFbVfs {
  formula: string;
  imagePath: string;
  publicUrl: string;
}

async function buildFormulaVfs(
  metadata: HomebrewTapMetadata,
  formula: string,
  options: CliOptions,
): Promise<BuiltFbVfs> {
  const [{ buildHomebrewVfs }, { planHomebrewVfs }, { MemoryFileSystem }, helpers] = await Promise.all([
    import("../host/src/homebrew-vfs-builder"),
    import("../host/src/homebrew-vfs-planner"),
    import("../host/src/vfs/memory-fs"),
    import("../images/vfs/scripts/vfs-image-helpers"),
  ]);
  const plan = await planHomebrewVfs(metadata, {
    packages: [formula],
    arch: options.arch,
    expectedAbi: ABI_VERSION,
    loadLinkManifest: (relPath: string) => readJsonFile(join(options.tapRoot, relPath)),
  });
  const fs = createFs(MemoryFileSystem as unknown as { create(sab: SharedArrayBuffer, maxBytes?: number): unknown }, options.maxBytes);
  const result = await buildHomebrewVfs(plan, {
    fs: fs as never,
    createdBy: "scripts/homebrew-package-framebuffer-smoke.ts",
    loadBottleBytes: (pkg: HomebrewVfsPackagePlan) => loadBottleBytes(pkg, options),
  });

  const spec = FB_SPECS[formula];
  if (spec.needsWad) {
    if (!options.wadFile || !existsSync(options.wadFile)) {
      throw new SkipCase(`${formula} requires the DOOM shareware IWAD; pass --wad-file <doom1.wad> (fetch ${"https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad"})`);
    }
    const wadBytes = new Uint8Array(readFileSync(options.wadFile));
    helpers.writeVfsBinary(fs, "/doom1.wad", wadBytes, 0o644);
  }

  const dir = join(options.resultDir, `${formula}-${options.arch}`);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `${formula}-${options.arch}-homebrew-vfs-report.json`);
  const imagePath = join(dir, `${formula}-${options.arch}-homebrew.vfs.zst`);
  writeFileSync(reportPath, `${JSON.stringify({ ...result.report, image: imagePath }, null, 2)}\n`);
  await helpers.saveImage(fs, imagePath, {
    metadata: {
      version: 1,
      kernelAbi: plan.kandeloAbi,
      createdBy: "scripts/homebrew-package-framebuffer-smoke.ts",
    },
  });

  const publicDir = join(publicSmokeRoot, options.runId);
  mkdirSync(publicDir, { recursive: true });
  copyFileSync(imagePath, join(publicDir, basename(imagePath)));
  const publicUrl = `http://127.0.0.1:${options.port}${publicSmokePath}/${encodeURIComponent(options.runId)}/${encodeURIComponent(basename(imagePath))}`;
  return { formula, imagePath, publicUrl };
}

async function startViteServer(options: CliOptions): Promise<ChildProcess> {
  const logPath = join(options.resultDir, "vite.log");
  writeFileSync(logPath, "");
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("npx", [
      "vite", "--config", join(browserDemoDir, "vite.config.ts"),
      "--host", "127.0.0.1", "--port", String(options.port), "--strictPort",
    ], {
      cwd: browserDemoDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        KANDELO_BROWSER_TEST_NO_HMR: "1",
        KANDELO_BROWSER_DEMO_INPUTS: "homebrew-fb-smoke",
        KANDELO_PLAYWRIGHT_PORT: String(options.port),
      },
    });
    let started = false;
    const timeout = setTimeout(() => {
      if (!started) { proc.kill(); reject(new Error(`Vite did not start within 30000ms; see ${logPath}`)); }
    }, 30_000);
    const onData = (data: Buffer) => {
      const text = data.toString();
      appendFileSync(logPath, text);
      if (!started && /Local:\s+http:\/\/127\.0\.0\.1:/.test(text)) {
        started = true; clearTimeout(timeout); setTimeout(() => resolvePromise(proc), 500);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => { if (!started) { clearTimeout(timeout); reject(new Error(`Vite exited with code ${code}; see ${logPath}`)); } });
  });
}

function evaluateOutcome(formula: string, result: FbSmokeResult, screenshotBytes: number): { ok: boolean; detail: string } {
  const spec = FB_SPECS[formula];
  if (spec.mode === "kms") {
    const detail = `kmsCommits=${result.kmsCommits} kmsBlits=${result.kmsBlits} ` +
      `dims=${result.width}x${result.height} screenshotBytes=${screenshotBytes} ` +
      `exitedEarly=${result.exitedEarly} exit=${result.exitCode ?? "-"}`;
    // A page-flip/commit through the CRTC + a non-trivial scanout means modeset
    // reached the browser display path via /dev/dri/card0 + WebGL2.
    const ok = (result.kmsCommits >= 1 || result.kmsBlits >= 1) && result.width > 0 && result.height > 0;
    return { ok, detail };
  }
  const detail = `binds=${result.binds} writes=${result.writes} writeBytes=${result.writeBytes} ` +
    `dims=${result.width}x${result.height} canvasNonBlank=${result.canvasNonBlankPixels} ` +
    `screenshotBytes=${screenshotBytes} exitedEarly=${result.exitedEarly} exit=${result.exitCode ?? "-"}`;
  const ok = result.binds >= 1 && result.writes >= spec.minWrites && result.canvasNonBlankPixels > 0;
  return { ok, detail };
}

async function runCase(
  outcomes: SmokeOutcome[],
  name: string,
  fn: () => Promise<string>,
  artifactPath: string,
): Promise<void> {
  const started = Date.now();
  try {
    const details = await fn();
    outcomes.push({ name, status: "pass", durationMs: Date.now() - started, details, artifactPath });
  } catch (error) {
    const skipped = error instanceof SkipCase;
    const message = error instanceof Error ? error.message : String(error);
    outcomes.push({
      name,
      status: skipped ? "skip" : "fail",
      durationMs: Date.now() - started,
      details: message,
      ...(skipped ? {} : { error: error instanceof Error ? (error.stack ?? message) : message }),
      artifactPath,
    });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  mkdirSync(options.resultDir, { recursive: true });
  const publicRunDir = join(publicSmokeRoot, options.runId);
  const metadataPath = join(options.tapRoot, "Kandelo", "metadata.json");
  const metadata = readJsonFile<HomebrewTapMetadata>(metadataPath);
  const outcomes: SmokeOutcome[] = [];
  const resultsByFormula: Record<string, FbSmokeResult | null> = {};
  const built = new Map<string, BuiltFbVfs>();

  try {
    for (const formula of options.formulas) {
      await runCase(outcomes, `homebrew_fb_vfs_build_${formula}`, async () => {
        const b = await buildFormulaVfs(metadata, formula, options);
        built.set(formula, b);
        return `image=${b.imagePath}; browser_url=${b.publicUrl}`;
      }, join(options.resultDir, `${formula}-${options.arch}`));
    }

    let vite: ChildProcess | undefined;
    let browser: Browser | undefined;
    await runCase(outcomes, "browser_server_start", async () => {
      vite = await startViteServer(options);
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ channel: options.browserChannel, headless: true });
      return `vite=http://127.0.0.1:${options.port}`;
    }, join(options.resultDir, "vite.log"));

    try {
      for (const formula of options.formulas) {
        const spec = FB_SPECS[formula];
        await runCase(outcomes, `fb_smoke_${formula}`, async () => {
          const b = built.get(formula);
          if (!b) throw new SkipCase(`requires successful homebrew_fb_vfs_build_${formula}`);
          if (!browser) throw new Error("browser did not start");
          const context = await browser.newContext();
          const page = await context.newPage();
          const consoleErrors: string[] = [];
          page.on("pageerror", (err) => consoleErrors.push(err.message));
          page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
          try {
            await page.goto(`http://127.0.0.1:${options.port}/pages/homebrew-fb-smoke/`, {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            });
            await page.waitForFunction(() => (window as unknown as { __homebrewFbSmokeReady?: boolean }).__homebrewFbSmokeReady === true, undefined, { timeout: 60_000 });
            const dir = join(options.resultDir, `${formula}-${options.arch}`);
            // Screenshot mid-run (page.evaluate blocks until the smoke ends and
            // tears down the canvas), captured on a timer that fires during the
            // observation window.
            const shotPath = join(dir, `${formula}-fb.png`);
            const shotTimer = setTimeout(() => {
              page.screenshot({ path: shotPath }).catch(() => {});
            }, Math.min(options.observeMs, 8_000));
            const result = (await page.evaluate(
              async ({ vfsUrl, argv, observeMs, mode, crtcId }) =>
                (window as unknown as { __runHomebrewFbSmoke: (r: unknown) => Promise<FbSmokeResult> }).__runHomebrewFbSmoke({ vfsUrl, argv, observeMs, mode, crtcId }),
              { vfsUrl: b.publicUrl, argv: spec.argv, observeMs: options.observeMs, mode: spec.mode, crtcId: 1 },
            )) as FbSmokeResult;
            clearTimeout(shotTimer);
            resultsByFormula[formula] = result;
            writeFileSync(join(dir, `${formula}-fb-result.json`), `${JSON.stringify({ ...result, consoleErrors }, null, 2)}\n`);
            const screenshotBytes = existsSync(shotPath) ? readFileSync(shotPath).length : 0;
            const { ok, detail } = evaluateOutcome(formula, result, screenshotBytes);
            if (!ok) {
              throw new Error(`${formula} did not demonstrate ${spec.device} activity (${detail}); consoleErrors=${JSON.stringify(consoleErrors.slice(0, 3))}`);
            }
            return `${detail}; device=${spec.device}`;
          } finally {
            await context.close().catch(() => {});
          }
        }, join(options.resultDir, `${formula}-${options.arch}`, `${formula}-fb-result.json`));
      }
    } finally {
      await browser?.close().catch(() => {});
      if (vite) { vite.kill("SIGTERM"); }
    }
  } finally {
    rmSync(publicRunDir, { recursive: true, force: true });
  }

  const counts = countOutcomes(outcomes);
  const summary = {
    suite: "Homebrew package framebuffer/device browser smoke",
    bead_id: options.beadId,
    arch: options.arch,
    tap_root: options.tapRoot,
    formulas: options.formulas,
    counts,
    outcomes,
    results: resultsByFormula,
  };
  writeFileSync(join(options.resultDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeOutcomeLists(options.resultDir, outcomes, { includeArtifactPath: true });
  process.stdout.write(`framebuffer smoke: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip\n`);
  if (counts.fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
