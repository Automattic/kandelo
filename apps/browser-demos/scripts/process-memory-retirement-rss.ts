import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserServer,
  type BrowserType,
  type Page,
} from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  classifyProcessMemoryRss,
  type ProcessMemoryRssSample,
  type ProcessRssEntry,
} from "../process-memory-rss-telemetry";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const browserKernelModulePath = resolve(
  repoRoot,
  "host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(
  repoRoot,
  "host/src/vfs/memory-fs.ts",
);
const MIB = 1024 * 1024;
const PRODUCTION_TRIALS = 2;
const PRODUCTION_WARMUP_CHILDREN = 4;
const PRODUCTION_WAVE_CHILDREN = 8;
const PRODUCTION_WAVES = 6;
const CONTROL_WAVE_CHILDREN = 4;
const CONTROL_WAVES = 4;
const CHILD_MIB = 8;
const SAMPLE_DELAY_MS = 200;

type EngineName = "chromium" | "firefox" | "webkit";

interface CliOptions {
  readonly engine: EngineName;
  readonly kernelPath: string;
  readonly programPath: string;
  readonly outputPath: string;
}

interface BrowserRunResult {
  readonly samples: readonly ProcessMemoryRssSample[];
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics: readonly {
    source: string;
    message: string;
  }[];
  readonly runtimeErrors: readonly string[];
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "usage: process-memory-retirement-rss.ts " +
          "--engine <chromium|firefox|webkit> --kernel <path> " +
          "--program <path> --output <path>",
      );
    }
    values.set(key, value);
  }
  const engine = values.get("--engine");
  if (
    engine !== "chromium"
    && engine !== "firefox"
    && engine !== "webkit"
  ) {
    throw new Error(`invalid browser engine: ${String(engine)}`);
  }
  const kernelPath = values.get("--kernel");
  const programPath = values.get("--program");
  const outputPath = values.get("--output");
  if (!kernelPath || !programPath || !outputPath) {
    throw new Error("kernel, program, and output paths are required");
  }
  return {
    engine,
    kernelPath: resolve(kernelPath),
    programPath: resolve(programPath),
    outputPath: resolve(outputPath),
  };
}

function engineType(engine: EngineName): BrowserType {
  if (engine === "chromium") return chromium;
  if (engine === "firefox") return firefox;
  return webkit;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await delay(100);
  }
  throw new Error(`Vite did not become ready: ${lastError}`);
}

async function processTree(rootPid: number): Promise<ProcessRssEntry[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,ppid=,rss=,command="],
    { maxBuffer: 16 * MIB },
  );
  const all = new Map<number, ProcessRssEntry>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    all.set(pid, {
      pid,
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      command: match[4]!,
    });
  }

  const selected = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of all.values()) {
      if (selected.has(entry.ppid) && !selected.has(entry.pid)) {
        selected.add(entry.pid);
        changed = true;
      }
    }
  }
  const entries = [...selected]
    .map((pid) => all.get(pid))
    .filter((entry): entry is ProcessRssEntry => entry !== undefined)
    .sort((left, right) => left.pid - right.pid);
  if (!entries.some((entry) => entry.pid === rootPid)) {
    throw new Error(`browser process ${rootPid} disappeared before sampling`);
  }
  return entries;
}

function browserLaunchEnvironment(): Record<string, string> {
  const keys = [
    "CI",
    "DEBUG",
    "DISPLAY",
    "FORCE_COLOR",
    "GITHUB_ACTIONS",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_COLOR",
    "PATH",
    "PLAYWRIGHT_BROWSERS_PATH",
    "SHELL",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USER",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
  ];
  const selected: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

function recordRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error"
      && !message.text().startsWith("Failed to load resource:")
    ) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function installTsxEvaluationHelper(page: Page): Promise<void> {
  // WHY: this standalone harness is loaded through tsx, whose function-name
  // transform references its private `__name` helper. Playwright serializes
  // only the evaluate callback, not that module helper. Supplying the
  // semantics-free naming helper in the page keeps the measured workload
  // identical to the checked-in callback.
  await page.addInitScript(
    "globalThis.__name = (value) => value;",
  );
}

