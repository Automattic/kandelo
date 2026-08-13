import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { HomebrewBottleDescriptor } from "../../../host/src/homebrew-bottle-descriptor";
import {
  composeHomebrewFlatLazyVfs,
  type HomebrewFlatLazyVfsReport,
} from "../../../host/src/homebrew-flat-lazy-vfs-composer";
import { planHomebrewVfsSelection } from "../../../host/src/homebrew-vfs-planner";
import type { HomebrewBottleMirrorBundle } from "../../../host/src/homebrew-vfs-composer";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  MAX_KANDELO_DEMO_CONFIG_BYTES,
} from "../../../web-libs/kandelo-session/src/demo-config";
import {
  MAX_KANDELO_SHELL_CONFIG_BYTES,
} from "../../../web-libs/kandelo-session/src/shell-config";
import {
  isFlatHomebrewVfsCliInvocation,
  loadFlatHomebrewBottle,
  publishFlatHomebrewVfsOutputs,
  readBoundedRegularFileNoFollow,
  resolveFlatHomebrewBottleCacheRoot,
} from "./build-homebrew-flat-vfs-image";
import {
  parseDemoConfigBytes,
  parseShellConfigBytes,
  restoreVerifiedHomebrewBaseImage,
  serializeVerifiedHomebrewVfsImage,
} from "./build-homebrew-vfs-image";
import { sourceDateEpochMilliseconds } from "./vfs-image-helpers";

const MAX_SELECTION_BYTES = 16 * 1024 * 1024;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_BASE_IMAGE_BYTES = 1024 * 1024 * 1024;
const BOOTSTRAP_PACKAGE = "kandelo-dev/tap-core/homebrew-bootstrap";
const BOOTSTRAP_ZIP_OUTPUT = "homebrew-bootstrap";
const BOOTSTRAP_ENV_OUTPUT = "homebrew-brew";

export interface FlatHomebrewLazyVfsCliOptions {
  selection: string;
  materializationPolicy: string;
  runtimeSupportPolicy: string;
  baseImage: string;
  bootstrapZip: string;
  bootstrapEnv: string;
  bottleCache: string;
  mirrorRepository: string;
  mirrorOut: string;
  shellConfig: string;
  demoConfig: string;
  out: string;
  report: string;
}

const CLI_FLAGS = new Map<string, keyof FlatHomebrewLazyVfsCliOptions>([
  ["--selection", "selection"],
  ["--materialization-policy", "materializationPolicy"],
  ["--runtime-support-policy", "runtimeSupportPolicy"],
  ["--base-image", "baseImage"],
  ["--bootstrap-zip", "bootstrapZip"],
  ["--bootstrap-env", "bootstrapEnv"],
  ["--bottle-cache", "bottleCache"],
  ["--mirror-repository", "mirrorRepository"],
  ["--mirror-out", "mirrorOut"],
  ["--shell-config", "shellConfig"],
  ["--demo-config", "demoConfig"],
  ["--out", "out"],
  ["--report", "report"],
]);

export function parseFlatHomebrewLazyVfsArgs(
  args: readonly string[],
): FlatHomebrewLazyVfsCliOptions {
  const parsed: Partial<FlatHomebrewLazyVfsCliOptions> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const key = flag === undefined ? undefined : CLI_FLAGS.get(flag);
    if (key === undefined) {
      throw new Error(
        `unknown flat lazy Homebrew VFS option: ${flag ?? "<missing>"}`,
      );
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`flat lazy Homebrew VFS option ${flag} requires one value`);
    }
    if (parsed[key] !== undefined) {
      throw new Error(
        `flat lazy Homebrew VFS option ${flag} was provided more than once`,
      );
    }
    parsed[key] = value;
  }
  for (const [flag, key] of CLI_FLAGS) {
    if (parsed[key] === undefined) {
      throw new Error(`required flat lazy Homebrew VFS option is missing: ${flag}`);
    }
  }
  const options = parsed as FlatHomebrewLazyVfsCliOptions;
  const outputPaths = [options.out, options.report, options.mirrorOut]
    .map((path) => resolve(path));
  if (new Set(outputPaths).size !== outputPaths.length) {
    throw new Error("flat lazy Homebrew VFS output paths must be different");
  }
  return options;
}

export interface FlatHomebrewLazyVfsBuilderResult {
  report: HomebrewFlatLazyVfsReport;
  cleanupWarnings: readonly string[];
}

