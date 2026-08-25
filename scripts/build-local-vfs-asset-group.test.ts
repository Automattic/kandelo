import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MemoryFileSystem } from "../host/src/vfs/memory-fs.ts";
import { validateVfsAssetGroupManifest } from "../web-libs/kandelo-session/src/vfs-asset-group.ts";
import {
  buildLocalVfsAssetGroup,
  publishGeneratedTargets,
} from "./build-local-vfs-asset-group.ts";
import { loadVfsProductDeploymentMap } from "./vfs-product-deployment.ts";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTS = [
  ["browser-lamp", "lazy", "lamp.vfs.zst", "lamp.vfs.zst"],
  ["browser-main-shell", "eager", "shell.vfs.zst", "shell.vfs.zst"],
  ["browser-nginx", "lazy", "nginx-vfs.vfs.zst", "nginx-vfs.vfs.zst"],
  ["browser-nginx-php", "lazy", "nginx-php-vfs.vfs.zst", "nginx-php-vfs.vfs.zst"],
  ["browser-node", "lazy", "node-vfs.vfs.zst", "node-vfs.vfs.zst"],
  ["browser-wordpress", "lazy", "wordpress.vfs.zst", "wordpress.vfs.zst"],
  ["platform-rootfs", "eager", "rootfs.vfs", "rootfs.vfs"],
] as const;

test("produces the exact seven-image and 80-body closure from all legacy reference forms", async () => {
  const fixture = await createFixture();
  try {
    await withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
      buildLocalVfsAssetGroup({
        assetGroupDirectory: fixture.outputDirectory,
        productMapPath: fixture.productMapPath,
        sourceRoot,
      }),
    );

    const manifestBytes = readFileSync(
      join(fixture.outputDirectory, "manifest.json"),
    );
    const manifest = validateVfsAssetGroupManifest(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    assert.deepEqual(
      manifest.products.map(({ id, image, eager_groups, lazy_groups }) => ({
        eager_groups,
        id,
        image: image.path,
        lazy_groups,
      })),
      PRODUCTS.map(([id, _load, _sourceName, output]) => ({
        eager_groups: [],
        id,
        image: `images/${output}`,
        lazy_groups: ["programs"],
      })),
    );
    assert.equal(manifest.assets.length, 80);
    assert.deepEqual(
      manifest.assets.map(({ group, path }) => ({ group, path })).slice(0, 3),
      [
        { group: "programs", path: "assets/programs/wasm32/lazy/file-000.bin" },
        { group: "programs", path: "assets/programs/wasm32/lazy/file-001.bin" },
        { group: "programs", path: "assets/programs/wasm32/lazy/file-002.bin" },
      ],
    );
    assert.deepEqual(manifest.assets.map(({ path }) => path).slice(-2), [
      "assets/programs/wasm32/nethack.zip",
      "assets/programs/wasm32/vim.zip",
    ]);

    const map = loadVfsProductDeploymentMap({
      mapPath: fixture.productMapPath,
      sourceRoot,
    });
    assert.deepEqual(
      map.products.map(({ id, load, private_path, asset_group }) => ({
        group: asset_group.path,
        id,
        load,
        private: basename(private_path),
      })),
      PRODUCTS.map(([id, load, _sourceName, output]) => ({
        group: "vfs-groups/release-1/manifest.json",
        id,
        load,
        private: output,
      })),
    );

    for (const [id, _load, _sourceName, output] of PRODUCTS) {
      assert.deepEqual(
        readFileSync(join(fixture.outputDirectory, "images", output)),
        fixture.images.get(id),
      );
    }
    assert.deepEqual(
      readFileSync(
        join(
          fixture.outputDirectory,
          "assets/programs/wasm32/lazy/file-000.bin",
        ),
      ),
      fixture.members.get("programs/wasm32/lazy/file-000.bin"),
    );
  } finally {
    fixture.dispose();
  }
});

