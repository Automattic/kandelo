import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  type HomebrewBottleMirrorPlan,
} from "../../host/src/homebrew-bottle-mirror-plan";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import { homebrewRuntimeLayerPayloadAsset } from "../../host/src/homebrew-runtime-layer-limits";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../host/src/vfs/image-helpers";
import { recoverHomebrewBottleMirror } from "../../scripts/recover-homebrew-bottle-mirror";
import { createHomebrewBottleMirrorPublishManifest } from
  "../../scripts/create-homebrew-bottle-mirror-publish-manifest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mirrorPlan(payloads: readonly Uint8Array[]): HomebrewBottleMirrorPlan {
  const repository = "example/project";
  const identities = payloads.map((payload, index) => {
    const suffix = payloads.length === 1 ? "test" : `test-${String(index).padStart(3, "0")}`;
    const id = `bottle-${suffix}`;
    return {
      id,
      package: `example/tap/${suffix}`,
      asset: homebrewRuntimeLayerPayloadAsset(id),
      sha256: sha256(payload),
      bytes: payload.byteLength,
    };
  });
  const collection = sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(repository, identities),
  );
  const tag = `homebrew-shell-bottles-sha256-${collection}`;
  const releaseRoot = `https://github.com/${repository}/releases/download/${tag}`;
  return {
    schema: 1,
    kind: HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
    repository,
    collection_sha256: collection,
    tag,
    release_root: releaseRoot,
    manifest_asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    assets: identities.map((identity) => ({
      ...identity,
      url: `${releaseRoot}/${identity.asset}`,
    })),
  };
}

async function fixture(options: {
  wrongGuestBytes?: boolean;
  assetCount?: number;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "kandelo-mirror-recovery-"));
  roots.push(root);
  const payloads = Array.from(
    { length: options.assetCount ?? 1 },
    (_, index) => new Uint8Array([1, 4, 9, 16, index]),
  );
  const payload = payloads[0]!;
  const plan = mirrorPlan(payloads);
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsBinary(
    fs,
    HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
    encodeHomebrewBottleMirrorPlan(plan),
    0o644,
  );
  writeVfsFile(fs, "/etc/kandelo/homebrew-vfs.json", JSON.stringify({
    schema: 1,
    catalog: {
      tap_repository: plan.repository,
      tap_name: "example/tap",
      checkout_commit: "a".repeat(40),
    },
    packages: plan.assets.map((asset, index) => ({
      full_name: asset.package,
      source_status: "success",
      url: `https://ghcr.io/v2/example/project/${asset.id}/blobs/sha256:${asset.sha256}`,
      sha256: asset.sha256,
      bytes: payloads[index]!.byteLength +
        (options.wrongGuestBytes && index === 0 ? 1 : 0),
    })),
  }));
  const imagePath = join(root, "shell.vfs");
  writeFileSync(imagePath, await fs.saveImage());
  return {
    root,
    payload,
    payloads,
    plan,
    imagePath,
    outputDirectory: join(root, "mirror"),
    reportPath: join(root, "recovery.json"),
  };
}

describe("Homebrew bottle mirror recovery", () => {
  it("recovers and verifies the complete bundle from anonymous source URLs", async () => {
    const value = await fixture();
    const fetchImpl = vi.fn(async () => new Response(value.payload));
    await recoverHomebrewBottleMirror({
      imagePath: value.imagePath,
      outputDirectory: value.outputDirectory,
      reportPath: value.reportPath,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(readdirSync(value.outputDirectory).sort()).toEqual([
      HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
      value.plan.assets[0]!.asset,
    ].sort());
    expect(new Uint8Array(readFileSync(
      join(value.outputDirectory, value.plan.assets[0]!.asset),
    ))).toEqual(value.payload);
    expect(JSON.parse(readFileSync(value.reportPath, "utf8"))).toMatchObject({
      repository: value.plan.repository,
      tag: value.plan.tag,
      catalog: {
        tap_repository: value.plan.repository,
        checkout_commit: "a".repeat(40),
      },
      assets: [{ package: value.plan.assets[0]!.package }],
    });
  });

  it("rejects a guest/source identity mismatch before fetching or publishing files", async () => {
    const value = await fixture({ wrongGuestBytes: true });
    const fetchImpl = vi.fn(async () => new Response(value.payload));
    await expect(recoverHomebrewBottleMirror({
      imagePath: value.imagePath,
      outputDirectory: value.outputDirectory,
      reportPath: value.reportPath,
      fetchImpl,
    })).rejects.toThrow("guest bottle identity differs");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(value.outputDirectory)).toBe(false);
    expect(existsSync(value.reportPath)).toBe(false);
  });

  it("bounds concurrent anonymous source recovery", async () => {
    const value = await fixture({ assetCount: 9 });
    const payloadByDigest = new Map(
      value.payloads.map((payload) => [sha256(payload), payload]),
    );
    let active = 0;
    let maximumActive = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const digest = input.toString().split("sha256:").at(-1)!;
      return new Response(payloadByDigest.get(digest));
    });
    await recoverHomebrewBottleMirror({
      imagePath: value.imagePath,
      outputDirectory: value.outputDirectory,
      reportPath: value.reportPath,
      fetchImpl,
      maxConcurrency: 3,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(maximumActive).toBe(3);
    expect(readdirSync(value.outputDirectory)).toHaveLength(10);
  });

  it("rolls back the bundle if the separately staged report cannot commit", async () => {
    const value = await fixture();
    const fetchImpl = vi.fn(async () => {
      mkdirSync(value.reportPath);
      return new Response(value.payload);
    });
    await expect(recoverHomebrewBottleMirror({
      imagePath: value.imagePath,
      outputDirectory: value.outputDirectory,
      reportPath: value.reportPath,
      fetchImpl,
    })).rejects.toThrow();
    expect(existsSync(value.outputDirectory)).toBe(false);
    expect(lstatSync(value.reportPath).isDirectory()).toBe(true);
  });

  it("declares exactly the recovered 35 payloads and plan for immutable publication", async () => {
    const value = await fixture({ assetCount: 35 });
    const payloadByDigest = new Map(
      value.payloads.map((payload) => [sha256(payload), payload]),
    );
    await recoverHomebrewBottleMirror({
      imagePath: value.imagePath,
      outputDirectory: value.outputDirectory,
      reportPath: value.reportPath,
      fetchImpl: async (input) => {
        const digest = input.toString().split("sha256:").at(-1)!;
        return new Response(payloadByDigest.get(digest));
      },
    });
    const publishManifestPath = join(value.root, "publish-manifest.json");
    await createHomebrewBottleMirrorPublishManifest({
      bundleDirectory: value.outputDirectory,
      recoveryReportPath: value.reportPath,
      outputPath: publishManifestPath,
    });
    const manifest = JSON.parse(readFileSync(publishManifestPath, "utf8"));
    const bundleNames = readdirSync(value.outputDirectory).sort();
    expect(manifest).toMatchObject({
      schema: 1,
      repository: value.plan.repository,
      tag: value.plan.tag,
      target_commitish: "a".repeat(40),
      accepted_existing_asset_sets: [],
    });
    expect(manifest.assets).toHaveLength(36);
    expect([...manifest.preferred_asset_names].sort()).toEqual(bundleNames);
    expect(manifest.assets.map((asset: { name: string }) => asset.name).sort())
      .toEqual(bundleNames);
  });
});
