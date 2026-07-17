/**
 * Node-side smoke coverage for the published Kandelo Homebrew hello bottle.
 *
 * Run:
 *   npx tsx packages/registry/hello/test/homebrew-node-smoke.ts \
 *     --result-dir test-runs/kd-8ho.9/manual \
 *     --tap-repository kandelo-dev/homebrew-tap-core
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ABI_VERSION } from "../../../../host/src/generated/abi";
import { fetchHomebrewBottleBytes } from "../../../../host/src/homebrew-vfs-fetch";
import { buildHomebrewVfs } from "../../../../host/src/homebrew-vfs-builder";
import {
  planHomebrewVfs,
  type HomebrewTapMetadata,
  type HomebrewVfsPackagePlan,
} from "../../../../host/src/homebrew-vfs-planner";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { saveImage } from "../../../../images/vfs/scripts/vfs-image-helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const DEFAULT_TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core";
const HELLO_PATH = "/home/linuxbrew/.linuxbrew/bin/hello";

type OutcomeStatus = "pass" | "fail" | "skip";

interface CliOptions {
  resultDir: string;
  tapRoot?: string;
  tapRepository: string;
  bottleCache: string;
  timeoutMs: number;
  maxBytes: number;
  beadId: string;
}

interface Outcome {
  name: string;
  status: OutcomeStatus;
  durationMs: number;
  details?: string;
  error?: string;
}

interface BuiltVfs {
  fs: MemoryFileSystem;
  imageBytes: Uint8Array;
  reportPath: string;
}

class SkipCase extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipCase";
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.resultDir, { recursive: true });
  mkdirSync(join(options.resultDir, "outcome-lists"), { recursive: true });
  mkdirSync(options.bottleCache, { recursive: true });

  const startedAt = new Date();
  const tapRoot = ensureTapRoot(options);
  const metadataPath = join(tapRoot, "Kandelo", "metadata.json");
  const metadata = readJsonFile<HomebrewTapMetadata>(metadataPath);
  const tapCommit = gitRevParse(tapRoot);

  let builtVfs: BuiltVfs | null = null;
  const outcomes: Outcome[] = [];
  writeCurrentRun(options, {
    status: "running",
    startedAt,
    tapRoot,
    tapCommit,
    outcomes,
    currentCase: "startup",
  });

  await runCase(outcomes, options, tapRoot, tapCommit, "homebrew_vfs_build_from_published_sidecars", async () => {
    builtVfs = await buildPublishedHelloVfs(metadata, tapRoot, options);
    return `report=${builtVfs.reportPath}`;
  });

  await runCase(outcomes, options, tapRoot, tapCommit, "hello_version_on_node_from_homebrew_vfs", async () => {
    if (!builtVfs) throw new SkipCase("requires successful homebrew_vfs_build_from_published_sidecars");
    return await runHelloVersion(builtVfs, options);
  });

  await runCase(outcomes, options, tapRoot, tapCommit, "negative_abi_mismatch_rejected", async () => {
    await assertAbiMismatchRejected(metadata, tapRoot);
    return `metadata ABI ${ABI_VERSION - 1} rejected before bottle fetch`;
  });

  await runCase(outcomes, options, tapRoot, tapCommit, "negative_missing_bottle_rejected", async () => {
    await assertMissingBottleRejected(metadata, tapRoot, options);
    return "missing bottle failed during VFS materialization";
  });

  writeOutcomeLists(options.resultDir, outcomes);
  writeSummary(options, {
    startedAt,
    completedAt: new Date(),
    tapRoot,
    tapCommit,
    outcomes,
  });
  writeCurrentRun(options, {
    status: outcomes.some((outcome) => outcome.status === "fail") ? "failed" : "complete",
    startedAt,
    tapRoot,
    tapCommit,
    outcomes,
    currentCase: "complete",
  });

  const failed = outcomes.filter((outcome) => outcome.status === "fail").length;
  process.exit(failed === 0 ? 0 : 1);
}

async function runCase(
  outcomes: Outcome[],
  options: CliOptions,
  tapRoot: string,
  tapCommit: string,
  name: string,
  fn: () => Promise<string | undefined>,
): Promise<void> {
  writeCurrentRun(options, {
    status: "running",
    startedAt: undefined,
    tapRoot,
    tapCommit,
    outcomes,
    currentCase: name,
  });
  const started = Date.now();
  try {
    const details = await fn();
    outcomes.push({ name, status: "pass", durationMs: Date.now() - started, details });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    outcomes.push({
      name,
      status: error instanceof SkipCase ? "skip" : "fail",
      durationMs: Date.now() - started,
      details: error.message,
      error: error.stack ?? error.message,
    });
  }
  writeOutcomeLists(options.resultDir, outcomes);
}

async function buildPublishedHelloVfs(
  metadata: HomebrewTapMetadata,
  tapRoot: string,
  options: CliOptions,
): Promise<BuiltVfs> {
  const plan = await planHomebrewVfs(metadata, {
    packages: ["hello"],
    arch: "wasm32",
    runtime: "node",
    loadLinkManifest: (relPath) => readJsonFile(join(tapRoot, relPath)),
  });
  const fs = createFs(options.maxBytes);
  const result = await buildHomebrewVfs(plan, {
    fs,
    createdBy: "packages/registry/hello/test/homebrew-node-smoke.ts",
    loadBottleBytes: (pkg) => loadBottleBytes(pkg, options),
  });

  const reportPath = join(options.resultDir, "homebrew-vfs-report.json");
  writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
  const imagePath = join(options.resultDir, "hello-homebrew.vfs.zst");
  const imageBytes = await saveImage(fs, imagePath, {
    metadata: {
      version: 1,
      kernelAbi: plan.kandeloAbi,
      createdBy: "packages/registry/hello/test/homebrew-node-smoke.ts",
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
  return { fs, imageBytes, reportPath };
}

async function runHelloVersion(built: BuiltVfs, options: CliOptions): Promise<string> {
  const helloBytes = readVfsFile(built.fs, HELLO_PATH);
  let stdout = "";
  let stderr = "";
  const host = new NodeKernelHost({
    maxWorkers: 4,
    rootfsImage: built.imageBytes,
    onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  });
  await host.init();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitPromise = host.spawn(toArrayBuffer(helloBytes), ["hello", "--version"], {
      env: [
        "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
        "HOME=/tmp",
        "TMPDIR=/tmp",
      ],
      cwd: "/",
      stdin: new Uint8Array(),
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`hello --version timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    });
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    if (exitCode !== 0) {
      throw new Error(`hello --version exited ${exitCode}; stderr=${JSON.stringify(stderr)}`);
    }
    if (!stdout.includes("hello (GNU Hello) 2.12.3")) {
      throw new Error(`unexpected hello --version stdout: ${JSON.stringify(stdout)}`);
    }
    return stdout.trim().split("\n")[0] ?? "hello --version passed";
  } finally {
    if (timeout) clearTimeout(timeout);
    await host.destroy().catch(() => {});
  }
}

async function assertAbiMismatchRejected(
  metadata: HomebrewTapMetadata,
  tapRoot: string,
): Promise<void> {
  const badMetadata = cloneJson(metadata) as HomebrewTapMetadata;
  badMetadata.kandelo_abi = ABI_VERSION - 1;
  badMetadata.release_tag = `bottles-abi-v${ABI_VERSION - 1}`;
  for (const pkg of badMetadata.packages) {
    for (const bottle of pkg.bottles) {
      bottle.kandelo_abi = ABI_VERSION - 1;
    }
  }

  await expectReject(
    () => planHomebrewVfs(badMetadata, {
      packages: ["hello"],
      arch: "wasm32",
      runtime: "node",
      loadLinkManifest: (relPath) => readJsonFile(join(tapRoot, relPath)),
    }),
    "metadata ABI",
  );
}

async function assertMissingBottleRejected(
  metadata: HomebrewTapMetadata,
  tapRoot: string,
  options: CliOptions,
): Promise<void> {
  const missingUrl = pathToFileURL(join(options.resultDir, "missing-hello.bottle.tar.gz")).href;
  const badMetadata = cloneJson(metadata) as HomebrewTapMetadata;
  for (const pkg of badMetadata.packages) {
    if (pkg.name !== "hello") continue;
    for (const bottle of pkg.bottles) {
      if (bottle.arch === "wasm32") bottle.url = missingUrl;
    }
  }

  const plan = await planHomebrewVfs(badMetadata, {
    packages: ["hello"],
    arch: "wasm32",
    runtime: "node",
    loadLinkManifest: (relPath) => {
      const manifest = readJsonFile<Record<string, unknown>>(join(tapRoot, relPath));
      const bottle = manifest.bottle as Record<string, unknown>;
      bottle.url = missingUrl;
      return manifest;
    },
  });
  const fs = createFs(options.maxBytes);
  await expectReject(
    () => buildHomebrewVfs(plan, {
      fs,
      createdBy: "packages/registry/hello/test/homebrew-node-smoke.ts negative_missing_bottle_rejected",
      loadBottleBytes: (pkg) => loadBottleBytes(pkg, options),
    }),
    "missing-hello.bottle.tar.gz",
  );
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

  const bytes = await fetchHomebrewBottleBytes(pkg.url);
  writeFileSync(cachePath, bytes);
  return bytes;
}

async function expectReject(fn: () => Promise<unknown>, expected: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(expected)) {
      throw new Error(`expected rejection containing ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`);
    }
    return;
  }
  throw new Error(`expected rejection containing ${JSON.stringify(expected)}, but operation succeeded`);
}

function ensureTapRoot(options: CliOptions): string {
  if (options.tapRoot) return resolve(options.tapRoot);

  const tapRoot = join(options.resultDir, "tap");
  rmSync(tapRoot, { recursive: true, force: true });
  const repoUrl = `git@github.com:${options.tapRepository}.git`;
  execFileSync("git", ["clone", "--depth", "1", repoUrl, tapRoot], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return tapRoot;
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

function createFs(maxBytes: number): MemoryFileSystem {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  return MemoryFileSystem.create(
    new SharedArrayBufferCtor(maxBytes, { maxByteLength: maxBytes }),
    maxBytes,
  );
}

function parseArgs(args: string[]): CliOptions {
  const defaultResultDir = join(
    repoRoot,
    "test-runs",
    "hello-homebrew-node-smoke",
    new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z"),
  );
  const options: CliOptions = {
    resultDir: process.env.KANDELO_TEST_RESULT_DIR || defaultResultDir,
    tapRoot: process.env.KANDELO_HOMEBREW_TAP_ROOT,
    tapRepository: process.env.KANDELO_HOMEBREW_TAP_REPOSITORY || DEFAULT_TAP_REPOSITORY,
    bottleCache: "",
    timeoutMs: 30_000,
    maxBytes: 128 * 1024 * 1024,
    beadId: process.env.KANDELO_BEAD_ID || "kd-8ho.9",
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
      case "--tap-repository":
        options.tapRepository = requireValue(args, ++i, arg);
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
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        usage(2, `unexpected argument ${arg}`);
    }
  }

  options.resultDir = resolve(options.resultDir);
  options.bottleCache = options.bottleCache
    ? resolve(options.bottleCache)
    : join(options.resultDir, "bottle-cache");
  return options;
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
  if (message) console.error(`homebrew-node-smoke: ${message}`);
  console.error(`usage: npx tsx packages/registry/hello/test/homebrew-node-smoke.ts \\
  [--result-dir <dir>] [--tap-root <dir> | --tap-repository <owner/repo>] \\
  [--bottle-cache <dir>] [--timeout-ms <ms>] [--max-bytes <bytes|MiB>]`);
  process.exit(code);
}

function writeOutcomeLists(resultDir: string, outcomes: Outcome[]): void {
  const listsDir = join(resultDir, "outcome-lists");
  mkdirSync(listsDir, { recursive: true });
  const passed = outcomes.filter((outcome) => outcome.status === "pass");
  const failed = outcomes.filter((outcome) => outcome.status === "fail");
  const skipped = outcomes.filter((outcome) => outcome.status === "skip");
  writeFileSync(
    join(listsDir, "passed-tests.tsv"),
    ["test\tduration_ms\tdetails", ...passed.map((outcome) =>
      `${outcome.name}\t${outcome.durationMs}\t${tsv(outcome.details ?? "")}`,
    )].join("\n") + "\n",
  );
  writeFileSync(
    join(listsDir, "failed-tests.tsv"),
    ["test\tduration_ms\terror", ...failed.map((outcome) =>
      `${outcome.name}\t${outcome.durationMs}\t${tsv(outcome.error ?? outcome.details ?? "")}`,
    )].join("\n") + "\n",
  );
  writeFileSync(
    join(listsDir, "skipped-tests.tsv"),
    ["test\treason", ...skipped.map((outcome) =>
      `${outcome.name}\t${tsv(outcome.details ?? "")}`,
    )].join("\n") + "\n",
  );
  writeFileSync(
    join(resultDir, "failures.json"),
    `${JSON.stringify(failed, null, 2)}\n`,
  );
}

function writeSummary(
  options: CliOptions,
  data: {
    startedAt: Date;
    completedAt: Date;
    tapRoot: string;
    tapCommit: string;
    outcomes: Outcome[];
  },
): void {
  const counts = countOutcomes(data.outcomes);
  const summary = {
    suite: "hello Homebrew Node VFS smoke",
    bead_id: options.beadId,
    started_at: data.startedAt.toISOString(),
    completed_at: data.completedAt.toISOString(),
    duration_ms: data.completedAt.getTime() - data.startedAt.getTime(),
    result_dir: options.resultDir,
    tap_root: data.tapRoot,
    tap_commit: data.tapCommit,
    counts,
    outcomes: data.outcomes,
    artifacts: {
      passed: join(options.resultDir, "outcome-lists", "passed-tests.tsv"),
      failed: join(options.resultDir, "outcome-lists", "failed-tests.tsv"),
      skipped: join(options.resultDir, "outcome-lists", "skipped-tests.tsv"),
      failures: join(options.resultDir, "failures.json"),
      current_run: join(options.resultDir, "current-run.json"),
      vfs_report: join(options.resultDir, "homebrew-vfs-report.json"),
      vfs_image: join(options.resultDir, "hello-homebrew.vfs.zst"),
    },
  };
  writeFileSync(join(options.resultDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(options.resultDir, "summary.md"), [
    "# hello Homebrew Node VFS smoke",
    "",
    `Result dir: \`${options.resultDir}\``,
    `Tap commit: \`${data.tapCommit}\``,
    `Counts: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`,
    "",
    "| Test | Status | Details |",
    "|---|---:|---|",
    ...data.outcomes.map((outcome) =>
      `| \`${outcome.name}\` | ${outcome.status} | ${outcome.details ? outcome.details.replace(/\|/g, "\\|") : ""} |`,
    ),
    "",
  ].join("\n"));
}

function writeCurrentRun(
  options: CliOptions,
  data: {
    status: "running" | "complete" | "failed";
    startedAt?: Date;
    tapRoot: string;
    tapCommit: string;
    outcomes: Outcome[];
    currentCase: string;
  },
): void {
  const counts = countOutcomes(data.outcomes);
  const currentRun = {
    suite: "hello-homebrew-node-smoke",
    bead_id: options.beadId,
    worktree: repoRoot,
    result_dir: options.resultDir,
    status: data.status,
    started_at: data.startedAt?.toISOString(),
    updated_at: new Date().toISOString(),
    current_case: data.currentCase,
    progress: {
      completed: data.outcomes.length,
      total: 4,
      pass: counts.pass,
      fail: counts.fail,
      skip: counts.skip,
    },
    tap_root: data.tapRoot,
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
    stale_no_runner_threshold_seconds: 600,
    expected_next: data.status === "running"
      ? { deterministic: true, action: "continue current smoke case" }
      : { deterministic: false, action: "suite terminal" },
  };
  const out = join(options.resultDir, "current-run.json");
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(currentRun, null, 2)}\n`);
  renameSync(tmp, out);
}

function countOutcomes(outcomes: Outcome[]): { pass: number; fail: number; skip: number } {
  return {
    pass: outcomes.filter((outcome) => outcome.status === "pass").length,
    fail: outcomes.filter((outcome) => outcome.status === "fail").length,
    skip: outcomes.filter((outcome) => outcome.status === "skip").length,
  };
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function gitRevParse(path: string): string {
  try {
    return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function tsv(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, "\\n");
}

main().catch((err) => {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error(error.stack ?? error.message);
  process.exit(1);
});