test("rejects a missing SourceOnly lazy member before publishing", async () => {
  const fixture = await createFixture();
  try {
    rmSync(join(fixture.sourceOnlyRoot, "programs/wasm32/lazy/file-077.bin"));
    await assert.rejects(
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: fixture.outputDirectory,
          productMapPath: fixture.productMapPath,
          sourceRoot,
        }),
      ),
      /Source-only package member|lacks/,
    );
    assert.equal(existsSync(fixture.outputDirectory), false);
    assert.equal(existsSync(fixture.productMapPath), false);
  } finally {
    fixture.dispose();
  }
});

test("rejects conflicting lazy-file sizes for one normalized body", async () => {
  const fixture = await createFixture({
    extraReference: {
      reference: "kandelo-lazy:programs/lazy/file-000.bin",
      sizeDelta: 1,
    },
  });
  try {
    await assert.rejects(
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: fixture.outputDirectory,
          productMapPath: fixture.productMapPath,
          sourceRoot,
        }),
      ),
      /conflicting image identities/,
    );
  } finally {
    fixture.dispose();
  }
});

test("rejects an unknown bare archive reference before publishing", async () => {
  const fixture = await createFixture({
    extraReference: { reference: "rogue.zip", sizeDelta: 0 },
  });
  try {
    await assert.rejects(
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: fixture.outputDirectory,
          productMapPath: fixture.productMapPath,
          sourceRoot,
        }),
      ),
      /reference is invalid/,
    );
    assert.equal(existsSync(fixture.outputDirectory), false);
  } finally {
    fixture.dispose();
  }
});

test("rejects an archive body that differs from its image integrity metadata", async () => {
  const fixture = await createFixture();
  try {
    fixture.members.set(
      "programs/wasm32/vim.zip",
      Buffer.from("bad archive\n"),
    );
    writeSourceOnlyProjection(fixture.sourceOnlyRoot, fixture.members);
    await assert.rejects(
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: fixture.outputDirectory,
          productMapPath: fixture.productMapPath,
          sourceRoot,
        }),
      ),
      /differs from its image byte identity/,
    );
  } finally {
    fixture.dispose();
  }
});

test("rejects a lazy asset member that collides with a product image member", async () => {
  const fixture = await createFixture({ collidingImageMember: true });
  try {
    await assert.rejects(
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: fixture.outputDirectory,
          productMapPath: fixture.productMapPath,
          sourceRoot,
        }),
      ),
      /image and lazy asset members collide|87 distinct snapshot members/,
    );
    assert.equal(existsSync(fixture.outputDirectory), false);
  } finally {
    fixture.dispose();
  }
});

test("reuses identical output and replaces only generated targets after a changed capture", async () => {
  const fixture = await createFixture();
  try {
    const run = () =>
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: fixture.outputDirectory,
          productMapPath: fixture.productMapPath,
          sourceRoot,
        }),
      );
    await run();
    const marker = join(dirname(fixture.outputDirectory), "keep.txt");
    writeFileSync(marker, "keep\n");
    const originalManifest = statSync(
      join(fixture.outputDirectory, "manifest.json"),
      { bigint: true },
    );
    const originalMap = statSync(fixture.productMapPath, { bigint: true });

    await run();
    assert.equal(
      statSync(join(fixture.outputDirectory, "manifest.json"), { bigint: true })
        .ino,
      originalManifest.ino,
    );
    assert.equal(
      statSync(fixture.productMapPath, { bigint: true }).ino,
      originalMap.ino,
    );

    fixture.members.set(
      "programs/wasm32/lazy/file-077.bin",
      Buffer.from("changed\n"),
    );
    writeSourceOnlyProjection(fixture.sourceOnlyRoot, fixture.members);
    await run();
    assert.notEqual(
      statSync(join(fixture.outputDirectory, "manifest.json"), { bigint: true })
        .ino,
      originalManifest.ino,
    );
    assert.equal(readFileSync(marker, "utf8"), "keep\n");
    assert.deepEqual(
      readFileSync(
        join(
          fixture.outputDirectory,
          "assets/programs/wasm32/lazy/file-077.bin",
        ),
      ),
      Buffer.from("changed\n"),
    );
  } finally {
    fixture.dispose();
  }
});

