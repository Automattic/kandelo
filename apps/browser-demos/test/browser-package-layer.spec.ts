import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { zipSync, type Zippable } from "fflate";

import { ABI_VERSION } from "../../../host/src/generated/abi";
import type {
  HomebrewDeferredTreeDraftDescriptor,
  HomebrewLazyLayerDraftDescriptor,
  HomebrewLazyLayerEntry,
  HomebrewLazyLayerPackageRecord,
} from "../../../host/src/homebrew-lazy-layer-descriptor";
import {
  closeHomebrewLazyLayerDescriptor,
  encodeHomebrewLazyLayerDescriptor,
  homebrewRuntimeLayerDescriptorAsset,
  homebrewRuntimeLayerPayloadAsset,
} from "../../../host/src/homebrew-lazy-layer";
import {
  ensureDirRecursive,
  writeVfsFile,
} from "../../../host/src/vfs/image-helpers";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import type {
  BootDescriptor,
} from "../../../web-libs/kandelo-session/src/kernel-host";

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __bootPackageLayerAcceptance: (request: {
      baseVfsUrl: string;
      descriptor: BootDescriptor;
    }) => Promise<{ layerIds: string[] }>;
    __readPackageLayerAcceptance: (path: string) => Promise<string>;
    __execPackageLayerAcceptance: (request: {
      executable: string;
      argv: string[];
      env?: string[];
      timeoutMs: number;
    }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    __destroyPackageLayerAcceptance: () => Promise<void>;
    __packageLayerDiscardedBufferCount: () => number;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const mountProbeProgram = join(
  here,
  "../../../examples/mount_probe_test.wasm",
);
const kernel = join(here, "../../../host/wasm/kandelo-kernel.wasm");
const available = existsSync(mountProbeProgram) && existsSync(kernel);
const HOME_BREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const PACKAGE = "lazyfixture";
const VERSION = "1.0";
const KEG = `${HOME_BREW_PREFIX}/Cellar/${PACKAGE}/${VERSION}`;
const RELEASE_REPOSITORY = "kandelo-dev/homebrew-tap-core";
const TAP_NAME = "kandelo-dev/tap-core";
const TAP_COMMIT = "1".repeat(40);
const KANDELO_COMMIT = "2".repeat(40);
const ACCEPTANCE_SHA = "e".repeat(64);
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

interface PackageLayerFixture {
  baseImage: Uint8Array;
  descriptorBytes: Uint8Array;
  descriptor: BootDescriptor;
  dataArchive: Uint8Array;
  execArchive: Uint8Array;
  dataPath: string;
  executable: string;
  urls: {
    base: string;
    descriptor: string;
    data: string;
    dataMirror: string;
    exec: string;
  };
}

interface PackageLayerFixtureOptions {
  bootPrefetchTree?: "data" | "exec";
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function routeBytes(
  page: Page,
  url: string,
  bytes: Uint8Array,
  onRequest?: () => void,
): Promise<void> {
  await page.route(url, async (route) => {
    onRequest?.();
    await route.fulfill({
      status: 200,
      body: Buffer.from(bytes),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(bytes.byteLength),
        "content-type": "application/octet-stream",
      },
    });
  });
}

async function routeFailure(
  page: Page,
  url: string,
  onRequest?: () => void,
): Promise<void> {
  await page.route(url, async (route) => {
    onRequest?.();
    await route.fulfill({
      status: 503,
      body: "fixture transport offline",
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "text/plain",
      },
    });
  });
}

function packageRecord(): HomebrewLazyLayerPackageRecord {
  return {
    name: PACKAGE,
    full_name: `${TAP_NAME}/${PACKAGE}`,
    tap_repository: RELEASE_REPOSITORY,
    tap_name: TAP_NAME,
    tap_commit: TAP_COMMIT,
    version: VERSION,
    formula_revision: 0,
    bottle_rebuild: 0,
    arch: "wasm32",
    source_status: "success",
    metadata_status: "success",
    url: `https://ghcr.io/v2/${RELEASE_REPOSITORY}/${PACKAGE}/blobs/sha256:${"3".repeat(64)}`,
    sha256: "3".repeat(64),
    bytes: 1,
    cache_key_sha: "4".repeat(64),
    link_manifest: `Kandelo/link/${PACKAGE}-${VERSION}-rebuild0-wasm32.json`,
    prefix: HOME_BREW_PREFIX,
    keg: KEG,
    opt_link: {
      path: `opt/${PACKAGE}`,
      target: `../Cellar/${PACKAGE}/${VERSION}`,
    },
  };
}