export async function runFlatHomebrewLazyVfsImageBuilder(
  args: readonly string[],
): Promise<FlatHomebrewLazyVfsBuilderResult> {
  const options = parseFlatHomebrewLazyVfsArgs(args);
  const selectionBytes = readBoundedRegularFileNoFollow(
    options.selection,
    `flat lazy Homebrew selection at ${options.selection}`,
    MAX_SELECTION_BYTES,
  );
  const plan = planHomebrewVfsSelection(selectionBytes);
  if (basename(resolve(options.out)) !== plan.requestedVfsFilename) {
    throw new Error(
      `flat lazy Homebrew output filename must match selection request ` +
        plan.requestedVfsFilename,
    );
  }

  const materializationPolicy = readJsonInput(
    options.materializationPolicy,
    "materialization policy",
    MAX_POLICY_BYTES,
  );
  const runtimeSupportPolicy = readJsonInput(
    options.runtimeSupportPolicy,
    "runtime-support policy",
    MAX_POLICY_BYTES,
  );
  const baseBytes = readBoundedRegularFileNoFollow(
    options.baseImage,
    `flat lazy Homebrew base image at ${options.baseImage}`,
    MAX_BASE_IMAGE_BYTES,
  );
  const base = await restoreVerifiedHomebrewBaseImage(
    baseBytes,
    `flat lazy Homebrew base image at ${options.baseImage}`,
    plan.kandeloAbi,
  );
  const shell = parseShellConfigBytes(
    readBoundedRegularFileNoFollow(
      options.shellConfig,
      `flat lazy Homebrew shell config at ${options.shellConfig}`,
      MAX_KANDELO_SHELL_CONFIG_BYTES,
    ),
    options.shellConfig,
  );
  const demo = parseDemoConfigBytes(
    readBoundedRegularFileNoFollow(
      options.demoConfig,
      `flat lazy Homebrew demo config at ${options.demoConfig}`,
      MAX_KANDELO_DEMO_CONFIG_BYTES,
    ),
    options.demoConfig,
  );
  const bootstrap = selectedBootstrap(plan.packages);
  const bootstrapZipBytes = readSelectedSupportOutput(
    options.bootstrapZip,
    bootstrap,
    BOOTSTRAP_ZIP_OUTPUT,
  );
  const bootstrapEnvironmentBytes = readSelectedSupportOutput(
    options.bootstrapEnv,
    bootstrap,
    BOOTSTRAP_ENV_OUTPUT,
  );
  const cacheRoot = resolveFlatHomebrewBottleCacheRoot(options.bottleCache);
  const cleanupWarnings: string[] = [];
  const outputFs = base.fs.rebaseToNewFileSystem(base.capacity.maxByteLength);
  const scratchFs = base.fs.rebaseToNewFileSystem(base.capacity.maxByteLength);
  const normalizeTimestampsMs = sourceDateEpochMilliseconds(
    process.env.SOURCE_DATE_EPOCH,
  );
  const composition = await composeHomebrewFlatLazyVfs(plan, {
    materializationPolicyValue: materializationPolicy.value,
    materializationPolicyBytes: materializationPolicy.bytes,
    runtimeSupportPolicyValue: runtimeSupportPolicy.value,
    runtimeSupportPolicyBytes: runtimeSupportPolicy.bytes,
    baseFs: base.fs,
    outputFs,
    scratchFs,
    baseImage: {
      sha256: base.sha256,
      bytes: base.bytes,
      kernelAbi: base.metadata.kernelAbi,
    },
    async loadBottleBytes(descriptor) {
      const loaded = await loadFlatHomebrewBottle(cacheRoot, descriptor);
      cleanupWarnings.push(...loaded.cleanupWarnings);
      return loaded.bytes;
    },
    bootstrapZipBytes,
    bootstrapEnvironmentBytes,
    mirrorRepository: options.mirrorRepository,
    shellConfig: { config: shell.config, source: shell.source },
    demoConfig: { config: demo.config, source: demo.source },
    normalizeTimestampsMs,
  });
  const artifact = await serializeFlatHomebrewLazyVfsArtifact(
    composition.fs,
    composition.report,
    normalizeTimestampsMs,
  );

  const reportBytes = new TextEncoder().encode(
    `${JSON.stringify(artifact.report, null, 2)}\n`,
  );
  let mirrorWritten = false;
  try {
    writeMirrorBundle(options.mirrorOut, composition.mirrorBundle);
    mirrorWritten = true;
    const publication = publishFlatHomebrewVfsOutputs([
      exactOutput(options.out, artifact.bytes),
      exactOutput(options.report, reportBytes),
    ]);
    cleanupWarnings.push(...publication.cleanupWarnings);
  } catch (error) {
    if (mirrorWritten) {
      rmSync(resolve(options.mirrorOut), { recursive: true, force: true });
    }
    throw error;
  }
  return { report: artifact.report, cleanupWarnings };
}

export interface FlatHomebrewLazyVfsSerializedArtifact {
  bytes: Uint8Array;
  rawBytes: number;
  report: HomebrewFlatLazyVfsReport;
}