test("replaces generated output when a captured body shrinks", async () => {
  const fixture = await createFixture({ vimBody: Buffer.alloc(4096, 0x61) });
  const changed = await createFixture({ vimBody: Buffer.from("smaller vim\n") });
  try {
    const run = (sourceOnlyRoot: string) =>
      withSourceOnlyRoot(sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: fixture.outputDirectory,
          productMapPath: fixture.productMapPath,
          sourceRoot,
        }),
      );
    await run(fixture.sourceOnlyRoot);
    const originalManifest = statSync(
      join(fixture.outputDirectory, "manifest.json"),
      { bigint: true },
    );

    await run(changed.sourceOnlyRoot);
    assert.deepEqual(
      readFileSync(
        join(fixture.outputDirectory, "assets/programs/wasm32/vim.zip"),
      ),
      Buffer.from("smaller vim\n"),
    );
    assert.notEqual(
      statSync(join(fixture.outputDirectory, "manifest.json"), { bigint: true })
        .ino,
      originalManifest.ino,
    );
  } finally {
    fixture.dispose();
    changed.dispose();
  }
});

test("replaces generated output when the existing group has an extra file", async () => {
  const fixture = await createFixture();
  try {
    const run = () =>
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: fixture.outputDirectory,
          productMapPath: fixture.productMapPath,
          sourceRoot,
        }),
      );
    await run();
    const extra = join(fixture.outputDirectory, "unexpected.bin");
    writeFileSync(extra, "foreign\n");

    await run();
    assert.equal(existsSync(extra), false);
    assert.equal(
      validateVfsAssetGroupManifest(
        JSON.parse(
          readFileSync(
            join(fixture.outputDirectory, "manifest.json"),
            "utf8",
          ),
        ),
      ).products.length,
      7,
    );
  } finally {
    fixture.dispose();
  }
});

test("preserves prior generated output when changed staging input fails validation", async () => {
  const fixture = await createFixture();
  try {
    const run = () =>
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: fixture.outputDirectory,
          productMapPath: fixture.productMapPath,
          sourceRoot,
        }),
      );
    await run();
    const before = generatedSnapshot(fixture);
    fixture.members.set(
      "programs/wasm32/vim.zip",
      Buffer.from("bad archive\n"),
    );
    writeSourceOnlyProjection(fixture.sourceOnlyRoot, fixture.members);

    await assert.rejects(run(), /differs from its image byte identity/);
    assert.deepEqual(generatedSnapshot(fixture), before);
  } finally {
    fixture.dispose();
  }
});

test("serializes publication against an existing concurrent writer", () => {
  const fixture = publicationFixture();
  try {
    mkdirSync(join(fixture.root, ".local-vfs-asset-group.lock"));
    assert.throws(
      () => publishGeneratedTargets(fixture),
      /publication is already in progress/,
    );
    assert.equal(readFileSync(fixture.productMapPath, "utf8"), "old map\n");
    assert.equal(
      readFileSync(join(fixture.assetGroupDirectory, "value"), "utf8"),
      "old group\n",
    );
  } finally {
    fixture.dispose();
  }
});

test("removes old map authority before swapping the authenticated group", () => {
  const fixture = publicationFixture();
  try {
    publishGeneratedTargets(fixture, {
      rename(from, to) {
        if (from === fixture.assetGroupDirectory) {
          assert.equal(existsSync(fixture.productMapPath), false);
        }
        renameSync(from, to);
      },
    });
    assert.equal(readFileSync(fixture.productMapPath, "utf8"), "new map\n");
  } finally {
    fixture.dispose();
  }
});

