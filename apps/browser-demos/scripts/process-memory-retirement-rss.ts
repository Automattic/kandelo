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
import { randomUUID } from "node:crypto";
import {
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import {
  dirname,
  join,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  applyProcessMemoryRssHealthErrors,
  classifyProcessMemoryRss,
  PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS,
  type ProcessMemoryRssPhase,
  type ProcessMemoryRssSample,
  type ProcessMemoryRssTrial,
  type ProcessMemoryRssTrialKind,
  type ProcessRssEntry,
} from "../process-memory-rss-telemetry";
import {
  exactPlaywrightInstallRoot,
  exactPlaywrightInstallRoots,
  linuxBrowserProcessAttributionComplete,
  parseLinuxProcessMemory,
  parseLinuxProcStartTicks,
  parseLinuxSwapDisabled,
  parsePlaywrightInstallation,
  processEnvironmentHasLaunchNonce,
  type BrowserEngineName,
  type PlaywrightInstallation,
} from "../process-memory-linux-accounting";

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
const PRODUCTION_WARMUP_CHILDREN = 4;
const PRODUCTION_WAVE_CHILDREN = 8;
const PRODUCTION_WAVES = 32;
const CONTROL_WARMUP_CHILDREN = 1;
const CONTROL_WAVE_CHILDREN = 1;
const CONTROL_WAVES = 4;
const LOW_CHILD_MIB = 1;
const HIGH_CHILD_MIB = 32;
const SAMPLE_DELAY_MS = 200;
const LAUNCH_NONCE_KEY = "KANDELO_MEMORY_TELEMETRY_NONCE";
const VITE_ERROR_MARKERS = [
  "internal server error",
  "pre-transform error",
  "error when starting dev server",
  "failed to run dependency scan",
  "build failed with ",
];

type EngineName = BrowserEngineName;

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
  readonly samplingIssues: readonly string[];
}

interface TrialPlan {
  readonly kind: ProcessMemoryRssTrialKind;
  readonly childMiB: number;
}

const TRIAL_PLAN: readonly TrialPlan[] = [
  { kind: "retired", childMiB: LOW_CHILD_MIB },
  { kind: "live-control", childMiB: LOW_CHILD_MIB },
  { kind: "retired", childMiB: HIGH_CHILD_MIB },
  { kind: "live-control", childMiB: HIGH_CHILD_MIB },
  { kind: "live-control", childMiB: HIGH_CHILD_MIB },
  { kind: "retired", childMiB: HIGH_CHILD_MIB },
  { kind: "live-control", childMiB: LOW_CHILD_MIB },
  { kind: "retired", childMiB: LOW_CHILD_MIB },
];

interface ProcessSamplingContext {
  readonly engine: EngineName;
  readonly rootPid: number;
  readonly playwrightInstallation: PlaywrightInstallation | null;
  readonly browserBirthTicks: number | null;
  readonly launchNonce: string;
  readonly initialHostSwapDisabled: boolean | null;
}

interface ProcessSnapshot {
  readonly processes: readonly ProcessRssEntry[];
  readonly rssBytes: number;
  readonly swapBytes: number;
  readonly processAttributionComplete: boolean;
  readonly swapAccountingComplete: boolean;
  readonly hostSwapDisabled: boolean | null;
  readonly exactInstallRoots: readonly string[];
  readonly attributionReason: string;
  readonly swapAccountingReason: string;
}

interface LinuxProcessIdentity {
  readonly executablePath: string;
  readonly startTicks: number;
}

interface PsProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly command: string;
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

async function linuxProcessIdentity(
  pid: number,
): Promise<LinuxProcessIdentity | null> {
  try {
    // WHY: PID reuse between independent `/proc` reads could pair a new
    // process's executable with an old process's birth identity. Bracket the
    // executable read with stat reads and accept only one stable start tick.
    const beforeStat = await readFile(`/proc/${pid}/stat`, "utf8");
    const executablePath = await readlink(`/proc/${pid}/exe`);
    const afterStat = await readFile(`/proc/${pid}/stat`, "utf8");
    const beforeStartTicks = parseLinuxProcStartTicks(beforeStat);
    const afterStartTicks = parseLinuxProcStartTicks(afterStat);
    if (
      beforeStartTicks === null
      || beforeStartTicks !== afterStartTicks
    ) {
      return null;
    }
    return {
      executablePath: executablePath.replace(/ \(deleted\)$/, ""),
      startTicks: beforeStartTicks,
    };
  } catch {
    return null;
  }
}