function zipTree(
  id: string,
  root: string,
  transportUrl: string,
  entries: HomebrewLazyLayerEntry[],
  files: ReadonlyMap<string, Uint8Array>,
): { archive: Uint8Array; tree: HomebrewDeferredTreeDraftDescriptor } {
  const input: Zippable = {};
  for (const entry of entries) {
    const archivePath = entry.type === "directory"
      ? `${entry.source_path}/`
      : entry.source_path;
    const typeMode = entry.type === "directory"
      ? S_IFDIR
      : entry.type === "symlink"
        ? S_IFLNK
        : S_IFREG;
    const bytes = entry.type === "file"
      ? files.get(entry.source_path)!
      : entry.type === "symlink"
        ? utf8(entry.target ?? "")
        : new Uint8Array();
    input[archivePath] = [bytes, {
      level: entry.type === "file" ? 9 : 0,
      mtime: ZIP_EPOCH,
      os: 3,
      attrs: (((typeMode | entry.mode) << 16) >>> 0),
    }];
  }
  const archive = zipSync(input, { level: 9 });
  const expandedBytes = entries
    .filter((entry) => entry.type !== "hardlink")
    .reduce((total, entry) => total + entry.size, 0);
  const payloadBytes = entries
    .filter((entry) => entry.type === "file")
    .reduce((total, entry) => total + entry.size, 0);
  return {
    archive,
    tree: {
      id,
      activation: {
        mode: "first-use",
        capabilities: [`homebrew-runtime:${PACKAGE}`],
        roots: [root],
      },
      content: {
        media_type: "application/zip",
        decoder: "zip-v1",
        sha256: sha256(archive),
        bytes: archive.byteLength,
      },
      transports: [
        { kind: "external-https", url: transportUrl },
        {
          kind: "bundle-release",
          asset: homebrewRuntimeLayerPayloadAsset(id),
        },
      ],
      inventory: {
        entry_count: entries.length,
        source_entry_count: new Set(entries.map((entry) => entry.source_path)).size,
        regular_inode_count: new Set(entries.flatMap((entry) =>
          entry.inode_group === undefined ? [] : [entry.inode_group]
        )).size,
        layer_entry_count: entries.length,
        shared_base_directory_count: 0,
        expanded_bytes: expandedBytes,
        payload_bytes: payloadBytes,
        entries,
      },
    },
  };
}

