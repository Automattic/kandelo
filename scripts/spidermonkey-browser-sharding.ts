#!/usr/bin/env tsx
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type SpiderMonkeySuite = "jstests";

export interface ChunkPlan {
  index: number;
  suite: SpiderMonkeySuite;
  chunk: string;
  runnableJsFiles: number;
  selectors: string[];
}

export interface LanePorts {
  laneId: string;
  vitePort: number;
  bridgePort: number;
}

export interface LanePlan extends LanePorts {
  index: number;
  resultDir: string;
  chunkListPath: string;
  runnableJsFiles: number;
  chunks: ChunkPlan[];
}

export interface SummaryRow {
  laneId: string;
  host: string;
  suite: SpiderMonkeySuite;
  chunk: string;
  status: number;
  pass: number;
  knownSkip: number;
  unexpected: number;
  elapsedSeconds: number;
  queueSeconds: number;
  guestSeconds: number;
  start: string;
  end: string;
  log: string;
}

export interface MergeAudit {
  plannedChunks: number;
  mergedChunks: number;
  missingChunks: string[];
  duplicateChunks: string[];
  extraChunks: string[];
}

export interface MergeResult {
  rows: SummaryRow[];
  audit: MergeAudit;
  totals: {
    pass: number;
    knownSkip: number;
    unexpected: number;
    elapsedSeconds: number;
    queueSeconds: number;
    guestSeconds: number;
  };
}

interface ParsedArgs {
  lanes: number;
  timeout: number;
  noSlow: boolean;
  resultsDir: string;
  chunks: string[];
  chunkList?: string;
  baseVitePort: number;
  baseBridgePort: number;
  heartbeatSeconds: number;
  chunkSize: number;
  dryRun: boolean;
}

