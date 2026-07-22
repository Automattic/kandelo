#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
  type SerializedLazyArchiveEntry,
} from "../host/src/vfs/memory-fs";
import type { ClosedLazyAsset } from "../host/src/vfs/closed-lazy-assets";
import {
  assertHomebrewBottleMirrorBundle,
  assertHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-vfs-composer";
import { assertMainShellImageContract } from "./homebrew-main-shell-image-contract";
import { KANDELO_DEMO_CONFIG_PATH } from "../web-libs/kandelo-session/src/demo-config";
import {
  KANDELO_SHELL_CONFIG_PATH,
  parseKandeloShellConfig,
} from "../web-libs/kandelo-session/src/shell-config";
import {
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  assertVfsImageFitsProfile,
  declaredVfsMaxByteLength,
} from "../web-libs/kandelo-session/src/vfs-capacity";
import { MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS } from "./homebrew-language-runtime-contract";

const {
  imagePath,
  migrationLockPath,
  demoConfigPath,
  transportMode,
  bottleMirrorPlanPath,
} = parseArgs(process.argv.slice(2));
const BASE_EXPECTED_FETCHED_PACKAGES = [
  "kandelo-dev/tap-core/dash",
  "kandelo-dev/tap-core/git",
  "kandelo-dev/tap-core/nethack",
] as const;
const LANGUAGE_PACKAGE_NAMES = new Set(
  MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS.map(({ packageName }) => packageName),
);
const imageBytes = new Uint8Array(readFileSync(imagePath));
const metadata = MemoryFileSystem.readImageMetadata(imageBytes);
const capacity = MemoryFileSystem.readImageCapacity(imageBytes);
assertVfsImageFitsProfile(
  capacity,
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  declaredVfsMaxByteLength(metadata),
  imagePath,
);

const fs = MemoryFileSystem.fromImage(imageBytes, {
  maxByteLength: MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
});
const migrationLockBytes = new Uint8Array(readFileSync(migrationLockPath));
const migrationLock = parseJson(migrationLockBytes, migrationLockPath);
const demoConfigSource = readVfsFile(fs, KANDELO_DEMO_CONFIG_PATH);
const guestManifest = parseJson(
  readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json"),
  "/etc/kandelo/homebrew-vfs.json",
);
const shellConfig = parseKandeloShellConfig(
  new TextDecoder("utf-8", { fatal: true }).decode(readVfsFile(fs, KANDELO_SHELL_CONFIG_PATH)),
);
if (shellConfig === null) {
  throw new Error(`${KANDELO_SHELL_CONFIG_PATH} has an unsupported schema`);
}
assertMainShellImageContract({
  migrationLock,
  migrationLockSha256: createHash("sha256").update(migrationLockBytes).digest("hex"),
  migrationLockBytes: migrationLockBytes.byteLength,
  guestManifest,
  imageMetadata: metadata,
  imageCapacity: capacity,
  shellConfig,
  demoConfigSource,
  expectedDemoConfigSource: new Uint8Array(readFileSync(demoConfigPath)),
  runtimeState: readRuntimeState(fs, migrationLock),
});
const pendingTrees = fs.exportLazyArchiveEntries().filter(
  (tree) => tree.content !== undefined,
);
if (fs.isPathDeferred(shellConfig.path)) {
  throw new Error(`image-owned default shell remains deferred: ${shellConfig.path}`);
}
const embeddedMirrorPlanBytes = readVfsFile(
  fs,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
);
const mirrorPlan = decodeBottleMirrorPlan(
  embeddedMirrorPlanBytes,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
);
if (pendingTrees.length !== mirrorPlan.assets.length) {
  throw new Error(
    `main-shell image has ${pendingTrees.length} pending bottle trees, while its ` +
      `mirror plan declares ${mirrorPlan.assets.length}`,
  );
}
assertPendingTreeMirrorBinding(pendingTrees, mirrorPlan);
const closedLazyAssets = transportMode === "closed"
  ? loadBottleMirrorBindings(
      bottleMirrorPlanPath!,
      embeddedMirrorPlanBytes,
      pendingTrees,
    )
  : undefined;
const posixShell = assertRetainedPosixShellAlias(fs, migrationLock, guestManifest);
const pendingPosixShellTrees = pendingTrees.filter((tree) =>
  tree.entries.some((entry) => entry.vfsPath === posixShell.executablePath)
);
if (pendingPosixShellTrees.length !== 1) {
  throw new Error(
    `${posixShell.executablePath} belongs to ` +
      `${pendingPosixShellTrees.length} pending bottle trees, expected one`,
  );
}
const shellBytes = readVfsBinary(fs, shellConfig.path);
let stdout = "";
let stderr = "";
const lazyDownloads: LazyDownloadEvent[] = [];
const host = new NodeKernelHost({
  maxWorkers: 8,
  rootfsImage: imageBytes,
  rootfsLazyAssets: closedLazyAssets,
  onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
  onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  onLazyDownload: (event) => { lazyDownloads.push(event); },
});

await host.init();
try {
  const offlineCommand = `
set -eu
test -n "$BASH_VERSION"
printf 'homebrew-offline-bash-ok\\n'
`.trim();
  await spawnWithTimeout(
    host,
    shellBytes,
    [shellConfig.argv[0], "-l", "-c", offlineCommand],
    "image-owned Bash offline phase",
    () => ({ stdout, stderr }),
  );
  if (!stdout.includes("homebrew-offline-bash-ok")) {
    throw new Error(
      `Homebrew image-owned Bash did not reach the offline marker; ` +
        `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  assertNoLazyTransport(
    lazyDownloads,
    "kernel initialization and image-owned Bash offline phase",
  );

  const posixShellLazyStart = lazyDownloads.length;
  const posixShellCommand = `
set -eu
/bin/sh -c 'test -z "\${BASH_VERSION-}" && test -x /bin/bash && test -x /usr/bin/sh && test -x /usr/bin/env && printf "homebrew-posix-paths-ok\\n"'
`.trim();
  await spawnWithTimeout(
    host,
    shellBytes,
    [shellConfig.argv[0], "-c", posixShellCommand],
    "retained /bin/sh phase",
    () => ({ stdout, stderr }),
  );
  if (!stdout.includes("homebrew-posix-paths-ok")) {
    throw new Error(
      `Homebrew retained /bin/sh did not reach its marker; ` +
        `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  assertSingleBottleTransport(
    lazyDownloads.slice(posixShellLazyStart),
    pendingPosixShellTrees[0]!,
    posixShell.executablePath,
  );

  const command = `
set -eu
/bin/bash -c 'test -x /bin/dash && printf "homebrew-bash-path-ok\\n"'
/bin/bash -lc 'set -eu
test "$USER" = player
printf "homebrew-profile-user-ok\\n"
test "$NETHACKOPTIONS" = "windowtype:curses,color,lit_corridor,hilite_pet"
printf "homebrew-profile-nethack-options-ok\\n"
alias ls >/dev/null
alias grep >/dev/null
printf "homebrew-profile-aliases-ok\\n"
test "$(git config --get user.name)" = User
printf "homebrew-profile-git-config-ok\\n"
printf "homebrew-profile-state-ok\\n"'
for cmd in python python3 python3.13 perl erl ruby gem bundle bundler; do
  command -v "$cmd" >/dev/null
done
printf 'homebrew-language-command-surface-ok\\n'
printf 'device-null-check' >/dev/null
printf 'homebrew-dev-null-ok\\n'
printf '' >>/home/.nethack/record
score_output="$(nethack -s all 2>&1)"
case "$score_output" in
  *"Cannot open record file"*) printf '%s\\n' "$score_output" >&2; exit 1 ;;
esac
printf 'homebrew-nethack-state-ok\\n'
`.trim();
  await spawnWithTimeout(
    host,
    shellBytes,
    [shellConfig.argv[0], "-c", command],
    "compatibility command-surface phase",
    () => ({ stdout, stderr }),
  );
  for (const marker of [
    "homebrew-bash-path-ok",
    "homebrew-profile-state-ok",
    "homebrew-language-command-surface-ok",
    "homebrew-dev-null-ok",
    "homebrew-nethack-state-ok",
  ]) {
    if (!stdout.includes(marker)) {
      throw new Error(
        `Homebrew /bin/sh smoke did not emit ${marker}; stdout=${JSON.stringify(stdout)}`,
      );
    }
  }
  assertFetchedPackageSet(
    lazyDownloads,
    pendingTrees,
    mirrorPlan,
    BASE_EXPECTED_FETCHED_PACKAGES,
    "base shell compatibility surface",
  );

  for (const invocation of MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS) {
    const eventStart = lazyDownloads.length;
    const stdoutStart = stdout.length;
    const stderrStart = stderr.length;
    await spawnWithTimeout(
      host,
      shellBytes,
      invocation.argv,
      invocation.label,
      () => ({ stdout: stdout.slice(stdoutStart), stderr: stderr.slice(stderrStart) }),
    );
    const runtimeStdout = stdout.slice(stdoutStart);
    const runtimeStderr = stderr.slice(stderrStart);
    if (runtimeStdout !== invocation.expectedStdout || runtimeStderr !== "") {
      throw new Error(
        `${invocation.label} returned unexpected output; ` +
          `stdout=${JSON.stringify(runtimeStdout)} stderr=${JSON.stringify(runtimeStderr)}`,
      );
    }
    assertLanguageBottleIsolation(
      invocation.packageName,
      invocation.dependencyPackages,
      lazyDownloads.slice(eventStart),
      pendingTrees,
      mirrorPlan,
      guestManifest,
      invocation.label,
    );
  }
  const transportEvidence = assertBottleTransportEvents(
    lazyDownloads,
    pendingTrees,
    mirrorPlan,
    guestManifest,
  );
  const counts = mainShellCounts(migrationLock);
  console.log(
    `Homebrew main-shell Node smoke: exact ${counts.roots}-root/` +
      `${counts.formulae}-Formula archive, image-owned ` +
      "offline Bash, retained /bin/sh, metadata/runtime state, /dev/null, and " +
      "isolated Python/Perl/Erlang/Ruby first use passed " +
      `(${transportEvidence.bottles} bottles, ` +
      `${transportEvidence.bytes} bytes).`,
  );
} finally {
  await host.destroy().catch(() => {});
}

function loadBottleMirrorBindings(
  planPath: string,
  embeddedManifestBytes: Uint8Array,
  pendingTrees: readonly SerializedLazyArchiveEntry[],
): ClosedLazyAsset[] {
  const planStat = lstatSync(planPath);
  if (!planStat.isFile() || planStat.isSymbolicLink()) {
    throw new Error(`bottle mirror plan is not a regular non-symlink file: ${planPath}`);
  }
  const manifestBytes = new Uint8Array(readFileSync(planPath));
  if (
    manifestBytes.byteLength !== embeddedManifestBytes.byteLength ||
    !manifestBytes.every((byte, index) => byte === embeddedManifestBytes[index])
  ) {
    throw new Error("closed bottle mirror plan differs from the exact VFS-embedded plan");
  }
  const plan = decodeBottleMirrorPlan(manifestBytes, planPath);
  const decoded = plan as unknown as Record<string, unknown>;
  if (!isRecord(decoded) || !Array.isArray(decoded.assets)) {
    throw new Error("bottle mirror plan does not declare an asset array");
  }
  if (
    typeof decoded.manifest_asset !== "string" ||
    basename(planPath) !== decoded.manifest_asset
  ) {
    throw new Error("bottle mirror plan filename differs from its declared asset name");
  }

  const mirrorDir = dirname(planPath);
  const payloads = decoded.assets.map((value, index) => {
    if (
      !isRecord(value) || typeof value.id !== "string" ||
      typeof value.package !== "string" || typeof value.asset !== "string" ||
      typeof value.sha256 !== "string"
    ) {
      throw new Error(`bottle mirror asset ${index} has invalid identity fields`);
    }
    if (value.asset === "." || value.asset === ".." || basename(value.asset) !== value.asset) {
      throw new Error(`bottle mirror asset ${index} filename is not canonical`);
    }
    const assetPath = join(mirrorDir, value.asset);
    const stat = lstatSync(assetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `bottle mirror asset is not a regular non-symlink file: ${assetPath}`,
      );
    }
    const bytes = new Uint8Array(readFileSync(assetPath));
    return {
      id: value.id,
      package: value.package,
      asset: value.asset,
      sha256: value.sha256,
      bytes,
    };
  });
  assertHomebrewBottleMirrorBundle(plan, payloads, {
    asset: basename(planPath) as "kandelo-homebrew-bottle-mirror-plan.json",
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    bytes: manifestBytes,
  });
  assertPendingTreeMirrorBinding(pendingTrees, plan);
  const payloadByPackage = new Map(payloads.map((payload) => [payload.package, payload]));
  return plan.assets.map((asset): ClosedLazyAsset => {
    const payload = payloadByPackage.get(asset.package)!;
    return {
      url: asset.url,
      sha256: asset.sha256,
      size: asset.bytes,
      bytes: payload.bytes,
    };
  });
}

function decodeBottleMirrorPlan(
  manifestBytes: Uint8Array,
  label: string,
): HomebrewBottleMirrorPlan {
  const decoded = parseJson(manifestBytes, label);
  if (!isRecord(decoded) || !Array.isArray(decoded.assets)) {
    throw new Error(`${label} does not declare a bottle mirror asset array`);
  }
  const plan = decoded as unknown as HomebrewBottleMirrorPlan;
  assertHomebrewBottleMirrorPlan(plan);
  return plan;
}

function assertPendingTreeMirrorBinding(
  pendingTrees: readonly SerializedLazyArchiveEntry[],
  plan: HomebrewBottleMirrorPlan,
): void {
  if (pendingTrees.length !== plan.assets.length) {
    throw new Error(
      `pending tree count ${pendingTrees.length} differs from mirror asset count ` +
        `${plan.assets.length}`,
    );
  }
  const assetByUrl = new Map(plan.assets.map((asset) => [asset.url, asset]));
  if (assetByUrl.size !== plan.assets.length) {
    throw new Error("bottle mirror plan duplicates a release URL");
  }
  const seen = new Set<string>();
  for (const tree of pendingTrees) {
    const content = tree.content;
    const primaryUrl = content?.transports[0];
    const asset = primaryUrl === undefined ? undefined : assetByUrl.get(primaryUrl);
    if (
      content === undefined || asset === undefined ||
      content.sha256 !== asset.sha256 || content.bytes !== asset.bytes
    ) {
      throw new Error(
        `pending tree ${tree.mountPrefix} does not match one exact mirror asset`,
      );
    }
    if (seen.has(primaryUrl!)) {
      throw new Error(`multiple pending trees use mirror URL ${primaryUrl}`);
    }
    seen.add(primaryUrl!);
  }
  if (seen.size !== plan.assets.length) {
    throw new Error("pending trees do not cover the complete bottle mirror plan");
  }
}

function assertNoLazyTransport(
  events: readonly LazyDownloadEvent[],
  label: string,
): void {
  if (events.length !== 0) {
    const first = events[0]!;
    throw new Error(
      `${label} unexpectedly started lazy transport ${first.kind} ${first.url}`,
    );
  }
}

function assertSingleBottleTransport(
  events: readonly LazyDownloadEvent[],
  tree: SerializedLazyArchiveEntry,
  executablePath: string,
): void {
  if (!tree.entries.some((entry) => entry.vfsPath === executablePath)) {
    throw new Error(
      `pending bottle tree ${tree.mountPrefix} does not own ${executablePath}`,
    );
  }
  assertCompleteBottleTransport(events, [tree], "retained /bin/sh first use");
  const ids = new Set(events.map((event) => event.id));
  if (ids.size !== 1) {
    throw new Error(
      `retained /bin/sh first use used ${ids.size} bottle fetches, expected one`,
    );
  }
}

function assertBottleTransportEvents(
  events: readonly LazyDownloadEvent[],
  pendingTrees: readonly SerializedLazyArchiveEntry[],
  plan: HomebrewBottleMirrorPlan,
  guestManifest: unknown,
): { bottles: number; bytes: number } {
  const evidence = assertCompleteBottleTransport(
    events,
    pendingTrees,
    "Homebrew main-shell command surface",
  );
  const fetchedPackages = packagesForUrls(evidence.urls, plan);
  const requiredPackages = [
    ...BASE_EXPECTED_FETCHED_PACKAGES,
    ...MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS.map(({ packageName }) => packageName),
  ];
  const missing = requiredPackages.filter((name) => !fetchedPackages.includes(name));
  if (missing.length !== 0) {
    throw new Error(
      `main-shell smoke did not fetch required bottles ${JSON.stringify(missing)}; ` +
        `fetched ${JSON.stringify(fetchedPackages)}`,
    );
  }
  const allowedPackages = new Set<string>(BASE_EXPECTED_FETCHED_PACKAGES);
  for (const { packageName, dependencyPackages } of MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS) {
    for (const dependency of reviewedPackageClosure(
      guestManifest,
      packageName,
      dependencyPackages,
    )) {
      allowedPackages.add(dependency);
    }
  }
  const unexpected = fetchedPackages.filter((name) => !allowedPackages.has(name));
  if (unexpected.length !== 0) {
    throw new Error(
      `main-shell smoke fetched bottles outside its reviewed runtime closures: ` +
        JSON.stringify(unexpected),
    );
  }
  const fetchedUrls = new Set(evidence.urls);
  const remaining = plan.assets.filter((asset) => !fetchedUrls.has(asset.url));
  if (remaining.length === 0) {
    throw new Error("main-shell smoke unexpectedly materialized every deferred bottle");
  }
  const initiallyPendingUrls = new Set(pendingTrees.map((tree) => tree.content!.transports[0]!));
  if (remaining.some((asset) => !initiallyPendingUrls.has(asset.url))) {
    throw new Error("main-shell smoke remaining bottle set differs from the initial pending set");
  }
  return { bottles: evidence.bottles, bytes: evidence.bytes };
}

function assertFetchedPackageSet(
  events: readonly LazyDownloadEvent[],
  pendingTrees: readonly SerializedLazyArchiveEntry[],
  plan: HomebrewBottleMirrorPlan,
  expectedPackages: readonly string[],
  label: string,
): void {
  const evidence = assertCompleteBottleTransport(events, pendingTrees, label);
  const actual = packagesForUrls(evidence.urls, plan);
  const expected = [...expectedPackages].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} fetched ${JSON.stringify(actual)}, expected exactly ` +
        JSON.stringify(expected),
    );
  }
}

function assertLanguageBottleIsolation(
  packageName: string,
  declaredDependencies: readonly string[],
  events: readonly LazyDownloadEvent[],
  pendingTrees: readonly SerializedLazyArchiveEntry[],
  plan: HomebrewBottleMirrorPlan,
  guestManifest: unknown,
  label: string,
): void {
  const evidence = assertCompleteBottleTransport(events, pendingTrees, `${label} first use`);
  const fetchedPackages = packagesForUrls(evidence.urls, plan);
  if (!fetchedPackages.includes(packageName)) {
    throw new Error(
      `${label} did not fetch its own bottle ${packageName}; ` +
        `fetched ${JSON.stringify(fetchedPackages)}`,
    );
  }
  const allowed = reviewedPackageClosure(
    guestManifest,
    packageName,
    declaredDependencies,
  );
  const outsideClosure = fetchedPackages.filter((name) => !allowed.has(name));
  if (outsideClosure.length !== 0) {
    throw new Error(
      `${label} fetched bottles outside its dependency closure: ` +
        JSON.stringify(outsideClosure),
    );
  }
  const otherLanguages = fetchedPackages.filter(
    (name) => name !== packageName && LANGUAGE_PACKAGE_NAMES.has(name),
  );
  if (otherLanguages.length !== 0) {
    throw new Error(
      `${label} fetched unrelated language bottles: ${JSON.stringify(otherLanguages)}`,
    );
  }
}

function packagesForUrls(
  urls: readonly string[],
  plan: HomebrewBottleMirrorPlan,
): string[] {
  const packageByUrl = new Map(plan.assets.map((asset) => [asset.url, asset.package]));
  return urls.map((url) => {
    const packageName = packageByUrl.get(url);
    if (packageName === undefined) {
      throw new Error(`completed bottle URL is absent from the mirror plan: ${url}`);
    }
    return packageName;
  }).sort();
}

function reviewedPackageClosure(
  guestManifest: unknown,
  rootPackage: string,
  declaredDependencies: readonly string[],
): Set<string> {
  const guest = asRecord(guestManifest, "guest Homebrew manifest");
  if (!Array.isArray(guest.packages)) {
    throw new Error("guest Homebrew manifest packages are missing");
  }
  const packageNames = new Set<string>();
  for (const [index, value] of guest.packages.entries()) {
    const pkg = asRecord(value, `guest Homebrew package ${index}`);
    if (typeof pkg.full_name !== "string") {
      throw new Error(`guest Homebrew package ${index} has no full identity`);
    }
    if (packageNames.has(pkg.full_name)) {
      throw new Error(`guest Homebrew manifest duplicates ${pkg.full_name}`);
    }
    packageNames.add(pkg.full_name);
  }
  const reviewed = new Set([rootPackage, ...declaredDependencies]);
  for (const packageName of reviewed) {
    if (!packageNames.has(packageName)) {
      throw new Error(
        `guest Homebrew manifest omits reviewed runtime package ${packageName}`,
      );
    }
  }
  return reviewed;
}

function mainShellCounts(migrationLock: unknown): { roots: number; formulae: number } {
  const lock = asRecord(migrationLock, "migration lock");
  if (!Array.isArray(lock.packages) || !Array.isArray(lock.formula_closure)) {
    throw new Error("migration lock package counts are unavailable");
  }
  return { roots: lock.packages.length, formulae: lock.formula_closure.length };
}

function assertCompleteBottleTransport(
  events: readonly LazyDownloadEvent[],
  pendingTrees: readonly SerializedLazyArchiveEntry[],
  label: string,
): { bottles: number; bytes: number; urls: string[] } {
  if (events.length === 0) {
    throw new Error(`${label} did not fetch a deferred bottle`);
  }
  const treeByPrimaryUrl = new Map<string, SerializedLazyArchiveEntry>();
  for (const tree of pendingTrees) {
    const content = tree.content;
    if (content === undefined || content.transports.length === 0) {
      throw new Error(`pending tree ${tree.mountPrefix} has no bottle transport`);
    }
    const primaryUrl = content.transports[0]!;
    if (treeByPrimaryUrl.has(primaryUrl)) {
      throw new Error(`multiple pending bottle trees use ${primaryUrl}`);
    }
    treeByPrimaryUrl.set(primaryUrl, tree);
  }

  const eventsById = new Map<string, LazyDownloadEvent[]>();
  for (const event of events) {
    const tree = treeByPrimaryUrl.get(event.url);
    if (tree === undefined) {
      throw new Error(`${label} used an unreviewed lazy URL: ${event.url}`);
    }
    const content = tree.content!;
    if (event.kind !== "tree" || event.mountPrefix !== tree.mountPrefix) {
      throw new Error(
        `${label} transport ${event.id} does not match its registered bottle tree`,
      );
    }
    if (event.totalBytes !== content.bytes) {
      throw new Error(
        `${label} transport ${event.id} declares ${String(event.totalBytes)} bytes, ` +
          `expected exact bottle size ${content.bytes}`,
      );
    }
    if (event.loadedBytes < 0 || event.loadedBytes > content.bytes) {
      throw new Error(
        `${label} transport ${event.id} loaded invalid byte count ${event.loadedBytes}`,
      );
    }
    const grouped = eventsById.get(event.id) ?? [];
    grouped.push(event);
    eventsById.set(event.id, grouped);
  }

  const completedUrls = new Set<string>();
  let completedBytes = 0;
  for (const [id, grouped] of eventsById) {
    const first = grouped[0]!;
    const tree = treeByPrimaryUrl.get(first.url)!;
    const expectedBytes = tree.content!.bytes;
    if (grouped.some((event) => event.url !== first.url)) {
      throw new Error(`${label} transport ${id} changed URL during one fetch`);
    }
    const started = grouped.filter((event) => event.status === "started");
    const completed = grouped.filter((event) => event.status === "complete");
    const errors = grouped.filter((event) => event.status === "error");
    if (
      started.length !== 1 || completed.length !== 1 || errors.length !== 0 ||
      grouped[0]!.status !== "started" || grouped.at(-1)!.status !== "complete"
    ) {
      throw new Error(
        `${label} transport ${id} must have one start, one completion, and no fallback error`,
      );
    }
    if (started[0]!.loadedBytes !== 0 || completed[0]!.loadedBytes !== expectedBytes) {
      throw new Error(
        `${label} transport ${id} did not retrieve the complete original bottle ` +
          `(${completed[0]!.loadedBytes}/${expectedBytes} bytes)`,
      );
    }
    let previousLoaded = -1;
    for (const event of grouped) {
      if (event.loadedBytes < previousLoaded) {
        throw new Error(`${label} transport ${id} byte progress moved backwards`);
      }
      previousLoaded = event.loadedBytes;
    }
    if (completedUrls.has(first.url)) {
      throw new Error(`${label} fetched bottle ${first.url} more than once`);
    }
    completedUrls.add(first.url);
    completedBytes += expectedBytes;
  }
  return {
    bottles: completedUrls.size,
    bytes: completedBytes,
    urls: [...completedUrls].sort(),
  };
}

function assertRetainedPosixShellAlias(
  fs: MemoryFileSystem,
  migrationLock: unknown,
  guestManifest: unknown,
): { executablePath: string } {
  const lock = asRecord(migrationLock, "migration lock");
  const compatibility = asRecord(lock.compatibility, "migration lock compatibility");
  if (!Array.isArray(compatibility.aliases)) {
    throw new Error("migration lock compatibility aliases are missing");
  }
  const matches = compatibility.aliases.filter((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.targets)) return false;
    return entry.targets.includes("/bin/sh");
  });
  if (matches.length !== 1) {
    throw new Error(`migration lock declares ${matches.length} /bin/sh aliases, expected one`);
  }
  const alias = matches[0]! as Record<string, unknown>;
  const packageName = "kandelo-dev/tap-core/dash";
  if (
    alias.package !== packageName || alias.source_kind !== "link" ||
    alias.source !== "bin/dash"
  ) {
    throw new Error("migration lock /bin/sh alias is not the reviewed Dash link");
  }

  const guest = asRecord(guestManifest, "guest Homebrew manifest");
  if (!Array.isArray(guest.packages)) {
    throw new Error("guest Homebrew manifest packages are missing");
  }
  const packages = guest.packages.filter(
    (entry) => isRecord(entry) && entry.full_name === packageName,
  );
  if (packages.length !== 1) {
    throw new Error(`guest Homebrew manifest has ${packages.length} Dash packages, expected one`);
  }
  const prefix = packages[0]!.prefix;
  if (typeof prefix !== "string" || !prefix.startsWith("/")) {
    throw new Error("guest Dash package prefix is invalid");
  }
  const expectedAliasTarget = posix.join(prefix, "bin/dash");
  const aliasStat = fs.lstat("/bin/sh");
  if ((aliasStat.mode & 0xf000) !== 0xa000) {
    throw new Error("/bin/sh is not the reviewed compatibility symlink");
  }
  if (fs.readlink("/bin/sh") !== expectedAliasTarget) {
    throw new Error(`/bin/sh does not target ${expectedAliasTarget}`);
  }
  const executablePath = resolveVfsSymlinkPath(fs, "/bin/sh");
  if (!executablePath.startsWith(`${prefix}/`)) {
    throw new Error(`resolved /bin/sh executable escapes the Dash prefix: ${executablePath}`);
  }
  return { executablePath };
}

function resolveVfsSymlinkPath(fs: MemoryFileSystem, path: string): string {
  let current = posix.normalize(path);
  for (let depth = 0; depth < 32; depth += 1) {
    const stat = fs.lstat(current);
    if ((stat.mode & 0xf000) !== 0xa000) return current;
    const target = fs.readlink(current);
    current = target.startsWith("/")
      ? posix.normalize(target)
      : posix.normalize(posix.join(posix.dirname(current), target));
  }
  throw new Error(`symlink chain for ${path} exceeds 32 links`);
}

async function spawnWithTimeout(
  host: NodeKernelHost,
  programBytes: Uint8Array,
  argv: string[],
  label: string,
  output: () => { stdout: string; stderr: string },
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitPromise = host.spawn(toArrayBuffer(programBytes), argv, {
      env: [
        "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
        "HOME=/home/user",
        "USER=user",
        "TMPDIR=/tmp",
      ],
      cwd: "/home/user",
      uid: 1000,
      gid: 1000,
      stdin: new Uint8Array(),
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out after 120 seconds`)),
        120_000,
      );
    });
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    if (exitCode !== 0) {
      const captured = output();
      throw new Error(
        `${label} exited ${exitCode}; stdout=${JSON.stringify(captured.stdout)} ` +
          `stderr=${JSON.stringify(captured.stderr)}`,
      );
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parseArgs(args: string[]): {
  imagePath: string;
  migrationLockPath: string;
  demoConfigPath: string;
  transportMode: "closed" | "public";
  bottleMirrorPlanPath?: string;
} {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--image",
    "--migration-lock",
    "--demo-config",
    "--transport-mode",
    "--bottle-mirror-plan",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined || value === undefined || !allowed.has(option) ||
      values.has(option)
    ) {
      return smokeUsage();
    }
    values.set(option, value);
  }
  const image = values.get("--image");
  const migrationLock = values.get("--migration-lock");
  const demoConfig = values.get("--demo-config");
  const mode = values.get("--transport-mode");
  const plan = values.get("--bottle-mirror-plan");
  if (
    !image || !migrationLock || !demoConfig ||
    (mode !== "closed" && mode !== "public") ||
    (mode === "closed" && !plan) ||
    (mode === "public" && plan !== undefined)
  ) {
    return smokeUsage();
  }
  return {
    imagePath: resolve(image),
    migrationLockPath: resolve(migrationLock),
    demoConfigPath: resolve(demoConfig),
    transportMode: mode,
    ...(plan === undefined ? {} : { bottleMirrorPlanPath: resolve(plan) }),
  };
}

