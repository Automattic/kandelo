#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
  type SerializedLazyArchiveEntry,
} from "../host/src/vfs/memory-fs";
import type { ClosedLazyAsset } from "../host/src/vfs/closed-lazy-assets";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
  type DerivedPackageDeferredZipTree,
} from "../host/src/vfs/package-deferred-tree";
import {
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-vfs-composer";
import {
  assertPendingTreeHomebrewBottleMirrorBinding,
  decodeHomebrewBottleMirrorPlan,
  loadHomebrewBottleMirrorBindings,
} from "./homebrew-closed-lazy-assets";
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
import { parseHomebrewRuntimeSupportContract } from "../host/src/homebrew-runtime-support";

const {
  imagePath,
  migrationLockPath,
  homebrewBootstrapSpecPath,
  homebrewBootstrapArchivePath,
  homebrewBootstrapEnvPath,
  homebrewBootstrapState,
  homebrewRuntimeSupportPath,
  demoConfigPath,
  transportMode,
  bottleMirrorPlanPath,
} = parseArgs(process.argv.slice(2));
if (homebrewBootstrapState !== "deferred") {
  throw new Error(
    "the atomic Homebrew runtime proof requires a deferred bootstrap tree",
  );
}
const runtimeSupport = parseHomebrewRuntimeSupportContract(
  parseJson(
    readRegularFile(
      homebrewRuntimeSupportPath,
      "Homebrew runtime-support contract",
    ),
    homebrewRuntimeSupportPath,
  ),
);
const BASE_EXPECTED_FETCHED_PACKAGES = [
  "kandelo-dev/tap-core/dash",
  "kandelo-dev/tap-core/bzip2",
  "kandelo-dev/tap-core/m4",
] as const;
const RUNTIME_SUPPORT_EXPECTED_PACKAGES = runtimeSupport.additionalFormulaOrder;
const imageBytes = new Uint8Array(readFileSync(imagePath));
const homebrewBootstrapArchiveBytes = readRegularFile(
  homebrewBootstrapArchivePath,
  "Homebrew bootstrap package output",
);
const homebrewBootstrapEnvBytes = readRegularFile(
  homebrewBootstrapEnvPath,
  "Homebrew bootstrap launcher environment",
);
const homebrewBootstrapTree = derivePackageDeferredZipTree(
  parseJson(
    readRegularFile(
      homebrewBootstrapSpecPath,
      "Homebrew bootstrap package-tree spec",
    ),
    homebrewBootstrapSpecPath,
  ),
  homebrewBootstrapArchiveBytes,
);
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
// WHY: the smoke exports lazy state as acceptance evidence, so imported
// atomic seals must be authenticated before the synchronous assertions run.
await fs.verifyImportedLazyAtomicGroupSeals();
assertPackageDeferredZipTreeState(
  fs,
  homebrewBootstrapTree,
  homebrewBootstrapState,
);
assertHomebrewBootstrapTreeMetadata(
  metadata,
  homebrewBootstrapTree,
  homebrewBootstrapState,
);
assertHomebrewBootstrapConsumerContract(
  fs,
  metadata,
  homebrewBootstrapEnvBytes,
);
const migrationLockBytes = new Uint8Array(readFileSync(migrationLockPath));
const migrationLock = parseJson(migrationLockBytes, migrationLockPath);
const demoConfigSource = readVfsFile(fs, KANDELO_DEMO_CONFIG_PATH);
const guestManifest = parseJson(
  readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json"),
  "/etc/kandelo/homebrew-vfs.json",
);
const shellConfig = parseKandeloShellConfig(
  new TextDecoder("utf-8", { fatal: true }).decode(
    readVfsFile(fs, KANDELO_SHELL_CONFIG_PATH),
  ),
);
if (shellConfig === null) {
  throw new Error(`${KANDELO_SHELL_CONFIG_PATH} has an unsupported schema`);
}
assertMainShellImageContract({
  migrationLock,
  migrationLockSha256: createHash("sha256")
    .update(migrationLockBytes)
    .digest("hex"),
  migrationLockBytes: migrationLockBytes.byteLength,
  runtimeSupport,
  guestManifest,
  imageMetadata: metadata,
  imageCapacity: capacity,
  shellConfig,
  demoConfigSource,
  expectedDemoConfigSource: new Uint8Array(readFileSync(demoConfigPath)),
  runtimeState: readRuntimeState(fs, migrationLock),
});
const allPendingTrees = fs
  .exportLazyArchiveEntries()
  .filter((tree) => tree.content !== undefined);
const pendingTrees = allPendingTrees.filter((tree) =>
  tree.activation?.capabilities.some((capability) =>
    capability.startsWith("homebrew-bottle:"),
  ),
);
const pendingBootstrapTrees = allPendingTrees.filter((tree) =>
  tree.activation?.capabilities.includes("homebrew:bootstrap"),
);
const pendingRuntimeSupportTrees = pendingTrees.filter(
  (tree) =>
    tree.activation?.atomicGroup?.id === runtimeSupport.activation.atomicGroup,
);
const unknownPendingTrees = allPendingTrees.filter(
  (tree) =>
    !pendingTrees.includes(tree) && !pendingBootstrapTrees.includes(tree),
);
if (unknownPendingTrees.length !== 0) {
  throw new Error(
    `main-shell image has ${unknownPendingTrees.length} unclassified pending package trees`,
  );
}
if (
  pendingBootstrapTrees.length !==
  (homebrewBootstrapState === "deferred" ? 1 : 0)
) {
  throw new Error(
    `main-shell image has ${pendingBootstrapTrees.length} pending Homebrew source trees; ` +
      `expected ${homebrewBootstrapState === "deferred" ? 1 : 0}`,
  );
}
if (
  pendingRuntimeSupportTrees.length !==
  runtimeSupport.additionalFormulaOrder.length
) {
  throw new Error(
    `main-shell image has ${pendingRuntimeSupportTrees.length} atomic runtime-support ` +
      `trees; expected ${runtimeSupport.additionalFormulaOrder.length}`,
  );
}
if (
  pendingBootstrapTrees.some(
    (tree) =>
      tree.activation?.atomicGroup?.id !==
      runtimeSupport.activation.atomicGroup,
  )
) {
  throw new Error(
    "Homebrew bootstrap and bottle support trees do not share one atomic group",
  );
}
if (fs.isPathDeferred(shellConfig.path)) {
  throw new Error(
    `image-owned default shell remains deferred: ${shellConfig.path}`,
  );
}
const embeddedMirrorPlanBytes = readVfsFile(
  fs,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
);
const mirrorPlan = decodeHomebrewBottleMirrorPlan(
  embeddedMirrorPlanBytes,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
);
if (pendingTrees.length !== mirrorPlan.assets.length) {
  throw new Error(
    `main-shell image has ${pendingTrees.length} pending bottle trees, while its ` +
      `mirror plan declares ${mirrorPlan.assets.length}`,
  );
}
assertPendingTreeHomebrewBottleMirrorBinding(pendingTrees, mirrorPlan);
const runtimeSupportPackages = packagesForUrls(
  pendingRuntimeSupportTrees.map((tree) => tree.content!.transports[0]!),
  mirrorPlan,
);
if (
  JSON.stringify(runtimeSupportPackages) !==
  JSON.stringify([...RUNTIME_SUPPORT_EXPECTED_PACKAGES].sort())
) {
  throw new Error(
    "main-shell atomic runtime-support trees differ from the reviewed contract",
  );
}
const homebrewBootstrapLazyBase =
  transportMode === "closed"
    ? "https://closed.kandelo.invalid/main-shell/"
    : pathToFileURL(`${dirname(homebrewBootstrapArchivePath)}/`).toString();
const homebrewBootstrapTransportUrl = new URL(
  homebrewBootstrapTree.descriptor.archive.url,
  homebrewBootstrapLazyBase,
).toString();
const closedLazyAssets =
  transportMode === "closed"
    ? [
        ...loadHomebrewBottleMirrorBindings(
          bottleMirrorPlanPath!,
          embeddedMirrorPlanBytes,
          pendingTrees,
        ),
        ...(homebrewBootstrapState === "deferred"
          ? [
              {
                url: homebrewBootstrapTransportUrl,
                sha256: homebrewBootstrapTree.descriptor.archive.sha256,
                size: homebrewBootstrapTree.descriptor.archive.bytes,
                bytes: homebrewBootstrapArchiveBytes,
              } satisfies ClosedLazyAsset,
            ]
          : []),
      ]
    : undefined;
const posixShell = assertRetainedPosixShellAlias(
  fs,
  migrationLock,
  guestManifest,
);
const pendingPosixShellTrees = pendingTrees.filter((tree) =>
  tree.entries.some((entry) => entry.vfsPath === posixShell.executablePath),
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
  ...(homebrewBootstrapState === "deferred"
    ? { rootfsLazyUrlBase: homebrewBootstrapLazyBase }
    : {}),
  rootfsLazyAssets: closedLazyAssets,
  onStdout: (_pid, data) => {
    stdout += new TextDecoder().decode(data);
  },
  onStderr: (_pid, data) => {
    stderr += new TextDecoder().decode(data);
  },
  onLazyDownload: (event) => {
    lazyDownloads.push(event);
  },
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
/bin/sh -c 'test -z "\${BASH_VERSION-}" && test -x /bin/bash && test -x /usr/bin/sh && printf "homebrew-posix-paths-ok\\n"'
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

  const bzip2EventStart = lazyDownloads.length;
  const bzip2Command = `
set -eu
# Exercise bzip2's normal file workflow so the proof validates both compression
# and decompression without sending binary output through the machine's PTY.
printf 'mostly-lazy-shell\\n' > /tmp/kandelo-bzip2-smoke
bzip2 -f /tmp/kandelo-bzip2-smoke
bzip2 -d -f /tmp/kandelo-bzip2-smoke.bz2
IFS= read -r bzip2_result < /tmp/kandelo-bzip2-smoke
test "$bzip2_result" = mostly-lazy-shell
printf 'homebrew-bzip2-ok\\n'
`.trim();
  await spawnWithTimeout(
    host,
    shellBytes,
    [shellConfig.argv[0], "-c", bzip2Command],
    "lazy bzip2 phase",
    () => ({ stdout, stderr }),
  );
  if (!stdout.includes("homebrew-bzip2-ok")) {
    throw new Error(
      `Homebrew bzip2 smoke did not reach its marker; stdout=${JSON.stringify(stdout)}`,
    );
  }
  assertFetchedPackageSet(
    lazyDownloads.slice(bzip2EventStart),
    pendingTrees,
    mirrorPlan,
    ["kandelo-dev/tap-core/bzip2"],
    "bzip2 first use",
  );

  const m4EventStart = lazyDownloads.length;
  const m4Command = `
set -eu
test "$(printf 'mostly-lazy-shell\\n' | m4)" = mostly-lazy-shell
printf 'homebrew-m4-ok\\n'
`.trim();
  await spawnWithTimeout(
    host,
    shellBytes,
    [shellConfig.argv[0], "-c", m4Command],
    "lazy m4 phase",
    () => ({ stdout, stderr }),
  );
  if (!stdout.includes("homebrew-m4-ok")) {
    throw new Error(
      `Homebrew m4 smoke did not reach its marker; stdout=${JSON.stringify(stdout)}`,
    );
  }
  assertFetchedPackageSet(
    lazyDownloads.slice(m4EventStart),
    pendingTrees,
    mirrorPlan,
    ["kandelo-dev/tap-core/m4"],
    "m4 first use",
  );

  const repeatEventStart = lazyDownloads.length;
  await spawnWithTimeout(
    host,
    shellBytes,
    [
      shellConfig.argv[0],
      "-c",
      "/bin/sh -c 'printf repeat-dash >/dev/null'; " +
        "printf repeat-bzip2 > /tmp/kandelo-repeat-bzip2; " +
        "bzip2 -f /tmp/kandelo-repeat-bzip2; " +
        "printf 'repeat-m4\\n' | m4 >/dev/null",
    ],
    "repeated lazy base command phase",
    () => ({ stdout, stderr }),
  );
  assertNoLazyTransport(
    lazyDownloads.slice(repeatEventStart),
    "repeated lazy base command use",
  );

  assertNoTransportForUrl(
    lazyDownloads,
    homebrewBootstrapTransportUrl,
    "base shell proof",
  );

  const brewEventStart = lazyDownloads.length;
  const brewStdoutStart = stdout.length;
  const brewStderrStart = stderr.length;
  const brewCommand = `
set -eu
brew_smoke_fail() {
  printf 'homebrew runtime smoke: %s\\n' "$1" >&2
  exit 1
}
test ! -e /usr/bin/file ||
  brew_smoke_fail '/usr/bin/file must remain outside the admitted runtime'
test -x /usr/bin/brew ||
  brew_smoke_fail '/usr/bin/brew is not executable after atomic activation'
brew_version="$(/usr/bin/brew --version 2>&1)" ||
  brew_smoke_fail 'brew --version failed'
case "$brew_version" in
  "Homebrew "*) ;;
  *) brew_smoke_fail "unexpected brew version: $brew_version" ;;
esac
test "$(/usr/bin/brew --prefix 2>&1)" = /home/linuxbrew/.linuxbrew ||
  brew_smoke_fail 'brew --prefix differs from the guest prefix'
test "$(/usr/bin/brew --repository 2>&1)" = /home/linuxbrew/.linuxbrew ||
  brew_smoke_fail 'brew --repository differs from the guest repository'
test "$(/usr/bin/brew --cellar 2>&1)" = /home/linuxbrew/.linuxbrew/Cellar ||
  brew_smoke_fail 'brew --cellar differs from the guest Cellar'
test "$(/usr/bin/brew --cache 2>&1)" = /home/user/.cache/Homebrew ||
  brew_smoke_fail 'brew --cache differs from the guest cache'
# WHY: \`brew ruby\` is a developer command and may query Homebrew's developer
# package API. A temporary stock Bash command observes the same post-brew.env
# process environment without turning this offline smoke into a network test;
# the lifecycle test separately proves that installs use this bottle tag.
probe=/home/linuxbrew/.linuxbrew/Library/Homebrew/cmd/kandelo-env-probe.sh
cat > "$probe" <<'KANDELO_BREW_ENV_PROBE'
homebrew-kandelo-env-probe() {
  printf '%s\n' "$HOMEBREW_KANDELO_BOTTLE_TAG"
}
KANDELO_BREW_ENV_PROBE
brew_tag="$(
/usr/bin/brew kandelo-env-probe 2>&1
)" || brew_smoke_fail "brew environment probe failed: $brew_tag"
rm -f "$probe"
test "$brew_tag" = wasm32_kandelo ||
  brew_smoke_fail "brew returned the wrong Kandelo bottle tag: $brew_tag"
printf 'homebrew-atomic-runtime-ok\n'
`.trim();
  await spawnWithTimeout(
    host,
    shellBytes,
    [shellConfig.argv[0], "-c", brewCommand],
    "atomic Homebrew runtime phase",
    () => ({
      stdout: stdout.slice(brewStdoutStart),
      stderr: stderr.slice(brewStderrStart),
    }),
  );
  const brewStdout = stdout.slice(brewStdoutStart);
  const brewStderr = stderr.slice(brewStderrStart);
  if (brewStdout !== "homebrew-atomic-runtime-ok\n" || brewStderr !== "") {
    throw new Error(
      `atomic Homebrew runtime returned unexpected output; ` +
        `stdout=${JSON.stringify(brewStdout)} stderr=${JSON.stringify(brewStderr)}`,
    );
  }
  const brewEvents = lazyDownloads.slice(brewEventStart);
  assertHomebrewBootstrapTransport(
    brewEvents,
    homebrewBootstrapTree,
    homebrewBootstrapTransportUrl,
  );
  assertFetchedPackageSet(
    withoutTransportUrl(brewEvents, homebrewBootstrapTransportUrl),
    pendingTrees,
    mirrorPlan,
    RUNTIME_SUPPORT_EXPECTED_PACKAGES,
    "atomic Homebrew runtime first use",
  );

  const repeatBrewEventStart = lazyDownloads.length;
  await spawnWithTimeout(
    host,
    shellBytes,
    [shellConfig.argv[0], "-c", "/usr/bin/brew --prefix >/dev/null"],
    "repeated Homebrew runtime phase",
    () => ({ stdout, stderr }),
  );
  assertNoLazyTransport(
    lazyDownloads.slice(repeatBrewEventStart),
    "repeated Homebrew runtime use",
  );

  assertFetchedPackageSet(
    withoutTransportUrl(lazyDownloads, homebrewBootstrapTransportUrl),
    pendingTrees,
    mirrorPlan,
    [...BASE_EXPECTED_FETCHED_PACKAGES, ...RUNTIME_SUPPORT_EXPECTED_PACKAGES],
    "complete lazy shell and Homebrew runtime surface",
  );
  const transportEvidence = assertBottleTransportEvents(
    withoutTransportUrl(lazyDownloads, homebrewBootstrapTransportUrl),
    pendingTrees,
    mirrorPlan,
  );
  const counts = mainShellCounts(migrationLock);
  console.log(
    `Homebrew main-shell Node smoke: exact ${counts.roots}-root/` +
      `${counts.formulae}-Formula archive, image-owned ` +
      "offline Bash, retained lazy /bin/sh, lazy bzip2 and m4, metadata, and " +
      "one atomic Homebrew runtime activation passed " +
      `(${transportEvidence.bottles} bottles, ` +
      `${transportEvidence.bytes} bytes).`,
  );
} finally {
  await host.destroy().catch(() => {});
}

function assertHomebrewBootstrapTreeMetadata(
  metadata: unknown,
  tree: DerivedPackageDeferredZipTree,
  state: "deferred" | "materialized",
): void {
  const imageMetadata = asRecord(metadata, "main-shell image metadata");
  if (!Array.isArray(imageMetadata.packageDeferredTrees)) {
    throw new Error("main-shell image metadata omits packageDeferredTrees");
  }
  const descriptor = tree.descriptor;
  const expected = [
    {
      schema: descriptor.schema,
      kind: descriptor.kind,
      id: descriptor.id,
      content_role: descriptor.content_role,
      package: descriptor.package,
      descriptor: {
        sha256: tree.descriptorSha256,
        bytes: tree.descriptorBytes.byteLength,
      },
      archive: {
        output: descriptor.package.output,
        url: descriptor.archive.url,
        sha256: descriptor.archive.sha256,
        bytes: descriptor.archive.bytes,
        expanded_bytes: descriptor.archive.expanded_bytes,
        source_entry_count: descriptor.archive.source_entry_count,
      },
      mount_prefix: descriptor.mount_prefix,
      owner: descriptor.owner,
      activation: descriptor.activation,
      state,
    },
  ];
  if (
    canonicalJson(imageMetadata.packageDeferredTrees) !==
    canonicalJson(expected)
  ) {
    throw new Error(
      "main-shell package-tree metadata differs from the exact Homebrew package output",
    );
  }
}

function assertHomebrewBootstrapConsumerContract(
  fs: MemoryFileSystem,
  metadata: unknown,
  expectedEnvironment: Uint8Array,
): void {
  const environmentPath = "/etc/homebrew/brew.env";
  const entrypointPath = "/usr/bin/brew";
  const target = "/home/linuxbrew/.linuxbrew/bin/brew";
  const actualEnvironment = readVfsFile(fs, environmentPath);
  if (
    actualEnvironment.byteLength !== expectedEnvironment.byteLength ||
    !actualEnvironment.every(
      (byte, index) => byte === expectedEnvironment[index],
    )
  ) {
    throw new Error(
      "main-shell Homebrew environment differs from its package output",
    );
  }
  const entrypoint = fs.lstat(entrypointPath);
  if (
    (entrypoint.mode & 0xf000) !== 0xa000 ||
    fs.readlink(entrypointPath) !== target
  ) {
    throw new Error(
      "main-shell does not expose the canonical /usr/bin/brew alias",
    );
  }
  assertTreeOwner(fs, "/home/linuxbrew/.linuxbrew", 1000, 1000);
  assertTreeOwner(fs, "/home/user/.cache", 1000, 1000);

  const imageMetadata = asRecord(metadata, "main-shell image metadata");
  const expected = {
    environment: {
      path: environmentPath,
      sha256: createHash("sha256").update(expectedEnvironment).digest("hex"),
      bytes: expectedEnvironment.byteLength,
    },
    entrypoint: { path: entrypointPath, target },
    ownership: {
      prefix: "/home/linuxbrew/.linuxbrew",
      uid: 1000,
      gid: 1000,
      mutable_paths: [
        "/home/linuxbrew/.linuxbrew/Cellar",
        "/home/linuxbrew/.linuxbrew/Library/Taps",
        "/home/linuxbrew/.linuxbrew/var/homebrew/linked",
        "/home/linuxbrew/.linuxbrew/var/homebrew/locks",
        "/home/user/.cache/Homebrew",
      ],
    },
  };
  if (
    canonicalJson(imageMetadata.homebrewBootstrap) !== canonicalJson(expected)
  ) {
    throw new Error("main-shell Homebrew consumer metadata changed");
  }
}

function assertTreeOwner(
  fs: MemoryFileSystem,
  root: string,
  uid: number,
  gid: number,
): void {
  const stat = fs.lstat(root);
  if (stat.uid !== uid || stat.gid !== gid) {
    throw new Error(`main-shell Homebrew path has the wrong owner: ${root}`);
  }
  if ((stat.mode & 0xf000) !== 0x4000) return;
  const handle = fs.opendir(root);
  try {
    for (;;) {
      const entry = fs.readdir(handle);
      if (entry === null) break;
      if (entry.name === "." || entry.name === "..") continue;
      assertTreeOwner(
        fs,
        root === "/" ? `/${entry.name}` : `${root}/${entry.name}`,
        uid,
        gid,
      );
    }
  } finally {
    fs.closedir(handle);
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

function assertNoTransportForUrl(
  events: readonly LazyDownloadEvent[],
  url: string,
  label: string,
): void {
  const event = events.find((candidate) => candidate.url === url);
  if (event !== undefined) {
    throw new Error(
      `${label} unexpectedly fetched the Homebrew source tree from ${url}`,
    );
  }
}

function withoutTransportUrl(
  events: readonly LazyDownloadEvent[],
  url: string,
): LazyDownloadEvent[] {
  return events.filter((event) => event.url !== url);
}

function assertHomebrewBootstrapTransport(
  events: readonly LazyDownloadEvent[],
  tree: DerivedPackageDeferredZipTree,
  url: string,
): void {
  const matching = events.filter((event) => event.url === url);
  const ids = new Set(matching.map((event) => event.id));
  const started = matching.filter((event) => event.status === "started");
  const completed = matching.filter((event) => event.status === "complete");
  const errors = matching.filter((event) => event.status === "error");
  const expectedBytes = tree.descriptor.archive.bytes;
  if (
    ids.size !== 1 ||
    started.length !== 1 ||
    completed.length !== 1 ||
    errors.length !== 0 ||
    matching[0]?.status !== "started" ||
    matching.at(-1)?.status !== "complete" ||
    started[0]?.loadedBytes !== 0 ||
    completed[0]?.loadedBytes !== expectedBytes ||
    matching.some(
      (event) =>
        event.kind !== "tree" ||
        event.mountPrefix !== tree.descriptor.mount_prefix ||
        event.totalBytes !== expectedBytes ||
        event.loadedBytes < 0 ||
        event.loadedBytes > expectedBytes,
    )
  ) {
    throw new Error(
      "first brew use did not fetch the exact bootstrap tree once",
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
): { bottles: number; bytes: number } {
  const evidence = assertCompleteBottleTransport(
    events,
    pendingTrees,
    "Homebrew main-shell command surface",
  );
  const fetchedPackages = packagesForUrls(evidence.urls, plan);
  const expectedPackages = [
    ...BASE_EXPECTED_FETCHED_PACKAGES,
    ...RUNTIME_SUPPORT_EXPECTED_PACKAGES,
  ].sort();
  if (JSON.stringify(fetchedPackages) !== JSON.stringify(expectedPackages)) {
    throw new Error(
      `main-shell smoke fetched ${JSON.stringify(fetchedPackages)}, expected ` +
        `the exact lazy base ${JSON.stringify(expectedPackages)}`,
    );
  }
  if (evidence.bottles !== pendingTrees.length) {
    throw new Error(
      `main-shell smoke fetched ${evidence.bottles} trees, expected all ` +
        `${pendingTrees.length} reviewed lazy bottle trees`,
    );
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

function packagesForUrls(
  urls: readonly string[],
  plan: HomebrewBottleMirrorPlan,
): string[] {
  const packageByUrl = new Map(
    plan.assets.map((asset) => [asset.url, asset.package]),
  );
  return urls
    .map((url) => {
      const packageName = packageByUrl.get(url);
      if (packageName === undefined) {
        throw new Error(
          `completed bottle URL is absent from the mirror plan: ${url}`,
        );
      }
      return packageName;
    })
    .sort();
}

function mainShellCounts(migrationLock: unknown): {
  roots: number;
  formulae: number;
} {
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
      throw new Error(
        `pending tree ${tree.mountPrefix} has no bottle transport`,
      );
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
      started.length !== 1 ||
      completed.length !== 1 ||
      errors.length !== 0 ||
      grouped[0]!.status !== "started" ||
      grouped.at(-1)!.status !== "complete"
    ) {
      throw new Error(
        `${label} transport ${id} must have one start, one completion, and no fallback error`,
      );
    }
    if (
      started[0]!.loadedBytes !== 0 ||
      completed[0]!.loadedBytes !== expectedBytes
    ) {
      throw new Error(
        `${label} transport ${id} did not retrieve the complete original bottle ` +
          `(${completed[0]!.loadedBytes}/${expectedBytes} bytes)`,
      );
    }
    let previousLoaded = -1;
    for (const event of grouped) {
      if (event.loadedBytes < previousLoaded) {
        throw new Error(
          `${label} transport ${id} byte progress moved backwards`,
        );
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
  const compatibility = asRecord(
    lock.compatibility,
    "migration lock compatibility",
  );
  if (!Array.isArray(compatibility.aliases)) {
    throw new Error("migration lock compatibility aliases are missing");
  }
  const matches = compatibility.aliases.filter((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.targets)) return false;
    return entry.targets.includes("/bin/sh");
  });
  if (matches.length !== 1) {
    throw new Error(
      `migration lock declares ${matches.length} /bin/sh aliases, expected one`,
    );
  }
  const alias = matches[0]! as Record<string, unknown>;
  const packageName = "kandelo-dev/tap-core/dash";
  if (
    alias.package !== packageName ||
    alias.source_kind !== "link" ||
    alias.source !== "bin/dash"
  ) {
    throw new Error(
      "migration lock /bin/sh alias is not the reviewed Dash link",
    );
  }

  const guest = asRecord(guestManifest, "guest Homebrew manifest");
  if (!Array.isArray(guest.packages)) {
    throw new Error("guest Homebrew manifest packages are missing");
  }
  const packages = guest.packages.filter(
    (entry) => isRecord(entry) && entry.full_name === packageName,
  );
  if (packages.length !== 1) {
    throw new Error(
      `guest Homebrew manifest has ${packages.length} Dash packages, expected one`,
    );
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
    throw new Error(
      `resolved /bin/sh executable escapes the Dash prefix: ${executablePath}`,
    );
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
  homebrewBootstrapSpecPath: string;
  homebrewBootstrapArchivePath: string;
  homebrewBootstrapEnvPath: string;
  homebrewBootstrapState: "deferred" | "materialized";
  homebrewRuntimeSupportPath: string;
  demoConfigPath: string;
  transportMode: "closed" | "public";
  bottleMirrorPlanPath?: string;
} {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--image",
    "--migration-lock",
    "--homebrew-bootstrap-spec",
    "--homebrew-bootstrap-archive",
    "--homebrew-bootstrap-env",
    "--homebrew-bootstrap-state",
    "--homebrew-runtime-support",
    "--demo-config",
    "--transport-mode",
    "--bottle-mirror-plan",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !allowed.has(option) ||
      values.has(option)
    ) {
      return smokeUsage();
    }
    values.set(option, value);
  }
  const image = values.get("--image");
  const migrationLock = values.get("--migration-lock");
  const homebrewBootstrapSpec = values.get("--homebrew-bootstrap-spec");
  const homebrewBootstrapArchive = values.get("--homebrew-bootstrap-archive");
  const homebrewBootstrapEnv = values.get("--homebrew-bootstrap-env");
  const homebrewBootstrapState = values.get("--homebrew-bootstrap-state");
  const homebrewRuntimeSupport = values.get("--homebrew-runtime-support");
  const demoConfig = values.get("--demo-config");
  const mode = values.get("--transport-mode");
  const plan = values.get("--bottle-mirror-plan");
  if (
    !image ||
    !migrationLock ||
    !homebrewBootstrapSpec ||
    !homebrewBootstrapArchive ||
    !homebrewBootstrapEnv ||
    !homebrewRuntimeSupport ||
    !demoConfig ||
    (homebrewBootstrapState !== "deferred" &&
      homebrewBootstrapState !== "materialized") ||
    (mode !== "closed" && mode !== "public") ||
    (mode === "closed" && !plan) ||
    (mode === "public" && plan !== undefined)
  ) {
    return smokeUsage();
  }
  return {
    imagePath: resolve(image),
    migrationLockPath: resolve(migrationLock),
    homebrewBootstrapSpecPath: resolve(homebrewBootstrapSpec),
    homebrewBootstrapArchivePath: resolve(homebrewBootstrapArchive),
    homebrewBootstrapEnvPath: resolve(homebrewBootstrapEnv),
    homebrewBootstrapState,
    homebrewRuntimeSupportPath: resolve(homebrewRuntimeSupport),
    demoConfigPath: resolve(demoConfig),
    transportMode: mode,
    ...(plan === undefined ? {} : { bottleMirrorPlanPath: resolve(plan) }),
  };
}

function smokeUsage(): never {
  throw new Error(
    "usage: npx tsx scripts/homebrew-main-shell-node-smoke.ts " +
      "--image <main-shell.vfs.zst> --migration-lock <main-shell-migration-lock.json> " +
      "--homebrew-bootstrap-spec <main-shell-brew-package-tree.json> " +
      "--homebrew-bootstrap-archive <homebrew-bootstrap.zip> " +
      "--homebrew-bootstrap-env <homebrew-brew.env> " +
      "--homebrew-bootstrap-state <deferred|materialized> " +
      "--homebrew-runtime-support <runtime-support.json> " +
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
    compatibility?: {
      runtime_state?: Array<{ path?: unknown; kind?: unknown }>;
    };
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
    const actualKind =
      (stat.mode & 0xf000) === 0x4000
        ? "directory"
        : (stat.mode & 0xf000) === 0x8000
          ? declaration.kind === "text_file"
            ? "text_file"
            : "empty_file"
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
      ...(actualKind === "directory"
        ? {}
        : {
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

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!isRecord(candidate)) return candidate;
    return Object.fromEntries(
      Object.keys(candidate)
        .sort()
        .map((key) => [key, normalize(candidate[key])]),
    );
  };
  return JSON.stringify(normalize(value));
}

function readRegularFile(path: string, label: string): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`${label} is not a nonempty regular file: ${path}`);
  }
  return new Uint8Array(readFileSync(path));
}

function readVfsFile(
  fs: MemoryFileSystem,
  path: string,
  knownSize?: number,
): Uint8Array {
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
