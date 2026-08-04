import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { zipSync, type Zippable } from "fflate";

import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  type HomebrewBottleMirrorPlan,
} from "../../host/src/homebrew-bottle-mirror-plan";
import { homebrewRuntimeLayerPayloadAsset } from
  "../../host/src/homebrew-runtime-layer-limits";
import { deriveHomebrewPortableRubyTree } from
  "../../host/src/homebrew-portable-ruby";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import {
  derivePackageDeferredZipTree,
  registerPackageDeferredZipTree,
} from "../../host/src/vfs/package-deferred-tree";
import {
  forgeLazyAtomicSeal,
} from "../../host/test/lazy-atomic-seal-fixture";
import {
  deriveHomebrewGuestLifecycleRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";

const encoder = new TextEncoder();

test("binds verified bootstrap bytes and bottle payloads to one exact image", async () => {
  const coreRevision = "1".repeat(40);
  const bootstrapArchive = zipSync({
    "bin/": zipEntry(new Uint8Array(), 0o040755),
    "bin/brew": zipEntry(encoder.encode("#!/bin/sh\n"), 0o100755),
    "Library/": zipEntry(new Uint8Array(), 0o040755),
    "Library/Homebrew/": zipEntry(new Uint8Array(), 0o040755),
    "Library/Homebrew/vendor/": zipEntry(new Uint8Array(), 0o040755),
    "Library/Homebrew/vendor/portable-ruby-version": zipEntry(
      encoder.encode("4.0.5\n"),
      0o100644,
    ),
  }, { level: 9 });
  const bootstrapSpec = {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: "homebrew-bootstrap/source-tree",
    content_role: "source-tree",
    package: {
      name: "homebrew-bootstrap",
      output: "homebrew-bootstrap.zip",
    },
    archive: {
      url: "homebrew-bootstrap.zip",
      mode_policy: "portable-posix-v1",
    },
    mount_prefix: "/opt/kandelo/homebrew",
    owner: { uid: 1000, gid: 1000 },
    activation: {
      mode: "first-use",
      capabilities: ["homebrew:bootstrap", "homebrew:runtime"],
      roots: ["/opt/kandelo/homebrew/bin/brew"],
      atomic_group: "homebrew-runtime-support",
    },
  } as const;
  const bootstrapTree = derivePackageDeferredZipTree(
    bootstrapSpec,
    bootstrapArchive,
  );
  const portableRubyArchive = zipSync({
    "4.0.5/": zipEntry(new Uint8Array(), 0o040755),
    "4.0.5/bin/": zipEntry(new Uint8Array(), 0o040755),
    "4.0.5/bin/ruby": zipEntry(encoder.encode("ruby-wasm\n"), 0o100755),
    current: zipEntry(encoder.encode("4.0.5"), 0o120777),
  }, { level: 9 });
  const portableRubyTree = deriveHomebrewPortableRubyTree(
    bootstrapTree,
    bootstrapArchive,
    portableRubyArchive,
  );
  const bottleBytes = new Uint8Array([42]);
  const mirror = createMirrorPlan(bottleBytes);
  const mirrorBytes = encodeHomebrewBottleMirrorPlan(mirror);
  const environmentBytes = encoder.encode(
    "HOMEBREW_SYSTEM=Kandelo\nHOMEBREW_PROCESSOR=wasm32\n",
  );

  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(32 * 1024 * 1024),
  );
  for (const path of [
    "/etc",
    "/etc/kandelo",
    "/etc/homebrew",
    "/bin",
    "/home",
    "/home/user",
    "/opt",
    "/opt/kandelo",
    "/opt/kandelo/homebrew",
    "/bottle",
  ]) {
    fs.mkdir(path, 0o755);
  }
  fs.chown("/home/user", 1000, 1000);
  fs.chown("/opt/kandelo/homebrew", 1000, 1000);
  assert.deepEqual(
    ["/home", "/opt", "/opt/kandelo"].map((path) => {
      const stat = fs.stat(path);
      return [stat.uid, stat.gid];
    }),
    [[0, 0], [0, 0], [0, 0]],
  );
  writeFile(fs, "/bin/bash", new Uint8Array([0, 97, 115, 109]), 0o755);
  writeFile(
    fs,
    "/etc/kandelo/shell.json",
    encoder.encode(JSON.stringify({
      version: 1,
      path: "/bin/bash",
      argv: ["bash", "-l", "-i"],
    })),
  );
  writeFile(fs, "/etc/homebrew/brew.env", environmentBytes);
  writeFile(
    fs,
    "/etc/kandelo/homebrew-vfs.json",
    encoder.encode(JSON.stringify({
      schema: 1,
      catalog: {
        tap_repository: "kandelo-dev/homebrew-tap-core",
        tap_name: "kandelo-dev/tap-core",
        checkout_commit: coreRevision,
      },
    })),
  );
  writeFile(fs, HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH, mirrorBytes);
  registerPackageDeferredZipTree(fs, bootstrapTree);
  registerPackageDeferredZipTree(fs, portableRubyTree);
  fs.registerLazyTree(
    {
      decoder: "zip-v1",
      mediaType: "application/zip",
      sha256: sha256(bottleBytes),
      bytes: bottleBytes.byteLength,
      expandedBytes: 1,
      sourceEntryCount: 1,
      transports: [mirror.assets[0]!.url],
      modePolicy: "portable-posix-v1",
    },
    [{
      vfsPath: "/bottle/tool",
      sourcePath: "tool",
      type: "file",
      mode: 0o755,
      size: 1,
      inodeGroup: "bottle:tool",
    }],
    "/bottle",
    {
      mode: "first-use",
      capabilities: ["homebrew-bottle:bottle-test"],
      roots: ["/bottle/tool"],
      atomicGroup: {
        id: "homebrew-runtime-support",
        member: "bottle-test",
      },
    },
    { uid: 1000, gid: 1000 },
  );
  await fs.sealLazyAtomicGroup("homebrew-runtime-support", [
    bootstrapTree.descriptor.id,
    "bottle-test",
    portableRubyTree.descriptor.id,
  ]);

  const imageBytes = await fs.saveImage();
  const commonRuntimeInputs = {
    bootstrapSpecBytes: encoder.encode(JSON.stringify(bootstrapSpec)),
    bootstrapArchiveBytes: bootstrapArchive,
    bootstrapArchiveSha256: sha256(bootstrapArchive),
    portableRubyArchiveBytes: portableRubyArchive,
    portableRubyArchiveSha256: sha256(portableRubyArchive),
    bootstrapEnvironmentBytes: environmentBytes,
    coreRevision,
    transportMode: "closed" as const,
    lazyUrlBase: "https://closed.kandelo.invalid/lifecycle/",
    expectedEmbeddedBottlePlanBytes: mirrorBytes,
  };
  let validatedMirror: HomebrewBottleMirrorPlan | undefined;
  const runtime = await deriveHomebrewGuestLifecycleRuntimeInputs({
    imageBytes,
    ...commonRuntimeInputs,
    validateEmbeddedBottlePlan: (plan) => {
      validatedMirror = plan;
    },
    closedBottleAssets: [{
      url: mirror.assets[0]!.url,
      sha256: sha256(bottleBytes),
      size: bottleBytes.byteLength,
      bytes: bottleBytes,
    }],
  });

  assert.equal(runtime.shellPath, "/bin/bash");
  assert.equal(runtime.shellArgv0, "bash");
  assert.equal(
    runtime.bootstrapTransportUrl,
    "https://closed.kandelo.invalid/lifecycle/homebrew-bootstrap.zip",
  );
  assert.equal(runtime.bootstrapBytes, bootstrapArchive.byteLength);
  assert.deepEqual(runtime.runtimeSupportTrees, [
    {
      url: mirror.assets[0]!.url,
      bytes: bottleBytes.byteLength,
    },
    {
      url:
        "https://closed.kandelo.invalid/lifecycle/" +
        "homebrew-portable-ruby.zip",
      bytes: portableRubyArchive.byteLength,
    },
  ]);
  assert.equal(runtime.lazyAssets?.length, 3);
  assert.equal(
    runtime.lazyAssets?.[1]?.sha256,
    bootstrapTree.content.sha256,
  );
  assert.equal(
    runtime.lazyAssets?.[2]?.sha256,
    portableRubyTree.content.sha256,
  );
  assert.deepEqual(validatedMirror, mirror);

  for (const [forgery, expected] of [
    ["member", /activation member .* changed after sealing/],
    // WHY: collection import now rejects a cohort whose members carry
    // different seals before the later per-seal verification can run.
    ["cohort", /activation group .* (?:differs from its seal|has inconsistent seals)/],
  ] as const) {
    let callbacks = 0;
    await assert.rejects(
      deriveHomebrewGuestLifecycleRuntimeInputs({
        imageBytes: forgeLazyAtomicSeal(imageBytes, forgery),
        ...commonRuntimeInputs,
        validateImageFileSystem: () => {
          callbacks += 1;
        },
        validateEmbeddedBottlePlan: () => {
          callbacks += 1;
        },
        loadClosedBottleAssets: () => {
          callbacks += 1;
          return [];
        },
      }),
      expected,
      `${forgery} seal forgery`,
    );
    assert.equal(callbacks, 0, `${forgery} callbacks ran before seal verification`);
  }
});

