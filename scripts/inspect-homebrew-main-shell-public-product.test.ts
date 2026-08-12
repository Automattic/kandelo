import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { zipSync, type Zippable } from "fflate";

import {
  installHomebrewBootstrapConsumerState,
  prepareHomebrewBootstrapConsumerNamespace,
} from "../images/vfs/scripts/build-homebrew-vfs-image";
import { decodeHomebrewBottleMirrorPlan } from "./homebrew-closed-lazy-assets";
import { parseCanonicalHomebrewBottleSelection } from "../host/src/homebrew-bottle-selection";
import {
  deriveFlatLazyCompositionPartition,
  parseHomebrewVfsMaterializationPolicy,
} from "../host/src/homebrew-vfs-materialization-policy";
import { parseHomebrewRuntimeSupportPolicy } from "../host/src/homebrew-runtime-support";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../host/src/vfs/image-helpers";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import {
  derivePackageDeferredZipTree,
  registerPackageDeferredZipTree,
} from "../host/src/vfs/package-deferred-tree";
import {
  HOMEBREW_MAIN_SHELL_PUBLIC_PRODUCT_KIND,
  inspectHomebrewMainShellPublicProduct,
} from "./inspect-homebrew-main-shell-public-product";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const selectionBytes = bytes("../homebrew/main-shell-flat-selection.json");
const materializationPolicyBytes = bytes(
  "../homebrew/main-shell-materialization-policy.json",
);
const runtimeSupportPolicyBytes = bytes(
  "../homebrew/main-shell-runtime-support-policy.json",
);
const checkedMirrorPlanBytes = bytes(
  "../homebrew/main-shell-flat-lazy-mirror-plan.json",
);
const checkedMirrorPlan = decodeHomebrewBottleMirrorPlan(
  checkedMirrorPlanBytes,
  "checked mirror plan",
);
const selection = parseCanonicalHomebrewBottleSelection(selectionBytes);
const materializationPolicy = parseHomebrewVfsMaterializationPolicy(
  JSON.parse(new TextDecoder().decode(materializationPolicyBytes)),
);
const runtimeSupportPolicy = parseHomebrewRuntimeSupportPolicy(
  JSON.parse(new TextDecoder().decode(runtimeSupportPolicyBytes)),
);
const partition = deriveFlatLazyCompositionPartition(
  selection,
  materializationPolicy,
  runtimeSupportPolicy,
);
const bootstrapSpec = JSON.parse(
  new TextDecoder().decode(
    bytes("../homebrew/main-shell-brew-package-tree.json"),
  ),
);
const bootstrapEnvironment = encoder.encode(
  "HOMEBREW_NO_ANALYTICS=1\n" +
    "HOMEBREW_NO_AUTO_UPDATE=1\n" +
    "HOMEBREW_NO_INSTALL_FROM_API=1\n" +
    "HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1\n" +
    "HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1\n" +
    "HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo\n",
);

test("binds the exact 3/1/2/35 lazy shell and checked mirror plan", async () => {
  const fixture = await productFixture();
  const result = await inspectHomebrewMainShellPublicProduct({
    imageBytes: fixture.imageBytes,
    homebrewBootstrapArchiveBytes: fixture.bootstrapArchive,
    homebrewBootstrapSpec: bootstrapSpec,
    selectionBytes,
    materializationPolicyBytes,
    runtimeSupportPolicyBytes,
    checkedMirrorPlanBytes,
  });

  assert.deepEqual(result, {
    schema: 1,
    kind: HOMEBREW_MAIN_SHELL_PUBLIC_PRODUCT_KIND,
    image: {
      sha256: sha256(fixture.imageBytes),
      bytes: fixture.imageBytes.byteLength,
      kernel_abi: 42,
    },
    homebrew_bootstrap: {
      sha256: sha256(fixture.bootstrapArchive),
      bytes: fixture.bootstrapArchive.byteLength,
      activation_root: "/usr/bin/brew",
    },
    partition: {
      embedded_bottles: 3,
      bootstrap_trees: 1,
      runtime_cohort_bottles: 2,
      ordinary_deferred_bottles: 35,
      deferred_bottles: 37,
      initial_pending_trees: 38,
    },
    bottle_mirror: {
      repository: checkedMirrorPlan.repository,
      collection_sha256: checkedMirrorPlan.collection_sha256,
      tag: checkedMirrorPlan.tag,
      plan_url: `${checkedMirrorPlan.release_root}/${checkedMirrorPlan.manifest_asset}`,
      plan_sha256: sha256(checkedMirrorPlanBytes),
      plan_bytes: checkedMirrorPlanBytes.byteLength,
      asset_count: 37,
    },
  });
});