interface InventoryCache {
  recursiveFiles: Map<string, string[]>;
  directFiles: Map<string, string[]>;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const OFFICIAL_ALL_RUNNER = join(REPO_ROOT, "scripts/run-spidermonkey-official-all.sh");
const HELPER_NAMES = new Set([
  "shell.js",
  "browser.js",
  "template.js",
  "user.js",
  "js-test-driver-begin.js",
  "js-test-driver-end.js",
]);
const PLATFORM_CRASH_PATTERNS = [
  /RuntimeError: unreachable/i,
  /memory access out of bounds/i,
  /Maximum call stack size exceeded/i,
  /deadlock/i,
  /unreaped/i,
  /ABI mismatch/i,
  /VFS .*mismatch/i,
  /missing artifact/i,
  /spidermonkey-test\.vfs\.zst not found/i,
];

function nowIso(): string {
  return new Date().toISOString();
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function normalizeChunk(chunk: string): string {
  let value = chunk.trim();
  if (value.startsWith("jstests/")) value = value.slice("jstests/".length);
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function chunkKey(suite: string, chunk: string): string {
  return `${suite}/${normalizeChunk(chunk)}`;
}

function isRunnableJstestFile(name: string): boolean {
  return name.endsWith(".js") && !HELPER_NAMES.has(name);
}

function sortedDirents(dir: string) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listRunnableFilesRecursive(
  dir: string,
  testRoot: string,
  cache?: InventoryCache,
): string[] {
  const cached = cache?.recursiveFiles.get(dir);
  if (cached) return cached;
  const files: string[] = [];
  for (const entry of sortedDirents(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRunnableFilesRecursive(path, testRoot, cache));
    } else if (entry.isFile() && isRunnableJstestFile(entry.name)) {
      files.push(toPosix(relative(testRoot, path)));
    }
  }
  cache?.recursiveFiles.set(dir, files);
  return files;
}

function listRunnableFilesDirect(
  dir: string,
  testRoot: string,
  cache?: InventoryCache,
): string[] {
  const cached = cache?.directFiles.get(dir);
  if (cached) return cached;
  const files: string[] = [];
  for (const entry of sortedDirents(dir)) {
    if (entry.isFile() && isRunnableJstestFile(entry.name)) {
      files.push(toPosix(relative(testRoot, join(dir, entry.name))));
    }
  }
  cache?.directFiles.set(dir, files);
  return files;
}

function addChunk(
  chunks: ChunkPlan[],
  suite: SpiderMonkeySuite,
  chunk: string,
  selectors: string[],
) {
  chunks.push({
    index: chunks.length,
    suite,
    chunk: normalizeChunk(chunk),
    runnableJsFiles: selectors.length,
    selectors,
  });
}

function addSelectorGroups(
  chunks: ChunkPlan[],
  chunkPrefix: string,
  selectors: string[],
  chunkSize: number,
) {
  let part = 1;
  for (let index = 0; index < selectors.length; index += chunkSize) {
    const group = selectors.slice(index, index + chunkSize);
    addChunk(
      chunks,
      "jstests",
      `${chunkPrefix}#part-${String(part).padStart(4, "0")}`,
      group,
    );
    part++;
  }
}

function collectJstestDir(
  chunks: ChunkPlan[],
  dir: string,
  testRoot: string,
  chunk: string,
  chunkSize: number,
  cache: InventoryCache,
) {
  const selectors = listRunnableFilesRecursive(dir, testRoot, cache);
  if (selectors.length === 0) {
    addChunk(chunks, "jstests", chunk, []);
    return;
  }

  if (selectors.length <= chunkSize) {
    addChunk(chunks, "jstests", chunk, selectors);
    return;
  }

  const directFiles = listRunnableFilesDirect(dir, testRoot, cache);
  if (directFiles.length > 0) {
    addSelectorGroups(chunks, `${chunk}/_files`, directFiles, chunkSize);
  }

  for (const entry of sortedDirents(dir)) {
    if (entry.isDirectory()) {
      collectJstestDir(
        chunks,
        join(dir, entry.name),
        testRoot,
        `${chunk}/${entry.name}`,
        chunkSize,
        cache,
      );
    }
  }
}

export function buildJstestChunkInventory(testRoot: string, chunkSize = 500): ChunkPlan[] {
  const chunks: ChunkPlan[] = [];
  const cache: InventoryCache = {
    recursiveFiles: new Map(),
    directFiles: new Map(),
  };
  for (const entry of sortedDirents(testRoot)) {
    if (!entry.isDirectory()) continue;
    const dir = join(testRoot, entry.name);
    if (listRunnableFilesRecursive(dir, testRoot, cache).length === 0) continue;
    collectJstestDir(chunks, dir, testRoot, entry.name, chunkSize, cache);
  }
  return chunks;
}

export function filterChunks(chunks: ChunkPlan[], requestedChunks: string[]): ChunkPlan[] {
  if (requestedChunks.length === 0) return chunks;
  const byChunk = new Map<string, ChunkPlan>();
  for (const chunk of chunks) {
    byChunk.set(chunk.chunk, chunk);
    byChunk.set(chunkKey(chunk.suite, chunk.chunk), chunk);
  }

  const selected: ChunkPlan[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const requested of requestedChunks) {
    const normalized = normalizeChunk(requested);
    const found = byChunk.get(normalized) ?? byChunk.get(`jstests/${normalized}`);
    if (!found) {
      missing.push(requested);
      continue;
    }
    const key = chunkKey(found.suite, found.chunk);
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(found);
    }
  }
  if (missing.length > 0) {
    throw new Error(`requested chunks not found: ${missing.join(", ")}`);
  }
  return selected;
}

export function planPortNumbers(
  laneCount: number,
  baseVitePort: number,
  baseBridgePort: number,
): LanePorts[] {
  if (!Number.isInteger(laneCount) || laneCount < 1) {
    throw new Error("lane count must be a positive integer");
  }
  const ports: LanePorts[] = [];
  const used = new Set<number>();
  for (let index = 0; index < laneCount; index++) {
    const vitePort = baseVitePort + index;
    const bridgePort = baseBridgePort + index;
    if (used.has(vitePort) || used.has(bridgePort)) {
      throw new Error(`duplicate lane port allocation at lane ${index + 1}`);
    }
    used.add(vitePort);
    used.add(bridgePort);
    ports.push({ laneId: `lane-${index + 1}`, vitePort, bridgePort });
  }
  return ports;
}

export function assertAuthoritativeBrowserJobs(host: string, jobs: number): void {
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error("jobs must be a positive integer");
  }
  if ((host === "browser" || host === "both") && jobs > 1) {
    throw new Error(
      `browser --jobs ${jobs} through one bridge is non-authoritative; use independent browser lanes with --jobs 1`,
    );
  }
}