test("rename failure rollback does not delete a target installed by another writer", () => {
  const fixture = publicationFixture();
  try {
    assert.throws(
      () =>
        publishGeneratedTargets(fixture, {
          rename(from, to) {
            if (from === fixture.stagedMap) {
              writeFileSync(fixture.productMapPath, "foreign map\n");
              renameSync(
                fixture.assetGroupDirectory,
                join(fixture.root, "displaced-new-group"),
              );
              mkdirSync(fixture.assetGroupDirectory);
              writeFileSync(
                join(fixture.assetGroupDirectory, "value"),
                "foreign group\n",
              );
              throw new Error("injected staged-map rename failure");
            }
            renameSync(from, to);
          },
        }),
      /injected staged-map rename failure/,
    );
    assert.equal(
      readFileSync(fixture.productMapPath, "utf8"),
      "foreign map\n",
    );
    assert.equal(
      readFileSync(join(fixture.assetGroupDirectory, "value"), "utf8"),
      "foreign group\n",
    );
  } finally {
    fixture.dispose();
  }
});

test("preserves the prior generation when backup-group restoration fails", () => {
  const fixture = publicationFixture();
  let backupRoot: string | undefined;
  let thrown: Error | undefined;
  try {
    try {
      publishGeneratedTargets(fixture, {
        rename(from, to) {
          if (from === fixture.productMapPath) backupRoot = dirname(to);
          if (from === fixture.stagedMap) {
            throw new Error("injected staged-map rename failure");
          }
          if (
            backupRoot !== undefined &&
            from === join(backupRoot, "vfs-group")
          ) {
            throw new Error("injected backup-group restoration failure");
          }
          renameSync(from, to);
        },
      });
    } catch (error) {
      assert.ok(error instanceof Error);
      thrown = error;
    }
    assert.ok(thrown !== undefined);
    assert.ok(backupRoot !== undefined);
    assert.equal(
      readFileSync(join(backupRoot, "vfs-group", "value"), "utf8"),
      "old group\n",
    );
    assert.equal(
      readFileSync(
        join(backupRoot, "pages-vfs-products.private.json"),
        "utf8",
      ),
      "old map\n",
    );
    assert.match(thrown.message, /injected staged-map rename failure/);
    assert.match(thrown.message, /injected backup-group restoration failure/);
    assert.ok(thrown.message.includes(backupRoot));
    assert.equal(
      existsSync(join(fixture.root, ".local-vfs-asset-group.lock")),
      false,
    );
  } finally {
    fixture.dispose();
  }
});

test("preserves the prior map when backup-map restoration fails", () => {
  const fixture = publicationFixture();
  let backupRoot: string | undefined;
  let thrown: Error | undefined;
  try {
    try {
      publishGeneratedTargets(fixture, {
        rename(from, to) {
          if (from === fixture.productMapPath) backupRoot = dirname(to);
          if (from === fixture.stagedMap) {
            throw new Error("injected staged-map rename failure");
          }
          if (
            backupRoot !== undefined &&
            from === join(backupRoot, "pages-vfs-products.private.json")
          ) {
            throw new Error("injected backup-map restoration failure");
          }
          renameSync(from, to);
        },
      });
    } catch (error) {
      assert.ok(error instanceof Error);
      thrown = error;
    }
    assert.ok(thrown !== undefined);
    assert.ok(backupRoot !== undefined);
    assert.equal(
      readFileSync(join(fixture.assetGroupDirectory, "value"), "utf8"),
      "old group\n",
    );
    assert.equal(
      readFileSync(
        join(backupRoot, "pages-vfs-products.private.json"),
        "utf8",
      ),
      "old map\n",
    );
    assert.match(thrown.message, /injected staged-map rename failure/);
    assert.match(thrown.message, /injected backup-map restoration failure/);
    assert.ok(thrown.message.includes(backupRoot));
    assert.equal(
      existsSync(join(fixture.root, ".local-vfs-asset-group.lock")),
      false,
    );
  } finally {
    fixture.dispose();
  }
});