async function runProductionTrial(
  browser: Browser,
  browserRootPid: number,
  baseUrl: string,
  kernelBase64: string,
  programBase64: string,
): Promise<BrowserRunResult> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const runtimeErrors = recordRuntimeErrors(page);
  const samples: ProcessMemoryRssSample[] = [];
  const startedAt = Date.now();
  await installTsxEvaluationHelper(page);
  await page.exposeBinding(
    "__kandeloRecordProcessMemoryRss",
    async (_source, completedChildren: number) => {
      const processes = await processTree(browserRootPid);
      samples.push({
        completedChildren,
        elapsedMs: Date.now() - startedAt,
        rssBytes: processes.reduce(
          (sum, entry) => sum + entry.rssBytes,
          0,
        ),
        processes,
      });
    },
  );
  await page.goto(new URL("/trap-signal-test.html", baseUrl).href);
  try {
    const result = await page.evaluate(
      async ({
        browserKernelUrl,
        memoryFsUrl,
        kernelBytesBase64,
        programBytesBase64,
        warmupChildren,
        waveChildren,
        waveCount,
        childMiB,
        sampleDelayMs,
      }) => {
        const { BrowserKernel } = await import(
          /* @vite-ignore */ browserKernelUrl
        );
        const { MemoryFileSystem } = await import(
          /* @vite-ignore */ memoryFsUrl
        );
        const decodeBase64 = (encoded: string): ArrayBuffer => {
          const binary = atob(encoded);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          return bytes.buffer;
        };
        const kernelBytes = decodeBase64(kernelBytesBase64);
        const programBytes = decodeBase64(programBytesBase64);
        const decoder = new TextDecoder();
        let stdout = "";
        let stderr = "";
        const diagnostics: Array<{
          source: string;
          message: string;
        }> = [];
        let currentPids = new Set<number>();
        const kernel = new BrowserKernel({
          maxWorkers: 4,
          maxProcessMemoryBytes: 64 * 1024 * 1024,
          onStdout: (data: Uint8Array) => {
            stdout += decoder.decode(data);
          },
          onStderr: (data: Uint8Array) => {
            stderr += decoder.decode(data);
          },
          onHostDiagnostic: (diagnostic: {
            source: string;
            message: string;
          }) => diagnostics.push(diagnostic),
          onProcessEvent: (event: { kind: string; pid: number }) => {
            if (event.kind === "spawn") currentPids.add(event.pid);
          },
        });

        const waitUntilReaped = async (): Promise<void> => {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const maps = await Promise.all(
              [...currentPids].map((pid) => kernel.readProcMaps(pid)),
            );
            if (maps.every((entry) => entry === null)) {
              for (let turn = 0; turn < 4; turn += 1) {
                await new Promise<void>((resolveTurn) =>
                  setTimeout(resolveTurn, 0)
                );
              }
              return;
            }
            await new Promise<void>((resolvePoll) =>
              setTimeout(resolvePoll, 10)
            );
          }
          throw new Error(
            `process teardown did not reap pids: ${
              [...currentPids].join(", ")
            }`,
          );
        };

        const runWave = async (children: number): Promise<void> => {
          currentPids = new Set<number>();
          const status = await kernel.spawn(
            programBytes.slice(0),
            [
              "process-memory-reclamation-churn",
              String(children),
              String(childMiB),
            ],
          );
          if (status !== 0) {
            throw new Error(`production churn exited ${status}: ${stderr}`);
          }
          await waitUntilReaped();
        };

        const imageOwner = MemoryFileSystem.create(
          new SharedArrayBuffer(2 * 1024 * 1024),
        );
        imageOwner.mkdir("/bin", 0o755);
        imageOwner.createFileWithOwner(
          "/bin/process-memory-reclamation-churn",
          0o755,
          0,
          0,
          new Uint8Array(programBytes),
        );
        await kernel.initFromImage({
          kernelWasm: kernelBytes,
          vfsImage: await imageOwner.saveImage(),
        });

        try {
          await runWave(warmupChildren);
          await new Promise<void>((resolveSample) =>
            setTimeout(resolveSample, sampleDelayMs)
          );
          await (
            globalThis as typeof globalThis & {
              __kandeloRecordProcessMemoryRss:
                (completed: number) => Promise<void>;
            }
          ).__kandeloRecordProcessMemoryRss(0);
          for (let wave = 1; wave <= waveCount; wave += 1) {
            await runWave(waveChildren);
            await new Promise<void>((resolveSample) =>
              setTimeout(resolveSample, sampleDelayMs)
            );
            await (
              globalThis as typeof globalThis & {
                __kandeloRecordProcessMemoryRss:
                  (completed: number) => Promise<void>;
              }
            ).__kandeloRecordProcessMemoryRss(wave * waveChildren);
          }
          return { stdout, stderr, diagnostics };
        } finally {
          await kernel.destroy();
        }
      },
      {
        browserKernelUrl: new URL(
          `/@fs/${browserKernelModulePath}`,
          baseUrl,
        ).href,
        memoryFsUrl: new URL(`/@fs/${memoryFsModulePath}`, baseUrl).href,
        kernelBytesBase64: kernelBase64,
        programBytesBase64: programBase64,
        warmupChildren: PRODUCTION_WARMUP_CHILDREN,
        waveChildren: PRODUCTION_WAVE_CHILDREN,
        waveCount: PRODUCTION_WAVES,
        childMiB: CHILD_MIB,
        sampleDelayMs: SAMPLE_DELAY_MS,
      },
    );
    return { samples, ...result, runtimeErrors };
  } finally {
    await context.close();
  }
}

