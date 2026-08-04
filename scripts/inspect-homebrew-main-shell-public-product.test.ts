import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { zipSync, type Zippable } from "fflate";

import {
  installHomebrewBootstrapConsumerState,
  prepareHomebrewBootstrapConsumerNamespace,
} from "../images/vfs/scripts/build-homebrew-vfs-image";
import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-bottle-mirror-plan";
import { homebrewRuntimeLayerPayloadAsset } from "../host/src/homebrew-runtime-layer-limits";
import { deriveHomebrewPortableRubyTree } from
  "../host/src/homebrew-portable-ruby";
import { parseHomebrewRuntimeSupportContract } from "../host/src/homebrew-runtime-support";
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
const runtimeSupportValue = JSON.parse(
  readFileSync(
    new URL(
      "../homebrew/main-shell-homebrew-runtime-support.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const runtimeSupport = parseHomebrewRuntimeSupportContract(runtimeSupportValue);
const bootstrapSpec = JSON.parse(
  readFileSync(
    new URL("../homebrew/main-shell-brew-package-tree.json", import.meta.url),
    "utf8",
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

test("binds the sealed image, deferred brew source, and public mirror plan", async () => {
  const fixture = await productFixture();
  const result = await inspectHomebrewMainShellPublicProduct({
    imageBytes: fixture.imageBytes,
    homebrewBootstrapArchiveBytes: fixture.bootstrapArchive,
    homebrewPortableRubyArchiveBytes: fixture.portableRubyArchive,
    homebrewBootstrapSpec: bootstrapSpec,
    homebrewRuntimeSupport: runtimeSupportValue,
  });

  assert.deepEqual(result, {
    schema: 1,
    kind: HOMEBREW_MAIN_SHELL_PUBLIC_PRODUCT_KIND,
    image: {
      sha256: sha256(fixture.imageBytes),
      bytes: fixture.imageBytes.byteLength,
    },
    homebrew_bootstrap: {
      sha256: sha256(fixture.bootstrapArchive),
      bytes: fixture.bootstrapArchive.byteLength,
      activation_root: "/usr/bin/brew",
    },
    homebrew_portable_ruby: {
      sha256: sha256(fixture.portableRubyArchive),
      bytes: fixture.portableRubyArchive.byteLength,
    },
    bottle_mirror: {
      repository: runtimeSupport.catalog.tapRepository,
      collection_sha256: fixture.plan.collection_sha256,
      tag: fixture.plan.tag,
      plan_url: `${fixture.plan.release_root}/${fixture.plan.manifest_asset}`,
      plan_sha256: sha256(encodeHomebrewBottleMirrorPlan(fixture.plan)),
      plan_bytes: encodeHomebrewBottleMirrorPlan(fixture.plan).byteLength,
      asset_count: fixture.plan.assets.length,
    },
  });
});

test("rejects bootstrap bytes that are not the deferred tree in the image", async () => {
  const fixture = await productFixture();
  const changedArchive = homebrewBootstrapArchive("changed\n");
  await assert.rejects(
    () =>
      inspectHomebrewMainShellPublicProduct({
        imageBytes: fixture.imageBytes,
        homebrewBootstrapArchiveBytes: changedArchive,
        homebrewPortableRubyArchiveBytes: fixture.portableRubyArchive,
        homebrewBootstrapSpec: bootstrapSpec,
        homebrewRuntimeSupport: runtimeSupportValue,
      }),
    /not pending exactly once/,
  );
});

test("rejects a public mirror outside the runtime-support catalog", async () => {
  const fixture = await productFixture({
    mirrorRepository: "example/homebrew-wrong",
  });
  await assert.rejects(
    () =>
      inspectHomebrewMainShellPublicProduct({
        imageBytes: fixture.imageBytes,
        homebrewBootstrapArchiveBytes: fixture.bootstrapArchive,
        homebrewPortableRubyArchiveBytes: fixture.portableRubyArchive,
        homebrewBootstrapSpec: bootstrapSpec,
        homebrewRuntimeSupport: runtimeSupportValue,
      }),
    /repository differs from the runtime-support catalog/,
  );
});

test("rejects an unclassified deferred package tree", async () => {
  const fixture = await productFixture({ includeUnknownTree: true });
  await assert.rejects(
    () =>
      inspectHomebrewMainShellPublicProduct({
        imageBytes: fixture.imageBytes,
        homebrewBootstrapArchiveBytes: fixture.bootstrapArchive,
        homebrewPortableRubyArchiveBytes: fixture.portableRubyArchive,
        homebrewBootstrapSpec: bootstrapSpec,
        homebrewRuntimeSupport: runtimeSupportValue,
      }),
    /unexpected deferred package-tree inventory/,
  );
});

async function productFixture(options?: {
  mirrorRepository?: string;
  includeUnknownTree?: boolean;
}): Promise<{
  imageBytes: Uint8Array;
  bootstrapArchive: Uint8Array;
  portableRubyArchive: Uint8Array;
  plan: HomebrewBottleMirrorPlan;
}> {
  const repository =
    options?.mirrorRepository ?? runtimeSupport.catalog.tapRepository;
  const bootstrapArchive = homebrewBootstrapArchive("fixture\n");
  const bootstrap = derivePackageDeferredZipTree(
    bootstrapSpec,
    bootstrapArchive,
  );
  const portableRubyArchive = homebrewPortableRubyArchive();
  const portableRuby = deriveHomebrewPortableRubyTree(
    bootstrap,
    bootstrapArchive,
    portableRubyArchive,
  );
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(8 * MiB, { maxByteLength: 32 * MiB }),
    32 * MiB,
  );
  ensureDirRecursive(fs, "/usr/bin");
  prepareHomebrewBootstrapConsumerNamespace(fs, bootstrap);
  registerPackageDeferredZipTree(fs, bootstrap);
  installHomebrewBootstrapConsumerState(fs, bootstrap, bootstrapEnvironment);
  registerPackageDeferredZipTree(fs, portableRuby);

  const identities = runtimeSupport.baseFormulaOrder.map(
    (packageName, index) => {
      const id = `fixture-${String(index).padStart(2, "0")}`;
      const payload = new Uint8Array([index + 1]);
      return {
        id,
        package: packageName,
        asset: homebrewRuntimeLayerPayloadAsset(id),
        sha256: sha256(payload),
        bytes: payload.byteLength,
      };
    },
  );
  const collectionSha256 = sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(repository, identities),
  );
  const tag = `homebrew-shell-bottles-sha256-${collectionSha256}`;
  const releaseRoot = `https://github.com/${repository}/releases/download/${tag}`;
  const plan: HomebrewBottleMirrorPlan = {
    schema: 1,
    kind: "kandelo-homebrew-bottle-mirror-plan",
    repository,
    collection_sha256: collectionSha256,
    tag,
    release_root: releaseRoot,
    manifest_asset: "kandelo-homebrew-bottle-mirror-plan.json",
    assets: identities.map((identity) => ({
      ...identity,
      url: `${releaseRoot}/${identity.asset}`,
    })),
  };

  for (const [index, asset] of plan.assets.entries()) {
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
      },
      { uid: 1000, gid: 1000 },
    );
  }
  await fs.sealLazyAtomicGroup(runtimeSupport.activation.atomicGroup, [
    bootstrap.descriptor.activation.atomicGroup!.member,
    portableRuby.descriptor.activation.atomicGroup!.member,
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
    encodeHomebrewBottleMirrorPlan(plan),
    0o644,
  );
  return {
    imageBytes: await fs.saveImage(),
    bootstrapArchive,
    portableRubyArchive,
    plan,
  };
}

function homebrewBootstrapArchive(contents: string): Uint8Array {
  return zipSync(
    {
      "bin/": zipEntry(new Uint8Array(), 0o040755),
      "Library/": zipEntry(new Uint8Array(), 0o040755),
      "Library/Homebrew/": zipEntry(new Uint8Array(), 0o040755),
      "Library/Homebrew/vendor/": zipEntry(new Uint8Array(), 0o040755),
      "Library/Homebrew/vendor/portable-ruby-version": zipEntry(
        encoder.encode("4.0.5\n"),
        0o100644,
      ),
      "Library/Homebrew/global.rb": zipEntry(
        encoder.encode(contents),
        0o100644,
      ),
      "bin/brew": zipEntry(encoder.encode("#!/bin/bash -pu\n"), 0o100755),
    } satisfies Zippable,
    { level: 9 },
  );
}

function homebrewPortableRubyArchive(): Uint8Array {
  return zipSync(
    {
      "4.0.5/": zipEntry(new Uint8Array(), 0o040755),
      "4.0.5/bin/": zipEntry(new Uint8Array(), 0o040755),
      "4.0.5/bin/ruby": zipEntry(
        encoder.encode("ruby-wasm\n"),
        0o100755,
      ),
      current: zipEntry(encoder.encode("4.0.5"), 0o120777),
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