async function linuxProcessMemory(
  pid: number,
  expectedStartTicks: number,
): Promise<{ rssBytes: number; swapBytes: number } | null> {
  try {
    // WHY: keep the rollup attached to the same process identity established
    // by attribution. Otherwise a PID reused between reads could contribute
    // unrelated memory to an exact-launch trace.
    const beforeStat = await readFile(`/proc/${pid}/stat`, "utf8");
    const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const afterStat = await readFile(`/proc/${pid}/stat`, "utf8");
    if (
      parseLinuxProcStartTicks(beforeStat) !== expectedStartTicks
      || parseLinuxProcStartTicks(afterStat) !== expectedStartTicks
    ) {
      return null;
    }
    return parseLinuxProcessMemory(rollup);
  } catch {
    return null;
  }
}

async function linuxProcessHasLaunchNonce(
  pid: number,
  nonce: string,
): Promise<boolean | null> {
  try {
    const environment = await readFile(`/proc/${pid}/environ`, "utf8");
    return processEnvironmentHasLaunchNonce(
      environment,
      LAUNCH_NONCE_KEY,
      nonce,
    );
  } catch {
    return null;
  }
}

async function linuxHostSwapDisabled(): Promise<boolean | null> {
  if (platform() !== "linux") return null;
  try {
    const swaps = await readFile("/proc/swaps", "utf8");
    return parseLinuxSwapDisabled(swaps);
  } catch {
    return null;
  }
}

async function createProcessSamplingContext(
  engine: EngineName,
  rootPid: number,
  browserExecutablePath: string,
  launchNonce: string,
): Promise<ProcessSamplingContext> {
  const linuxIdentity =
    platform() === "linux"
      ? await linuxProcessIdentity(rootPid)
      : null;
  return {
    engine,
    rootPid,
    playwrightInstallation:
      platform() === "linux"
        ? parsePlaywrightInstallation(engine, browserExecutablePath)
        : null,
    browserBirthTicks: linuxIdentity?.startTicks ?? null,
    launchNonce,
    initialHostSwapDisabled: await linuxHostSwapDisabled(),
  };
}