export function planShards(
  chunks: ChunkPlan[],
  laneCount: number,
  ports: LanePorts[] = planPortNumbers(laneCount, 5624, 5724),
  resultsDir = "",
): LanePlan[] {
  if (ports.length !== laneCount) {
    throw new Error("port allocation count must match lane count");
  }
  const lanes: LanePlan[] = ports.map((port, index) => ({
    ...port,
    index,
    resultDir: resultsDir ? join(resultsDir, port.laneId) : port.laneId,
    chunkListPath: resultsDir ? join(resultsDir, port.laneId, "chunk-list.txt") : "chunk-list.txt",
    runnableJsFiles: 0,
    chunks: [],
  }));

  const sorted = [...chunks].sort((a, b) => {
    const bySize = b.runnableJsFiles - a.runnableJsFiles;
    return bySize !== 0 ? bySize : a.index - b.index;
  });
  for (const chunk of sorted) {
    const lane = lanes.reduce((best, candidate) => {
      if (candidate.runnableJsFiles < best.runnableJsFiles) return candidate;
      if (
        candidate.runnableJsFiles === best.runnableJsFiles &&
        candidate.index < best.index
      ) {
        return candidate;
      }
      return best;
    }, lanes[0]);
    lane.chunks.push(chunk);
    lane.runnableJsFiles += chunk.runnableJsFiles;
  }

  for (const lane of lanes) {
    lane.chunks.sort((a, b) => a.index - b.index);
  }
  auditShardPlan(chunks, lanes);
  return lanes;
}

export function laneViteCacheDir(lane: LanePlan): string {
  return join(lane.resultDir, "vite-cache");
}

export function auditShardPlan(chunks: ChunkPlan[], lanes: LanePlan[]): void {
  const expected = new Set(chunks.map((chunk) => chunkKey(chunk.suite, chunk.chunk)));
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const lane of lanes) {
    for (const chunk of lane.chunks) {
      const key = chunkKey(chunk.suite, chunk.chunk);
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
  }
  const missing = [...expected].filter((key) => !seen.has(key));
  const extra = [...seen].filter((key) => !expected.has(key));
  if (duplicates.length > 0 || missing.length > 0 || extra.length > 0) {
    throw new Error(
      [
        "shard plan audit failed",
        duplicates.length ? `duplicates=${duplicates.join(",")}` : "",
        missing.length ? `missing=${missing.join(",")}` : "",
        extra.length ? `extra=${extra.join(",")}` : "",
      ].filter(Boolean).join(" "),
    );
  }
}

export async function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.listen(port, host, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

export async function assertPortsAvailable(ports: LanePorts[]): Promise<void> {
  for (const lane of ports) {
    for (const [kind, port] of [["Vite", lane.vitePort], ["bridge", lane.bridgePort]] as const) {
      if (!(await isPortAvailable(port))) {
        throw new Error(`${kind} port ${port} for ${lane.laneId} is already in use`);
      }
    }
  }
}

function parseNumber(value: string | undefined): number {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}

export function parseSummaryTsv(text: string, laneId: string): SummaryRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  const indexOf = (name: string) => header.indexOf(name);
  const rows: SummaryRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    const field = (name: string): string => {
      const index = indexOf(name);
      return index >= 0 ? fields[index] ?? "" : "";
    };
    rows.push({
      laneId,
      host: field("host") || "browser",
      suite: (field("suite") || "jstests") as SpiderMonkeySuite,
      chunk: normalizeChunk(field("chunk")),
      status: parseNumber(field("status")),
      pass: parseNumber(field("pass")),
      knownSkip: parseNumber(field("known_skip")),
      unexpected: parseNumber(field("unexpected")),
      elapsedSeconds: parseNumber(field("elapsed_seconds")),
      queueSeconds: parseNumber(field("queue_seconds")),
      guestSeconds: parseNumber(field("guest_seconds") || field("elapsed_seconds")),
      start: field("start"),
      end: field("end"),
      log: field("log"),
    });
  }
  return rows;
}

