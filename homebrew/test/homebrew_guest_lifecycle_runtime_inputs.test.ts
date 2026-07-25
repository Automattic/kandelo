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
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import {
  derivePackageDeferredZipTree,
  registerPackageDeferredZipTree,
} from "../../host/src/vfs/package-deferred-tree";
import {
  deriveHomebrewGuestLifecycleRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";

const encoder = new TextEncoder();

test("binds verified bootstrap bytes and bottle payloads to one exact image", async () => {
  const coreRevision = "1".repeat(40);
  const bootstrapArchive = zipSync({
    "bin/": zipEntry(new Uint8Array(), 0o040755),
    "bin/brew": zipEntry(encoder.encode("#!/bin/sh\n"), 0o100755),
  }, { level: 9 });
  const bootstrapSpec = {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: "shell/homebrew-bootstrap",
    content_role: "source-tree",
    package: {
      name: "shell",
      output: "homebrew-bootstrap.zip",
    },
    archive: {
      url: "homebrew-bootstrap.zip",
      mode_policy: "portable-posix-v1",
    },
    mount_prefix: "/home/linuxbrew/.linuxbrew",
    owner: { uid: 1000, gid: 1000 },
    activation: {
      mode: "first-use",
      capabilities: ["homebrew:bootstrap"],
      roots: ["/home/linuxbrew/.linuxbrew/bin/brew"],
    },
  } as const;
  const bootstrapTree = derivePackageDeferredZipTree(
    bootstrapSpec,
    bootstrapArchive,
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
    "/home/linuxbrew",
    "/home/linuxbrew/.linuxbrew",
    "/bottle",
  ]) {
    fs.mkdir(path, 0o755);
  }
  fs.chown("/home", 1000, 1000);
  fs.chown("/home/linuxbrew", 1000, 1000);
  fs.chown("/home/linuxbrew/.linuxbrew", 1000, 1000);
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
    },
    { uid: 1000, gid: 1000 },
  );

  const imageBytes = await fs.saveImage();
  let validatedMirror: HomebrewBottleMirrorPlan | undefined;
  const runtime = deriveHomebrewGuestLifecycleRuntimeInputs({
    imageBytes,
    bootstrapSpecBytes: encoder.encode(JSON.stringify(bootstrapSpec)),
    bootstrapArchiveBytes: bootstrapArchive,
    bootstrapArchiveSha256: sha256(bootstrapArchive),
    bootstrapEnvironmentBytes: environmentBytes,
    coreRevision,
    transportMode: "closed",
    lazyUrlBase: "https://closed.kandelo.invalid/lifecycle/",
    expectedEmbeddedBottlePlanBytes: mirrorBytes,
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
  assert.equal(runtime.lazyAssets?.length, 2);
  assert.equal(
    runtime.lazyAssets?.[1]?.sha256,
    bootstrapTree.content.sha256,
  );
  assert.deepEqual(validatedMirror, mirror);
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