test("rejects generated targets inside the SourceOnly projection", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: join(fixture.sourceOnlyRoot, "vfs-group"),
          productMapPath: join(
            fixture.sourceOnlyRoot,
            "pages-vfs-products.private.json",
          ),
          sourceRoot,
        }),
      ),
      /may not overlap/,
    );
  } finally {
    fixture.dispose();
  }
});

test("rejects a generated output with a symlinked ancestor", async () => {
  const fixture = await createFixture();
  try {
    const realOutput = join(fixture.root, "real-output");
    const linkedOutput = join(fixture.root, "linked-output");
    mkdirSync(realOutput);
    symlinkSync(realOutput, linkedOutput);
    await assert.rejects(
      withSourceOnlyRoot(fixture.sourceOnlyRoot, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: join(linkedOutput, "vfs-group"),
          productMapPath: join(
            linkedOutput,
            "pages-vfs-products.private.json",
          ),
          sourceRoot,
        }),
      ),
      /symlinked ancestor/,
    );
    assert.deepEqual(readdirSync(realOutput), []);
  } finally {
    fixture.dispose();
  }
});

test("rejects a generated output that contains the SourceOnly projection", async () => {
  const fixture = await createFixture();
  try {
    const outputDirectory = join(fixture.root, "overlap", "vfs-group");
    const nestedSourceOnly = join(outputDirectory, "source-only");
    mkdirSync(outputDirectory, { recursive: true });
    mkdirSync(nestedSourceOnly);
    writeSourceOnlyProjection(nestedSourceOnly, fixture.members);
    await assert.rejects(
      withSourceOnlyRoot(nestedSourceOnly, () =>
        buildLocalVfsAssetGroup({
          assetGroupDirectory: outputDirectory,
          productMapPath: join(
            dirname(outputDirectory),
            "pages-vfs-products.private.json",
          ),
          sourceRoot,
        }),
      ),
      /may not overlap the SourceOnly projection/,
    );
    assert.equal(
      existsSync(
        join(
          nestedSourceOnly,
          ".kandelo/source-only-program-projection-v1.json",
        ),
      ),
      true,
    );
  } finally {
    fixture.dispose();
  }
});

interface Fixture {
  dispose(): void;
  images: Map<string, Buffer>;
  members: Map<string, Buffer>;
  outputDirectory: string;
  productMapPath: string;
  root: string;
  sourceOnlyRoot: string;
}

function publicationFixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "kandelo-vfs-publication-")),
  );
  const assetGroupDirectory = join(root, "vfs-group");
  const productMapPath = join(root, "pages-vfs-products.private.json");
  const stagedGroup = join(root, "staged-vfs-group");
  const stagedMap = join(root, "staged-private-map.json");
  mkdirSync(assetGroupDirectory);
  mkdirSync(stagedGroup);
  writeFileSync(join(assetGroupDirectory, "value"), "old group\n");
  writeFileSync(productMapPath, "old map\n");
  writeFileSync(join(stagedGroup, "value"), "new group\n");
  writeFileSync(stagedMap, "new map\n");
  return {
    assetGroupDirectory,
    dispose: () => rmSync(root, { force: true, recursive: true }),
    productMapPath,
    root,
    stagedGroup,
    stagedMap,
  };
}