export function mergeLaneSummaries(
  plannedChunks: ChunkPlan[],
  laneRows: SummaryRow[],
): MergeResult {
  const expected = new Map<string, ChunkPlan>();
  for (const chunk of plannedChunks) {
    expected.set(chunkKey(chunk.suite, chunk.chunk), chunk);
  }

  const seen = new Map<string, SummaryRow>();
  const duplicates: string[] = [];
  const extra: string[] = [];
  for (const row of laneRows) {
    const key = chunkKey(row.suite, row.chunk);
    if (!expected.has(key)) extra.push(key);
    if (seen.has(key)) duplicates.push(key);
    seen.set(key, row);
  }

  const missing = [...expected.keys()].filter((key) => !seen.has(key));
  const audit: MergeAudit = {
    plannedChunks: expected.size,
    mergedChunks: seen.size,
    missingChunks: missing,
    duplicateChunks: duplicates,
    extraChunks: extra,
  };
  if (missing.length > 0 || duplicates.length > 0 || extra.length > 0) {
    throw new Error(
      `merge audit failed: missing=${missing.length} duplicate=${duplicates.length} extra=${extra.length}`,
    );
  }

  const rows = [...laneRows].sort((a, b) => {
    const ai = expected.get(chunkKey(a.suite, a.chunk))!.index;
    const bi = expected.get(chunkKey(b.suite, b.chunk))!.index;
    return ai - bi;
  });
  const totals = rows.reduce((acc, row) => {
    acc.pass += row.pass;
    acc.knownSkip += row.knownSkip;
    acc.unexpected += row.unexpected;
    acc.elapsedSeconds += row.elapsedSeconds;
    acc.queueSeconds += row.queueSeconds;
    acc.guestSeconds += row.guestSeconds;
    return acc;
  }, {
    pass: 0,
    knownSkip: 0,
    unexpected: 0,
    elapsedSeconds: 0,
    queueSeconds: 0,
    guestSeconds: 0,
  });
  return { rows, audit, totals };
}

export function formatMergedSummaryTsv(rows: SummaryRow[]): string {
  const header = [
    "lane",
    "host",
    "suite",
    "chunk",
    "status",
    "pass",
    "known_skip",
    "unexpected",
    "elapsed_seconds",
    "queue_seconds",
    "guest_seconds",
    "start",
    "end",
    "log",
  ];
  const body = rows.map((row) => [
    row.laneId,
    row.host,
    row.suite,
    row.chunk,
    String(row.status),
    String(row.pass),
    String(row.knownSkip),
    String(row.unexpected),
    String(row.elapsedSeconds),
    String(row.queueSeconds),
    String(row.guestSeconds),
    row.start,
    row.end,
    row.log,
  ].join("\t"));
  return `${[header.join("\t"), ...body].join("\n")}\n`;
}

function readChunkList(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    lanes: 2,
    timeout: 120,
    noSlow: false,
    resultsDir: join(REPO_ROOT, "test-results/spidermonkey-browser-sharded", nowIso().replace(/[:.]/g, "")),
    chunks: [],
    baseVitePort: 5624,
    baseBridgePort: 5724,
    heartbeatSeconds: 600,
    chunkSize: 500,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case "--suite":
        if (value() !== "jstests") throw new Error("browser sharding currently supports --suite jstests only");
        break;
      case "--lanes":
        parsed.lanes = Number(value());
        break;
      case "--timeout":
        parsed.timeout = Number(value());
        break;
      case "--no-slow":
        parsed.noSlow = true;
        break;
      case "--results-dir":
        parsed.resultsDir = resolve(value());
        break;
      case "--chunk":
        parsed.chunks.push(value());
        break;
      case "--chunk-list":
        parsed.chunkList = resolve(value());
        break;
      case "--base-vite-port":
        parsed.baseVitePort = Number(value());
        break;
      case "--base-bridge-port":
        parsed.baseBridgePort = Number(value());
        break;
      case "--heartbeat-seconds":
        parsed.heartbeatSeconds = Number(value());
        break;
      case "--chunk-size":
        parsed.chunkSize = Number(value());
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(parsed.lanes) || parsed.lanes < 1) {
    throw new Error("--lanes must be a positive integer");
  }
  if (!Number.isInteger(parsed.timeout) || parsed.timeout < 1) {
    throw new Error("--timeout must be a positive integer");
  }
  if (!Number.isInteger(parsed.chunkSize) || parsed.chunkSize < 1) {
    throw new Error("--chunk-size must be a positive integer");
  }
  if (parsed.chunkList) {
    parsed.chunks.push(...readChunkList(parsed.chunkList));
  }
  return parsed;
}

