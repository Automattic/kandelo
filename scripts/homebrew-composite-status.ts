/**
 * Classify Homebrew-backed composite VFS packages from generated sidecars.
 *
 * This does not build images. It records whether each composite package has
 * enough successful, runtime-supported Homebrew bottle metadata to proceed to
 * image or bundle materialization, and emits durable outcome lists for the
 * blockers that remain.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

type Runtime = "node" | "browser";
type Status = "pass" | "fail" | "skip";

interface CliOptions {
  metadataPaths: string[];
  resultDir: string;
  arch: "wasm32" | "wasm64";
  runtimes: Runtime[];
  beadId: string;
}

interface CompositeSpec {
  name: string;
  artifactKind: "vfs_image" | "lazy_archive";
  packages: string[];
  composites?: string[];
}

interface BottleMetadata {
  arch?: string;
  status?: string;
  url?: string;
  sha256?: string;
  bytes?: number;
  cache_key_sha?: string;
  link_manifest?: string;
  runtime_support?: string[];
  runtime_status?: Record<string, {
    status?: string;
    reason_code?: string;
    reason?: string;
    artifact_policy_failures?: Array<{
      path?: string;
      failures?: string[];
    }>;
  }>;
  browser_compatible?: boolean;
  fork_instrumentation?: string;
}

interface PackageDependency {
  name?: string;
}

interface PackageMetadata {
  name?: string;
  version?: string;
  dependencies?: PackageDependency[];
  bottles?: BottleMetadata[];
}

interface MetadataFile {
  packages?: PackageMetadata[];
}

interface Outcome {
  name: string;
  composite: string;
  runtime: Runtime;
  direct_packages: string[];
  closure_packages: string[];
  status: Status;
  details: string;
  blockers: string[];
}

const SPECS: CompositeSpec[] = [
  {
    name: "rootfs",
    artifactKind: "vfs_image",
    packages: [
      "dash",
      "bash",
      "ncurses",
      "coreutils",
      "gawk",
      "grep",
      "sed",
      "bc",
      "file",
      "m4",
      "make",
      "findutils",
      "diffutils",
      "posix-utils-lite",
    ],
  },
  {
    name: "shell",
    artifactKind: "vfs_image",
    composites: ["rootfs"],
    packages: [
      "less",
      "tar",
      "curl",
      "netcat",
      "wget",
      "git",
      "gzip",
      "bzip2",
      "xz",
      "zstd",
      "zip",
      "unzip",
      "lsof",
      "nano",
      "vim",
      "nethack",
      "fbdoom",
      "modeset",
    ],
  },
  {
    name: "python-vfs",
    artifactKind: "vfs_image",
    packages: ["cpython"],
  },
  {
    name: "perl-vfs",
    artifactKind: "vfs_image",
    packages: ["perl"],
  },
  {
    name: "erlang-vfs",
    artifactKind: "vfs_image",
    packages: ["erlang"],
  },
  {
    name: "vim-browser-bundle",
    artifactKind: "lazy_archive",
    packages: ["vim"],
  },
  {
    name: "nethack-browser-bundle",
    artifactKind: "lazy_archive",
    packages: ["nethack"],
  },
  {
    name: "node-vfs",
    artifactKind: "vfs_image",
    composites: ["shell"],
    packages: ["node"],
  },
];
const HTTPS_URL_RE = /^https:\/\/\S+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FORK_INSTRUMENTATION = new Set(["not-required", "required", "disabled", "unknown"]);

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.resultDir, { recursive: true });
  mkdirSync(join(options.resultDir, "outcome-lists"), { recursive: true });

  const packageIndex = readPackageIndex(options.metadataPaths);
  const outcomes: Outcome[] = [];
  const byCompositeRuntime = new Map<string, Outcome>();

  for (const runtime of options.runtimes) {
    for (const spec of SPECS) {
      const blockers: string[] = [];
      for (const composite of spec.composites ?? []) {
        const dependency = byCompositeRuntime.get(`${composite}:${runtime}`);
        if (!dependency || dependency.status !== "pass") {
          blockers.push(
            `composite ${composite} is not ready for ${runtime}: ${dependency?.details ?? "not evaluated"}`,
          );
        }
      }
      const closurePackages = collectPackageClosure(packageIndex, spec.packages);
      for (const pkg of closurePackages) {
        const blocker = packageBlocker(packageIndex.get(pkg), pkg, runtime, options.arch);
        if (blocker) blockers.push(blocker);
      }

      const outcome: Outcome = {
        name: `${spec.name}_${runtime}_${spec.artifactKind}`,
        composite: spec.name,
        runtime,
        direct_packages: spec.packages,
        closure_packages: closurePackages,
        status: blockers.length === 0 ? "pass" : "skip",
        details: blockers.length === 0
          ? `${spec.name} ${spec.artifactKind} has ${closurePackages.length} Homebrew package inputs ready for ${runtime}/${options.arch}`
          : blockers.join("; "),
        blockers,
      };
      outcomes.push(outcome);
      byCompositeRuntime.set(`${spec.name}:${runtime}`, outcome);
    }
  }

  writeSummary(options, outcomes, packageIndex);
  writeOutcomeLists(options.resultDir, outcomes);
  const failed = outcomes.filter((outcome) => outcome.status === "fail");
  process.exit(failed.length === 0 ? 0 : 1);
}

function collectPackageClosure(
  packageIndex: Map<string, PackageMetadata>,
  requested: string[],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    ordered.push(name);
    const pkg = packageIndex.get(name);
    if (!pkg) return;
    for (const dep of pkg.dependencies ?? []) {
      if (dep.name) visit(dep.name);
    }
  };

  for (const name of requested) visit(name);
  return ordered;
}

function packageBlocker(
  pkg: PackageMetadata | undefined,
  name: string,
  runtime: Runtime,
  arch: string,
): string | null {
  if (!pkg) return `${name}: no generated Homebrew sidecar metadata found`;
  const bottle = (pkg.bottles ?? []).find((candidate) => candidate.arch === arch);
  if (!bottle) return `${name}: no ${arch} bottle metadata found`;
  if (bottle.status !== "success") return `${name}: ${arch} bottle status is ${bottle.status ?? "missing"}`;
  const bottleBlocker = bottleMetadataBlocker(name, bottle, arch);
  if (bottleBlocker) return bottleBlocker;
  const support = bottle.runtime_support ?? [];
  if (!support.includes(runtime)) {
    const runtimeStatus = bottle.runtime_status?.[runtime];
    const reason = runtimeStatus
      ? formatRuntimeStatus(runtimeStatus)
      : `runtime_support does not include ${runtime}`;
    return `${name}: ${runtime} unsupported (${reason})`;
  }
  if (runtime === "browser" && bottle.browser_compatible !== true) {
    return `${name}: browser runtime is not marked browser_compatible`;
  }
  return null;
}

function bottleMetadataBlocker(name: string, bottle: BottleMetadata, arch: string): string | null {
  const blockers: string[] = [];
  if (!bottle.url || !HTTPS_URL_RE.test(bottle.url)) {
    blockers.push(`url ${bottle.url ?? "<missing>"} is not an https URL`);
  }
  if (!bottle.sha256 || !SHA256_RE.test(bottle.sha256)) {
    blockers.push("sha256 is missing or invalid");
  }
  if (!Number.isInteger(bottle.bytes) || (bottle.bytes ?? 0) <= 0) {
    blockers.push("bytes is missing or invalid");
  }
  if (!bottle.cache_key_sha || !SHA256_RE.test(bottle.cache_key_sha)) {
    blockers.push("cache_key_sha is missing or invalid");
  }
  if (!bottle.link_manifest) {
    blockers.push("link_manifest is missing");
  }
  if (!bottle.fork_instrumentation || !FORK_INSTRUMENTATION.has(bottle.fork_instrumentation)) {
    blockers.push(`fork_instrumentation ${bottle.fork_instrumentation ?? "<missing>"} is invalid`);
  }
  if (blockers.length === 0) return null;
  return `${name}: ${arch} bottle metadata is not publishable (${blockers.join("; ")})`;
}

function formatRuntimeStatus(status: NonNullable<BottleMetadata["runtime_status"]>[string]): string {
  const parts = [
    `status=${status.status ?? "unknown"}`,
    status.reason_code ? `reason_code=${status.reason_code}` : "",
    status.reason ? `reason=${status.reason}` : "",
  ].filter(Boolean);
  for (const failure of status.artifact_policy_failures ?? []) {
    parts.push(`artifact=${failure.path ?? "<unknown>"}:${(failure.failures ?? []).join("|")}`);
  }
  return parts.join(", ");
}

function readPackageIndex(paths: string[]): Map<string, PackageMetadata> {
  const index = new Map<string, PackageMetadata>();
  for (const path of paths) {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as MetadataFile;
    if (!Array.isArray(metadata.packages)) {
      throw new Error(`${path}: metadata packages must be an array`);
    }
    for (const pkg of metadata.packages) {
      if (!pkg.name) continue;
      const existing = index.get(pkg.name);
      if (!existing || preferPackage(pkg, existing)) {
        index.set(pkg.name, pkg);
      }
    }
  }
  return index;
}

function preferPackage(candidate: PackageMetadata, existing: PackageMetadata): boolean {
  const candidateScore = packageScore(candidate);
  const existingScore = packageScore(existing);
  return candidateScore > existingScore;
}

function packageScore(pkg: PackageMetadata): number {
  let score = 0;
  for (const bottle of pkg.bottles ?? []) {
    if (bottle.status === "success") {
      score += 4;
      if (bottle.arch && bottleMetadataBlocker(pkg.name ?? "<unknown>", bottle, bottle.arch) === null) {
        score += 8;
      }
    }
    if ((bottle.runtime_support ?? []).includes("node")) score += 2;
    if ((bottle.runtime_support ?? []).includes("browser")) score += 2;
    if (bottle.browser_compatible) score += 1;
  }
  return score;
}

function writeSummary(
  options: CliOptions,
  outcomes: Outcome[],
  packageIndex: Map<string, PackageMetadata>,
): void {
  const counts = countOutcomes(outcomes);
  const summary = {
    suite: "Homebrew composite VFS status",
    bead_id: options.beadId,
    generated_at: new Date().toISOString(),
    result_dir: options.resultDir,
    arch: options.arch,
    runtimes: options.runtimes,
    metadata: options.metadataPaths,
    package_count: packageIndex.size,
    counts,
    outcomes,
  };
  writeFileSync(join(options.resultDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

function writeOutcomeLists(resultDir: string, outcomes: Outcome[]): void {
  const listsDir = join(resultDir, "outcome-lists");
  const passed = outcomes.filter((outcome) => outcome.status === "pass");
  const failed = outcomes.filter((outcome) => outcome.status === "fail");
  const skipped = outcomes.filter((outcome) => outcome.status === "skip");
  writeFileSync(
    join(listsDir, "passed-tests.tsv"),
    ["test\tcomposite\truntime\tdetails", ...passed.map((outcome) =>
      `${outcome.name}\t${outcome.composite}\t${outcome.runtime}\t${tsv(outcome.details)}`,
    )].join("\n") + "\n",
  );
  writeFileSync(
    join(listsDir, "failed-tests.tsv"),
    ["test\tcomposite\truntime\terror", ...failed.map((outcome) =>
      `${outcome.name}\t${outcome.composite}\t${outcome.runtime}\t${tsv(outcome.details)}`,
    )].join("\n") + "\n",
  );
  writeFileSync(
    join(listsDir, "skipped-tests.tsv"),
    ["test\tcomposite\truntime\treason", ...skipped.map((outcome) =>
      `${outcome.name}\t${outcome.composite}\t${outcome.runtime}\t${tsv(outcome.details)}`,
    )].join("\n") + "\n",
  );
}

function countOutcomes(outcomes: Outcome[]): Record<Status, number> {
  return {
    pass: outcomes.filter((outcome) => outcome.status === "pass").length,
    fail: outcomes.filter((outcome) => outcome.status === "fail").length,
    skip: outcomes.filter((outcome) => outcome.status === "skip").length,
  };
}

function tsv(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    metadataPaths: [],
    resultDir: "test-runs/homebrew-composite-status",
    arch: "wasm32",
    runtimes: ["node", "browser"],
    beadId: "unknown",
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--metadata":
        options.metadataPaths.push(resolve(requireValue(args, ++i, arg)));
        break;
      case "--result-dir":
        options.resultDir = resolve(requireValue(args, ++i, arg));
        break;
      case "--arch":
        options.arch = parseArch(requireValue(args, ++i, arg));
        break;
      case "--runtime":
        options.runtimes = [parseRuntime(requireValue(args, ++i, arg))];
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

  if (options.metadataPaths.length === 0) usage(2, "at least one --metadata is required");
  return options;
}

function parseArch(value: string): "wasm32" | "wasm64" {
  if (value === "wasm32" || value === "wasm64") return value;
  usage(2, `--arch must be wasm32 or wasm64, got ${value}`);
}

function parseRuntime(value: string): Runtime {
  if (value === "node" || value === "browser") return value;
  usage(2, `--runtime must be node or browser, got ${value}`);
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) usage(2, `${flag} requires a value`);
  return value;
}

function usage(code: number, message?: string): never {
  if (message) console.error(`homebrew-composite-status: ${message}`);
  console.error(`usage: npx tsx scripts/homebrew-composite-status.ts \\
  --metadata <Kandelo/metadata.json> [--metadata ...] \\
  [--result-dir <dir>] [--arch wasm32|wasm64] [--runtime node|browser]`);
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