/** Compress the already-proved composition and bind the report to shipped bytes. */
export async function serializeFlatHomebrewLazyVfsArtifact(
  fs: MemoryFileSystem,
  report: HomebrewFlatLazyVfsReport,
  normalizeTimestampsMs: number,
): Promise<FlatHomebrewLazyVfsSerializedArtifact> {
  const serialized = await serializeVerifiedHomebrewVfsImage(
    fs,
    report.selection.requestedVfsFilename,
    {
      metadata: report.metadata,
      normalizeTimestampsMs,
    },
    report.image.capacity.maxByteLength,
  );
  if (serialized.rawBytes !== report.image.bytes) {
    throw new Error(
      `flat lazy Homebrew VFS changed during compression: ` +
        `${serialized.rawBytes} raw bytes, expected ${report.image.bytes}`,
    );
  }
  const capacity = report.image.capacity;
  const restoredCapacity = MemoryFileSystem.readImageCapacity(serialized.bytes);
  if (
    restoredCapacity.byteLength !== capacity.byteLength ||
    restoredCapacity.maxByteLength !== capacity.maxByteLength
  ) {
    throw new Error("flat lazy Homebrew compressed VFS capacity changed");
  }
  const bytes = Uint8Array.from(serialized.bytes);
  return {
    bytes,
    rawBytes: serialized.rawBytes,
    report: {
      ...report,
      image: {
        ...report.image,
        sha256: digest(bytes),
        bytes: bytes.byteLength,
      },
    },
  };
}

function readJsonInput(path: string, label: string, maxBytes: number) {
  const bytes = readBoundedRegularFileNoFollow(
    path,
    `flat lazy Homebrew ${label} at ${path}`,
    maxBytes,
  );
  try {
    return {
      bytes,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    throw new Error(`flat lazy Homebrew ${label} is not UTF-8 JSON: ${path}`);
  }
}

function selectedBootstrap(
  packages: readonly HomebrewBottleDescriptor[],
): HomebrewBottleDescriptor {
  const matches = packages.filter((descriptor) =>
    descriptor.fullName === BOOTSTRAP_PACKAGE &&
    descriptor.materialization === "homebrew-runtime-support-v1"
  );
  if (matches.length !== 1) {
    throw new Error("flat lazy Homebrew selection must name one bootstrap package");
  }
  return matches[0]!;
}

function readSelectedSupportOutput(
  path: string,
  bootstrap: HomebrewBottleDescriptor,
  name: string,
): Uint8Array {
  const matches = bootstrap.supportOutputs.filter((output) => output.name === name);
  if (matches.length !== 1) {
    throw new Error(`selected Homebrew bootstrap must name one ${name} output`);
  }
  const output = matches[0]!;
  const bytes = readBoundedRegularFileNoFollow(
    path,
    `selected Homebrew bootstrap ${name} at ${path}`,
    output.bytes,
    output.bytes,
  );
  const actual = digest(bytes);
  if (actual !== output.sha256) {
    throw new Error(
      `selected Homebrew bootstrap ${name} expected ${output.sha256}, got ${actual}`,
    );
  }
  return bytes;
}

function writeMirrorBundle(
  outputDirectory: string,
  bundle: HomebrewBottleMirrorBundle,
): void {
  const directory = resolve(outputDirectory);
  if (existsSync(directory)) {
    throw new Error(`flat lazy Homebrew mirror output already exists: ${directory}`);
  }
  const parent = resolve(dirname(directory));
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`flat lazy Homebrew mirror parent is not a directory: ${parent}`);
  }
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  try {
    for (const payload of bundle.payloads) {
      if (basename(payload.asset) !== payload.asset) {
        throw new Error(`flat lazy Homebrew mirror asset is invalid: ${payload.asset}`);
      }
      writeMirrorFile(
        join(directory, payload.asset),
        payload.bytes,
        payload.sha256,
      );
    }
    writeMirrorFile(
      join(directory, bundle.planAsset.asset),
      bundle.planAsset.bytes,
      bundle.planAsset.sha256,
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function writeMirrorFile(
  path: string,
  bytes: Uint8Array,
  expectedSha256: string,
): void {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  const verified = readBoundedRegularFileNoFollow(
    path,
    `flat lazy Homebrew mirror output at ${path}`,
    bytes.byteLength,
    bytes.byteLength,
    0o600,
  );
  if (digest(verified) !== expectedSha256) {
    throw new Error(`flat lazy Homebrew mirror output has the wrong digest: ${path}`);
  }
}

function exactOutput(finalPath: string, bytes: Uint8Array) {
  return {
    finalPath,
    bytes,
    expectedSha256: digest(bytes),
    expectedBytes: bytes.byteLength,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

if (isFlatHomebrewVfsCliInvocation(process.argv[1], import.meta.url)) {
  void runFlatHomebrewLazyVfsImageBuilder(process.argv.slice(2)).then(
    ({ report, cleanupWarnings }) => {
      console.log(
        `Built ${report.selection.requestedVfsFilename} ` +
          `(${report.image.sha256}, ${report.image.bytes} bytes; ` +
          `${report.lazyUsage.groups} deferred trees)`,
      );
      for (const warning of cleanupWarnings) console.warn(warning);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
