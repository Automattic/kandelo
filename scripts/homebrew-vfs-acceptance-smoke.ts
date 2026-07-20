/**
 * Verify and boot one dependency-bearing Homebrew VFS image on Node.
 *
 * The verifier keeps platform inputs (the base VFS and kernel) separate from
 * package evidence. Package bytes must come from successful GHCR bottle
 * sidecars; last-green, source-build, and Kandelo-registry package fallback is
 * intentionally rejected.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  describeWasmArtifactPolicyFailures,
  extractAbiVersion,
} from "../host/src/constants";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import {
  planHomebrewVfs,
  type HomebrewVfsPlan,
} from "../host/src/homebrew-vfs-planner";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import {
  KANDELO_SHELL_CONFIG_PATH,
  MAX_KANDELO_SHELL_CONFIG_BYTES,
  parseKandeloShellConfig,
  type KandeloShellConfig,
} from "../web-libs/kandelo-session/src/shell-config";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_BREWFILE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARGV_JSON_BYTES = 16 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const GUEST_PATH_RE = /^\/(?:[A-Za-z0-9._@%+=:-]+\/)*[A-Za-z0-9._@%+=:-]+$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BREWFILE_PARSER = resolve(SCRIPT_DIR, "homebrew-brewfile-selection.rb");

export type PlatformInputOrigin =
  | "kandelo-package-registry"
  | "kandelo-release"
  | "worktree-build";

export interface HomebrewVfsAcceptanceOptions {
  metadataPath: string;
  tapRoot: string;
  brewfilePath: string;
  baseImagePath: string;
  baseOrigin: PlatformInputOrigin;
  imagePath: string;
  reportPath: string;
  kernelPath: string;
  kernelOrigin: PlatformInputOrigin;
  expectedRootPackage: string;
  executablePath: string;
  argv: string[];
  expectedStdout: string;
  timeoutMs: number;
  shellConfigPath?: string;
}

export interface HomebrewVfsAcceptanceValidation {
  evidence: HomebrewVfsAcceptanceEvidence;
  imageBytes: Uint8Array;
  kernelBytes: Uint8Array;
  executableBytes: Uint8Array;
}

export interface HomebrewVfsAcceptanceEvidence {
  schema: 1;
  status: "validated" | "success";
  selection: {
    parser: "kandelo-static-brewfile-v1";
    sha256: string;
    bytes: number;
    requested_packages: string[];
  };
  dependency_edges: Array<{ from: string; to: string; version: string }>;
  browser_plan: {
    compatibility_basis: "pending-exact-image-runtime-test";
    packages: string[];
  };
  homebrew_bottles: Array<{
    name: string;
    version: string;
    sha256: string;
    bytes: number;
    cache_key_sha: string;
    url: string;
    declared_runtime_support: string[];
    declared_browser_compatible: boolean;
  }>;
  platform_inputs: Array<{
    role: "base-vfs" | "kernel";
    origin: PlatformInputOrigin;
    artifact: string;
    sha256: string;
    bytes: number;
    kernel_abi: number;
  }>;
  image: {
    artifact: string;
    sha256: string;
    bytes: number;
    kernel_abi: number;
  };
  default_shell?: {
    config_artifact: string;
    config_sha256: string;
    config_bytes: number;
    path: string;
    argv: string[];
    bottle_package: string;
  };
  node?: {
    executable: string;
    argv: string[];
    exit_code: number;
    stdout: string;
    stdout_sha256: string;
    stderr_sha256: string;
  };
}

interface BrewfileSelection {
  tapName: string;
  sha256: string;
  bytes: number;
  packages: string[];
}

interface LoadedShellConfig {
  path: string;
  bytes: Uint8Array;
  config: KandeloShellConfig;
  sha256: string;
}

interface CliOptions extends HomebrewVfsAcceptanceOptions {
  evidencePath: string;
}

export async function validateHomebrewVfsAcceptance(
  options: HomebrewVfsAcceptanceOptions,
): Promise<HomebrewVfsAcceptanceValidation> {
  validateGuestExecutablePath(options.executablePath);
  validateArgv(options.argv);
  if (
    options.expectedStdout.length === 0 ||
    options.expectedStdout.length > 4096 ||
    options.expectedStdout.includes("\0") ||
    options.expectedStdout.includes("\n") ||
    options.expectedStdout.includes("\r")
  ) {
    fail("expected stdout must be a single-line string between 1 and 4096 characters");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 600_000) {
    fail("timeout must be an integer between 1000 and 600000 milliseconds");
  }

  const metadata = readJson(options.metadataPath, "tap metadata");
  const brewfile = readBrewfileSelection(options.brewfilePath);
  const shellConfig = options.shellConfigPath
    ? readShellConfig(options.shellConfigPath)
    : undefined;
  if (!PACKAGE_NAME_RE.test(options.expectedRootPackage)) {
    fail(`expected root package is invalid: ${JSON.stringify(options.expectedRootPackage)}`);
  }
  if (!brewfile.packages.includes(options.expectedRootPackage)) {
    fail(`acceptance formula ${options.expectedRootPackage} is not a Brewfile root`);
  }
  const loadLinkManifest = (relativePath: string): unknown =>
    readJson(resolve(options.tapRoot, relativePath), `link manifest ${relativePath}`);
  const planOptions = {
    packages: brewfile.packages,
    arch: "wasm32" as const,
    expectedTapName: brewfile.tapName,
    allowFallback: false,
    loadLinkManifest,
  };
  const nodePlan = await planHomebrewVfs(metadata, {
    ...planOptions,
    runtime: "node",
  });
  // Browser compatibility sidecars normally record evidence from an earlier
  // smoke. This gate is itself producing the first closure-level smoke, so it
  // makes only the selected in-memory plan eligible, then requires the exact
  // composed bytes to succeed in Chromium before the workflow can pass. The
  // tap files and published package claims are never rewritten here.
  const browserPlan = await planHomebrewVfs(
    createBrowserCandidateMetadata(metadata, nodePlan.packages.map((pkg) => pkg.name)),
    { ...planOptions, runtime: "browser" },
  );
  assertEquivalentPlans(nodePlan, browserPlan);
  const plan = nodePlan;

  const dependencyEdges = collectDependencyEdges(plan, options.expectedRootPackage);
  if (dependencyEdges.length === 0) {
    fail("selected acceptance formula must resolve at least one real package dependency edge");
  }
  assertGhcrBottleSources(plan);

  const report = requireRecord(readJson(options.reportPath, "VFS report"), "VFS report");
  assertReportMatchesPlan(report, plan, brewfile, shellConfig);

  const baseImageBytes = readArtifact(options.baseImagePath, "base VFS");
  const baseFs = MemoryFileSystem.fromImagePreservingCapacity(baseImageBytes);
  const baseMetadata = requireRecord(baseFs.getImageMetadata(), "base VFS metadata");
  const baseAbi = requiredInteger(baseMetadata, "kernelAbi", "base VFS metadata");
  if (baseAbi !== plan.kandeloAbi) {
    fail(`base VFS ABI ${baseAbi} does not match bottle ABI ${plan.kandeloAbi}`);
  }
  assertBaseReport(report, baseImageBytes, baseAbi);

  const imageBytes = readArtifact(options.imagePath, "composed VFS");
  const imageFs = MemoryFileSystem.fromImagePreservingCapacity(imageBytes);
  assertImageMetadata(imageFs, plan, brewfile, baseImageBytes, baseAbi, shellConfig);
  assertGuestManifest(imageFs, plan, brewfile);

  const executableBytes = readVfsFile(imageFs, options.executablePath);
  assertExecutableBelongsToBottle(
    plan,
    options.expectedRootPackage,
    options.executablePath,
  );
  const executableFailures = describeWasmArtifactPolicyFailures(
    toArrayBuffer(executableBytes),
    { expectedAbi: plan.kandeloAbi, requiredExports: ["__abi_version", "_start"] },
  );
  if (executableFailures.length > 0) {
    fail(`guest executable is not a current Kandelo program: ${executableFailures.join("; ")}`);
  }

  let defaultShellEvidence: HomebrewVfsAcceptanceEvidence["default_shell"];
  if (shellConfig) {
    const imageConfigBytes = readVfsFile(imageFs, KANDELO_SHELL_CONFIG_PATH);
    if (!bytesEqual(imageConfigBytes, shellConfig.bytes)) {
      fail(`composed VFS ${KANDELO_SHELL_CONFIG_PATH} does not match the reviewed shell config`);
    }
    const bottlePackage = requireUniqueBottleLinkOwner(plan, shellConfig.config.path);
    const shellBytes = readVfsFile(imageFs, shellConfig.config.path);
    const shellFailures = describeWasmArtifactPolicyFailures(
      toArrayBuffer(shellBytes),
      { expectedAbi: plan.kandeloAbi, requiredExports: ["__abi_version", "_start"] },
    );
    if (shellFailures.length > 0) {
      fail(`default shell is not a current Kandelo program: ${shellFailures.join("; ")}`);
    }
    defaultShellEvidence = {
      config_artifact: basename(shellConfig.path),
      config_sha256: shellConfig.sha256,
      config_bytes: shellConfig.bytes.byteLength,
      path: shellConfig.config.path,
      argv: [...shellConfig.config.argv],
      bottle_package: bottlePackage,
    };
  }

  const kernelBytes = readArtifact(options.kernelPath, "kernel Wasm");
  const kernelAbi = extractAbiVersion(toArrayBuffer(kernelBytes));
  if (kernelAbi !== plan.kandeloAbi) {
    fail(`kernel Wasm ABI ${String(kernelAbi)} does not match bottle ABI ${plan.kandeloAbi}`);
  }

  return {
    imageBytes,
    kernelBytes,
    executableBytes,
    evidence: {
      schema: 1,
      status: "validated",
      selection: {
        parser: "kandelo-static-brewfile-v1",
        sha256: brewfile.sha256,
        bytes: brewfile.bytes,
        requested_packages: [...brewfile.packages],
      },
      dependency_edges: dependencyEdges,
      browser_plan: {
        compatibility_basis: "pending-exact-image-runtime-test",
        packages: plan.packages.map((pkg) => pkg.name),
      },
      homebrew_bottles: plan.packages.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        sha256: pkg.sha256,
        bytes: pkg.bytes,
        cache_key_sha: pkg.cacheKeySha,
        url: pkg.url,
        declared_runtime_support: [...pkg.runtimeSupport],
        declared_browser_compatible: pkg.browserCompatible,
      })),
      platform_inputs: [
        platformEvidence(
          "base-vfs",
          options.baseOrigin,
          options.baseImagePath,
          baseImageBytes,
          baseAbi,
        ),
        platformEvidence(
          "kernel",
          options.kernelOrigin,
          options.kernelPath,
          kernelBytes,
          plan.kandeloAbi,
        ),
      ],
      image: {
        artifact: basename(options.imagePath),
        sha256: sha256(imageBytes),
        bytes: imageBytes.byteLength,
        kernel_abi: plan.kandeloAbi,
      },
      ...(defaultShellEvidence ? { default_shell: defaultShellEvidence } : {}),
    },
  };
}

function createBrowserCandidateMetadata(
  metadata: unknown,
  selectedPackages: string[],
): unknown {
  const candidate = structuredClone(metadata);
  const root = requireRecord(candidate, "tap metadata browser candidate");
  const packages = requiredArray(root, "packages", "tap metadata browser candidate");
  for (const selectedName of selectedPackages) {
    const matches = packages
      .map((value, index) => requireRecord(value, `tap metadata browser candidate package ${index}`))
      .filter((pkg) => pkg.name === selectedName);
    if (matches.length !== 1) {
      fail(`browser candidate package ${selectedName} is not unique in tap metadata`);
    }
    const bottles = requiredArray(
      matches[0],
      "bottles",
      `tap metadata browser candidate package ${selectedName}`,
    );
    const wasm32 = bottles
      .map((value, index) => requireRecord(
        value,
        `tap metadata browser candidate package ${selectedName} bottle ${index}`,
      ))
      .filter((bottle) => bottle.arch === "wasm32");
    if (wasm32.length !== 1) {
      fail(`browser candidate package ${selectedName} does not have exactly one wasm32 bottle`);
    }
    wasm32[0].runtime_support = ["node", "browser"];
    wasm32[0].browser_compatible = true;
  }
  return candidate;
}

async function runNodeAcceptance(
  options: HomebrewVfsAcceptanceOptions,
  validated: HomebrewVfsAcceptanceValidation,
): Promise<HomebrewVfsAcceptanceEvidence> {
  let stdout = "";
  let stderr = "";
  const append = (current: string, bytes: Uint8Array, label: string): string => {
    const next = current + new TextDecoder().decode(bytes);
    if (new TextEncoder().encode(next).byteLength > MAX_OUTPUT_BYTES) {
      throw new Error(`${label} exceeded ${MAX_OUTPUT_BYTES} bytes`);
    }
    return next;
  };
  const host = new NodeKernelHost({
    maxWorkers: 4,
    rootfsImage: validated.imageBytes,
    onStdout: (_pid, bytes) => { stdout = append(stdout, bytes, "stdout"); },
    onStderr: (_pid, bytes) => { stderr = append(stderr, bytes, "stderr"); },
  });
  await host.init(toArrayBuffer(validated.kernelBytes));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      host.spawn(toArrayBuffer(validated.executableBytes), options.argv, {
        cwd: "/",
        env: [
          "HOME=/tmp",
          "TMPDIR=/tmp",
          "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
        ],
        stdin: new Uint8Array(),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Node acceptance timed out after ${options.timeoutMs}ms`)),
          options.timeoutMs,
        );
      }),
    ]);
    if (exitCode !== 0) {
      fail(`Node acceptance executable exited ${exitCode}; stderr=${JSON.stringify(stderr)}`);
    }
    if (!stdout.includes(options.expectedStdout)) {
      fail(
        `Node acceptance stdout did not contain ${JSON.stringify(options.expectedStdout)}: ` +
          JSON.stringify(stdout),
      );
    }
    return {
      ...validated.evidence,
      status: "success",
      node: {
        executable: options.executablePath,
        argv: [...options.argv],
        exit_code: exitCode,
        stdout,
        stdout_sha256: sha256(new TextEncoder().encode(stdout)),
        stderr_sha256: sha256(new TextEncoder().encode(stderr)),
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
    await host.destroy().catch(() => {});
  }
}

function assertEquivalentPlans(nodePlan: HomebrewVfsPlan, browserPlan: HomebrewVfsPlan): void {
  const identity = (plan: HomebrewVfsPlan) => JSON.stringify({
    tapRepository: plan.tapRepository,
    tapName: plan.tapName,
    tapCommit: plan.tapCommit,
    kandeloCommit: plan.kandeloCommit,
    kandeloAbi: plan.kandeloAbi,
    releaseTag: plan.releaseTag,
    requestedPackages: plan.requestedPackages,
    packages: plan.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      sha256: pkg.sha256,
      bytes: pkg.bytes,
      cacheKeySha: pkg.cacheKeySha,
      url: pkg.url,
      sourceStatus: pkg.sourceStatus,
      metadataStatus: pkg.metadataStatus,
      linkManifestPath: pkg.linkManifestPath,
    })),
  });
  if (identity(nodePlan) !== identity(browserPlan)) {
    fail("Node and browser selected different Homebrew bottle plans");
  }
}

function collectDependencyEdges(
  plan: HomebrewVfsPlan,
  rootPackage: string,
): Array<{ from: string; to: string; version: string }> {
  const selected = new Map(plan.packages.map((pkg) => [pkg.name, pkg]));
  const visited = new Set<string>();
  const edges: Array<{ from: string; to: string; version: string }> = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const pkg = selected.get(name);
    if (!pkg) fail(`acceptance formula closure is missing package ${name}`);
    for (const dependency of pkg.dependencies) {
      const resolved = selected.get(dependency.name);
      if (!resolved) continue;
      edges.push({
        from: pkg.name,
        to: resolved.name,
        version: resolved.version,
      });
      visit(resolved.name);
    }
  };
  visit(rootPackage);
  return edges;
}

function assertGhcrBottleSources(plan: HomebrewVfsPlan): void {
  const [owner, repository, extra] = plan.tapRepository.toLowerCase().split("/");
  if (!owner || !repository || extra !== undefined) {
    fail("tap repository is not owner/repository");
  }
  const root = `https://ghcr.io/v2/${owner}/${repository}`;
  for (const pkg of plan.packages) {
    if (pkg.sourceStatus !== "success" || pkg.metadataStatus !== "success") {
      fail(`package ${pkg.name} did not select a current successful bottle`);
    }
    const expected = `${root}/${pkg.name}/blobs/sha256:${pkg.sha256}`;
    if (pkg.url !== expected) {
      fail(`package ${pkg.name} bottle URL is not the repository GHCR blob ${expected}`);
    }
  }
}

function assertReportMatchesPlan(
  report: Record<string, unknown>,
  plan: HomebrewVfsPlan,
  brewfile: BrewfileSelection,
  shellConfig?: LoadedShellConfig,
): void {
  expectEqual(report, "schema", 1, "VFS report");
  const metadata = requiredRecord(report, "metadata", "VFS report");
  expectEqual(metadata, "tap_repository", plan.tapRepository, "VFS report metadata");
  expectEqual(metadata, "tap_name", plan.tapName, "VFS report metadata");
  expectEqual(metadata, "tap_commit", plan.tapCommit, "VFS report metadata");
  expectEqual(metadata, "kandelo_repository", plan.kandeloRepository, "VFS report metadata");
  expectEqual(metadata, "kandelo_commit", plan.kandeloCommit, "VFS report metadata");
  expectEqual(metadata, "kandelo_abi", plan.kandeloAbi, "VFS report metadata");
  expectEqual(metadata, "release_tag", plan.releaseTag, "VFS report metadata");

  const selection = requiredRecord(report, "selection", "VFS report");
  expectEqual(selection, "kind", "brewfile", "VFS report selection");
  expectStringArray(selection, "requested_packages", brewfile.packages, "VFS report selection");
  expectEqual(
    selection,
    "requested_packages_sha256",
    requestedPackagesSha256(brewfile.packages),
    "VFS report selection",
  );
  const brewfileReport = requiredRecord(selection, "brewfile", "VFS report selection");
  expectEqual(brewfileReport, "parser", "kandelo-static-brewfile-v1", "VFS report Brewfile");
  expectEqual(brewfileReport, "sha256", brewfile.sha256, "VFS report Brewfile");
  expectEqual(brewfileReport, "bytes", brewfile.bytes, "VFS report Brewfile");

  if (shellConfig) {
    const shell = requiredRecord(report, "default_shell", "VFS report");
    expectEqual(shell, "path", shellConfig.config.path, "VFS report default shell");
    expectStringArray(
      shell,
      "argv",
      shellConfig.config.argv,
      "VFS report default shell",
    );
    expectEqual(shell, "config_sha256", shellConfig.sha256, "VFS report default shell");
    expectEqual(
      shell,
      "config_bytes",
      shellConfig.bytes.byteLength,
      "VFS report default shell",
    );
  } else if (Object.hasOwn(report, "default_shell")) {
    fail("VFS report unexpectedly declares a default shell");
  }

  const packages = requiredArray(report, "packages", "VFS report");
  if (packages.length !== plan.packages.length) {
    fail(`VFS report has ${packages.length} packages, expected ${plan.packages.length}`);
  }
  plan.packages.forEach((pkg, index) => {
    const actual = requireRecord(packages[index], `VFS report package ${index}`);
    const expected: Record<string, string | number> = {
      name: pkg.name,
      version: pkg.version,
      arch: pkg.arch,
      source_status: "success",
      metadata_status: "success",
      url: pkg.url,
      sha256: pkg.sha256,
      bytes: pkg.bytes,
      cache_key_sha: pkg.cacheKeySha,
      link_manifest: pkg.linkManifestPath,
      prefix: pkg.prefix,
      keg: pkg.keg,
    };
    for (const [key, value] of Object.entries(expected)) {
      expectEqual(actual, key, value, `VFS report package ${pkg.name}`);
    }
  });
}

function assertBaseReport(
  report: Record<string, unknown>,
  baseBytes: Uint8Array,
  baseAbi: number,
): void {
  const base = requiredRecord(report, "base_image", "VFS report");
  expectEqual(base, "sha256", sha256(baseBytes), "VFS report base image");
  expectEqual(base, "bytes", baseBytes.byteLength, "VFS report base image");
  expectEqual(base, "kernelAbi", baseAbi, "VFS report base image");
}

function assertImageMetadata(
  fs: MemoryFileSystem,
  plan: HomebrewVfsPlan,
  brewfile: BrewfileSelection,
  baseBytes: Uint8Array,
  baseAbi: number,
  shellConfig?: LoadedShellConfig,
): void {
  const metadata = requireRecord(fs.getImageMetadata(), "composed VFS metadata");
  expectEqual(metadata, "version", 1, "composed VFS metadata");
  expectEqual(metadata, "kernelAbi", plan.kandeloAbi, "composed VFS metadata");
  expectEqual(
    metadata,
    "createdBy",
    "images/vfs/scripts/build-homebrew-vfs-image.ts",
    "composed VFS metadata",
  );
  const base = requiredRecord(metadata, "baseImage", "composed VFS metadata");
  expectEqual(base, "sha256", sha256(baseBytes), "composed VFS base binding");
  expectEqual(base, "bytes", baseBytes.byteLength, "composed VFS base binding");
  expectEqual(base, "kernelAbi", baseAbi, "composed VFS base binding");
  const homebrew = requiredRecord(metadata, "homebrew", "composed VFS metadata");
  expectEqual(homebrew, "tapRepository", plan.tapRepository, "composed VFS Homebrew metadata");
  expectEqual(homebrew, "tapName", plan.tapName, "composed VFS Homebrew metadata");
  expectEqual(homebrew, "tapCommit", plan.tapCommit, "composed VFS Homebrew metadata");
  expectEqual(homebrew, "releaseTag", plan.releaseTag, "composed VFS Homebrew metadata");
  const selection = requiredRecord(homebrew, "selection", "composed VFS Homebrew metadata");
  expectEqual(selection, "kind", "brewfile", "composed VFS selection");
  expectEqual(
    selection,
    "requestedPackageCount",
    brewfile.packages.length,
    "composed VFS selection",
  );
  expectEqual(
    selection,
    "requestedPackagesSha256",
    requestedPackagesSha256(brewfile.packages),
    "composed VFS selection",
  );
  const source = requiredRecord(selection, "brewfile", "composed VFS selection");
  expectEqual(source, "sha256", brewfile.sha256, "composed VFS Brewfile");
  expectEqual(source, "bytes", brewfile.bytes, "composed VFS Brewfile");
  if (shellConfig) {
    const shell = requiredRecord(homebrew, "defaultShell", "composed VFS Homebrew metadata");
    expectEqual(shell, "path", shellConfig.config.path, "composed VFS default shell");
    expectStringArray(
      shell,
      "argv",
      shellConfig.config.argv,
      "composed VFS default shell",
    );
    expectEqual(
      shell,
      "configSha256",
      shellConfig.sha256,
      "composed VFS default shell",
    );
  } else if (Object.hasOwn(homebrew, "defaultShell")) {
    fail("composed VFS metadata unexpectedly declares a default shell");
  }
  const packages = requiredArray(homebrew, "packages", "composed VFS Homebrew metadata");
  assertPackageRecords(packages, plan, "composed VFS package", (pkg) => ({
    name: pkg.name,
    version: pkg.version,
    arch: pkg.arch,
    sourceStatus: "success",
    cacheKeySha: pkg.cacheKeySha,
  }));
}

function assertGuestManifest(
  fs: MemoryFileSystem,
  plan: HomebrewVfsPlan,
  brewfile: BrewfileSelection,
): void {
  const manifest = requireRecord(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json"),
    )),
    "guest Homebrew manifest",
  );
  expectEqual(manifest, "schema", 1, "guest Homebrew manifest");
  const selection = requiredRecord(manifest, "selection", "guest Homebrew manifest");
  expectEqual(selection, "kind", "brewfile", "guest Homebrew selection");
  expectStringArray(selection, "requested_packages", brewfile.packages, "guest Homebrew selection");
  expectEqual(
    selection,
    "requested_packages_sha256",
    requestedPackagesSha256(brewfile.packages),
    "guest Homebrew selection",
  );
  const source = requiredRecord(selection, "brewfile", "guest Homebrew selection");
  expectEqual(source, "sha256", brewfile.sha256, "guest Homebrew Brewfile");
  expectEqual(source, "bytes", brewfile.bytes, "guest Homebrew Brewfile");
  const metadata = requiredRecord(manifest, "metadata", "guest Homebrew manifest");
  const expectedMetadata: Record<string, string | number> = {
    tap_repository: plan.tapRepository,
    tap_name: plan.tapName,
    tap_commit: plan.tapCommit,
    kandelo_repository: plan.kandeloRepository,
    kandelo_commit: plan.kandeloCommit,
    kandelo_abi: plan.kandeloAbi,
    release_tag: plan.releaseTag,
  };
  for (const [key, value] of Object.entries(expectedMetadata)) {
    expectEqual(metadata, key, value, "guest Homebrew metadata");
  }
  assertPackageRecords(
    requiredArray(manifest, "packages", "guest Homebrew manifest"),
    plan,
    "guest Homebrew package",
    (pkg) => ({
      name: pkg.name,
      version: pkg.version,
      arch: pkg.arch,
      source_status: "success",
      metadata_status: "success",
      url: pkg.url,
      sha256: pkg.sha256,
      bytes: pkg.bytes,
      cache_key_sha: pkg.cacheKeySha,
      link_manifest: pkg.linkManifestPath,
      prefix: pkg.prefix,
      keg: pkg.keg,
    }),
  );
}

function assertPackageRecords(
  actualPackages: unknown[],
  plan: HomebrewVfsPlan,
  label: string,
  expectedRecord: (pkg: HomebrewVfsPlan["packages"][number]) => Record<string, unknown>,
): void {
  if (actualPackages.length !== plan.packages.length) {
    fail(`${label} count ${actualPackages.length} does not match plan count ${plan.packages.length}`);
  }
  plan.packages.forEach((pkg, index) => {
    const actual = requireRecord(actualPackages[index], `${label} ${index}`);
    for (const [key, value] of Object.entries(expectedRecord(pkg))) {
      expectEqual(actual, key, value, `${label} ${pkg.name}`);
    }
  });
}

function assertExecutableBelongsToBottle(
  plan: HomebrewVfsPlan,
  expectedRootPackage: string,
  path: string,
): void {
  const root = plan.packages.find((pkg) => pkg.name === expectedRootPackage);
  if (!root) fail(`acceptance formula ${expectedRootPackage} is absent from the bottle plan`);
  const linked = root.linkManifest.links.some((link) =>
    joinGuestPath(root.prefix, link.target) === path
  );
  if (!linked) {
    fail(`guest executable ${path} is not a link owned by acceptance formula ${expectedRootPackage}`);
  }
}

function requireUniqueBottleLinkOwner(plan: HomebrewVfsPlan, path: string): string {
  const owners = plan.packages.filter((pkg) =>
    pkg.linkManifest.links.some((link) => joinGuestPath(pkg.prefix, link.target) === path)
  );
  if (owners.length !== 1) {
    fail(
      `default shell ${path} must be linked by exactly one selected Homebrew bottle; ` +
        `found ${owners.map((pkg) => pkg.name).join(", ") || "none"}`,
    );
  }
  return owners[0]!.name;
}

function platformEvidence(
  role: "base-vfs" | "kernel",
  origin: PlatformInputOrigin,
  path: string,
  bytes: Uint8Array,
  abi: number,
): HomebrewVfsAcceptanceEvidence["platform_inputs"][number] {
  return {
    role,
    origin,
    artifact: basename(path),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    kernel_abi: abi,
  };
}

function readBrewfileSelection(path: string): BrewfileSelection {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_BREWFILE_BYTES) {
    fail(`Brewfile must be a non-empty regular file no larger than ${MAX_BREWFILE_BYTES} bytes`);
  }
  const parsed = spawnSync("ruby", [BREWFILE_PARSER, path], {
    encoding: "utf8",
    maxBuffer: MAX_BREWFILE_BYTES,
  });
  if (parsed.error) fail(`cannot run the static Brewfile parser: ${parsed.error.message}`);
  if (parsed.status !== 0) fail(`static Brewfile parser rejected the file: ${parsed.stderr.trim()}`);
  const value = requireRecord(JSON.parse(parsed.stdout), "static Brewfile parser output");
  expectEqual(value, "schema", 1, "static Brewfile parser output");
  expectEqual(value, "kind", "kandelo-static-brewfile-v1", "static Brewfile parser output");
  const tapName = requiredString(value, "tap_name", "static Brewfile parser output");
  const digest = requiredString(value, "sha256", "static Brewfile parser output");
  const bytes = requiredInteger(value, "bytes", "static Brewfile parser output");
  const packages = requiredStringArray(value, "packages", "static Brewfile parser output");
  if (!SHA256_RE.test(digest) || bytes !== stat.size || packages.length === 0) {
    fail("static Brewfile parser returned invalid provenance");
  }
  return { tapName, sha256: digest, bytes, packages };
}

function readShellConfig(path: string): LoadedShellConfig {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size <= 0 ||
    stat.size > MAX_KANDELO_SHELL_CONFIG_BYTES
  ) {
    fail(
      `shell config must be a non-empty regular file no larger than ` +
        `${MAX_KANDELO_SHELL_CONFIG_BYTES} bytes`,
    );
  }
  const bytes = new Uint8Array(readFileSync(path));
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const config = parseKandeloShellConfig(source);
  if (!config) fail("shell config has an unsupported version");
  return { path, bytes, config, sha256: sha256(bytes) };
}

function readArtifact(path: string, label: string): Uint8Array {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch (error) {
    fail(`${label} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  const stat = statSync(resolved!);
  if (!stat.isFile() || stat.size <= 0) fail(`${label} must resolve to a non-empty regular file`);
  return new Uint8Array(readFileSync(resolved!));
}

function readJson(path: string, label: string): unknown {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JSON_BYTES) {
    fail(`${label} must be a regular non-symlink file no larger than ${MAX_JSON_BYTES} bytes`);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    fs.read(fd, bytes, null, bytes.byteLength);
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function validateGuestExecutablePath(path: string): void {
  if (!GUEST_PATH_RE.test(path) || path.includes("/../") || path.includes("//")) {
    fail(`executable must be a normalized absolute guest path, got ${JSON.stringify(path)}`);
  }
}

function validateArgv(argv: string[]): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64) {
    fail("argv must contain between 1 and 64 strings");
  }
  for (const value of argv) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
      fail("argv entries must be non-empty strings no longer than 4096 characters");
    }
  }
  if (new TextEncoder().encode(JSON.stringify(argv)).byteLength > MAX_ARGV_JSON_BYTES) {
    fail(`serialized argv must not exceed ${MAX_ARGV_JSON_BYTES} bytes`);
  }
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--metadata", "--tap-root", "--brewfile", "--base-image", "--base-origin",
    "--image", "--report", "--kernel", "--kernel-origin", "--formula", "--executable",
    "--argv-json", "--expect-stdout", "--timeout-ms", "--evidence", "--shell-config",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || value === undefined || values.has(flag)) usage(`invalid or repeated option ${flag}`);
    values.set(flag, value);
  }
  for (const flag of allowed) {
    if (flag === "--timeout-ms" || flag === "--shell-config") continue;
    if (!values.has(flag)) usage(`missing ${flag}`);
  }
  let argv: unknown;
  try {
    argv = JSON.parse(values.get("--argv-json")!);
  } catch {
    usage("--argv-json must be valid JSON");
  }
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    usage("--argv-json must be a JSON array of strings");
  }
  return {
    metadataPath: values.get("--metadata")!,
    tapRoot: values.get("--tap-root")!,
    brewfilePath: values.get("--brewfile")!,
    baseImagePath: values.get("--base-image")!,
    baseOrigin: parseOrigin(values.get("--base-origin")!),
    imagePath: values.get("--image")!,
    reportPath: values.get("--report")!,
    kernelPath: values.get("--kernel")!,
    kernelOrigin: parseOrigin(values.get("--kernel-origin")!),
    expectedRootPackage: values.get("--formula")!,
    executablePath: values.get("--executable")!,
    argv: argv as string[],
    expectedStdout: values.get("--expect-stdout")!,
    timeoutMs: parsePositiveInteger(values.get("--timeout-ms") ?? "120000", "--timeout-ms"),
    shellConfigPath: values.get("--shell-config"),
    evidencePath: values.get("--evidence")!,
  };
}

function parseOrigin(value: string): PlatformInputOrigin {
  if (value === "kandelo-package-registry" || value === "kandelo-release" || value === "worktree-build") {
    return value;
  }
  usage(`platform origin must be kandelo-package-registry, kandelo-release, or worktree-build, got ${value}`);
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) usage(`${label} must be a positive integer`);
  return Number(value);
}

function requiredRecord(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  return requireRecord(record[key], `${label}.${key}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredArray(record: Record<string, unknown>, key: string, label: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) fail(`${label}.${key} must be an array`);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) fail(`${label}.${key} must be a non-empty string`);
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) fail(`${label}.${key} must be an integer`);
  return value;
}

function requiredStringArray(record: Record<string, unknown>, key: string, label: string): string[] {
  const value = requiredArray(record, key, label);
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail(`${label}.${key} must contain only non-empty strings`);
  }
  return value as string[];
}

function expectStringArray(
  record: Record<string, unknown>,
  key: string,
  expected: string[],
  label: string,
): void {
  const actual = requiredStringArray(record, key, label);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}.${key} does not match the static Brewfile roots`);
  }
}

function expectEqual(
  record: Record<string, unknown>,
  key: string,
  expected: unknown,
  label: string,
): void {
  if (record[key] !== expected) {
    fail(`${label}.${key} is ${JSON.stringify(record[key])}, expected ${JSON.stringify(expected)}`);
  }
}

function joinGuestPath(base: string, relative: string): string {
  return `${base.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function requestedPackagesSha256(packages: string[]): string {
  return sha256(new TextEncoder().encode(JSON.stringify(packages)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function fail(message: string): never {
  throw new Error(`Homebrew VFS acceptance: ${message}`);
}

function usage(message: string): never {
  console.error(`homebrew-vfs-acceptance-smoke: ${message}`);
  console.error(`usage: npx tsx scripts/homebrew-vfs-acceptance-smoke.ts \\
  --metadata <Kandelo/metadata.json> --tap-root <tap> --brewfile <Brewfile> \\
  --base-image <base.vfs[.zst]> --base-origin <origin> \\
  --image <composed.vfs.zst> --report <report.json> \\
  --kernel <kernel.wasm> --kernel-origin <origin> --formula <root> \\
  --executable </guest/path> --argv-json <json-array> \\
  --expect-stdout <literal> [--timeout-ms <milliseconds>] \\
  [--shell-config <shell.json>] --evidence <out.json>`);
  process.exit(2);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const validated = await validateHomebrewVfsAcceptance(options);
  const evidence = await runNodeAcceptance(options, validated);
  mkdirSync(dirname(options.evidencePath), { recursive: true });
  writeFileSync(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Homebrew VFS acceptance evidence: ${options.evidencePath}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