async function createFixture(
  options: PackageLayerFixtureOptions = {},
): Promise<PackageLayerFixture> {
  const urls = {
    base: "https://fixtures.kandelo.invalid/package-layer-base.vfs",
    descriptor: "",
    data: "https://fixtures.kandelo.invalid/lazyfixture-data.zip",
    dataMirror: "",
    exec: "https://fixtures.kandelo.invalid/lazyfixture-exec.zip",
  };
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
  fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
  ensureDirRecursive(fs, "/etc/kandelo");
  ensureDirRecursive(fs, `${HOME_BREW_PREFIX}/Cellar`);
  ensureDirRecursive(fs, `${HOME_BREW_PREFIX}/opt`);
  const basePackages = [{ full_name: `${TAP_NAME}/base-runtime` }];
  const requestedPackages = ["base-runtime"];
  const composition = {
    schema: 1,
    selection: {
      requested_packages_sha256: sha256(utf8(JSON.stringify(requestedPackages))),
    },
    packages: basePackages,
  };
  const compositionBytes = utf8(`${JSON.stringify(composition)}\n`);
  writeVfsFile(
    fs,
    "/etc/kandelo/homebrew-vfs.json",
    new TextDecoder().decode(compositionBytes),
  );
  const baseImage = await fs.saveImage();

  const dataPath = `${KEG}/share/message.txt`;
  const dataBytes = utf8("package-layer-first-use\n");
  const dataEntries: HomebrewLazyLayerEntry[] = [
    {
      path: `${HOME_BREW_PREFIX.slice(1)}/Cellar/${PACKAGE}`,
      source_path: `${HOME_BREW_PREFIX.slice(1)}/Cellar/${PACKAGE}`,
      type: "directory",
      ownership: "layer",
      mode: 0o755,
      size: 0,
    },
    {
      path: KEG.slice(1),
      source_path: KEG.slice(1),
      type: "directory",
      ownership: "layer",
      mode: 0o755,
      size: 0,
    },
    {
      path: `${KEG.slice(1)}/share`,
      source_path: `${KEG.slice(1)}/share`,
      type: "directory",
      ownership: "layer",
      mode: 0o755,
      size: 0,
    },
    {
      path: dataPath.slice(1),
      source_path: dataPath.slice(1),
      type: "file",
      ownership: "layer",
      mode: 0o644,
      size: dataBytes.byteLength,
      inode_group: dataPath.slice(1),
    },
    {
      path: `${HOME_BREW_PREFIX.slice(1)}/opt/${PACKAGE}`,
      source_path: `${HOME_BREW_PREFIX.slice(1)}/opt/${PACKAGE}`,
      type: "symlink",
      ownership: "layer",
      mode: 0o777,
      size: utf8(`../Cellar/${PACKAGE}/${VERSION}`).byteLength,
      target: `../Cellar/${PACKAGE}/${VERSION}`,
    },
  ];
  const dataTree = zipTree(
    `${PACKAGE}-data`,
    dataPath,
    urls.data,
    dataEntries,
    new Map([[dataPath.slice(1), dataBytes]]),
  );

  const executable = `${KEG}/bin/mount-probe`;
  const executableBytes = new Uint8Array(readFileSync(mountProbeProgram));
  const execEntries: HomebrewLazyLayerEntry[] = [
    {
      path: `${KEG.slice(1)}/bin`,
      source_path: `${KEG.slice(1)}/bin`,
      type: "directory",
      ownership: "layer",
      mode: 0o755,
      size: 0,
    },
    {
      path: executable.slice(1),
      source_path: executable.slice(1),
      type: "file",
      ownership: "layer",
      mode: 0o755,
      size: executableBytes.byteLength,
      inode_group: executable.slice(1),
    },
  ];
  const execTree = zipTree(
    `${PACKAGE}-exec`,
    executable,
    urls.exec,
    execEntries,
    new Map([[executable.slice(1), executableBytes]]),
  );
  if (options.bootPrefetchTree === "data") {
    dataTree.tree.activation.mode = "boot-prefetch";
  } else if (options.bootPrefetchTree === "exec") {
    execTree.tree.activation.mode = "boot-prefetch";
  }

  const baseSha = sha256(baseImage);
  const draft: HomebrewLazyLayerDraftDescriptor = {
    schema: 4,
    kind: "kandelo-homebrew-deferred-layer-draft",
    arch: "wasm32",
    mount_prefix: "/",
    tap: {
      repository: RELEASE_REPOSITORY,
      name: TAP_NAME,
      commit: TAP_COMMIT,
    },
    tap_lock: [{
      repository: RELEASE_REPOSITORY,
      name: TAP_NAME,
      commit: TAP_COMMIT,
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: KANDELO_COMMIT,
      kandelo_abi: ABI_VERSION,
      bottle_release_tag: `bottles-abi-v${ABI_VERSION}`,
    }],
    kandelo: {
      repository: "Automattic/kandelo",
      commit: KANDELO_COMMIT,
      abi: ABI_VERSION,
    },
    bottle_release_tag: `bottles-abi-v${ABI_VERSION}`,
    selection: {
      requested_packages: [PACKAGE],
      package_order: [`${TAP_NAME}/${PACKAGE}`],
      base_package_order: [],
      layer_package_order: [`${TAP_NAME}/${PACKAGE}`],
    },
    packages: { base: [], layer: [packageRecord()] },
    base_vfs: {
      sha256: baseSha,
      bytes: baseImage.byteLength,
      kernel_abi: ABI_VERSION,
      package_source: {
        schema: 1,
        kind: "kandelo-package-output",
        index: {
          url: `https://github.com/Automattic/kandelo/releases/download/binaries-abi-v${ABI_VERSION}/index.toml`,
          sha256: "5".repeat(64),
          bytes: 1,
          abi: ABI_VERSION,
        },
        package: {
          name: "shell",
          version: "0.1.0",
          revision: 1,
          arch: "wasm32",
          cache_key_sha: "6".repeat(64),
        },
        archive: {
          format: "kandelo-package-tar-zstd-v2",
          url: `https://github.com/Automattic/kandelo/releases/download/binaries-abi-v${ABI_VERSION}/shell.tar.zst`,
          sha256: "7".repeat(64),
          bytes: 1,
        },
        output: {
          name: "shell",
          path: "shell.vfs.zst",
          sha256: baseSha,
          bytes: baseImage.byteLength,
        },
      },
      composition: {
        path: "/etc/kandelo/homebrew-vfs.json",
        sha256: sha256(compositionBytes),
        bytes: compositionBytes.byteLength,
        requested_packages_sha256:
          composition.selection.requested_packages_sha256,
        package_set_sha256: sha256(utf8(JSON.stringify(basePackages))),
        package_count: basePackages.length,
        package_order: basePackages.map((pkg) => pkg.full_name),
      },
    },
    acceptance_vfs: {
      asset: "kandelo-homebrew.vfs.zst",
      sha256: ACCEPTANCE_SHA,
      bytes: 1,
    },
    deferred_trees: [dataTree.tree, execTree.tree],
  };
  const descriptor = closeHomebrewLazyLayerDescriptor(draft, {
    descriptor: {
      asset: "kandelo-homebrew-vfs.json",
      sha256: "8".repeat(64),
      bytes: 1,
    },
    report: {
      asset: "kandelo-homebrew-vfs-report.json",
      sha256: "9".repeat(64),
      bytes: 1,
    },
    node: {
      asset: "kandelo-homebrew-node-evidence.json",
      sha256: "a".repeat(64),
      bytes: 1,
    },
    browser: {
      asset: "kandelo-homebrew-browser-evidence.json",
      sha256: "b".repeat(64),
      bytes: 1,
    },
  });
  urls.descriptor =
    `https://github.com/${RELEASE_REPOSITORY}/releases/download/` +
    `${descriptor.release.tag}/${homebrewRuntimeLayerDescriptorAsset(PACKAGE)}`;
  const mirrorUrl = (treeId: string): string => {
    const tree = descriptor.deferred_trees.find((candidate) =>
      candidate.id === treeId
    );
    const transport = tree?.transports.find((candidate) =>
      candidate.kind === "bundle-release"
    );
    if (!transport) throw new Error(`missing bundle mirror for ${treeId}`);
    return transport.url;
  };
  urls.dataMirror = mirrorUrl(`${PACKAGE}-data`);
  const descriptorBytes = encodeHomebrewLazyLayerDescriptor(descriptor);
  const bootDescriptor: BootDescriptor = {
    version: 1,
    id: "package-layer-acceptance",
    title: "Package layer acceptance",
    base: `kandelo:shell@abi${ABI_VERSION}`,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: 2048,
      features: ["shared-array-buffer"],
      time: "real",
    },
    packages: [`${TAP_NAME}/${PACKAGE}`],
    mounts: [
      { path: "/", source: "image", ref: urls.base, readonly: false },
      {
        path: "/",
        source: "package-layer",
        name: PACKAGE,
        url: urls.descriptor,
        ref: `sha256:${sha256(descriptorBytes)}`,
        bytes: descriptorBytes.byteLength,
      },
    ],
    boot: { argv: ["/bin/sh"], cwd: "/", env: {} },
    caps: { network: false },
  };
  return {
    baseImage,
    descriptorBytes,
    descriptor: bootDescriptor,
    dataArchive: dataTree.archive,
    execArchive: execTree.archive,
    dataPath,
    executable,
    urls,
  };
}