async function processTree(
  context: ProcessSamplingContext,
): Promise<ProcessSnapshot> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,ppid=,rss=,command="],
    { maxBuffer: 16 * MIB },
  );
  const all = new Map<number, PsProcessEntry>();
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

  const rootTree = new Set<number>([context.rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of all.values()) {
      if (rootTree.has(entry.ppid) && !rootTree.has(entry.pid)) {
        rootTree.add(entry.pid);
        changed = true;
      }
    }
  }

  const selected = new Set(rootTree);
  const identities = new Map<number, LinuxProcessIdentity>();
  const exactRootsByPid = new Map<number, string>();
  const nonceMatches = new Set<number>();
  const installRoots = new Set<string>();
  let installScanComplete = platform() !== "linux";
  let rootIdentityStable = platform() !== "linux";
  let rootNonceMatched = platform() !== "linux";
  let unattributedExactBuildProcessCount = 0;
  if (platform() === "linux") {
    installScanComplete =
      context.playwrightInstallation !== null
      && context.browserBirthTicks !== null;
    if (
      context.playwrightInstallation !== null
      && context.browserBirthTicks !== null
    ) {
      const installation = context.playwrightInstallation;
      const browserBirthTicks = context.browserBirthTicks;
      const expectedInstallRoots = exactPlaywrightInstallRoots(
        context.engine,
        installation,
      );
      // WHY: a helper can be reparented outside the BrowserServer tree. A
      // random environment nonce follows only this launch; the engine and
      // revision-specific executable path independently corroborate that the
      // nonce-bearing process set includes the browser build we intended.
      // This excludes concurrent launches even when they use the same build.
      const candidates = [...all.values()];
      await Promise.all(candidates.map(async (entry) => {
        const identity = await linuxProcessIdentity(entry.pid);
        if (!identity) {
          if (
            rootTree.has(entry.pid)
            || expectedInstallRoots.some(
              (root) =>
                entry.command.includes(`${root}${sep}`)
                || entry.command.endsWith(root),
            )
          ) {
            installScanComplete = false;
          }
          return;
        }
        identities.set(entry.pid, identity);
        if (identity.startTicks < browserBirthTicks) {
          // WHY: a root-tree PID older than the authenticated browser root
          // can only be a reused or inconsistent snapshot identity. Do not
          // count it merely because one `ps` parent edge looked plausible.
          if (rootTree.has(entry.pid)) installScanComplete = false;
          return;
        }
        const root = exactPlaywrightInstallRoot(
          context.engine,
          installation,
          identity.executablePath,
        );
        if (root !== null) exactRootsByPid.set(entry.pid, root);
        const nonceMatched = await linuxProcessHasLaunchNonce(
          entry.pid,
          context.launchNonce,
        );
        if (nonceMatched === null) {
          if (rootTree.has(entry.pid) || root !== null) {
            installScanComplete = false;
          }
          return;
        }
        if (nonceMatched) {
          nonceMatches.add(entry.pid);
          selected.add(entry.pid);
          if (root !== null) installRoots.add(root);
        } else if (root !== null && !rootTree.has(entry.pid)) {
          // WHY: this may be a reparented helper that sanitized its
          // environment or an unrelated same-build launch. Either way, the
          // sampler cannot safely omit it from an exact-launch total.
          unattributedExactBuildProcessCount += 1;
        }
      }));
      const rootIdentity = identities.get(context.rootPid);
      rootIdentityStable =
        rootIdentity?.startTicks === browserBirthTicks;
      rootNonceMatched = nonceMatches.has(context.rootPid);
      if (
        !rootIdentityStable
        || !rootNonceMatched
      ) {
        installScanComplete = false;
      }
    }
  }

  const hostSwapDisabledBefore = await linuxHostSwapDisabled();
  const memoryRollups = new Map<
    number,
    { rssBytes: number; swapBytes: number } | null
  >();
  const entries = (
    await Promise.all([...selected].map(async (pid) => {
      const entry = all.get(pid);
      if (!entry) return null;
      let identity = identities.get(pid) ?? null;
      if (platform() === "linux" && identity === null) {
        identity = await linuxProcessIdentity(pid);
        if (identity !== null) identities.set(pid, identity);
      }
      const root =
        exactRootsByPid.get(pid)
        ?? (
          identity !== null && context.playwrightInstallation !== null
            ? exactPlaywrightInstallRoot(
                context.engine,
                context.playwrightInstallation,
                identity.executablePath,
              )
            : null
        );
      if (root !== null) installRoots.add(root);

      let rssBytes = entry.rssBytes;
      let swapBytes = 0;
      if (platform() === "linux") {
        // WHY: RSS alone falls when the kernel swaps a still-retained shared
        // backing. Read both values even on a currently swap-free host; the
        // bracketed host check is only a safe fallback if a short-lived
        // process prevents one rollup read.
        const memory =
          identity !== null
            ? await linuxProcessMemory(pid, identity.startTicks)
            : null;
        memoryRollups.set(pid, memory);
        if (memory !== null) {
          rssBytes = memory.rssBytes;
          swapBytes = memory.swapBytes;
        }
      }
      return {
        ...entry,
        rssBytes,
        swapBytes,
        executablePath: identity?.executablePath ?? null,
        startTicks: identity?.startTicks ?? null,
        exactInstallRoot: root,
        launchNonceMatched: nonceMatches.has(pid),
        attributionSource:
          pid === context.rootPid
            ? "browser-server-root"
            : (
                rootTree.has(pid)
                  ? "root-tree"
                  : "reparented-launch-nonce"
              ),
      };
    }))
  )
    .filter((entry): entry is ProcessRssEntry => entry !== null)
    .sort((left, right) => left.pid - right.pid);
  if (!entries.some((entry) => entry.pid === context.rootPid)) {
    throw new Error(
      `browser process ${context.rootPid} disappeared before sampling`,
    );
  }

  const hostSwapDisabledAfter = await linuxHostSwapDisabled();
  const hostSwapDisabled =
    hostSwapDisabledBefore === true && hostSwapDisabledAfter === true
      ? true
      : (
          hostSwapDisabledBefore === false
          || hostSwapDisabledAfter === false
            ? false
            : null
        );
  const swapAccountingComplete =
    platform() === "linux"
    && entries.every((entry) => {
      const memory = memoryRollups.get(entry.pid);
      return (
        (memory !== undefined && memory !== null)
        || hostSwapDisabled === true
      );
    });

  const processAttributionComplete =
    platform() === "linux"
      ? linuxBrowserProcessAttributionComplete({
          scanComplete: installScanComplete,
          rootIdentityStable,
          rootNonceMatched,
          rootTreeProcessCount: entries.filter((entry) => {
            return rootTree.has(entry.pid);
          }).length,
          exactInstallProcessCount: entries.filter((entry) => {
            return entry.exactInstallRoot !== null;
          }).length,
          unattributedExactBuildProcessCount,
          reparentedProcesses: entries
            .filter((entry) => {
              return entry.attributionSource === "reparented-launch-nonce";
            })
            .map((entry) => ({
              exactInstallRoot: entry.exactInstallRoot !== null,
              launchNonceMatched: entry.launchNonceMatched,
            })),
        })
      : (
          entries.length >= 2
          && !(platform() === "darwin" && context.engine === "webkit")
        );
  return {
    processes: entries,
    rssBytes: entries.reduce((sum, entry) => sum + entry.rssBytes, 0),
    swapBytes: entries.reduce((sum, entry) => sum + entry.swapBytes, 0),
    processAttributionComplete,
    swapAccountingComplete,
    hostSwapDisabled,
    exactInstallRoots: [...installRoots].sort(),
    attributionReason: processAttributionComplete
      ? (
          platform() === "linux"
            ? "the nonce-authenticated stable root tree and every " +
              "reparented helper were attributed to the exact engine revision"
            : "the active page and browser helpers remained in the server tree"
        )
      : (
          platform() === "darwin" && context.engine === "webkit"
            ? "macOS reparents WebKit XPC helpers outside the server tree"
            : "the browser process scan could not prove complete attribution"
        ),
    swapAccountingReason: swapAccountingComplete
      ? (
          hostSwapDisabled === true
            ? "the Linux host exposes no active swap devices"
            : "every attributed process supplied RSS and Swap rollup values"
        )
      : "swap was available or unknown without complete per-process rollups",
  };
}

