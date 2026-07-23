#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
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
  homebrewBootstrapSpecPath,
  homebrewBootstrapArchivePath,
  homebrewBootstrapEnvPath,
  homebrewBootstrapState,
  demoConfigPath,
  transportMode,
  bottleMirrorPlanPath,
} = parseArgs(process.argv.slice(2));
const BASE_EXPECTED_FETCHED_PACKAGES = [
  "kandelo-dev/tap-core/dash",
  "kandelo-dev/tap-core/git",
  "kandelo-dev/tap-core/nethack",
] as const;
const BREW_EXPECTED_FETCHED_PACKAGES = [
  "kandelo-dev/tap-core/coreutils",
  "kandelo-dev/tap-core/posix-utils-lite",
  "kandelo-dev/tap-core/ruby",
  "kandelo-dev/tap-core/zlib",
] as const;
const LANGUAGE_PACKAGE_NAMES = new Set(
  MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS.map(({ packageName }) => packageName),
);
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
if (fs.isPathDeferred(shellConfig.path)) {
  throw new Error(
    `image-owned default shell remains deferred: ${shellConfig.path}`,
  );
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
        ...loadBottleMirrorBindings(
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
await proveLanguageIsolationOnFreshHost({
  imageBytes,
  shellBytes,
  homebrewBootstrapState,
  homebrewBootstrapLazyBase,
  homebrewBootstrapTransportUrl,
  closedLazyAssets,
  pendingTrees,
  mirrorPlan,
  guestManifest,
});
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

  assertNoTransportForUrl(
    lazyDownloads,
    homebrewBootstrapTransportUrl,
    "kernel initialization and non-brew shell commands",
  );

  const brewEventStart = lazyDownloads.length;
  const brewStdoutStart = stdout.length;
  const brewStderrStart = stderr.length;
  const brewCommand = `
set -eu
test -x /usr/bin/brew
brew_version="$(/usr/bin/brew --version 2>&1)"
case "$brew_version" in
  "Homebrew "*) ;;
  *) printf 'unexpected brew version: %s\n' "$brew_version" >&2; exit 1 ;;
esac
test "$(/usr/bin/brew --prefix 2>&1)" = /home/linuxbrew/.linuxbrew
test "$(/usr/bin/brew --repository 2>&1)" = /home/linuxbrew/.linuxbrew
test "$(/usr/bin/brew --cellar 2>&1)" = /home/linuxbrew/.linuxbrew/Cellar
test "$(/usr/bin/brew --cache 2>&1)" = /home/user/.cache/Homebrew
mkdir -p /home/linuxbrew/.linuxbrew/etc/homebrew /home/user/.homebrew
printf 'HOMEBREW_KANDELO_BOTTLE_TAG=wasm64_kandelo\n' > /home/linuxbrew/.linuxbrew/etc/homebrew/brew.env
printf 'HOMEBREW_KANDELO_BOTTLE_TAG=wasm64_kandelo\n' > /home/user/.homebrew/brew.env
test "$(/usr/bin/brew ruby -e 'print ENV.fetch("HOMEBREW_KANDELO_BOTTLE_TAG")' 2>&1)" = wasm32_kandelo
printf 'homebrew-ordinary-brew-ok\n'
`.trim();
  await spawnWithTimeout(
    host,
    shellBytes,
    [shellConfig.argv[0], "-c", brewCommand],
    "ordinary upstream Homebrew phase",
    () => ({
      stdout: stdout.slice(brewStdoutStart),
      stderr: stderr.slice(brewStderrStart),
    }),
  );
  const brewStdout = stdout.slice(brewStdoutStart);
  const brewStderr = stderr.slice(brewStderrStart);
  if (brewStdout !== "homebrew-ordinary-brew-ok\n" || brewStderr !== "") {
    throw new Error(
      `ordinary Homebrew command returned unexpected output; ` +
        `stdout=${JSON.stringify(brewStdout)} stderr=${JSON.stringify(brewStderr)}`,
    );
  }
  const brewEvents = lazyDownloads.slice(brewEventStart);
  assertHomebrewBootstrapTransport(
    brewEvents,
    homebrewBootstrapTree,
    homebrewBootstrapTransportUrl,
    homebrewBootstrapState,
  );
  assertFetchedPackageSet(
    withoutTransportUrl(brewEvents, homebrewBootstrapTransportUrl),
    pendingTrees,
    mirrorPlan,
    BREW_EXPECTED_FETCHED_PACKAGES,
    "ordinary upstream Homebrew first use",
  );

  const repeatBrewEventStart = lazyDownloads.length;
  const repeatBrewStdoutStart = stdout.length;
  const repeatBrewStderrStart = stderr.length;
  await spawnWithTimeout(
    host,
    shellBytes,
    [shellConfig.argv[0], "-c", "/usr/bin/brew --prefix"],
    "ordinary upstream Homebrew repeat phase",
    () => ({
      stdout: stdout.slice(repeatBrewStdoutStart),
      stderr: stderr.slice(repeatBrewStderrStart),
    }),
  );
  const repeatBrewStdout = stdout.slice(repeatBrewStdoutStart);
  const repeatBrewStderr = stderr.slice(repeatBrewStderrStart);
  if (
    repeatBrewStdout !== "/home/linuxbrew/.linuxbrew\n" ||
    repeatBrewStderr !== ""
  ) {
    throw new Error(
      `repeated ordinary Homebrew command returned unexpected output; ` +
        `stdout=${JSON.stringify(repeatBrewStdout)} ` +
        `stderr=${JSON.stringify(repeatBrewStderr)}`,
    );
  }
  assertNoLazyTransport(
    lazyDownloads.slice(repeatBrewEventStart),
    "repeated ordinary Homebrew use",
  );

  const transportEvidence = assertBottleTransportEvents(
    withoutTransportUrl(lazyDownloads, homebrewBootstrapTransportUrl),
    pendingTrees,
    mirrorPlan,
    guestManifest,
  );
  const counts = mainShellCounts(migrationLock);
  console.log(
    `Homebrew main-shell Node smoke: exact ${counts.roots}-root/` +
      `${counts.formulae}-Formula archive, image-owned ` +
      "offline Bash, retained /bin/sh, metadata/runtime state, /dev/null, and " +
      "ordinary brew plus isolated Python/Perl/Erlang/Ruby first use passed " +
      `(${transportEvidence.bottles} bottles, ` +
      `${transportEvidence.bytes} bytes).`,
  );
} finally {
  await host.destroy().catch(() => {});
}

async function proveLanguageIsolationOnFreshHost(options: {
  imageBytes: Uint8Array;
  shellBytes: Uint8Array;
  homebrewBootstrapState: "deferred" | "materialized";
  homebrewBootstrapLazyBase: string;
  homebrewBootstrapTransportUrl: string;
  closedLazyAssets: readonly ClosedLazyAsset[] | undefined;
  pendingTrees: readonly SerializedLazyArchiveEntry[];
  mirrorPlan: HomebrewBottleMirrorPlan;
  guestManifest: unknown;
}): Promise<void> {
  let stdout = "";
  let stderr = "";
  const lazyDownloads: LazyDownloadEvent[] = [];
  const host = new NodeKernelHost({
    maxWorkers: 8,
    rootfsImage: options.imageBytes,
    ...(options.homebrewBootstrapState === "deferred"
      ? { rootfsLazyUrlBase: options.homebrewBootstrapLazyBase }
      : {}),
    rootfsLazyAssets: options.closedLazyAssets,
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
    // WHY: brew itself starts the bottled Ruby runtime. A separate pristine
    // machine keeps the language proof independent while the primary machine
    // remains a truthful brew-first proof with Ruby still deferred.
    for (const invocation of MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS) {
      const eventStart = lazyDownloads.length;
      const stdoutStart = stdout.length;
      const stderrStart = stderr.length;
      await spawnWithTimeout(
        host,
        options.shellBytes,
        invocation.argv,
        invocation.label,
        () => ({
          stdout: stdout.slice(stdoutStart),
          stderr: stderr.slice(stderrStart),
        }),
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
        invocation.launcherPackages,
        lazyDownloads.slice(eventStart),
        options.pendingTrees,
        options.mirrorPlan,
        options.guestManifest,
        invocation.label,
      );
    }
    assertNoTransportForUrl(
      lazyDownloads,
      options.homebrewBootstrapTransportUrl,
      "fresh-machine language commands",
    );
  } finally {
    await host.destroy().catch(() => {});
  }
}

function loadBottleMirrorBindings(
  planPath: string,
  embeddedManifestBytes: Uint8Array,
  pendingTrees: readonly SerializedLazyArchiveEntry[],
): ClosedLazyAsset[] {
  const planStat = lstatSync(planPath);
  if (!planStat.isFile() || planStat.isSymbolicLink()) {
    throw new Error(
      `bottle mirror plan is not a regular non-symlink file: ${planPath}`,
    );
  }
  const manifestBytes = new Uint8Array(readFileSync(planPath));
  if (
    manifestBytes.byteLength !== embeddedManifestBytes.byteLength ||
    !manifestBytes.every((byte, index) => byte === embeddedManifestBytes[index])
  ) {
    throw new Error(
      "closed bottle mirror plan differs from the exact VFS-embedded plan",
    );
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
    throw new Error(
      "bottle mirror plan filename differs from its declared asset name",
    );
  }

  const mirrorDir = dirname(planPath);
  const payloads = decoded.assets.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.package !== "string" ||
      typeof value.asset !== "string" ||
      typeof value.sha256 !== "string"
    ) {
      throw new Error(
        `bottle mirror asset ${index} has invalid identity fields`,
      );
    }
    if (
      value.asset === "." ||
      value.asset === ".." ||
      basename(value.asset) !== value.asset
    ) {
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
  const payloadByPackage = new Map(
    payloads.map((payload) => [payload.package, payload]),
  );
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
    const asset =
      primaryUrl === undefined ? undefined : assetByUrl.get(primaryUrl);
    if (
      content === undefined ||
      asset === undefined ||
      content.sha256 !== asset.sha256 ||
      content.bytes !== asset.bytes
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
    throw new Error(
      "pending trees do not cover the complete bottle mirror plan",
    );
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
  state: "deferred" | "materialized",
): void {
  const matching = events.filter((event) => event.url === url);
  if (state === "materialized") {
    if (matching.length !== 0) {
      throw new Error(
        "eager Homebrew source tree unexpectedly used lazy transport",
      );
    }
    return;
  }
  if (matching.length === 0) {
    throw new Error(
      "first brew use did not fetch the deferred Homebrew source tree",
    );
  }
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
    matching[0]!.status !== "started" ||
    matching.at(-1)!.status !== "complete" ||
    started[0]!.loadedBytes !== 0 ||
    completed[0]!.loadedBytes !== expectedBytes ||
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
      "first brew use did not retrieve the complete Homebrew source package exactly once",
    );
  }
  let previousLoaded = -1;
  for (const event of matching) {
    if (event.loadedBytes < previousLoaded) {
      throw new Error("Homebrew source-tree download progress moved backwards");
    }
    previousLoaded = event.loadedBytes;
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
    ...BREW_EXPECTED_FETCHED_PACKAGES,
    ...MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS.map(
      ({ packageName }) => packageName,
    ),
  ];
  const missing = requiredPackages.filter(
    (name) => !fetchedPackages.includes(name),
  );
  if (missing.length !== 0) {
    throw new Error(
      `main-shell smoke did not fetch required bottles ${JSON.stringify(missing)}; ` +
        `fetched ${JSON.stringify(fetchedPackages)}`,
    );
  }
  const allowedPackages = new Set<string>([
    ...BASE_EXPECTED_FETCHED_PACKAGES,
    ...BREW_EXPECTED_FETCHED_PACKAGES,
  ]);
  for (const {
    packageName,
    dependencyPackages,
  } of MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS) {
    for (const dependency of reviewedPackageClosure(
      guestManifest,
      packageName,
      dependencyPackages,
    )) {
      allowedPackages.add(dependency);
    }
  }
  const unexpected = fetchedPackages.filter(
    (name) => !allowedPackages.has(name),
  );
  if (unexpected.length !== 0) {
    throw new Error(
      `main-shell smoke fetched bottles outside its reviewed runtime closures: ` +
        JSON.stringify(unexpected),
    );
  }
  const fetchedUrls = new Set(evidence.urls);
  const remaining = plan.assets.filter((asset) => !fetchedUrls.has(asset.url));
  if (remaining.length === 0) {
    throw new Error(
      "main-shell smoke unexpectedly materialized every deferred bottle",
    );
  }
  const initiallyPendingUrls = new Set(
    pendingTrees.map((tree) => tree.content!.transports[0]!),
  );
  if (remaining.some((asset) => !initiallyPendingUrls.has(asset.url))) {
    throw new Error(
      "main-shell smoke remaining bottle set differs from the initial pending set",
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

function assertLanguageBottleIsolation(
  packageName: string,
  declaredDependencies: readonly string[],
  launcherPackages: readonly string[],
  events: readonly LazyDownloadEvent[],
  pendingTrees: readonly SerializedLazyArchiveEntry[],
  plan: HomebrewBottleMirrorPlan,
  guestManifest: unknown,
  label: string,
): void {
  const evidence = assertCompleteBottleTransport(
    events,
    pendingTrees,
    `${label} first use`,
  );
  const fetchedPackages = packagesForUrls(evidence.urls, plan);
  if (!fetchedPackages.includes(packageName)) {
    throw new Error(
      `${label} did not fetch its own bottle ${packageName}; ` +
        `fetched ${JSON.stringify(fetchedPackages)}`,
    );
  }
  const allowed = reviewedPackageClosure(guestManifest, packageName, [
    ...declaredDependencies,
    ...launcherPackages,
  ]);
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
  const demoConfig = values.get("--demo-config");
  const mode = values.get("--transport-mode");
  const plan = values.get("--bottle-mirror-plan");
  if (
    !image ||
    !migrationLock ||
    !homebrewBootstrapSpec ||
    !homebrewBootstrapArchive ||
    !homebrewBootstrapEnv ||
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