test.skip(!available, "package-layer browser fixtures are not built");

test("browser applies a boot-descriptor package layer and materializes each tree on guest use", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const fixture = await createFixture();
  let descriptorFetches = 0;
  let dataFetches = 0;
  let execFetches = 0;
  await routeBytes(page, fixture.urls.base, fixture.baseImage);
  await routeBytes(
    page,
    fixture.urls.descriptor,
    fixture.descriptorBytes,
    () => descriptorFetches++,
  );
  await routeBytes(
    page,
    fixture.urls.data,
    fixture.dataArchive,
    () => dataFetches++,
  );
  await routeBytes(
    page,
    fixture.urls.exec,
    fixture.execArchive,
    () => execFetches++,
  );

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect.poll(
    () => page.evaluate(() => window.__homebrewVfsTestReady),
    { timeout: 120_000 },
  ).toBe(true);

  try {
    const boot = await page.evaluate(
      ({ baseVfsUrl, descriptor }) =>
        window.__bootPackageLayerAcceptance({ baseVfsUrl, descriptor }),
      { baseVfsUrl: fixture.urls.base, descriptor: fixture.descriptor },
    );
    expect(boot.layerIds).toEqual([PACKAGE]);
    expect(descriptorFetches).toBe(1);
    expect(dataFetches).toBe(0);
    expect(execFetches).toBe(0);

    const execution = await page.evaluate(
      ({ executable, dataPath }) => window.__execPackageLayerAcceptance({
        executable: executable,
        argv: ["mount_probe_test", "rootfs", dataPath],
        timeoutMs: 90_000,
      }),
      { executable: fixture.executable, dataPath: fixture.dataPath },
    );
    expect(execution.exitCode, execution.stderr).toBe(0);
    expect(execution.stdout).toContain("ROOTFS size=24 read=24");
    expect(execution.stderr).toBe("");
    expect(dataFetches).toBe(1);
    expect(execFetches).toBe(1);

    await expect(page.evaluate(
      (path) => window.__readPackageLayerAcceptance(path),
      fixture.dataPath,
    )).resolves.toBe("package-layer-first-use\n");
    expect(dataFetches).toBe(1);
    expect(execFetches).toBe(1);
  } finally {
    await page.evaluate(() => window.__destroyPackageLayerAcceptance());
  }
});