function browserLaunchEnvironment(
  launchNonce: string,
): Record<string, string> {
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
  // WHY: the nonce is visible only to this BrowserServer and its descendants.
  // It lets the Linux sampler distinguish reparented helpers from concurrent
  // launches of the same engine revision.
  selected[LAUNCH_NONCE_KEY] = launchNonce;
  return selected;
}

function recordRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function appendProcessMemorySample(
  samples: ProcessMemoryRssSample[],
  samplingIssues: Set<string>,
  samplingContext: ProcessSamplingContext,
  startedAt: number,
  phase: ProcessMemoryRssPhase,
  completedChildren: number,
): Promise<void> {
  const snapshot = await processTree(samplingContext);
  if (!snapshot.processAttributionComplete) {
    samplingIssues.add(snapshot.attributionReason);
  }
  if (!snapshot.swapAccountingComplete) {
    samplingIssues.add(snapshot.swapAccountingReason);
  }
  samples.push({
    phase,
    completedChildren,
    elapsedMs: Date.now() - startedAt,
    rssBytes: snapshot.rssBytes,
    swapBytes: snapshot.swapBytes,
    processAttributionComplete: snapshot.processAttributionComplete,
    swapAccountingComplete: snapshot.swapAccountingComplete,
    hostSwapDisabled: snapshot.hostSwapDisabled,
    exactInstallRoots: snapshot.exactInstallRoots,
    processes: snapshot.processes,
  });
}