function createMirrorPlan(payload: Uint8Array): HomebrewBottleMirrorPlan {
  const repository = "example/project";
  const identity = {
    id: "bottle-test",
    package: "example/tap/test",
    asset: homebrewRuntimeLayerPayloadAsset("bottle-test"),
    sha256: sha256(payload),
    bytes: payload.byteLength,
  };
  const collection = sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(repository, [identity]),
  );
  const tag = `homebrew-shell-bottles-sha256-${collection}`;
  const releaseRoot =
    `https://github.com/${repository}/releases/download/${tag}`;
  return {
    schema: 1,
    kind: HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
    repository,
    collection_sha256: collection,
    tag,
    release_root: releaseRoot,
    manifest_asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    assets: [{
      ...identity,
      url: `${releaseRoot}/${identity.asset}`,
    }],
  };
}

function zipEntry(
  bytes: Uint8Array,
  mode: number,
): Zippable[string] {
  return [bytes, { os: 3, attrs: ((mode << 16) >>> 0) }];
}

function writeFile(
  fs: MemoryFileSystem,
  path: string,
  bytes: Uint8Array,
  mode = 0o644,
): void {
  const fd = fs.open(path, 0o1101, mode);
  try {
    assert.equal(fs.write(fd, bytes, null, bytes.byteLength), bytes.byteLength);
  } finally {
    fs.close(fd);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
