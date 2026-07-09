/**
 * Browser smoke coverage for Kandelo Homebrew package sidecars.
 *
 * The runner consumes generated Kandelo/Homebrew sidecars, materializes each
 * requested wasm32 package into a candidate VFS without requiring existing
 * browser-compatible metadata, boots that image through BrowserKernel in
 * Chromium, and runs package-specific checks.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
import type { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import {
  HOMEBREW_CELLAR,
  browserSmokeCasesForFormula,
  browserUnsupportedReason,
  parseHomebrewSmokeFormula,
  SQLITE_BROWSER_CONSUMER_PATH,
  ZLIB_BROWSER_CONSUMER_PATH,
  type BrowserSmokeCase,
  type HomebrewSmokeFormula,
} from "./homebrew-package-smoke-cases";
import {
  countOutcomes,
  SkipCase,
  type SmokeOutcome,
  writeOutcomeLists,
} from "./homebrew-smoke-outcomes";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const browserDemoDir = join(repoRoot, "apps", "browser-demos");
const publicSmokeRoot = join(browserDemoDir, "public", "__kandelo-homebrew-smoke");
const publicSmokePath = "/__kandelo-homebrew-smoke";

interface CliOptions {
  resultDir: string;
  tapRoot: string;
  formulas: HomebrewSmokeFormula[];
  arch: HomebrewBottleArch;
  bottleCache: string;
  timeoutMs: number;
  maxBytes: number;
  beadId: string;
  port: number;
  runId: string;
  browserChannel: string;
}

interface BuiltBrowserVfs {
  formula: HomebrewSmokeFormula;
  fs: MemoryFileSystem;
  imagePath: string;
  reportPath: string;
  publicPath: string;
  publicUrl: string;
}

interface BrowserDiagnostics {
  console: string[];
  pageErrors: string[];
  requestFailures: string[];
}

interface BrowserSmokeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  durationMs: number;
}

type PackageStatus = "success" | "failed" | "skipped";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.resultDir, { recursive: true });
  mkdirSync(join(options.resultDir, "outcome-lists"), { recursive: true });
  mkdirSync(options.bottleCache, { recursive: true });

  const unsupportedReason = browserUnsupportedReason(options.arch);
  const metadataPath = join(options.tapRoot, "Kandelo", "metadata.json");
  const metadata = unsupportedReason ? undefined : readJsonFile<HomebrewTapMetadata>(metadataPath);
  const tapCommit = tryGitRevParse(options.tapRoot) ?? metadata?.tap_commit ?? "unknown";
  const startedAt = new Date();
  const outcomes: SmokeOutcome[] = [];
  const builtByFormula = new Map<HomebrewSmokeFormula, BuiltBrowserVfs>();
  const publicRunDir = join(publicSmokeRoot, options.runId);

  writeCurrentRun(options, {
    status: "running",
    startedAt,
    tapCommit,
    outcomes,
    currentCase: "startup",
  });

  try {
    if (unsupportedReason) {
      for (const formula of options.formulas) {
        await runCase(outcomes, options, tapCommit, `browser_smoke_${formula}_unsupported_arch`, async () => {
          throw new SkipCase(unsupportedReason);
        }, formulaDir(options, formula));
      }
    } else {
      mkdirSync(publicRunDir, { recursive: true });
      for (const formula of options.formulas) {
        await runCase(outcomes, options, tapCommit, `homebrew_browser_vfs_build_${formula}`, async () => {
          if (!metadata) throw new Error(`missing Homebrew metadata: ${metadataPath}`);
          const built = await buildFormulaVfs(metadata, formula, options);
          builtByFormula.set(formula, built);
          return `image=${built.imagePath}; report=${built.reportPath}; browser_url=${built.publicUrl}`;
        }, formulaDir(options, formula));
      }

      let vite: ChildProcess | undefined;
      let browser: Browser | undefined;
      await runCase(outcomes, options, tapCommit, "browser_server_start", async () => {
        vite = await startViteServer(options);
        const { chromium } = await import("playwright");
        browser = await chromium.launch({
          channel: options.browserChannel,
          headless: true,
        });
        return `vite=http://127.0.0.1:${options.port}; channel=${options.browserChannel}`;
      }, join(options.resultDir, "vite.log"));

      try {
        for (const formula of options.formulas) {
          for (const smokeCase of browserSmokeCasesForFormula(formula)) {
            await runCase(
              outcomes,
              options,
              tapCommit,
              `browser_smoke_${formula}_${smokeCase.name}`,
              async () => {
                const built = builtByFormula.get(formula);
                if (!built) throw new SkipCase(`requires successful homebrew_browser_vfs_build_${formula}`);
                if (!browser) throw new Error("browser did not start");
                if (smokeCase.skipReason) throw new SkipCase(smokeCase.skipReason);
                return runBrowserSmokeCase(browser, built, smokeCase, options);
              },
              join(formulaDir(options, formula), `${smokeCase.name}-terminal.txt`),
            );
          }
        }
      } finally {
        await browser?.close().catch(() => {});
        await stopProcess(vite);
      }
    }
  } finally {
    rmSync(publicRunDir, { recursive: true, force: true });
  }

  writeOutcomeLists(options.resultDir, outcomes, { includeArtifactPath: true });
  writeSummary(options, {
    startedAt,
    completedAt: new Date(),
    tapCommit,
    outcomes,
    builtByFormula,
  });
  writeCurrentRun(options, {
    status: outcomes.some((outcome) => outcome.status === "fail") ? "failed" : "complete",
    startedAt,
    tapCommit,
    outcomes,
    currentCase: "complete",
  });

  process.exit(outcomes.some((outcome) => outcome.status === "fail") ? 1 : 0);
}

async function buildFormulaVfs(
  metadata: HomebrewTapMetadata,
  formula: HomebrewSmokeFormula,
  options: CliOptions,
): Promise<BuiltBrowserVfs> {
  const [
    { buildHomebrewVfs },
    { planHomebrewVfs },
    { MemoryFileSystem },
    { saveImage },
  ] = await Promise.all([
    import("../host/src/homebrew-vfs-builder"),
    import("../host/src/homebrew-vfs-planner"),
    import("../host/src/vfs/memory-fs"),
    import("../images/vfs/scripts/vfs-image-helpers"),
  ]);
  const plan = await planHomebrewVfs(metadata, {
    packages: [formula],
    arch: options.arch,
    expectedAbi: ABI_VERSION,
    loadLinkManifest: (relPath) => readJsonFile(join(options.tapRoot, relPath)),
  });
  const fs = createFs(MemoryFileSystem, options.maxBytes);
  const result = await buildHomebrewVfs(plan, {
    fs,
    createdBy: "scripts/homebrew-package-browser-smoke.ts",
    loadBottleBytes: (pkg) => loadBottleBytes(pkg, options),
  });

  if (formula === "sqlite") {
    await compileAndInjectSqliteConsumer(fs, options);
  } else if (formula === "zlib") {
    await compileAndInjectZlibConsumer(fs, options);
  }

  const dir = formulaDir(options, formula);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `${formula}-${options.arch}-homebrew-vfs-report.json`);
  const imagePath = join(dir, `${formula}-${options.arch}-homebrew.vfs.zst`);
  writeFileSync(reportPath, `${JSON.stringify({ ...result.report, image: imagePath }, null, 2)}\n`);
  await saveImage(fs, imagePath, {
    metadata: {
      version: 1,
      kernelAbi: plan.kandeloAbi,
      createdBy: "scripts/homebrew-package-browser-smoke.ts",
      homebrew: {
        tapRepository: plan.tapRepository,
        tapCommit: plan.tapCommit,
        releaseTag: plan.releaseTag,
        packages: plan.packages.map((pkg) => ({
          name: pkg.name,
          version: pkg.version,
          arch: pkg.arch,
          sourceStatus: pkg.sourceStatus,
          cacheKeySha: pkg.cacheKeySha,
        })),
      },
    },
  });

  const publicDir = join(publicSmokeRoot, options.runId);
  mkdirSync(publicDir, { recursive: true });
  const publicPath = join(publicDir, basename(imagePath));
  copyFileSync(imagePath, publicPath);
  const publicUrl = `http://127.0.0.1:${options.port}${publicSmokePath}/${encodeURIComponent(options.runId)}/${encodeURIComponent(basename(imagePath))}`;

  return { formula, fs, imagePath, reportPath, publicPath, publicUrl };
}

async function compileAndInjectZlibConsumer(fs: MemoryFileSystem, options: CliOptions): Promise<void> {
  const { ensureDirRecursive, writeVfsBinary } = await import("../images/vfs/scripts/vfs-image-helpers");
  const stage = join(formulaDir(options, "zlib"), "zlib-consumer-build", options.arch);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "include"), { recursive: true });
  mkdirSync(join(stage, "lib"), { recursive: true });

  const version = findPackageVersion(fs, "zlib");
  writeFileSync(
    join(stage, "include", "zlib.h"),
    readVfsFile(fs, `${HOMEBREW_CELLAR}/zlib/${version}/include/zlib.h`),
  );
  writeFileSync(
    join(stage, "include", "zconf.h"),
    readVfsFile(fs, `${HOMEBREW_CELLAR}/zlib/${version}/include/zconf.h`),
  );
  writeFileSync(
    join(stage, "lib", "libz.a"),
    readVfsFile(fs, `${HOMEBREW_CELLAR}/zlib/${version}/lib/libz.a`),
  );
  writeFileSync(join(stage, "zlib_basic.c"), zlibSmokeSource());

  const cc = join(repoRoot, "sdk", "bin", `${options.arch}posix-cc`);
  if (!existsSync(cc)) {
    throw new SkipCase(`zlib consumer compiler is unavailable: ${cc}`);
  }
  const outWasm = join(stage, "zlib_basic.wasm");
  try {
    execFileSync(cc, [
      `-I${join(stage, "include")}`,
      join(stage, "zlib_basic.c"),
      join(stage, "lib", "libz.a"),
      "-o",
      outWasm,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${join(repoRoot, "sdk", "bin")}:${process.env.PATH ?? ""}`,
        WASM_POSIX_SYSROOT: join(repoRoot, options.arch === "wasm64" ? "sysroot64" : "sysroot"),
      },
      stdio: "pipe",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = readProcessErrorStderr(err);
    throw new Error(`zlib consumer compilation failed: ${stderr || message}`);
  }

  ensureDirRecursive(fs, dirname(ZLIB_BROWSER_CONSUMER_PATH));
  writeVfsBinary(fs, ZLIB_BROWSER_CONSUMER_PATH, new Uint8Array(readFileSync(outWasm)), 0o755);
}

async function compileAndInjectSqliteConsumer(fs: MemoryFileSystem, options: CliOptions): Promise<void> {
  const { ensureDirRecursive, writeVfsBinary } = await import("../images/vfs/scripts/vfs-image-helpers");
  const stage = join(formulaDir(options, "sqlite"), "sqlite-consumer-build", options.arch);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "include"), { recursive: true });
  mkdirSync(join(stage, "lib"), { recursive: true });

  const version = findPackageVersion(fs, "sqlite");
  writeFileSync(
    join(stage, "include", "sqlite3.h"),
    readVfsFile(fs, `${HOMEBREW_CELLAR}/sqlite/${version}/include/sqlite3.h`),
  );
  writeFileSync(
    join(stage, "include", "sqlite3ext.h"),
    readVfsFile(fs, `${HOMEBREW_CELLAR}/sqlite/${version}/include/sqlite3ext.h`),
  );
  writeFileSync(
    join(stage, "lib", "libsqlite3.a"),
    readVfsFile(fs, `${HOMEBREW_CELLAR}/sqlite/${version}/lib/libsqlite3.a`),
  );

  const cc = join(repoRoot, "sdk", "bin", `${options.arch}posix-cc`);
  if (!existsSync(cc)) {
    throw new SkipCase(`sqlite consumer compiler is unavailable: ${cc}`);
  }
  const testSrc = join(repoRoot, "packages", "registry", "sqlite", "test", "sqlite_basic.c");
  const outWasm = join(stage, "sqlite_basic.wasm");
  try {
    execFileSync(cc, [
      `-I${join(stage, "include")}`,
      testSrc,
      join(stage, "lib", "libsqlite3.a"),
      "-lm",
      "-o",
      outWasm,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${join(repoRoot, "sdk", "bin")}:${process.env.PATH ?? ""}`,
        WASM_POSIX_SYSROOT: join(repoRoot, "sysroot"),
      },
      stdio: "pipe",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = readProcessErrorStderr(err);
    throw new Error(`sqlite consumer compilation failed: ${stderr || message}`);
  }

  ensureDirRecursive(fs, dirname(SQLITE_BROWSER_CONSUMER_PATH));
  writeVfsBinary(fs, SQLITE_BROWSER_CONSUMER_PATH, new Uint8Array(readFileSync(outWasm)), 0o755);
}

function zlibSmokeSource(): string {
  return `#include <stdio.h>
#include <string.h>
#include <zlib.h>

int main(void) {
  const Bytef input[] = "ok";
  Bytef compressed[32];
  Bytef output[32];
  uLongf compressed_len = sizeof(compressed);
  uLongf output_len = sizeof(output);
  if (compress(compressed, &compressed_len, input, strlen((const char *)input)) != Z_OK) return 1;
  if (uncompress(output, &output_len, compressed, compressed_len) != Z_OK) return 2;
  output[output_len] = 0;
  puts(strcmp((const char *)output, "ok") == 0 ? "PASS" : "FAIL");
  return 0;
}
`;
}

async function runBrowserSmokeCase(
  browser: Browser,
  built: BuiltBrowserVfs,
  smokeCase: BrowserSmokeCase,
  options: CliOptions,
): Promise<string> {
  const dir = formulaDir(options, smokeCase.formula);
  const terminalPath = join(dir, `${smokeCase.name}-terminal.txt`);
  const eventsPath = join(dir, `${smokeCase.name}-browser-events.json`);
  const screenshotPath = join(dir, `${smokeCase.name}-failure.png`);
  const tracePath = join(dir, `${smokeCase.name}-trace.zip`);
  const diagnostics: BrowserDiagnostics = {
    console: [],
    pageErrors: [],
    requestFailures: [],
  };
  const context = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "warning" || msg.type() === "error") {
      diagnostics.console.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => diagnostics.pageErrors.push(err.stack ?? err.message));
  page.on("requestfailed", (request) => {
    diagnostics.requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim());
  });

  let failed = false;
  try {
    await page.goto(`http://127.0.0.1:${options.port}/pages/homebrew-smoke/`, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    await page.waitForFunction(() => window.__homebrewSmokeReady === true, undefined, {
      timeout: options.timeoutMs,
    });
    const result = await page.evaluate(
      async ({ vfsUrl, argv, stdin, env, timeoutMs }) =>
        window.__runHomebrewSmoke({ vfsUrl, argv, stdin, env, timeoutMs }),
      {
        vfsUrl: built.publicUrl,
        argv: smokeCase.argv,
        stdin: smokeCase.stdin,
        env: smokeCase.env,
        timeoutMs: options.timeoutMs,
      },
    ) as BrowserSmokeResult;
    const output = [
      `command: ${smokeCase.command}`,
      `argv: ${JSON.stringify(smokeCase.argv)}`,
      `exitCode: ${result.exitCode}`,
      `durationMs: ${result.durationMs}`,
      "",
      "stdout:",
      result.stdout,
      "",
      "stderr:",
      result.stderr,
    ].join("\n");
    writeFileSync(terminalPath, output);
    writeFileSync(eventsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);

    if (result.exitCode !== 0) {
      throw new Error(`${smokeCase.name} exited ${result.exitCode}; output=${JSON.stringify(output)}`);
    }
    smokeCase.expected.lastIndex = 0;
    if (!smokeCase.expected.test(result.combined)) {
      throw new Error(`${smokeCase.name} output did not match ${smokeCase.expected}: ${JSON.stringify(output)}`);
    }
    return `command=${smokeCase.command}; url=${built.publicUrl}; output=${terminalPath}`;
  } catch (err) {
    failed = true;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    writeFileSync(eventsPath, `${JSON.stringify({ ...diagnostics, error: message }, null, 2)}\n`);
    throw err;
  } finally {
    await context.tracing.stop(failed ? { path: tracePath } : undefined).catch(() => {});
    await context.close().catch(() => {});
  }
}

async function runCase(
  outcomes: SmokeOutcome[],
  options: CliOptions,
  tapCommit: string,
  name: string,
  fn: () => Promise<string | undefined>,
  artifactPath?: string,
): Promise<void> {
  writeCurrentRun(options, {
    status: "running",
    tapCommit,
    outcomes,
    currentCase: name,
  });
  const started = Date.now();
  try {
    const details = await fn();
    outcomes.push({ name, status: "pass", durationMs: Date.now() - started, details, artifactPath });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const skipped = error instanceof SkipCase;
    outcomes.push({
      name,
      status: skipped ? "skip" : "fail",
      durationMs: Date.now() - started,
      details: error.message,
      ...(skipped ? {} : { error: error.stack ?? error.message }),
      artifactPath,
    });
  }
  writeCurrentRun(options, {
    status: "running",
    tapCommit,
    outcomes,
    currentCase: name,
  });
}

async function startViteServer(options: CliOptions): Promise<ChildProcess> {
  const logPath = join(options.resultDir, "vite.log");
  writeFileSync(logPath, "");
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("npx", [
      "vite",
      "--config",
      join(browserDemoDir, "vite.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(options.port),
      "--strictPort",
    ], {
      cwd: browserDemoDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        KANDELO_BROWSER_TEST_NO_HMR: "1",
        KANDELO_BROWSER_DEMO_INPUTS: "homebrew-smoke",
        KANDELO_PLAYWRIGHT_PORT: String(options.port),
      },
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error(`Vite server did not start within 30000ms; see ${logPath}`));
      }
    }, 30_000);
    const onData = (data: Buffer) => {
      const text = data.toString();
      appendFileSync(logPath, text);
      if (!started && /Local:\s+http:\/\/127\.0\.0\.1:/.test(text)) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolvePromise(proc), 500);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Vite exited with code ${code}; see ${logPath}`));
      }
    });
    proc.on("error", (err) => {
      if (!started) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

async function stopProcess(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolvePromise();
    }, 5_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    proc.kill();
  });
}

async function loadBottleBytes(
  pkg: HomebrewVfsPackagePlan,
  options: CliOptions,
): Promise<Uint8Array> {
  if (pkg.url.startsWith("file://")) {
    return new Uint8Array(readFileSync(fileURLToPath(pkg.url)));
  }

  const cachePath = join(options.bottleCache, `${pkg.sha256}.tar.gz`);
  if (existsSync(cachePath)) return new Uint8Array(readFileSync(cachePath));
  if (!pkg.url.startsWith("https://")) {
    throw new Error(
      `package ${pkg.name}@${pkg.version} bottle URL must be https:// or file://, got ${pkg.url}`,
    );
  }

  const { fetchHomebrewBottleBytes } = await import("../host/src/homebrew-vfs-fetch");
  const bytes = await fetchHomebrewBottleBytes(pkg.url);
  writeFileSync(cachePath, bytes);
  return bytes;
}

function findPackageVersion(fs: MemoryFileSystem, formula: string): string {
  const info = JSON.parse(new TextDecoder().decode(readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json")));
  const pkg = info.packages?.find((candidate: { name?: string }) => candidate.name === formula);
  if (!pkg) throw new Error(`package ${formula} missing from /etc/kandelo/homebrew-vfs.json`);
  const keg = String(pkg.keg ?? "");
  const prefix = `${HOMEBREW_CELLAR}/${formula}/`;
  if (!keg.startsWith(prefix)) throw new Error(`unexpected ${formula} keg path: ${keg}`);
  return keg.slice(prefix.length);
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(st.size);
    let offset = 0;
    while (offset < out.byteLength) {
      const n = fs.read(fd, out.subarray(offset), null, out.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return out.subarray(0, offset);
  } finally {
    fs.close(fd);
  }
}

function createFs(
  MemoryFileSystemCtor: {
    create(sab: SharedArrayBuffer, maxBytes?: number): MemoryFileSystem;
  },
  maxBytes: number,
): MemoryFileSystem {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  return MemoryFileSystemCtor.create(
    new SharedArrayBufferCtor(maxBytes, { maxByteLength: maxBytes }),
    maxBytes,
  );
}

function parseArgs(args: string[]): CliOptions {
  const defaultResultDir = join(
    repoRoot,
    "test-runs",
    "homebrew-package-browser-smoke",
    new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z"),
  );
  const options: CliOptions = {
    resultDir: process.env.KANDELO_TEST_RESULT_DIR || defaultResultDir,
    tapRoot: process.env.KANDELO_HOMEBREW_TAP_ROOT || "",
    formulas: [],
    arch: "wasm32",
    bottleCache: "",
    timeoutMs: 180_000,
    maxBytes: 128 * 1024 * 1024,
    beadId: process.env.KANDELO_BEAD_ID || "kd-1mr.2.1",
    port: Number(process.env.KANDELO_PLAYWRIGHT_PORT ?? 5401),
    runId: "",
    browserChannel: process.env.KANDELO_PLAYWRIGHT_CHANNEL || "chromium",
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--result-dir":
        options.resultDir = requireValue(args, ++i, arg);
        break;
      case "--tap-root":
        options.tapRoot = requireValue(args, ++i, arg);
        break;
      case "--formula":
        options.formulas.push(parseFormula(requireValue(args, ++i, arg)));
        break;
      case "--arch":
        options.arch = parseArch(requireValue(args, ++i, arg));
        break;
      case "--bottle-cache":
        options.bottleCache = requireValue(args, ++i, arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(requireValue(args, ++i, arg), arg);
        break;
      case "--max-bytes":
        options.maxBytes = parseByteSize(requireValue(args, ++i, arg));
        break;
      case "--bead-id":
        options.beadId = requireValue(args, ++i, arg);
        break;
      case "--port":
        options.port = parsePositiveInt(requireValue(args, ++i, arg), arg);
        break;
      case "--run-id":
        options.runId = sanitizeToken(requireValue(args, ++i, arg));
        break;
      case "--browser-channel":
        options.browserChannel = requireValue(args, ++i, arg);
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        usage(2, `unexpected argument ${arg}`);
    }
  }

  if (!options.tapRoot) usage(2, "--tap-root is required");
  if (options.formulas.length === 0) usage(2, "at least one --formula is required");
  const seen = new Set<HomebrewSmokeFormula>();
  for (const formula of options.formulas) {
    if (seen.has(formula)) usage(2, `duplicate --formula ${formula}`);
    seen.add(formula);
  }
  options.resultDir = resolve(options.resultDir);
  options.tapRoot = resolve(options.tapRoot);
  options.bottleCache = options.bottleCache
    ? resolve(options.bottleCache)
    : join(options.resultDir, "bottle-cache");
  options.runId ||= `${sanitizeToken(options.beadId)}-${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${process.pid}`;
  return options;
}

function parseFormula(value: string): HomebrewSmokeFormula {
  try {
    return parseHomebrewSmokeFormula(value);
  } catch (err) {
    usage(2, err instanceof Error ? err.message : String(err));
  }
}

function parseArch(value: string): HomebrewBottleArch {
  if (value === "wasm32" || value === "wasm64") return value;
  usage(2, `--arch must be wasm32 or wasm64, got ${value}`);
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) usage(2, `${flag} must be a positive integer`);
  return parsed;
}

function parseByteSize(value: string): number {
  const match = /^([1-9][0-9]*)([kKmMgG]i?[bB]?|[bB])?$/.exec(value);
  if (!match) usage(2, `--max-bytes must be a positive byte size, got ${value}`);
  const amount = Number(match[1]);
  const suffix = (match[2] ?? "b").toLowerCase();
  const multiplier = suffix.startsWith("g") ? 1024 ** 3
    : suffix.startsWith("m") ? 1024 ** 2
    : suffix.startsWith("k") ? 1024
    : 1;
  return amount * multiplier;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) usage(2, `${flag} requires a value`);
  return value;
}

function usage(code: number, message?: string): never {
  if (message) console.error(`homebrew-package-browser-smoke: ${message}`);
  console.error(`usage: npx tsx scripts/homebrew-package-browser-smoke.ts \\
  --tap-root <dir> --formula <package-name> [--formula ...] \\
  [--arch <wasm32|wasm64>] [--result-dir <dir>] [--bottle-cache <dir>] \\
  [--timeout-ms <ms>] [--max-bytes <bytes|MiB>] [--port <port>]`);
  process.exit(code);
}

function writeSummary(
  options: CliOptions,
  data: {
    startedAt: Date;
    completedAt: Date;
    tapCommit: string;
    outcomes: SmokeOutcome[];
    builtByFormula: Map<HomebrewSmokeFormula, BuiltBrowserVfs>;
  },
): void {
  const counts = countOutcomes(data.outcomes);
  const packages = options.formulas.map((formula) =>
    summarizePackage(formula, options, data.outcomes, data.builtByFormula.get(formula))
  );
  const summary = {
    suite: "Homebrew package browser VFS smoke",
    bead_id: options.beadId,
    started_at: data.startedAt.toISOString(),
    completed_at: data.completedAt.toISOString(),
    duration_ms: data.completedAt.getTime() - data.startedAt.getTime(),
    result_dir: options.resultDir,
    tap_root: options.tapRoot,
    tap_commit: data.tapCommit,
    arch: options.arch,
    formulas: options.formulas,
    counts,
    outcomes: data.outcomes,
    packages,
    artifacts: {
      passed: join(options.resultDir, "outcome-lists", "passed-tests.tsv"),
      failed: join(options.resultDir, "outcome-lists", "failed-tests.tsv"),
      skipped: join(options.resultDir, "outcome-lists", "skipped-tests.tsv"),
      failures: join(options.resultDir, "failures.json"),
      current_run: join(options.resultDir, "current-run.json"),
    },
  };
  writeFileSync(join(options.resultDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(options.resultDir, "summary.md"), [
    "# Homebrew package browser VFS smoke",
    "",
    `Result dir: \`${options.resultDir}\``,
    `Tap commit: \`${data.tapCommit}\``,
    `Counts: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`,
    "",
    "| Formula | Status | Browser URL | Details |",
    "|---|---:|---|---|",
    ...packages.map((pkg) =>
      `| \`${pkg.formula}\` | ${pkg.status} | ${pkg.browser_url ? `\`${pkg.browser_url}\`` : ""} | ${[...pkg.failed, ...pkg.skipped].join("; ").replace(/\|/g, "\\|")} |`,
    ),
    "",
    "| Test | Status | Details |",
    "|---|---:|---|",
    ...data.outcomes.map((outcome) =>
      `| \`${outcome.name}\` | ${outcome.status} | ${(outcome.details ?? "").replace(/\|/g, "\\|")} |`,
    ),
    "",
  ].join("\n"));
}

function summarizePackage(
  formula: HomebrewSmokeFormula,
  options: CliOptions,
  outcomes: SmokeOutcome[],
  built: BuiltBrowserVfs | undefined,
): {
  formula: HomebrewSmokeFormula;
  arch: HomebrewBottleArch;
  status: PackageStatus;
  required_cases: string[];
  browser_url?: string;
  vfs_image?: string;
  vfs_report?: string;
  commands: string[];
  argv: string[][];
  passed: string[];
  failed: string[];
  skipped: string[];
  skip_reason?: string;
} {
  const smokeCases = browserSmokeCasesForFormula(formula);
  const formulaOutcomes = outcomes.filter((outcome) =>
    outcome.name === `homebrew_browser_vfs_build_${formula}` ||
    outcome.name.startsWith(`browser_smoke_${formula}_`)
  );
  const globalOutcomes = outcomes.filter((outcome) => outcome.name === "browser_server_start");
  const relevant = [...globalOutcomes, ...formulaOutcomes];
  const failed = relevant.filter((outcome) => outcome.status === "fail").map(formatOutcome);
  const skipped = formulaOutcomes.filter((outcome) => outcome.status === "skip").map(formatOutcome);
  const passed = relevant.filter((outcome) => outcome.status === "pass").map(formatOutcome);
  const status: PackageStatus = failed.length > 0 ? "failed" : skipped.length > 0 ? "skipped" : "success";
  const firstSkip = formulaOutcomes.find((outcome) => outcome.status === "skip");

  return {
    formula,
    arch: options.arch,
    status,
    required_cases: smokeCases.filter((smokeCase) => smokeCase.required).map((smokeCase) => smokeCase.name),
    browser_url: built?.publicUrl,
    vfs_image: built?.imagePath,
    vfs_report: built?.reportPath,
    commands: smokeCases.map((smokeCase) => smokeCase.command),
    argv: smokeCases.map((smokeCase) => smokeCase.argv),
    passed,
    failed,
    skipped,
    ...(status === "skipped" && firstSkip?.details ? { skip_reason: firstSkip.details } : {}),
  };
}

function formatOutcome(outcome: SmokeOutcome): string {
  const text = outcome.status === "fail"
    ? outcome.error ?? outcome.details ?? ""
    : outcome.details ?? "";
  return `${outcome.name}: ${text}${outcome.artifactPath ? ` [${outcome.artifactPath}]` : ""}`;
}

function writeCurrentRun(
  options: CliOptions,
  data: {
    status: "running" | "complete" | "failed";
    startedAt?: Date;
    tapCommit: string;
    outcomes: SmokeOutcome[];
    currentCase: string;
  },
): void {
  const counts = countOutcomes(data.outcomes);
  const currentRun = {
    suite: "homebrew-package-browser-smoke",
    bead_id: options.beadId,
    worktree: repoRoot,
    result_dir: options.resultDir,
    status: data.status,
    started_at: data.startedAt?.toISOString(),
    updated_at: new Date().toISOString(),
    current_case: data.currentCase,
    progress: {
      completed: data.outcomes.length,
      total: options.arch === "wasm64"
        ? options.formulas.length
        : options.formulas.length * 2 + 1,
      pass: counts.pass,
      fail: counts.fail,
      skip: counts.skip,
    },
    tap_root: options.tapRoot,
    tap_commit: data.tapCommit,
    command: {
      cwd: repoRoot,
      argv: process.argv,
    },
    outcome_lists: {
      passed: join(options.resultDir, "outcome-lists", "passed-tests.tsv"),
      failed: join(options.resultDir, "outcome-lists", "failed-tests.tsv"),
      skipped: join(options.resultDir, "outcome-lists", "skipped-tests.tsv"),
    },
    stale_no_runner_threshold_seconds: 900,
    expected_next: data.status === "running"
      ? { deterministic: true, action: "continue current browser smoke case" }
      : { deterministic: false, action: "suite terminal" },
  };
  const out = join(options.resultDir, "current-run.json");
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(currentRun, null, 2)}\n`);
  renameSync(tmp, out);
}

function formulaDir(options: CliOptions, formula: HomebrewSmokeFormula): string {
  return join(options.resultDir, `${formula}-${options.arch}`);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function tryGitRevParse(path: string): string | undefined {
  try {
    return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function readProcessErrorStderr(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (stderr instanceof Buffer) return stderr.toString();
    if (typeof stderr === "string") return stderr;
  }
  return "";
}

function sanitizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "run";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