test("browser discards each private package-layer stage after repeated boot-prefetch failures", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const fixture = await createFixture({ bootPrefetchTree: "data" });
  let descriptorFetches = 0;
  let directArchiveFetches = 0;
  let mirrorArchiveFetches = 0;
  await routeBytes(page, fixture.urls.base, fixture.baseImage);
  await routeBytes(
    page,
    fixture.urls.descriptor,
    fixture.descriptorBytes,
    () => descriptorFetches++,
  );
  await routeFailure(page, fixture.urls.data, () => directArchiveFetches++);
  await routeFailure(
    page,
    fixture.urls.dataMirror,
    () => mirrorArchiveFetches++,
  );

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect.poll(
    () => page.evaluate(() => window.__homebrewVfsTestReady),
    { timeout: 120_000 },
  ).toBe(true);
  const initialDiscards = await page.evaluate(() =>
    window.__packageLayerDiscardedBufferCount()
  );

  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failure = await page.evaluate(
        async ({ baseVfsUrl, descriptor }) => {
          try {
            await window.__bootPackageLayerAcceptance({ baseVfsUrl, descriptor });
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        { baseVfsUrl: fixture.urls.base, descriptor: fixture.descriptor },
      );
      expect(failure).toContain("failed");
      expect(await page.evaluate(() =>
        window.__packageLayerDiscardedBufferCount()
      )).toBe(initialDiscards + attempt);
    }

    expect(descriptorFetches).toBe(3);
    expect(directArchiveFetches).toBe(3);
    expect(mirrorArchiveFetches).toBe(3);
    await expect(page.evaluate(async (path) => {
      try {
        await window.__readPackageLayerAcceptance(path);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, fixture.dataPath)).resolves.toContain("not booted");
  } finally {
    await page.evaluate(() => window.__destroyPackageLayerAcceptance());
  }
});