function smokeUsage(): never {
    throw new Error(
      "usage: npx tsx scripts/homebrew-main-shell-node-smoke.ts " +
        "--image <main-shell.vfs.zst> --migration-lock <main-shell-migration-lock.json> " +
        "--demo-config <main-shell-demo.json> --transport-mode <closed|public> " +
        "[--bottle-mirror-plan <kandelo-homebrew-bottle-mirror-plan.json>] " +
        "(the plan is required only in closed mode)",
    );
}

function readRuntimeState(
  fs: MemoryFileSystem,
  migrationLock: unknown,
): Array<{
  path: string;
  kind: "directory" | "empty_file" | "text_file";
  mode: number;
  uid: number;
  gid: number;
  contents?: Uint8Array;
}> {
  const lock = migrationLock as {
    compatibility?: { runtime_state?: Array<{ path?: unknown; kind?: unknown }> };
  };
  const declarations = lock.compatibility?.runtime_state;
  if (!Array.isArray(declarations)) {
    throw new Error("migration lock does not declare runtime_state");
  }
  return declarations.map((declaration, index) => {
    if (
      typeof declaration.path !== "string" ||
      (declaration.kind !== "directory" &&
        declaration.kind !== "empty_file" &&
        declaration.kind !== "text_file")
    ) {
      throw new Error(`migration lock runtime_state[${index}] is invalid`);
    }
    const stat = fs.lstat(declaration.path);
    const actualKind = (stat.mode & 0xf000) === 0x4000
      ? "directory"
      : (stat.mode & 0xf000) === 0x8000
      ? declaration.kind === "text_file" ? "text_file" : "empty_file"
      : "unsupported";
    if (actualKind === "unsupported") {
      throw new Error(`${declaration.path} is not a regular file or directory`);
    }
    return {
      path: declaration.path,
      kind: actualKind,
      mode: stat.mode & 0o7777,
      uid: stat.uid,
      gid: stat.gid,
      ...(actualKind === "directory" ? {} : {
        contents: readVfsFile(fs, declaration.path, stat.size),
      }),
    };
  });
}

function readVfsBinary(fs: MemoryFileSystem, path: string): Uint8Array {
  if (fs.isPathDeferred(path)) {
    throw new Error(`${path} is still backed by a deferred bottle`);
  }
  const stat = fs.stat(path);
  if ((stat.mode & 0xf000) !== 0x8000 || (stat.mode & 0o111) === 0) {
    throw new Error(`${path} is not an executable regular file`);
  }
  return readVfsFile(fs, path, stat.size);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

function readVfsFile(fs: MemoryFileSystem, path: string, knownSize?: number): Uint8Array {
  const stat = knownSize === undefined ? fs.stat(path) : undefined;
  const size = knownSize ?? stat!.size;
  if (stat !== undefined && (stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`${path} is not a regular file`);
  }
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(size);
    fs.read(fd, bytes, null, bytes.length);
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