async function createFixture(
  options: {
    collidingImageMember?: boolean;
    extraReference?: { reference: string; sizeDelta: number };
    vimBody?: Buffer;
  } = {},
): Promise<Fixture> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "kandelo-local-vfs-group-")),
  );
  const sourceOnlyRoot = join(root, "source-only");
  const outputParent = join(root, "generated");
  mkdirSync(sourceOnlyRoot);
  mkdirSync(outputParent);
  const members = new Map<string, Buffer>();
  const assetBodies = new Map<string, Buffer>();
  for (let index = 0; index < 78; index += 1) {
    const relative = `lazy/file-${String(index).padStart(3, "0")}.bin`;
    assetBodies.set(relative, Buffer.from(`lazy-${index}\n`));
  }
  assetBodies.set("vim.zip", options.vimBody ?? Buffer.from("vim archive\n"));
  assetBodies.set("nethack.zip", Buffer.from("nethack archive\n"));

  const images = new Map<string, Buffer>();
  for (const [id, _load, sourceName] of PRODUCTS) {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    if (id === "browser-main-shell") {
      const lazyFileCount = options.collidingImageMember ? 77 : 78;
      for (let index = 0; index < lazyFileCount; index += 1) {
        const relative = `lazy/file-${String(index).padStart(3, "0")}.bin`;
        const reference =
          index < 39
            ? `binaries/programs/wasm32/${relative}`
            : `kandelo-lazy:programs/${relative}`;
        fs.registerLazyFile(
          `/opt/lazy/${String(index).padStart(3, "0")}`,
          reference,
          assetBodies.get(relative)!.byteLength,
        );
      }
      for (const name of ["vim.zip", "nethack.zip"] as const) {
        const body = assetBodies.get(name)!;
        fs.registerLazyTree(
          {
            bytes: body.byteLength,
            decoder: "zip-v1",
            expandedBytes: 1,
            mediaType: "application/zip",
            sha256: sha256(body),
            sourceEntryCount: 1,
            transports: [name],
          },
          [
            {
              inodeGroup: name,
              mode: 0o755,
              size: 1,
              sourcePath: `bin/${name}`,
              type: "file",
              vfsPath: `/opt/${name}`,
            },
          ],
        );
      }
    } else if (id === "browser-node" && options.collidingImageMember) {
      const body = images.get("browser-lamp")!;
      fs.registerLazyFile(
        `/opt/${id}`,
        "binaries/programs/wasm32/lamp.vfs.zst",
        body.byteLength,
      );
    } else {
      const body = assetBodies.get("lazy/file-000.bin")!;
      fs.registerLazyFile(
        `/opt/${id}`,
        "binaries/programs/wasm32/lazy/file-000.bin",
        body.byteLength,
      );
    }
    if (id === "browser-lamp" && options.extraReference !== undefined) {
      const body = assetBodies.get("lazy/file-000.bin")!;
      fs.registerLazyFile(
        "/opt/extra-reference",
        options.extraReference.reference,
        body.byteLength + options.extraReference.sizeDelta,
      );
    }
    const body = Buffer.from(await fs.saveImage());
    images.set(id, body);
    members.set(`programs/wasm32/${sourceName}`, body);
  }
  for (const [relative, body] of assetBodies) {
    members.set(`programs/wasm32/${relative}`, body);
  }
  writeSourceOnlyProjection(sourceOnlyRoot, members);
  return {
    dispose: () => rmSync(root, { force: true, recursive: true }),
    images,
    members,
    outputDirectory: join(outputParent, "vfs-group"),
    productMapPath: join(outputParent, "pages-vfs-products.private.json"),
    root,
    sourceOnlyRoot,
  };
}