async function runLiveControl(
  browser: Browser,
  browserRootPid: number,
  baseUrl: string,
  kernelBase64: string,
  programBase64: string,
): Promise<BrowserRunResult> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const runtimeErrors = recordRuntimeErrors(page);
  const samples: ProcessMemoryRssSample[] = [];
  const startedAt = Date.now();
  await installTsxEvaluationHelper(page);
  await page.exposeBinding(
    "__kandeloRecordProcessMemoryRss",
    async (_source, completedChildren: number) => {
      const processes = await processTree(browserRootPid);
      samples.push({
        completedChildren,
        elapsedMs: Date.now() - startedAt,
        rssBytes: processes.reduce(
          (sum, entry) => sum + entry.rssBytes,
          0,
        ),
        processes,
      });
    },
  );
  await page.goto(new URL("/trap-signal-test.html", baseUrl).href);
  try {
    const result = await page.evaluate(
      async ({
        browserKernelUrl,
        memoryFsUrl,
        kernelBytesBase64,
        programBytesBase64,
        waveChildren,
        waveCount,
        childMiB,
        sampleDelayMs,
      }) => {
        const { BrowserKernel } = await import(
          /* @vite-ignore */ browserKernelUrl
        );
        const { MemoryFileSystem } = await import(
          /* @vite-ignore */ memoryFsUrl
        );
        const decodeBase64 = (encoded: string): ArrayBuffer => {
          const binary = atob(encoded);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          return bytes.buffer;
        };
        const kernelBytes = decodeBase64(kernelBytesBase64);
        const programBytes = decodeBase64(programBytesBase64);
        const decoder = new TextDecoder();
        let stdout = "";
        let stderr = "";
        const diagnostics: Array<{
          source: string;
          message: string;
        }> = [];
        const kernel = new BrowserKernel({
          maxWorkers: waveChildren * waveCount + 2,
          maxProcessMemoryBytes: 768 * 1024 * 1024,
          onStdout: (data: Uint8Array) => {
            stdout += decoder.decode(data);
          },
          onStderr: (data: Uint8Array) => {
            stderr += decoder.decode(data);
          },
          onHostDiagnostic: (diagnostic: {
            source: string;
            message: string;
          }) => diagnostics.push(diagnostic),
        });

        const imageOwner = MemoryFileSystem.create(
          new SharedArrayBuffer(2 * 1024 * 1024),
        );
        imageOwner.mkdir("/bin", 0o755);
        imageOwner.createFileWithOwner(
          "/bin/process-memory-reclamation-churn",
          0o755,
          0,
          0,
          new Uint8Array(programBytes),
        );
        await kernel.initFromImage({
          kernelWasm: kernelBytes,
          vfsImage: await imageOwner.saveImage(),
        });

        const waitForReadyCount = async (expected: number): Promise<void> => {
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const actual =
              stdout.match(/PROCESS_MEMORY_CONTROL_READY/g)?.length ?? 0;
            if (actual >= expected) return;
            await new Promise<void>((resolvePoll) =>
              setTimeout(resolvePoll, 10)
            );
          }
          throw new Error(
            `only ${
              stdout.match(/PROCESS_MEMORY_CONTROL_READY/g)?.length ?? 0
            } of ${expected} controls became ready`,
          );
        };

        try {
          await (
            globalThis as typeof globalThis & {
              __kandeloRecordProcessMemoryRss:
                (completed: number) => Promise<void>;
            }
          ).__kandeloRecordProcessMemoryRss(0);
          let started = 0;
          for (let wave = 1; wave <= waveCount; wave += 1) {
            for (let child = 0; child < waveChildren; child += 1) {
              const process = await kernel.spawnFromVfs(
                "/bin/process-memory-reclamation-churn",
                [
                  "process-memory-reclamation-churn",
                  "hold",
                  String(childMiB),
                ],
              );
              void process.exit.catch(() => undefined);
              started += 1;
            }
            await waitForReadyCount(started);
            await new Promise<void>((resolveSample) =>
              setTimeout(resolveSample, sampleDelayMs)
            );
            await (
              globalThis as typeof globalThis & {
                __kandeloRecordProcessMemoryRss:
                  (completed: number) => Promise<void>;
              }
            ).__kandeloRecordProcessMemoryRss(started);
          }
          return { stdout, stderr, diagnostics };
        } finally {
          await kernel.destroy();
        }
      },
      {
        browserKernelUrl: new URL(
          `/@fs/${browserKernelModulePath}`,
          baseUrl,
        ).href,
        memoryFsUrl: new URL(`/@fs/${memoryFsModulePath}`, baseUrl).href,
        kernelBytesBase64: kernelBase64,
        programBytesBase64: programBase64,
        waveChildren: CONTROL_WAVE_CHILDREN,
        waveCount: CONTROL_WAVES,
        childMiB: CHILD_MIB,
        sampleDelayMs: SAMPLE_DELAY_MS,
      },
    );
    return { samples, ...result, runtimeErrors };
  } finally {
    await context.close();
  }
}