test("CI mirror state admits the exact flat-lazy shell and requires its mirror", async () => {
  const fixture = await productFixture();
  const root = mkdtempSync(join(tmpdir(), "kandelo-flat-lazy-ci-state-"));
  try {
    const image = join(root, "shell.vfs.zst");
    const bootstrap = join(root, "homebrew-bootstrap.zip");
    const expected = join(root, "expected.json");
    const blockers = join(root, "blockers.json");
    const index = join(root, "index.toml");
    const state = join(root, "state.json");
    const xtask = join(root, "xtask");
    const cacheKey = "c".repeat(64);
    writeFileSync(image, fixture.imageBytes);
    writeFileSync(bootstrap, fixture.bootstrapArchive);
    writeFileSync(
      expected,
      `${JSON.stringify({
        abi_version: 42,
        entries: [
          {
            package: "shell",
            arch: "wasm32",
            kind: "program",
            version: "0.1.0",
            revision: 24,
            cache_key_sha: cacheKey,
          },
        ],
      })}\n`,
    );
    writeFileSync(
      blockers,
      `${JSON.stringify({ abi_version: 42, entries: [] })}\n`,
    );
    writeFileSync(index, "abi_version = 42\n");
    writeFileSync(
      xtask,
      "#!/usr/bin/env bash\n" +
        "set -euo pipefail\n" +
        '[ "$1:$2:$3" = index-candidate:current-entry:--canonical-index ]\n' +
        "printf 'false\\n'\n",
    );
    chmodSync(xtask, 0o755);

    const command = join(
      repoRoot,
      "scripts/ci-homebrew-browser-mirror-state.sh",
    );
    const environment = {
      ...process.env,
      WASM_POSIX_XTASK_BIN: xtask,
    };
    await execFileAsync(
      "bash",
      [
        command,
        "create",
        expected,
        blockers,
        index,
        "https://example.invalid/index.toml",
        image,
        bootstrap,
        state,
      ],
      { cwd: repoRoot, env: environment },
    );

    const value = JSON.parse(readFileSync(state, "utf8"));
    assert.equal(value.schema, 3);
    assert.equal(value.mode, "resolved");
    assert.equal(value.transport, "flat-lazy");
    assert.equal(value.mirror_required, true);
    assert.equal(
      value.inspection.kind,
      HOMEBREW_MAIN_SHELL_PUBLIC_PRODUCT_KIND,
    );
    assert.deepEqual(value.inspection.partition, {
      embedded_bottles: 3,
      bootstrap_trees: 1,
      runtime_cohort_bottles: 2,
      ordinary_deferred_bottles: 35,
      deferred_bottles: 37,
      initial_pending_trees: 38,
    });

    await execFileAsync(
      "bash",
      [command, "validate", "producer", state, blockers, image, bootstrap],
      { cwd: repoRoot, env: environment },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects bootstrap bytes that are not the deferred tree in the image", async () => {
  const fixture = await productFixture();
  await assert.rejects(
    () =>
      inspectHomebrewMainShellPublicProduct({
        imageBytes: fixture.imageBytes,
        homebrewBootstrapArchiveBytes: homebrewBootstrapArchive("changed\n"),
        homebrewBootstrapSpec: bootstrapSpec,
        selectionBytes,
        materializationPolicyBytes,
        runtimeSupportPolicyBytes,
        checkedMirrorPlanBytes,
      }),
    /not pending exactly once/,
  );
});

test("rejects an embedded mirror plan that differs from the checked plan", async () => {
  const fixture = await productFixture();
  const changedCheckedPlan = new Uint8Array(
    checkedMirrorPlanBytes.byteLength + 1,
  );
  changedCheckedPlan.set(checkedMirrorPlanBytes);
  changedCheckedPlan[changedCheckedPlan.byteLength - 1] = 0x0a;
  await assert.rejects(
    () =>
      inspectHomebrewMainShellPublicProduct({
        imageBytes: fixture.imageBytes,
        homebrewBootstrapArchiveBytes: fixture.bootstrapArchive,
        homebrewBootstrapSpec: bootstrapSpec,
        selectionBytes,
        materializationPolicyBytes,
        runtimeSupportPolicyBytes,
        checkedMirrorPlanBytes: changedCheckedPlan,
      }),
    /embedded bottle mirror plan differs from the checked plan/,
  );
});

test("rejects flat lazy metadata with the wrong ordinary deferred count", async () => {
  const fixture = await productFixture({ omitOrdinaryBinding: true });
  await assert.rejects(
    () =>
      inspectHomebrewMainShellPublicProduct({
        imageBytes: fixture.imageBytes,
        homebrewBootstrapArchiveBytes: fixture.bootstrapArchive,
        homebrewBootstrapSpec: bootstrapSpec,
        selectionBytes,
        materializationPolicyBytes,
        runtimeSupportPolicyBytes,
        checkedMirrorPlanBytes,
      }),
    /partition differs from the selected 3\/1\/2\/35 product/,
  );
});

test("rejects a flat-lazy shell for a different kernel ABI", async () => {
  const fixture = await productFixture({ kernelAbi: 41 });
  await assert.rejects(
    () =>
      inspectHomebrewMainShellPublicProduct({
        imageBytes: fixture.imageBytes,
        homebrewBootstrapArchiveBytes: fixture.bootstrapArchive,
        homebrewBootstrapSpec: bootstrapSpec,
        selectionBytes,
        materializationPolicyBytes,
        runtimeSupportPolicyBytes,
        checkedMirrorPlanBytes,
      }),
    /declares kernel ABI 41, expected 42/,
  );
});

test("rejects an unclassified deferred package tree", async () => {
  const fixture = await productFixture({ includeUnknownTree: true });
  await assert.rejects(
    () =>
      inspectHomebrewMainShellPublicProduct({
        imageBytes: fixture.imageBytes,
        homebrewBootstrapArchiveBytes: fixture.bootstrapArchive,
        homebrewBootstrapSpec: bootstrapSpec,
        selectionBytes,
        materializationPolicyBytes,
        runtimeSupportPolicyBytes,
        checkedMirrorPlanBytes,
      }),
    /unexpected deferred package-tree inventory/,
  );
});

async function productFixture(options?: {
  embeddedPlan?: typeof checkedMirrorPlan;
  includeUnknownTree?: boolean;
  kernelAbi?: number;
  omitOrdinaryBinding?: boolean;
}): Promise<{ imageBytes: Uint8Array; bootstrapArchive: Uint8Array }> {
  const embeddedPlan = options?.embeddedPlan ?? checkedMirrorPlan;
  const bootstrapArchive = homebrewBootstrapArchive("fixture\n");
  const bootstrap = derivePackageDeferredZipTree(
    bootstrapSpec,
    bootstrapArchive,
  );
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(8 * MiB, { maxByteLength: 32 * MiB }),
    32 * MiB,
  );
  ensureDirRecursive(fs, "/usr/bin");
  prepareHomebrewBootstrapConsumerNamespace(fs, bootstrap);
  registerPackageDeferredZipTree(fs, bootstrap);
  installHomebrewBootstrapConsumerState(fs, bootstrap, bootstrapEnvironment);

  const runtimePackages = new Set(partition.runtimeCohortPackageOrder);
  for (const [index, asset] of embeddedPlan.assets.entries()) {
    const mountPrefix = `/opt/homebrew-fixture/${index}`;
    fs.registerLazyTreeWithMaterializationHandle(
      {
        decoder: "zip-v1",
        mediaType: "application/zip",
        sha256: asset.sha256,
        bytes: asset.bytes,
        expandedBytes: asset.bytes,
        sourceEntryCount: 1,
        transports: [asset.url],
        modePolicy: "portable-posix-v1",
      },
      [
        {
          vfsPath: `${mountPrefix}/bin/tool`,
          sourcePath: "bin/tool",
          type: "file",
          mode: 0o755,
          size: asset.bytes,
          inodeGroup: "tool",
        },
      ],
      mountPrefix,
      {
        mode: "first-use",
        capabilities: [`homebrew-bottle:${asset.id}`],
        roots: [`${mountPrefix}/bin/tool`],
        ...(runtimePackages.has(asset.package)
          ? {
              atomicGroup: {
                id: runtimeSupportPolicy.activation.atomicGroup,
                member: asset.id,
              },
            }
          : {}),
      },
      { uid: 1000, gid: 1000 },
    );
  }
  await fs.sealLazyAtomicGroup(runtimeSupportPolicy.activation.atomicGroup, [
    bootstrap.descriptor.activation.atomicGroup!.member,
    ...embeddedPlan.assets
      .filter((asset) => runtimePackages.has(asset.package))
      .map((asset) => asset.id),
  ]);

  if (options?.includeUnknownTree) {
    fs.registerLazyTreeWithMaterializationHandle(
      {
        decoder: "zip-v1",
        mediaType: "application/zip",
        sha256: "f".repeat(64),
        bytes: 1,
        expandedBytes: 1,
        sourceEntryCount: 1,
        transports: ["unknown.zip"],
        modePolicy: "portable-posix-v1",
      },
      [
        {
          vfsPath: "/opt/unknown/tool",
          sourcePath: "tool",
          type: "file",
          mode: 0o755,
          size: 1,
          inodeGroup: "tool",
        },
      ],
      "/opt/unknown",
      {
        mode: "first-use",
        capabilities: ["fixture:unknown"],
        roots: ["/opt/unknown/tool"],
      },
    );
  }

  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsBinary(
    fs,
    "/etc/kandelo/homebrew-bottle-mirror-plan.json",
    new TextEncoder().encode(`${JSON.stringify(embeddedPlan, null, 2)}\n`),
    0o644,
  );
  fs.setImageMetadata({
    version: 1,
    kernelAbi: options?.kernelAbi ?? 42,
    homebrewFlatLazy: {
      schema: 1,
      kind: "kandelo-homebrew-flat-selection-lazy-v1",
      selection: {
        name: selection.name,
        arch: selection.arch,
        kandeloAbi: selection.kandeloAbi,
        requestedVfsFilename: selection.requestedVfsFilename,
        resourcePolicy: selection.resourcePolicy,
        linkPolicy: selection.linkPolicy,
        runtimeSupport: selection.runtimeSupport,
        sha256: sha256(selectionBytes),
      },
      materializationPolicySha256: sha256(materializationPolicyBytes),
      runtimeSupportPolicySha256: sha256(runtimeSupportPolicyBytes),
      mirror: {
        repository: embeddedPlan.repository,
        tag: embeddedPlan.tag,
        collectionSha256: embeddedPlan.collection_sha256,
        planSha256: sha256(
          new TextEncoder().encode(
            `${JSON.stringify(embeddedPlan, null, 2)}\n`,
          ),
        ),
        planBytes: new TextEncoder().encode(
          `${JSON.stringify(embeddedPlan, null, 2)}\n`,
        ).byteLength,
        assetCount: embeddedPlan.assets.length,
      },
      partition: {
        embeddedPackageOrder: [...partition.embeddedPackageOrder],
        deferredPackageOrder: options?.omitOrdinaryBinding
          ? partition.deferredPackageOrder.slice(1)
          : [...partition.deferredPackageOrder],
        bootstrapPackage: partition.bootstrapPackage,
        runtimeCohortPackageOrder: [...partition.runtimeCohortPackageOrder],
      },
    },
  });
  return { imageBytes: await fs.saveImage(), bootstrapArchive };
}

function bytes(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(relative, import.meta.url)));
}

function homebrewBootstrapArchive(contents: string): Uint8Array {
  return zipSync(
    {
      "bin/": zipEntry(new Uint8Array(), 0o040755),
      "Library/": zipEntry(new Uint8Array(), 0o040755),
      "Library/Homebrew/": zipEntry(new Uint8Array(), 0o040755),
      "Library/Homebrew/global.rb": zipEntry(
        encoder.encode(contents),
        0o100644,
      ),
      "bin/brew": zipEntry(encoder.encode("#!/bin/bash -pu\n"), 0o100755),
    } satisfies Zippable,
    { level: 9 },
  );
}

function zipEntry(bytes: Uint8Array, mode: number): Zippable[string] {
  return [bytes, { os: 3, attrs: (mode << 16) >>> 0 }];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