async function appendPostContextCloseSamples(
  samples: ProcessMemoryRssSample[],
  samplingIssues: Set<string>,
  samplingContext: ProcessSamplingContext,
  startedAt: number,
  completedChildren: number,
): Promise<void> {
  let previousOffset = 0;
  for (const offset of PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS) {
    await delay(offset - previousOffset);
    previousOffset = offset;
    await appendProcessMemorySample(
      samples,
      samplingIssues,
      samplingContext,
      startedAt,
      "post-context-close",
      completedChildren,
    );
  }
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

async function warmBrowserRealm(
  browser: Browser,
  samplingContext: ProcessSamplingContext,
  baseUrl: string,
  kernelBase64: string,
  programBase64: string,
): Promise<void> {
  // WHY: WebKit does not create every process helper merely by initializing
  // an empty kernel. If the warm realm skips a real guest process, its first
  // measured trial absorbs hundreds of MiB of one-time worker/JIT startup and
  // makes a bounded cold start look like a retained address space. Exercise
  // the exact live-process path, including context teardown, before recording
  // any of the eight counterbalanced trials.
  const warmup = await runLiveControl(
    browser,
    samplingContext,
    baseUrl,
    kernelBase64,
    programBase64,
    HIGH_CHILD_MIB,
  );
  const errors = validateControl(warmup, -1);
  if (errors.length > 0) {
    throw new Error(`unmeasured process warm-up failed: ${errors.join("; ")}`);
  }
}

async function runProductionTrial(
  browser: Browser,
  samplingContext: ProcessSamplingContext,
  baseUrl: string,
  kernelBase64: string,
  programBase64: string,
  childMiB: number,
): Promise<BrowserRunResult> {
  const samples: ProcessMemoryRssSample[] = [];
  const samplingIssues = new Set<string>();
  const startedAt = Date.now();
  await appendProcessMemorySample(
    samples,
    samplingIssues,
    samplingContext,
    startedAt,
    "pre-context",
    0,
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  const runtimeErrors = recordRuntimeErrors(page);
  await installTsxEvaluationHelper(page);
  await page.exposeBinding(
    "__kandeloRecordProcessMemoryRss",
    async (
      _source,
      request: {
        phase: ProcessMemoryRssPhase;
        completedChildren: number;
      },
    ) => {
      await appendProcessMemorySample(
        samples,
        samplingIssues,
        samplingContext,
        startedAt,
        request.phase,
        request.completedChildren,
      );
    },
  );
  await page.goto(new URL("/trap-signal-test.html", baseUrl).href);
  let result: Omit<BrowserRunResult, "samples" | "runtimeErrors" | "samplingIssues">;
  try {
    result = await page.evaluate(
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
            const remainingProcesses = await kernel.enumProcs();
            if (
              maps.every((entry) => entry === null)
              && remainingProcesses.every(
                (process: { pid: number }) => process.pid === 1,
              )
            ) {
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

        const record = async (
          phase:
            | "initialized"
            | "post-warmup"
            | "post-wave"
            | "post-kernel-destroy",
          completedChildren: number,
        ): Promise<void> => {
          await new Promise<void>((resolveSample) =>
            setTimeout(resolveSample, sampleDelayMs)
          );
          await (
            globalThis as typeof globalThis & {
              __kandeloRecordProcessMemoryRss:
                (request: {
                  phase: string;
                  completedChildren: number;
                }) => Promise<void>;
            }
          ).__kandeloRecordProcessMemoryRss({
            phase,
            completedChildren,
          });
        };

        try {
          await record("initialized", 0);
          await runWave(warmupChildren);
          await record("post-warmup", 0);
          for (let wave = 1; wave <= waveCount; wave += 1) {
            await runWave(waveChildren);
            await record("post-wave", wave * waveChildren);
          }
        } finally {
          await kernel.destroy();
        }
        await record(
          "post-kernel-destroy",
          waveChildren * waveCount,
        );
        return { stdout, stderr, diagnostics };
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
        childMiB,
        sampleDelayMs: SAMPLE_DELAY_MS,
      },
    );
  } finally {
    await context.close();
  }
  await appendPostContextCloseSamples(
    samples,
    samplingIssues,
    samplingContext,
    startedAt,
    PRODUCTION_WAVE_CHILDREN * PRODUCTION_WAVES,
  );
  return {
    samples,
    ...result,
    runtimeErrors,
    samplingIssues: [...samplingIssues],
  };
}

async function runLiveControl(
  browser: Browser,
  samplingContext: ProcessSamplingContext,
  baseUrl: string,
  kernelBase64: string,
  programBase64: string,
  childMiB: number,
): Promise<BrowserRunResult> {
  const samples: ProcessMemoryRssSample[] = [];
  const samplingIssues = new Set<string>();
  const startedAt = Date.now();
  await appendProcessMemorySample(
    samples,
    samplingIssues,
    samplingContext,
    startedAt,
    "pre-context",
    0,
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  const runtimeErrors = recordRuntimeErrors(page);
  await installTsxEvaluationHelper(page);
  await page.exposeBinding(
    "__kandeloRecordProcessMemoryRss",
    async (
      _source,
      request: {
        phase: ProcessMemoryRssPhase;
        completedChildren: number;
      },
    ) => {
      await appendProcessMemorySample(
        samples,
        samplingIssues,
        samplingContext,
        startedAt,
        request.phase,
        request.completedChildren,
      );
    },
  );
  await page.goto(new URL("/trap-signal-test.html", baseUrl).href);
  let result: Omit<BrowserRunResult, "samples" | "runtimeErrors" | "samplingIssues">;
  try {
    result = await page.evaluate(
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
        const kernel = new BrowserKernel({
          maxWorkers: warmupChildren + waveChildren * waveCount + 2,
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

        const record = async (
          phase:
            | "initialized"
            | "post-warmup"
            | "post-wave"
            | "post-kernel-destroy",
          completedChildren: number,
        ): Promise<void> => {
          await new Promise<void>((resolveSample) =>
            setTimeout(resolveSample, sampleDelayMs)
          );
          await (
            globalThis as typeof globalThis & {
              __kandeloRecordProcessMemoryRss:
                (request: {
                  phase: string;
                  completedChildren: number;
                }) => Promise<void>;
            }
          ).__kandeloRecordProcessMemoryRss({
            phase,
            completedChildren,
          });
        };
        const spawnLiveChildren = async (count: number): Promise<void> => {
          for (let child = 0; child < count; child += 1) {
            const process = await kernel.spawnFromVfs(
              "/bin/process-memory-reclamation-churn",
              [
                "process-memory-reclamation-churn",
                "hold",
                String(childMiB),
              ],
            );
            void process.exit.catch(() => undefined);
          }
        };

        try {
          await record("initialized", 0);
          let started = warmupChildren;
          await spawnLiveChildren(warmupChildren);
          await waitForReadyCount(started);
          await record("post-warmup", 0);
          for (let wave = 1; wave <= waveCount; wave += 1) {
            await spawnLiveChildren(waveChildren);
            started += waveChildren;
            await waitForReadyCount(started);
            const liveProcesses = (await kernel.enumProcs()).filter(
              (process: { pid: number }) => process.pid !== 1,
            );
            if (liveProcesses.length !== started) {
              throw new Error(
                `only ${liveProcesses.length} of ${started} controls ` +
                "remained live",
              );
            }
            await record("post-wave", wave * waveChildren);
          }
        } finally {
          await kernel.destroy();
        }
        await record(
          "post-kernel-destroy",
          waveChildren * waveCount,
        );
        return { stdout, stderr, diagnostics };
      },
      {
        browserKernelUrl: new URL(
          `/@fs/${browserKernelModulePath}`,
          baseUrl,
        ).href,
        memoryFsUrl: new URL(`/@fs/${memoryFsModulePath}`, baseUrl).href,
        kernelBytesBase64: kernelBase64,
        programBytesBase64: programBase64,
        warmupChildren: CONTROL_WARMUP_CHILDREN,
        waveChildren: CONTROL_WAVE_CHILDREN,
        waveCount: CONTROL_WAVES,
        childMiB,
        sampleDelayMs: SAMPLE_DELAY_MS,
      },
    );
  } finally {
    await context.close();
  }
  await appendPostContextCloseSamples(
    samples,
    samplingIssues,
    samplingContext,
    startedAt,
    CONTROL_WAVE_CHILDREN * CONTROL_WAVES,
  );
  return {
    samples,
    ...result,
    runtimeErrors,
    samplingIssues: [...samplingIssues],
  };
}

function outputLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function validateCommonRun(
  label: string,
  run: BrowserRunResult,
  expectedPhases: readonly ProcessMemoryRssPhase[],
  expectedCompletedChildren: readonly number[],
): string[] {
  const errors: string[] = [];
  if (run.stderr !== "") {
    errors.push(`${label} wrote guest stderr: ${run.stderr.trim()}`);
  }
  for (const diagnostic of run.diagnostics) {
    errors.push(
      `${label} host diagnostic from ${diagnostic.source}: ` +
      diagnostic.message,
    );
  }
  for (const runtimeError of run.runtimeErrors) {
    errors.push(`${label} browser runtime error: ${runtimeError}`);
  }
  for (const samplingIssue of run.samplingIssues) {
    errors.push(`${label} sampler: ${samplingIssue}`);
  }
  const actualCompletedChildren = run.samples.map(
    (sample) => sample.completedChildren,
  );
  const actualPhases = run.samples.map((sample) => sample.phase);
  if (JSON.stringify(actualPhases) !== JSON.stringify(expectedPhases)) {
    errors.push(
      `${label} sampled phases ${JSON.stringify(actualPhases)} instead of ` +
        JSON.stringify(expectedPhases),
    );
  }
  if (
    JSON.stringify(actualCompletedChildren)
    !== JSON.stringify(expectedCompletedChildren)
  ) {
    errors.push(
      `${label} sampled children ${JSON.stringify(actualCompletedChildren)} ` +
      `instead of ${JSON.stringify(expectedCompletedChildren)}`,
    );
  }
  if (run.samples.some((sample) => !sample.processAttributionComplete)) {
    errors.push(`${label} has an incompletely attributed process sample`);
  }
  if (run.samples.some((sample) => !sample.swapAccountingComplete)) {
    errors.push(`${label} has an incomplete swap sample`);
  }
  return errors;
}

function validateProductionTrial(
  run: BrowserRunResult,
  sequenceIndex: number,
  childMiB: number,
): string[] {
  const label = `retirement trial ${sequenceIndex + 1}`;
  const expectedPhases: ProcessMemoryRssPhase[] = [
    "pre-context",
    "initialized",
    "post-warmup",
    ...Array.from(
      { length: PRODUCTION_WAVES },
      () => "post-wave" as const,
    ),
    "post-kernel-destroy",
    ...PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS.map(
      () => "post-context-close" as const,
    ),
  ];
  const expectedCompletedChildren = [
    0,
    0,
    0,
    ...Array.from(
      { length: PRODUCTION_WAVES },
      (_unused, index) => (index + 1) * PRODUCTION_WAVE_CHILDREN,
    ),
    PRODUCTION_WAVES * PRODUCTION_WAVE_CHILDREN,
    ...PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS.map(
      () => PRODUCTION_WAVES * PRODUCTION_WAVE_CHILDREN,
    ),
  ];
  const errors = validateCommonRun(
    label,
    run,
    expectedPhases,
    expectedCompletedChildren,
  );
  const expectedLines = [
    `PROCESS_MEMORY_RECLAMATION_PASS ` +
      `count=${PRODUCTION_WARMUP_CHILDREN} child_mib=${childMiB}`,
    ...Array.from(
      { length: PRODUCTION_WAVES },
      () => (
        `PROCESS_MEMORY_RECLAMATION_PASS ` +
        `count=${PRODUCTION_WAVE_CHILDREN} child_mib=${childMiB}`
      ),
    ),
  ];
  if (JSON.stringify(outputLines(run.stdout)) !== JSON.stringify(expectedLines)) {
    errors.push(
      `${label} did not produce the exact expected completion transcript`,
    );
  }
  return errors;
}

function validateControl(
  run: BrowserRunResult,
  sequenceIndex: number,
): string[] {
  const expectedPhases: ProcessMemoryRssPhase[] = [
    "pre-context",
    "initialized",
    "post-warmup",
    ...Array.from(
      { length: CONTROL_WAVES },
      () => "post-wave" as const,
    ),
    "post-kernel-destroy",
    ...PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS.map(
      () => "post-context-close" as const,
    ),
  ];
  const expectedCompletedChildren = [
    0,
    0,
    0,
    ...Array.from(
      { length: CONTROL_WAVES },
      (_unused, index) => (index + 1) * CONTROL_WAVE_CHILDREN,
    ),
    CONTROL_WAVES * CONTROL_WAVE_CHILDREN,
    ...PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS.map(
      () => CONTROL_WAVES * CONTROL_WAVE_CHILDREN,
    ),
  ];
  const errors = validateCommonRun(
    `live-process control ${sequenceIndex + 1}`,
    run,
    expectedPhases,
    expectedCompletedChildren,
  );
  const expectedReadyCount =
    CONTROL_WARMUP_CHILDREN + CONTROL_WAVES * CONTROL_WAVE_CHILDREN;
  const lines = outputLines(run.stdout);
  if (
    lines.length !== expectedReadyCount
    || lines.some((line) => line !== "PROCESS_MEMORY_CONTROL_READY")
  ) {
    errors.push(
      "live-process control did not produce the exact expected readiness " +
      "transcript",
    );
  }
  return errors;
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
  const viteProcessErrors: string[] = [];
  let viteReportedError = false;
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
      env: {
        ...process.env,
        KANDELO_BROWSER_TEST_NO_DEP_SCAN: "1",
        KANDELO_PLAYWRIGHT_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collectViteLog = (chunk: Buffer): void => {
    const text = chunk.toString();
    viteLogs.push(text);
    if (viteLogs.length > 200) viteLogs.shift();
    if (VITE_ERROR_MARKERS.some(
      (marker) => text.toLowerCase().includes(marker),
    )) {
      viteReportedError = true;
    }
  };
  vite.stdout?.on("data", collectViteLog);
  vite.stderr?.on("data", collectViteLog);
  vite.on("error", (error) => {
    viteProcessErrors.push(`Vite process error: ${error.message}`);
  });

  let browserServer: BrowserServer | undefined;
  let browser: Browser | undefined;
  try {
    await waitForServer(`${baseUrl}/trap-signal-test.html`);
    const type = engineType(options.engine);
    const launchNonce = randomUUID();
    browserServer = await type.launchServer({
      headless: true,
      env: browserLaunchEnvironment(launchNonce),
    });
    const browserProcess = browserServer.process();
    const rootPid = browserProcess.pid;
    if (!rootPid) throw new Error("Playwright did not expose a browser pid");
    browser = await type.connect(browserServer.wsEndpoint());
    const samplingContext = await createProcessSamplingContext(
      options.engine,
      rootPid,
      type.executablePath(),
      launchNonce,
    );

    // WHY: Vite treats a fetched `.wasm` path as a module request and may
    // return its JavaScript wrapper. Transport exact bytes through
    // Playwright instead so telemetry can never measure an accidental build
    // artifact selected by the dev server.
    const [kernelBase64, programBase64] = await Promise.all([
      readFile(options.kernelPath).then((bytes) => bytes.toString("base64")),
      readFile(options.programPath).then((bytes) => bytes.toString("base64")),
    ]);
    await warmBrowserRealm(
      browser,
      samplingContext,
      baseUrl,
      kernelBase64,
      programBase64,
    );
    const runs: Array<{
      plan: TrialPlan;
      result: BrowserRunResult;
      sequenceIndex: number;
    }> = [];
    for (
      let sequenceIndex = 0;
      sequenceIndex < TRIAL_PLAN.length;
      sequenceIndex += 1
    ) {
      const plan = TRIAL_PLAN[sequenceIndex]!;
      const result = plan.kind === "retired"
        ? await runProductionTrial(
            browser,
            samplingContext,
            baseUrl,
            kernelBase64,
            programBase64,
            plan.childMiB,
          )
        : await runLiveControl(
            browser,
            samplingContext,
            baseUrl,
            kernelBase64,
            programBase64,
            plan.childMiB,
          );
      runs.push({ plan, result, sequenceIndex });
    }
    const trials: ProcessMemoryRssTrial[] = runs.map((run) => {
      const retired = run.plan.kind === "retired";
      return {
        kind: run.plan.kind,
        sequenceIndex: run.sequenceIndex,
        childMiB: run.plan.childMiB,
        warmupChildren:
          retired
            ? PRODUCTION_WARMUP_CHILDREN
            : CONTROL_WARMUP_CHILDREN,
        waveChildren:
          retired ? PRODUCTION_WAVE_CHILDREN : CONTROL_WAVE_CHILDREN,
        waves: retired ? PRODUCTION_WAVES : CONTROL_WAVES,
        samples: run.result.samples,
      };
    });
    const physicalVerdict = classifyProcessMemoryRss(trials);
    let verdict = physicalVerdict;
    const allSamples = runs.flatMap((run) => run.result.samples);
    const minimumAttributedProcessCount = Math.min(
      ...allSamples.map((sample) => sample.processes.length),
    );
    const exactInstallRoots = [
      ...new Set(allSamples.flatMap((sample) => sample.exactInstallRoots)),
    ].sort();
    const processAttributionComplete = allSamples.every(
      (sample) => sample.processAttributionComplete,
    );
    const swapAccountingComplete = allSamples.every(
      (sample) => sample.swapAccountingComplete,
    );
    const allHostSwapDisabled = allSamples.every(
      (sample) => sample.hostSwapDisabled === true,
    );
    const attribution = {
      model:
        platform() === "linux"
          ? "launch-nonce-plus-birth-fenced-exact-playwright-install"
          : "browser-server-root-plus-transitive-descendants",
      rootPid,
      minimumAttributedProcessCount,
      exactInstallRoots,
      processAttributionComplete,
      reason: processAttributionComplete
        ? (
            platform() === "linux"
              ? "the root tree and reparented nonce-bearing helpers matched " +
                "the exact engine revision"
              : "the active page and browser helpers remained in the server tree"
          )
        : (
          platform() === "darwin" && options.engine === "webkit"
            ? "macOS reparents WebKit XPC helpers outside the server tree"
            : "the sampler could not prove exact-build process attribution"
        ),
    };
    const swapAccounting = {
      model:
        allHostSwapDisabled
          ? "host-swap-disabled"
          : "per-process-smaps-rollup",
      complete: swapAccountingComplete,
      hostSwapDisabledForEverySample: allHostSwapDisabled,
      initialHostSwapDisabled:
        samplingContext.initialHostSwapDisabled,
      reason: swapAccountingComplete
        ? (
            allHostSwapDisabled
              ? "the Linux host exposes no active swap devices"
              : "every attributed process supplied RSS and Swap values"
          )
        : "swap was not disabled and per-process accounting was incomplete",
    };

    const healthErrors = [
      ...runs.flatMap((run) => {
        return run.plan.kind === "retired"
          ? validateProductionTrial(
              run.result,
              run.sequenceIndex,
              run.plan.childMiB,
            )
          : validateControl(run.result, run.sequenceIndex);
      }),
      ...viteProcessErrors,
    ];
    if (vite.exitCode !== null || vite.signalCode !== null) {
      healthErrors.push(
        `Vite exited before telemetry completed: code=${vite.exitCode} ` +
        `signal=${vite.signalCode}`,
      );
    }
    if (viteReportedError) {
      healthErrors.push("Vite reported a compilation or server error");
    }
    if (
      browserProcess.exitCode !== null
      || browserProcess.signalCode !== null
      || !browser.isConnected()
    ) {
      healthErrors.push(
        "the browser server exited or disconnected before telemetry completed",
      );
    }
    if (!processAttributionComplete) {
      healthErrors.push(
        "the runner could not attribute the browser's exact process set",
      );
    }
    if (!swapAccountingComplete) {
      healthErrors.push(
        "the runner could not account for swapped browser memory",
      );
    }
    if (healthErrors.length > 0) {
      verdict = applyProcessMemoryRssHealthErrors(
        verdict,
        healthErrors,
      );
    }
    const playwrightPackage = JSON.parse(
      await readFile(
        join(appRoot, "node_modules/@playwright/test/package.json"),
        "utf8",
      ),
    ) as { version: string };
    const output = {
      schema: 3,
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
        initialHostSwapDisabled:
          samplingContext.initialHostSwapDisabled,
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
        playwrightRevision:
          samplingContext.playwrightInstallation?.revision ?? null,
        executablePath: type.executablePath(),
        playwrightVersion: playwrightPackage.version,
        rootPid,
      },
      longitudinalBaselineKey: [
        options.engine,
        browser.version(),
        `revision-${
          samplingContext.playwrightInstallation?.revision ?? "unknown"
        }`,
        `playwright-${playwrightPackage.version}`,
        process.env.ImageOS ?? `${platform()}-${release()}-${arch()}`,
      ].join("/"),
      attribution,
      swapAccounting,
      workload: {
        trialPlan: TRIAL_PLAN,
        productionWarmupChildren: PRODUCTION_WARMUP_CHILDREN,
        productionWaveChildren: PRODUCTION_WAVE_CHILDREN,
        productionWaves: PRODUCTION_WAVES,
        controlWarmupChildren: CONTROL_WARMUP_CHILDREN,
        controlWaveChildren: CONTROL_WAVE_CHILDREN,
        controlWaves: CONTROL_WAVES,
        lowChildMiB: LOW_CHILD_MIB,
        highChildMiB: HIGH_CHILD_MIB,
        sampleDelayMs: SAMPLE_DELAY_MS,
        postContextCloseSampleOffsetsMs:
          PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS,
      },
      trials: trials.map((trial, index) => ({
        ...trial,
        ...runs[index]!.result,
      })),
      healthErrors,
      physicalVerdict,
      verdict,
      viteLogs,
    };
    await writeFile(
      options.outputPath,
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    if (verdict.status !== "pass") process.exitCode = 1;
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
