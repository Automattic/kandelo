/**
 * Node-side smoke coverage for Kandelo Homebrew package sidecars.
 *
 * The runner consumes generated Kandelo/Homebrew sidecars, materializes each
 * requested package into a VFS, and runs a package-specific smoke through
 * NodeKernelHost. Program packages execute their poured binary. SQLite
 * compiles a test-only consumer from the poured headers and static library.
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
import { fileURLToPath } from "node:url";
import { ABI_VERSION } from "../host/src/generated/abi";
import { fetchHomebrewBottleBytes } from "../host/src/homebrew-vfs-fetch";
import { buildHomebrewVfs } from "../host/src/homebrew-vfs-builder";
import {
  HomebrewVfsUnsupportedError,
  planHomebrewVfs,
  type HomebrewBottleArch,
  type HomebrewTapMetadata,
  type HomebrewVfsPackagePlan,
} from "../host/src/homebrew-vfs-planner";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import { saveImage } from "../images/vfs/scripts/vfs-image-helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const PREFIX = "/home/linuxbrew/.linuxbrew";
const CELLAR = `${PREFIX}/Cellar`;

type OutcomeStatus = "pass" | "fail" | "skip";
type FormulaName = string;

interface CliOptions {
  resultDir: string;
  tapRoot: string;
  formulas: FormulaName[];
  arch: HomebrewBottleArch;
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

  const metadataPath = join(options.tapRoot, "Kandelo", "metadata.json");
  const metadata = readJsonFile<HomebrewTapMetadata>(metadataPath);
  const tapCommit = gitRevParse(options.tapRoot);
  const startedAt = new Date();
  const outcomes: Outcome[] = [];

  writeCurrentRun(options, {
    status: "running",
    startedAt,
    tapCommit,
    outcomes,
    currentCase: "startup",
  });

  const builtByFormula = new Map<FormulaName, BuiltVfs>();
  const unsupportedByFormula = new Map<FormulaName, string>();
  for (const formula of options.formulas) {
    const buildOutcome = await runCase(outcomes, options, tapCommit, `homebrew_vfs_build_${formula}`, async () => {
      const built = await buildFormulaVfs(metadata, formula, options);
      builtByFormula.set(formula, built);
      return `report=${built.reportPath}`;
    });
    if (buildOutcome.status === "skip" && buildOutcome.details) {
      unsupportedByFormula.set(formula, buildOutcome.details);
    }

    await runCase(outcomes, options, tapCommit, `node_smoke_${formula}`, async () => {
      const built = builtByFormula.get(formula);
      if (!built) {
        throw new SkipCase(
          unsupportedByFormula.get(formula) ?? `requires successful homebrew_vfs_build_${formula}`,
        );
      }
      return await runFormulaSmoke(formula, built, options);
    });
  }

  writeOutcomeLists(options.resultDir, outcomes);
  writeSummary(options, {
    startedAt,
    completedAt: new Date(),
    tapCommit,
    outcomes,
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
  formula: FormulaName,
  options: CliOptions,
): Promise<BuiltVfs> {
  const packageName = packageNameForFormula(formula);
  let plan;
  try {
    plan = await planHomebrewVfs(metadata, {
      packages: [packageName],
      arch: options.arch,
      runtime: "node",
      expectedAbi: ABI_VERSION,
      loadLinkManifest: (relPath) => readJsonFile(join(options.tapRoot, relPath)),
    });
  } catch (err) {
    if (err instanceof HomebrewVfsUnsupportedError) {
      throw new SkipCase(formatUnsupportedRuntime(err, formula));
    }
    throw err;
  }
  const fs = createFs(options.maxBytes);
  const result = await buildHomebrewVfs(plan, {
    fs,
    createdBy: "scripts/homebrew-package-node-smoke.ts",
    loadBottleBytes: (pkg) => loadBottleBytes(pkg, options),
  });

  const reportPath = join(options.resultDir, `${formula}-${options.arch}-homebrew-vfs-report.json`);
  writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
  const imagePath = join(options.resultDir, `${formula}-${options.arch}-homebrew.vfs.zst`);
  const imageBytes = await saveImage(fs, imagePath, {
    metadata: {
      version: 1,
      kernelAbi: plan.kandeloAbi,
      createdBy: "scripts/homebrew-package-node-smoke.ts",
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

function formatUnsupportedRuntime(err: HomebrewVfsUnsupportedError, requestedFormula: string): string {
  const status = err.runtimeStatus;
  const details = [
    `requested=${requestedFormula}`,
    `blocked_package=${err.packageName}`,
    `runtime=${err.runtime}`,
    `arch=${err.arch}`,
  ];
  if (status?.status) details.push(`status=${status.status}`);
  if (status?.reason_code) details.push(`reason_code=${status.reason_code}`);
  if (status?.reason) details.push(`reason=${status.reason}`);
  for (const failure of status?.artifact_policy_failures ?? []) {
    details.push(`artifact=${failure.path}: ${failure.failures.join("; ")}`);
  }
  return details.join("; ");
}

async function runFormulaSmoke(
  formula: FormulaName,
  built: BuiltVfs,
  options: CliOptions,
): Promise<string> {
  const packageName = packageNameForFormula(formula);
  switch (packageName) {
    case "sqlite":
      return runSqliteSmoke(built, options);
    case "bc":
      return runProgramSmoke("bc", `${PREFIX}/bin/bc`, /(^|\n)5(\n|$)/, built, options, {
        stdin: "2+3\nquit\n",
      });
    case "coreutils":
      return runProgramSmoke("printf", `${PREFIX}/bin/coreutils`, /^ok$/m, built, options, {
        args: ["ok\n"],
      });
    case "diffutils":
      return runProgramVersionSmoke("diff", `${PREFIX}/bin/diff`, /diff/i, built, options);
    case "dash":
      return runProgramSmoke("dash", `${PREFIX}/bin/dash`, /dash-homebrew-smoke/, built, options, {
        args: ["-c", "echo dash-homebrew-smoke"],
      });
    case "fbdoom":
      throw new SkipCase(
        "fbdoom requires IWAD data and framebuffer/audio device plumbing; record browser framebuffer smoke separately",
      );
    case "file":
      return runProgramVersionSmoke("file", `${PREFIX}/bin/file`, /file/i, built, options);
    case "findutils":
      return runProgramVersionSmoke("find", `${PREFIX}/bin/find`, /find/i, built, options);
    case "gawk":
      return runProgramSmoke("gawk", `${PREFIX}/bin/gawk`, /^42$/m, built, options, {
        args: ["BEGIN { print 6 * 7 }"],
      });
    case "grep":
      return runProgramSmoke("grep", `${PREFIX}/bin/grep`, /^beta$/m, built, options, {
        args: ["beta"],
        stdin: "alpha\nbeta\n",
      });
    case "git":
      return runProgramVersionSmoke("git", `${PREFIX}/bin/git`, /git version/i, built, options);
    case "gzip":
      return runProgramVersionSmoke("gzip", `${PREFIX}/bin/gzip`, /gzip/i, built, options);
    case "less":
      return runProgramVersionSmoke("less", `${PREFIX}/bin/less`, /less/i, built, options);
    case "lsof":
      return runProgramSmoke("lsof", `${PREFIX}/bin/lsof`, /COMMAND|PID|lsof/i, built, options);
    case "m4":
      return runProgramSmoke("m4", `${PREFIX}/bin/m4`, /ok/, built, options, {
        stdin: "define(`x',`ok')x\n",
      });
    case "make":
      return runProgramVersionSmoke("make", `${PREFIX}/bin/make`, /make/i, built, options);
    case "modeset":
      throw new SkipCase(
        "modeset requires DRI/GLES framebuffer device support; record browser/device smoke separately",
      );
    case "msmtpd":
      return runProgramVersionSmoke("msmtpd", `${PREFIX}/bin/msmtpd`, /msmtp|msmtpd/i, built, options);
    case "nano":
      return runProgramVersionSmoke("nano", `${PREFIX}/bin/nano`, /GNU nano|nano/i, built, options);
    case "netcat":
      return runProgramVersionSmoke("nc", `${PREFIX}/bin/nc`, /netcat|listen|connect|usage/i, built, options, ["--help"]);
    case "posix-utils-lite":
      return runProgramSmoke("patch", `${PREFIX}/bin/patch`, /patch/i, built, options, {
        args: ["patch"],
        stdin: "--- a/file\n+++ b/file\n",
      });
    case "sed":
      return runProgramSmoke("sed", `${PREFIX}/bin/sed`, /^b$/m, built, options, {
        args: ["s/a/b/"],
        stdin: "a\n",
      });
    case "tar":
      return runProgramVersionSmoke("tar", `${PREFIX}/bin/tar`, /tar/i, built, options);
    case "tcl":
      return runProgramSmoke("tcl", `${PREFIX}/bin/tcl`, /^7$/m, built, options, {
        stdin: "puts [expr {2 + 5}]\n",
        env: [`TCL_LIBRARY=${PREFIX}/lib/tcl8.6`],
      });
    case "unzip":
      return runProgramVersionSmoke("unzip", `${PREFIX}/bin/unzip`, /unzip/i, built, options, ["-v"]);
    case "zip":
      return runProgramVersionSmoke("zip", `${PREFIX}/bin/zip`, /zip/i, built, options, ["-v"]);
    case "bzip2":
      return runProgramVersionSmoke("bzip2", `${PREFIX}/bin/bzip2`, /bzip2/i, built, options, ["--help"]);
    case "xz":
      return runProgramVersionSmoke("xz", `${PREFIX}/bin/xz`, /xz/i, built, options);
    case "zstd":
      return runProgramVersionSmoke("zstd", `${PREFIX}/bin/zstd`, /zstandard|zstd/i, built, options);
    case "vim":
      return runProgramVersionSmoke("vim", `${PREFIX}/bin/vim`, /VIM|Vi IMproved/i, built, options);
    case "wget":
      return runProgramVersionSmoke("wget", `${PREFIX}/bin/wget`, /GNU Wget|Wget/i, built, options);
    default:
      return runProgramVersionSmoke(packageName, `${PREFIX}/bin/${packageName}`, new RegExp(escapeRegex(packageName), "i"), built, options);
  }
}

function packageNameForFormula(formula: FormulaName): string {
  return formula === "file-formula" ? "file" : formula;
}

async function runProgramVersionSmoke(
  argv0: string,
  guestPath: string,
  expected: RegExp,
  built: BuiltVfs,
  options: CliOptions,
  args: string[] = ["--version"],
): Promise<string> {
  return runProgramSmoke(argv0, guestPath, expected, built, options, { args });
}

async function runProgramSmoke(
  argv0: string,
  guestPath: string,
  expected: RegExp,
  built: BuiltVfs,
  options: CliOptions,
  runOptions: { args?: string[]; stdin?: string; env?: string[] } = {},
): Promise<string> {
  const programBytes = readVfsFile(built.fs, guestPath);
  const args = runOptions.args ?? [];
  const result = await runWasm(programBytes, [argv0, ...args], built.imageBytes, options, {
    stdin: runOptions.stdin === undefined ? undefined : new TextEncoder().encode(runOptions.stdin),
    env: runOptions.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${argv0} ${args.join(" ")} exited ${result.exitCode}; stderr=${JSON.stringify(result.stderr)}`);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!expected.test(combined)) {
    throw new Error(`unexpected ${argv0} ${args.join(" ")} output: ${JSON.stringify(combined)}`);
  }
  return combined.trim().split("\n").find((line) => line.trim() !== "") ?? `${argv0} ${args.join(" ")} passed`;
}

async function runSqliteSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const stage = join(options.resultDir, "sqlite-consumer-build", options.arch);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "include"), { recursive: true });
  mkdirSync(join(stage, "lib"), { recursive: true });

  const version = findPackageVersion(built.fs, "sqlite");
  writeFileSync(
    join(stage, "include", "sqlite3.h"),
    readVfsFile(built.fs, `${CELLAR}/sqlite/${version}/include/sqlite3.h`),
  );
  writeFileSync(
    join(stage, "include", "sqlite3ext.h"),
    readVfsFile(built.fs, `${CELLAR}/sqlite/${version}/include/sqlite3ext.h`),
  );
  writeFileSync(
    join(stage, "lib", "libsqlite3.a"),
    readVfsFile(built.fs, `${CELLAR}/sqlite/${version}/lib/libsqlite3.a`),
  );

  const testSrc = join(repoRoot, "packages", "registry", "sqlite", "test", "sqlite_basic.c");
  const outWasm = join(stage, "sqlite_basic.wasm");
  const cc = join(repoRoot, "sdk", "bin", `${options.arch}posix-cc`);
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
      WASM_POSIX_SYSROOT: join(repoRoot, options.arch === "wasm64" ? "sysroot64" : "sysroot"),
    },
    stdio: "pipe",
  });

  const consumerBytes = new Uint8Array(readFileSync(outWasm));
  const result = await runWasm(consumerBytes, ["sqlite_basic"], built.imageBytes, options);
  if (result.exitCode !== 0) {
    throw new Error(`sqlite_basic exited ${result.exitCode}; stderr=${JSON.stringify(result.stderr)}`);
  }
  if (!result.stdout.includes("PASS")) {
    throw new Error(`sqlite_basic did not report PASS: ${JSON.stringify(result.stdout)}`);
  }
  return "sqlite_basic linked against poured sqlite keg and reported PASS";
}

async function runWasm(
  programBytes: Uint8Array,
  argv: string[],
  rootfsImage: Uint8Array,
  options: CliOptions,
  runOptions: { stdin?: Uint8Array; env?: string[] } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const host = new NodeKernelHost({
    maxWorkers: 4,
    rootfsImage,
    onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  });
  await host.init();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitPromise = host.spawn(toArrayBuffer(programBytes), argv, {
      env: [
        "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
        "HOME=/tmp",
        "TMPDIR=/tmp",
        ...(runOptions.env ?? []),
      ],
      cwd: "/",
      stdin: runOptions.stdin ?? new Uint8Array(),
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${argv[0]} timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    });
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    return { exitCode, stdout, stderr };
  } finally {
    if (timeout) clearTimeout(timeout);
    await host.destroy().catch(() => {});
  }
}

async function runCase(
  outcomes: Outcome[],
  options: CliOptions,
  tapCommit: string,
  name: string,
  fn: () => Promise<string | undefined>,
): Promise<Outcome> {
  writeCurrentRun(options, {
    status: "running",
    tapCommit,
    outcomes,
    currentCase: name,
  });
  const started = Date.now();
  let outcome: Outcome;
  try {
    const details = await fn();
    outcome = { name, status: "pass", durationMs: Date.now() - started, details };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    outcome = {
      name,
      status: error instanceof SkipCase ? "skip" : "fail",
      durationMs: Date.now() - started,
      details: error.message,
      error: error.stack ?? error.message,
    };
  }
  outcomes.push(outcome);
  writeOutcomeLists(options.resultDir, outcomes);
  return outcome;
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

function findPackageVersion(fs: MemoryFileSystem, formula: string): string {
  const info = JSON.parse(new TextDecoder().decode(readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json")));
  const pkg = info.packages?.find((candidate: { name?: string }) => candidate.name === formula);
  if (!pkg) throw new Error(`package ${formula} missing from /etc/kandelo/homebrew-vfs.json`);
  const keg = String(pkg.keg ?? "");
  const prefix = `${CELLAR}/${formula}/`;
  if (!keg.startsWith(prefix)) throw new Error(`unexpected sqlite keg path: ${keg}`);
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
    "homebrew-package-node-smoke",
    new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z"),
  );
  const options: CliOptions = {
    resultDir: process.env.KANDELO_TEST_RESULT_DIR || defaultResultDir,
    tapRoot: process.env.KANDELO_HOMEBREW_TAP_ROOT || "",
    formulas: [],
    arch: "wasm32",
    bottleCache: "",
    timeoutMs: 30_000,
    maxBytes: 128 * 1024 * 1024,
    beadId: process.env.KANDELO_BEAD_ID || "kd-1mr.2",
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
  options.resultDir = resolve(options.resultDir);
  options.tapRoot = resolve(options.tapRoot);
  options.bottleCache = options.bottleCache
    ? resolve(options.bottleCache)
    : join(options.resultDir, "bottle-cache");
  return options;
}

function parseFormula(value: string): FormulaName {
  if (/^[a-z0-9][a-z0-9._-]*$/.test(value)) return value;
  usage(2, `--formula must be a Homebrew formula name, got ${value}`);
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
  if (message) console.error(`homebrew-package-node-smoke: ${message}`);
  console.error(`usage: npx tsx scripts/homebrew-package-node-smoke.ts \\
  --tap-root <dir> --formula <name> [--formula ...] \\
  [--arch <wasm32|wasm64>] [--result-dir <dir>] [--bottle-cache <dir>]`);
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
  writeFileSync(join(resultDir, "failures.json"), `${JSON.stringify(failed, null, 2)}\n`);
}

function writeSummary(
  options: CliOptions,
  data: {
    startedAt: Date;
    completedAt: Date;
    tapCommit: string;
    outcomes: Outcome[];
  },
): void {
  const counts = countOutcomes(data.outcomes);
  const summary = {
    suite: "Homebrew package Node VFS smoke",
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
    "# Homebrew package Node VFS smoke",
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
    tapCommit: string;
    outcomes: Outcome[];
    currentCase: string;
  },
): void {
  const counts = countOutcomes(data.outcomes);
  const currentRun = {
    suite: "homebrew-package-node-smoke",
    bead_id: options.beadId,
    worktree: repoRoot,
    result_dir: options.resultDir,
    status: data.status,
    started_at: data.startedAt?.toISOString(),
    updated_at: new Date().toISOString(),
    current_case: data.currentCase,
    progress: {
      completed: data.outcomes.length,
      total: options.formulas.length * 2,
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

function gitRevParse(path: string): string {
  return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function tsv(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, "\\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