async function gitHead(): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot },
  );
  return stdout.trim();
}

async function linuxCgroupMetadata(): Promise<Record<string, unknown> | null> {
  if (platform() !== "linux") return null;
  const membership = await readFile("/proc/self/cgroup", "utf8")
    .catch(() => "");
  const unified = membership
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (!unified) {
    return { version: "unknown", membership };
  }
  const root = join("/sys/fs/cgroup", unified);
  const readControl = async (name: string): Promise<string | null> =>
    readFile(join(root, name), "utf8")
      .then((value) => value.trim())
      .catch(() => null);
  return {
    version: 2,
    membership,
    path: unified,
    memoryCurrent: await readControl("memory.current"),
    memoryPeak: await readControl("memory.peak"),
    memoryMax: await readControl("memory.max"),
    memoryEvents: await readControl("memory.events"),
    // WHY: touched SharedArrayBuffer pages can leave RSS by swapping without
    // becoming collectible. Keep swap state beside RSS so a future cgroup
    // sentinel cannot mistake eviction for memory retirement.
    memorySwapCurrent: await readControl("memory.swap.current"),
    memorySwapPeak: await readControl("memory.swap.peak"),
    memorySwapMax: await readControl("memory.swap.max"),
    memorySwapEvents: await readControl("memory.swap.events"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const viteLogs: string[] = [];
  const viteBin = join(appRoot, "node_modules/.bin/vite");
  const port = 5417;
  const baseUrl = `http://127.0.0.1:${port}`;
  const vite = spawn(
    viteBin,
    [
      "--config",
      join(appRoot, "vite.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: appRoot,
      env: { ...process.env, KANDELO_PLAYWRIGHT_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collectViteLog = (chunk: Buffer): void => {
    viteLogs.push(chunk.toString());
    if (viteLogs.length > 200) viteLogs.shift();
  };
  vite.stdout?.on("data", collectViteLog);
  vite.stderr?.on("data", collectViteLog);

  let browserServer: BrowserServer | undefined;
  let browser: Browser | undefined;
  try {
    await waitForServer(`${baseUrl}/trap-signal-test.html`);
    const type = engineType(options.engine);
    browserServer = await type.launchServer({
      headless: true,
      env: browserLaunchEnvironment(),
    });
    const rootPid = browserServer.process().pid;
    if (!rootPid) throw new Error("Playwright did not expose a browser pid");
    browser = await type.connect(browserServer.wsEndpoint());

    // WHY: Vite treats a fetched `.wasm` path as a module request and may
    // return its JavaScript wrapper. Transport exact bytes through
    // Playwright instead so telemetry can never measure an accidental build
    // artifact selected by the dev server.
    const [kernelBase64, programBase64] = await Promise.all([
      readFile(options.kernelPath).then((bytes) => bytes.toString("base64")),
      readFile(options.programPath).then((bytes) => bytes.toString("base64")),
    ]);
    const production: BrowserRunResult[] = [];
    for (let trial = 0; trial < PRODUCTION_TRIALS; trial += 1) {
      production.push(await runProductionTrial(
        browser,
        rootPid,
        baseUrl,
        kernelBase64,
        programBase64,
      ));
    }
    const control = await runLiveControl(
      browser,
      rootPid,
      baseUrl,
      kernelBase64,
      programBase64,
    );
    let verdict = classifyProcessMemoryRss(
      production.map((trial) => trial.samples),
      control.samples,
    );
    const allSamples = [
      ...production.flatMap((trial) => trial.samples),
      ...control.samples,
    ];
    const minimumAttributedProcessCount = Math.min(
      ...allSamples.map((sample) => sample.processes.length),
    );
    const expectedBrowserDescendantsAttributed =
      minimumAttributedProcessCount >= 2
      && (
        platform() === "linux"
        || (platform() === "darwin" && options.engine !== "webkit")
      );
    const attribution = {
      model: "browser-server-root-plus-transitive-descendants",
      rootPid,
      minimumAttributedProcessCount,
      expectedBrowserDescendantsAttributed,
      reason: expectedBrowserDescendantsAttributed
        ? "the active page and browser helpers remained in the server tree"
        : (
          platform() === "darwin" && options.engine === "webkit"
            ? "macOS reparents WebKit XPC helpers outside the server tree"
            : "the server tree did not contain an attributable page process"
        ),
    };
    if (!expectedBrowserDescendantsAttributed) {
      verdict = {
        status: "inconclusive",
        reason:
          "the runner could not attribute every expected browser descendant",
        production: verdict.production,
        control: verdict.control,
      };
    }
    const playwrightPackage = JSON.parse(
      await readFile(
        join(appRoot, "node_modules/@playwright/test/package.json"),
        "utf8",
      ),
    ) as { version: string };
    const output = {
      schema: 1,
      measuredAt: new Date().toISOString(),
      commit: await gitHead(),
      runner: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytesAtEnd: freemem(),
        github: {
          repository: process.env.GITHUB_REPOSITORY,
          runId: process.env.GITHUB_RUN_ID,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          runnerImage: process.env.ImageOS,
        },
        cgroup: await linuxCgroupMetadata(),
      },
      browser: {
        engine: options.engine,
        version: browser.version(),
        executablePath: type.executablePath(),
        playwrightVersion: playwrightPackage.version,
        rootPid,
      },
      attribution,
      workload: {
        productionTrials: PRODUCTION_TRIALS,
        productionWarmupChildren: PRODUCTION_WARMUP_CHILDREN,
        productionWaveChildren: PRODUCTION_WAVE_CHILDREN,
        productionWaves: PRODUCTION_WAVES,
        controlWaveChildren: CONTROL_WAVE_CHILDREN,
        controlWaves: CONTROL_WAVES,
        childMiB: CHILD_MIB,
        sampleDelayMs: SAMPLE_DELAY_MS,
      },
      production,
      control,
      verdict,
      viteLogs,
    };
    await writeFile(
      options.outputPath,
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    if (verdict.status === "regression") process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    await browserServer?.close().catch(() => undefined);
    await stopChild(vite);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) =>
      child.once("exit", () => resolveExit())
    ),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

await main();