function writeSourceOnlyProjection(
  root: string,
  members: ReadonlyMap<string, Buffer>,
): void {
  const packages = new Map<
    string,
    Array<{ body: Buffer; mirrorPath: string }>
  >();
  for (const [relPath, body] of members) {
    const mirrorPath = relPath.slice("programs/wasm32/".length);
    const packageName = mirrorPath.startsWith("lazy/")
      ? "lazy"
      : `scalar-${mirrorPath.replaceAll(/[^a-z0-9]+/gu, "-").replace(/-$/u, "")}`;
    const values = packages.get(packageName) ?? [];
    values.push({ body, mirrorPath });
    packages.set(packageName, values);
  }
  const identities: Record<string, unknown> = {};
  const projectedPackages: Record<string, unknown> = {};
  const nodes: unknown[] = [];
  for (const packageName of [...packages.keys()].sort()) {
    const packageMembers = packages.get(packageName)!.sort((left, right) =>
      left.mirrorPath.localeCompare(right.mirrorPath, "en", {
        usage: "sort",
      }),
    );
    const manifestSha256 = sha256(Buffer.from(`manifest:${packageName}`));
    const cacheKeySha256 = sha256(Buffer.from(`cache:${packageName}`));
    identities[packageName] = {
      cacheKeys: { wasm32: cacheKeySha256, wasm64: "f".repeat(64) },
      manifestSha256,
    };
    projectedPackages[packageName] = {
      arches: ["wasm32"],
      cacheKeys: { wasm32: cacheKeySha256 },
      dependencyClosures: { wasm32: [] },
      manifestSha256,
      members: packageMembers.map(({ mirrorPath }, index) => ({
        forkInstrumentation: "disabled",
        kind: "output",
        mirrorPath,
        outputName: `output-${index}`,
        sourceArtifact: `source-${index}${mirrorPath.includes(".") ? mirrorPath.slice(mirrorPath.indexOf(".")) : ""}`,
      })),
    };
    nodes.push({
      cacheKeySha256,
      cacheReceiptSha256: sha256(Buffer.from(`receipt:${packageName}`)),
      manifestSha256,
      members: packageMembers
        .map(({ body, mirrorPath }, index) => ({
          mirrorPath: `programs/wasm32/${mirrorPath}`,
          mode: 0o644,
          sha256: sha256(body),
          size: body.byteLength,
          sourceArtifact: `source-${index}${mirrorPath.includes(".") ? mirrorPath.slice(mirrorPath.indexOf(".")) : ""}`,
        }))
        .sort((left, right) => left.mirrorPath.localeCompare(right.mirrorPath)),
      node: { kind: "package", name: packageName, targetArch: "wasm32" },
    });
  }
  for (const [relPath, body] of members) {
    const path = join(root, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode: 0o644 });
    chmodSync(path, 0o644);
  }
  const metadata = join(root, ".kandelo");
  mkdirSync(metadata, { recursive: true, mode: 0o755 });
  const authorityPath = join(
    metadata,
    "source-only-program-projection-v1.json",
  );
  writeFileSync(
    authorityPath,
    `${JSON.stringify({
      format: "kandelo-source-only-program-projection-v1",
      graphAuthoritySha256: "e".repeat(64),
      nodes,
      projection: {
        format: "kandelo-program-packages-v2",
        identities,
        packages: projectedPackages,
      },
    })}\n`,
    { mode: 0o644 },
  );
  chmodSync(authorityPath, 0o644);
}

async function withSourceOnlyRoot<T>(
  root: string,
  run: () => Promise<T>,
): Promise<T> {
  const previousPolicy = process.env.WASM_POSIX_RESOLUTION_POLICY;
  const previousRoot = process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
  process.env.WASM_POSIX_RESOLUTION_POLICY = "source-only-v1";
  process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = root;
  try {
    return await run();
  } finally {
    if (previousPolicy === undefined)
      delete process.env.WASM_POSIX_RESOLUTION_POLICY;
    else process.env.WASM_POSIX_RESOLUTION_POLICY = previousPolicy;
    if (previousRoot === undefined)
      delete process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
    else process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = previousRoot;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function generatedSnapshot(fixture: Fixture): unknown {
  const manifest = readFileSync(join(fixture.outputDirectory, "manifest.json"));
  const map = readFileSync(fixture.productMapPath);
  const vim = readFileSync(
    join(fixture.outputDirectory, "assets/programs/wasm32/vim.zip"),
  );
  return {
    manifest: sha256(manifest),
    map: sha256(map),
    vim: sha256(vim),
  };
}