function printUsage(): void {
  console.log(`Usage: scripts/run-spidermonkey-browser-sharded.sh [OPTIONS]

Options:
  --suite jstests              Official suite to run (currently jstests only)
  --lanes N                    Number of independent browser lanes (default: 2)
  --timeout SECONDS            Upstream per-test timeout per lane (default: 120)
  --no-slow                    Skip tests marked slow
  --results-dir DIR            Output directory for merged and lane artifacts
  --chunk CHUNK                Limit the plan to a chunk; may be repeated
  --chunk-list FILE            Limit the plan to chunks listed in FILE
  --base-vite-port PORT        First lane Vite port (default: 5624)
  --base-bridge-port PORT      First lane browser bridge port (default: 5724)
  --heartbeat-seconds N        Progress heartbeat interval (default: 600)
  --chunk-size N               Planner split size matching official all-runner (default: 500)
  --dry-run                    Write inventory and shard plan without running lanes
`);
}

function ensureSpiderMonkeySource(): string {
  const result = spawnSync("bash", [join(REPO_ROOT, "scripts/ensure-spidermonkey-source.sh")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "failed to resolve SpiderMonkey source");
  }
  return result.stdout.trim();
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function appendProgress(path: string, event: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ timestamp: nowIso(), ...event })}\n`);
}

function logContainsPlatformCrash(path: string): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  return PLATFORM_CRASH_PATTERNS.some((pattern) => pattern.test(text));
}

function killProcessGroup(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    if (process.platform === "win32") proc.kill("SIGTERM");
    else process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
}

async function runLane(
  lane: LanePlan,
  args: ParsedArgs,
  progressPath: string,
  registerProcess: (proc: ChildProcess) => void,
): Promise<{ lane: LanePlan; status: number; signal: NodeJS.Signals | null; platformCrash: boolean }> {
  mkdirSync(lane.resultDir, { recursive: true });
  writeFileSync(lane.chunkListPath, lane.chunks.map((chunk) => `${chunk.suite}/${chunk.chunk}\n`).join(""));
  const commandLog = join(lane.resultDir, "command.log");
  const viteCacheDir = laneViteCacheDir(lane);
  const log = createWriteStream(commandLog, { flags: "w" });
  log.write(`lane=${lane.index + 1}\n`);
  log.write(`vite_port=${lane.vitePort}\n`);
  log.write(`bridge_port=${lane.bridgePort}\n`);
  log.write(`vite_cache_dir=${viteCacheDir}\n`);
  log.write(`chunks=${lane.chunks.length}\n`);
  log.write(`runnable_js_files=${lane.runnableJsFiles}\n`);
  log.write(`started=${nowIso()}\n`);

  if (lane.chunks.length === 0) {
    writeFileSync(
      join(lane.resultDir, "summary.tsv"),
      "host\tsuite\tchunk\tstatus\tpass\tknown_skip\tunexpected\telapsed_seconds\tqueue_seconds\tguest_seconds\tstart\tend\tlog\n",
    );
    log.end(`finished=${nowIso()}\n`);
    return { lane, status: 0, signal: null, platformCrash: false };
  }

  const runnerArgs = [
    OFFICIAL_ALL_RUNNER,
    "--host", "browser",
    "--suite", "jstests",
    "--jobs", "1",
    "--timeout", String(args.timeout),
    "--results-dir", lane.resultDir,
    "--chunk-list", lane.chunkListPath,
  ];
  if (args.noSlow) runnerArgs.push("--no-slow");

  appendProgress(progressPath, {
    event: "lane_start",
    lane_id: lane.laneId,
    chunks: lane.chunks.length,
    planned_scripts: lane.runnableJsFiles,
    vite_port: lane.vitePort,
    bridge_port: lane.bridgePort,
    result_dir: lane.resultDir,
    complete_suite_claim: false,
  });

  const proc = spawn("bash", runnerArgs, {
    cwd: REPO_ROOT,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      SPIDERMONKEY_TEST_VITE_PORT: String(lane.vitePort),
      SPIDERMONKEY_BROWSER_JS_SHELL_PORT: String(lane.bridgePort),
      KANDELO_BROWSER_TEST_VITE_CACHE_DIR: viteCacheDir,
      SPIDERMONKEY_BROWSER_JS_SHELL_RECYCLE_INTERVAL:
        process.env.SPIDERMONKEY_BROWSER_JS_SHELL_RECYCLE_INTERVAL ?? "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerProcess(proc);
  proc.stdout.pipe(log, { end: false });
  proc.stderr.pipe(log, { end: false });

  const result = await new Promise<{ status: number; signal: NodeJS.Signals | null }>((resolveExit) => {
    proc.on("exit", (status, signal) => resolveExit({ status: status ?? 1, signal }));
    proc.on("error", (err) => {
      log.write(`spawn error: ${err.message}\n`);
      resolveExit({ status: 1, signal: null });
    });
  });
  log.write(`finished=${nowIso()}\n`);
  log.end();

  const platformCrash = result.status === 86 ||
    logContainsPlatformCrash(commandLog) ||
    lane.chunks.some((chunk) => {
      const safe = `${rowSafeName(`browser-jstests-${chunk.chunk}`)}.log`;
      return logContainsPlatformCrash(join(lane.resultDir, safe));
    });
  appendProgress(progressPath, {
    event: "lane_complete",
    lane_id: lane.laneId,
    status: result.status,
    signal: result.signal,
    platform_crash: platformCrash,
    complete_suite_claim: false,
  });
  return { lane, status: result.status, signal: result.signal, platformCrash };
}

function rowSafeName(value: string): string {
  return value.replace(/[ /]/g, "_");
}

function readLaneRows(lanes: LanePlan[]): SummaryRow[] {
  const rows: SummaryRow[] = [];
  for (const lane of lanes) {
    const summary = join(lane.resultDir, "summary.tsv");
    if (!existsSync(summary)) continue;
    rows.push(...parseSummaryTsv(readFileSync(summary, "utf8"), lane.laneId));
  }
  return rows;
}

function writeFailureCatalogs(resultsDir: string, rows: SummaryRow[]): void {
  const failures: string[] = ["lane\thost\tsuite\tchunk\tstatus\tline\tlog"];
  const knownSkips: string[] = ["lane\thost\tsuite\tchunk\tline\tlog"];
  for (const row of rows) {
    const log = row.log;
    let unexpectedLines: string[] = [];
    let knownLines: string[] = [];
    if (existsSync(log) && statSync(log).isFile()) {
      const lines = readFileSync(log, "utf8").split(/\r?\n/);
      unexpectedLines = lines.filter((line) => line.startsWith("TEST-UNEXPECTED"));
      knownLines = lines.filter((line) => line.startsWith("TEST-KNOWN-FAIL"));
    }
    for (const line of unexpectedLines) {
      failures.push([row.laneId, row.host, row.suite, row.chunk, String(row.status), line, log].join("\t"));
    }
    if (unexpectedLines.length === 0 && (row.status !== 0 || row.unexpected > 0)) {
      failures.push([
        row.laneId,
        row.host,
        row.suite,
        row.chunk,
        String(row.status),
        `chunk status=${row.status} unexpected=${row.unexpected}`,
        log,
      ].join("\t"));
    }
    for (const line of knownLines) {
      knownSkips.push([row.laneId, row.host, row.suite, row.chunk, line, log].join("\t"));
    }
  }
  writeFileSync(join(resultsDir, "failures.tsv"), `${failures.join("\n")}\n`);
  writeFileSync(join(resultsDir, "known-skips.tsv"), `${knownSkips.join("\n")}\n`);
}

async function runShardedBrowser(args: ParsedArgs): Promise<number> {
  assertAuthoritativeBrowserJobs("browser", 1);
  const resultsDir = resolve(args.resultsDir);
  mkdirSync(resultsDir, { recursive: true });
  const progressPath = join(resultsDir, "progress.jsonl");
  appendProgress(progressPath, {
    event: "run_start",
    lanes: args.lanes,
    timeout_seconds: args.timeout,
    complete_suite_claim: false,
  });

  const smSource = ensureSpiderMonkeySource();
  const testRoot = join(smSource, "js/src/tests");
  const inventory = buildJstestChunkInventory(testRoot, args.chunkSize);
  const plannedChunks = filterChunks(inventory, args.chunks);
  if (plannedChunks.length === 0) throw new Error("shard plan is empty");
  const fullSuite = plannedChunks.length === inventory.length;
  const ports = planPortNumbers(args.lanes, args.baseVitePort, args.baseBridgePort);
  await assertPortsAvailable(ports);
  const lanes = planShards(plannedChunks, args.lanes, ports, resultsDir);

  writeJson(join(resultsDir, "inventory.json"), {
    source: smSource,
    suite: "jstests",
    full_chunk_count: inventory.length,
    planned_chunk_count: plannedChunks.length,
    planned_script_count: plannedChunks.reduce((sum, chunk) => sum + chunk.runnableJsFiles, 0),
    chunks: plannedChunks,
  });
  writeJson(join(resultsDir, "shard-plan.json"), {
    lanes: lanes.map((lane) => ({
      lane_id: lane.laneId,
      vite_port: lane.vitePort,
      bridge_port: lane.bridgePort,
      result_dir: lane.resultDir,
      chunk_list: lane.chunkListPath,
      chunks: lane.chunks.map((chunk) => ({
        suite: chunk.suite,
        chunk: chunk.chunk,
        runnable_js_files: chunk.runnableJsFiles,
      })),
      runnable_js_files: lane.runnableJsFiles,
    })),
  });

  appendProgress(progressPath, {
    event: "plan_written",
    planned_chunks: plannedChunks.length,
    planned_scripts: plannedChunks.reduce((sum, chunk) => sum + chunk.runnableJsFiles, 0),
    complete_suite_claim: false,
  });

  if (args.dryRun) {
    appendProgress(progressPath, {
      event: "dry_run_complete",
      complete_suite_claim: false,
      complete_planned_claim: true,
    });
    return 0;
  }

  let stopped = false;
  const heartbeat = setInterval(() => {
    const rows = readLaneRows(lanes);
    appendProgress(progressPath, {
      event: "heartbeat",
      completed_chunks: rows.length,
      planned_chunks: plannedChunks.length,
      pass: rows.reduce((sum, row) => sum + row.pass, 0),
      known_skip: rows.reduce((sum, row) => sum + row.knownSkip, 0),
      unexpected: rows.reduce((sum, row) => sum + row.unexpected, 0),
      queue_seconds: rows.reduce((sum, row) => sum + row.queueSeconds, 0),
      guest_seconds: rows.reduce((sum, row) => sum + row.guestSeconds, 0),
      complete_suite_claim: false,
    });
  }, args.heartbeatSeconds * 1000);

  const laneProcesses = new Set<ChildProcess>();
  const lanePromises = lanes.map(async (lane) => {
    const promise = runLane(lane, args, progressPath, (proc) => {
      laneProcesses.add(proc);
      proc.once("exit", () => laneProcesses.delete(proc));
    });
    return promise.then((result) => {
      if (!stopped && result.platformCrash) {
        stopped = true;
        appendProgress(progressPath, {
          event: "platform_crash_stop",
          lane_id: result.lane.laneId,
          complete_suite_claim: false,
        });
        for (const proc of laneProcesses) killProcessGroup(proc);
      }
      return result;
    });
  });
  const laneResults = await Promise.all(lanePromises);
  clearInterval(heartbeat);

  const rows = readLaneRows(lanes);
  let merged: MergeResult;
  try {
    merged = mergeLaneSummaries(plannedChunks, rows);
  } catch (err: any) {
    appendProgress(progressPath, {
      event: "merge_failed",
      error: err?.message || String(err),
      complete_suite_claim: false,
    });
    throw err;
  }

  writeFileSync(join(resultsDir, "summary.tsv"), formatMergedSummaryTsv(merged.rows));
  writeFileSync(
    join(resultsDir, "summary.jsonl"),
    merged.rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeJson(join(resultsDir, "merge-audit.json"), merged.audit);
  writeFailureCatalogs(resultsDir, merged.rows);
  appendProgress(progressPath, {
    event: "merge_complete",
    planned_chunks: merged.audit.plannedChunks,
    merged_chunks: merged.audit.mergedChunks,
    missing_chunks: merged.audit.missingChunks.length,
    duplicate_chunks: merged.audit.duplicateChunks.length,
    extra_chunks: merged.audit.extraChunks.length,
    pass: merged.totals.pass,
    known_skip: merged.totals.knownSkip,
    unexpected: merged.totals.unexpected,
    queue_seconds: merged.totals.queueSeconds,
    guest_seconds: merged.totals.guestSeconds,
    complete_suite_claim: fullSuite,
    complete_planned_claim: true,
  });

  const laneFailure = laneResults.some((result) => result.status !== 0);
  const rowFailure = merged.rows.some((row) => row.status !== 0 || row.unexpected > 0);
  console.log(`Summary written to ${join(resultsDir, "summary.tsv")}`);
  console.log(`Merge audit written to ${join(resultsDir, "merge-audit.json")}`);
  console.log(`Totals: pass=${merged.totals.pass} known_skip=${merged.totals.knownSkip} unexpected=${merged.totals.unexpected}`);
  return laneFailure || rowFailure ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  return runShardedBrowser(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((status) => {
    process.exit(status);
  }).catch((err: any) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
