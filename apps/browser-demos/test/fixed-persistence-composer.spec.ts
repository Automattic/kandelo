import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { expect, test, type BrowserType, type Page, type TestInfo } from "@playwright/test";
import { routeCurrentImageModules } from "./support/current-image-module";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import type { OpfsImageIntegrity } from "../../../host/src/vfs/opfs-image-reader";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const imageModulePath = [
  resolve(repoRoot, "local-binaries/kandelo_image_module32.wasm"),
  resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_image_module.wasm"),
].find((path) => existsSync(path) && WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(path))).length === 0) ?? null;
const programPath = tryResolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm");
const composerPath = resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/image-composer-client.ts");
const sourceStagePath = resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/opfs-source-image.ts");
const pagesLoaderPath = resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-loader.ts");
const persistenceModulePath = resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/fixed-persistence-image.ts");
const browserKernelPath = resolve(repoRoot, "host/src/browser-kernel-host.ts");
const fullBrowserProductsReady = [
  "programs/wasm32/bash.wasm",
  "programs/wasm32/shell.vfs.zst",
].every((path) => {
  try {
    return tryResolveBinary(path) !== null;
  } catch {
    return false;
  }
});
const kernelPath = tryResolveBinary("kernel.wasm") ?? [
  resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"),
  resolve(repoRoot, "local-binaries/kernel.wasm"),
].find(existsSync) ?? null;

test.skip(imageModulePath === null || programPath === null, "image writer and guest fixture are required");

async function imageWithState(state: string, largeFileBytes = 0): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.setImageCapacity(largeFileBytes > 0
    ? Math.max(96 * 1024 * 1024, largeFileBytes + 64 * 1024 * 1024)
    : 64 * 1024 * 1024);
  filesystem.mkdir("/etc", 0o755);
  filesystem.mkdir("/etc/kandelo", 0o755);
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode(state), 0o644);
  if (largeFileBytes > 0) filesystem.writeFile("/large", new Uint8Array(largeFileBytes), 0o644);
  filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(programPath!)), 0o755);
  filesystem.writeFile("/etc/kandelo/demo.json", new TextEncoder().encode(JSON.stringify({
    version: 1,
    defaultProfile: "probe",
    profiles: { probe: { identity: { title: "Persistence probe", summary: "Fixed-size overwrite test", accent: "#123456", glyph: "sh" } } },
  })), 0o644);
  filesystem.writeFile("/etc/kandelo/experimental-terminal-session.json", new TextEncoder().encode(JSON.stringify({
    kind: "kandelo-experimental-terminal-session",
    version: 1,
    initial: { path: "/bin/persistence-overwrite", argv: ["persistence-overwrite"], uid: 0, gid: 0 },
  })), 0o644);
  return filesystem.saveImage();
}

async function withOpfsPage<Result>(
  playwright: { chromium: BrowserType; firefox: BrowserType; webkit: BrowserType },
  browserName: "chromium" | "firefox" | "webkit",
  baseURL: string,
  testInfo: TestInfo,
  run: (page: Page) => Promise<Result>,
): Promise<Result> {
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-composer-opfs-"));
  const context = await playwright[browserName].launchPersistentContext(userDataDir, {
    channel: projectUse.channel,
    proxy: projectUse.proxy as never,
    extraHTTPHeaders: projectUse.extraHTTPHeaders,
    ...(projectUse.launchOptions ?? {}),
  });
  try {
    await routeCurrentImageModules(context);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    return await run(page);
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

test("composer reuses exact frozen computer image despite a changed source", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const firstImage = await imageWithState("abcdefgh");
  const changedImage = await imageWithState("changed!");
  const firstUrl = new URL("/fixed-composer-first.vfs", baseURL).href;
  const changedUrl = new URL("/fixed-composer-changed.vfs", baseURL).href;
  await page.route(firstUrl, (route) => route.fulfill({ body: Buffer.from(firstImage) }));
  await page.route(changedUrl, (route) => route.fulfill({ body: Buffer.from(changedImage) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ composerUrl, firstUrl, changedUrl }) => {
    const { composeImageInWorker } = await import(composerUrl);
    const compose = (imageBytes: Uint8Array, frozenImageBytes?: Uint8Array) =>
      composeImageInWorker({
        imageBytes,
        frozenImageBytes,
        maxVfsByteLength: 64 * 1024 * 1024,
        imageLabel: "persistence probe",
        requestedProfileId: "probe",
        requestedProfileSource: "test",
        hasCandidateEvidence: false,
        descriptor: { boot: { inputs: [] } } as never,
        appPath: "/pages/kandelo/",
        proto: "http",
        preforkServiceProcesses: 1,
      }, {
        onTick: () => {},
        isCurrent: () => true,
        supersededError: () => new Error("superseded"),
      });
    const first = await compose(new Uint8Array(await (await fetch(firstUrl)).arrayBuffer()));
    const frozen = first.imageBytes.slice();
    const restored = await compose(new Uint8Array(await (await fetch(changedUrl)).arrayBuffer()), frozen);
    const changed = await compose(new Uint8Array(await (await fetch(changedUrl)).arrayBuffer()));
    const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
    return {
      exact: await digest(first.imageBytes) === await digest(restored.imageBytes),
      differsFromChangedSource: await digest(restored.imageBytes) !== await digest(changed.imageBytes),
      profile: restored.profileId,
    };
  }, {
    composerUrl: new URL(`/@fs/${composerPath}`, baseURL).href,
    firstUrl,
    changedUrl,
  });
  expect(result).toEqual({ exact: true, differsFromChangedSource: true, profile: "probe" });
});

test("compressed source decodes into a bounded OPFS staging file", async ({ playwright, browserName, baseURL }, testInfo) => {
  const image = await imageWithState("compressed");
  const compressed = zstdCompressSync(Buffer.from(image));
  const imageUrl = new URL("/fixed-composer-compressed.vfs.zst", baseURL).href;
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
    await page.route(imageUrl, (route) => route.fulfill({ body: compressed }));
    return page.evaluate(async ({ sourceStageUrl, imageUrl }) => {
      const { stageRawVfsSourceImage } = await import(sourceStageUrl);
      const downloads: number[] = [];
      const decompressions: { completed: number; total?: number; status: string }[] = [];
      const source = await stageRawVfsSourceImage(await fetch(imageUrl),
        (loaded) => downloads.push(loaded), undefined, undefined,
        (progress) => decompressions.push(progress));
      try {
        const file = await source.file.getFile();
        return {
          length: source.integrity.length,
          magic: Array.from(new Uint8Array(await file.slice(0, 4).arrayBuffer())),
          downloaded: downloads.at(-1),
          decompressed: decompressions.at(-1),
          incremental: decompressions.some((progress) => progress.completed > 0 && progress.status === "loading"),
        };
      } finally {
        await source.remove();
      }
    }, {
      sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
      imageUrl,
    });
  });
  expect(result).toEqual({
    length: image.byteLength, magic: Array.from(image.subarray(0, 4)),
    downloaded: compressed.byteLength,
    decompressed: { completed: image.byteLength, total: image.byteLength, status: "complete" },
    incremental: true,
  });
});

for (const compressed of [false, true]) {
test(`source staging snapshots pinned ${compressed ? "compressed" : "raw"} producer windows before callbacks`, async ({ playwright, browserName, baseURL }, testInfo) => {
  const image = await imageWithState("owned-authenticated-source", 128 * 1024);
  const input = compressed ? zstdCompressSync(Buffer.from(image)) : Buffer.from(image);
  const expectedSource = createHash("sha256").update(input).digest("hex");
  const expectedImage = createHash("sha256").update(image).digest("hex");
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async page => {
    return page.evaluate(async ({ sourceStageUrl, bytes, expectedSource }) => {
      const { stageRawVfsSourceImage } = await import(sourceStageUrl);
      const borrowed = new Uint8Array(bytes);
      const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(borrowed); controller.close(); } }));
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
      const before: string[] = [];
      for await (const name of directory.keys()) before.push(name);
      let changed = false;
      let digest: string | null = null;
      let refusal = "";
      try {
        const source = await stageRawVfsSourceImage(response, () => {
          if (!changed) { borrowed.fill(217); changed = true; }
        }, directory, { bytes: borrowed.length, sha256: expectedSource });
        try {
          digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await (await source.file.getFile()).arrayBuffer())),
            byte => byte.toString(16).padStart(2, "0")).join("");
          if (digest !== source.integrity.imageSha256) throw new Error("Staged digest differs from stored bytes");
        } finally { await source.remove(); }
      } catch (error) { refusal = String(error); }
      const after: string[] = [];
      for await (const name of directory.keys()) after.push(name);
      return { changed, digest, refusal, before: before.sort(), after: after.sort() };
    }, { sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href, bytes: Array.from(input), expectedSource });
  });
  expect(result.changed).toBe(true);
  if (result.digest !== null) { expect(result.digest).toBe(expectedImage); expect(result.refusal).toBe(""); }
  else expect(result.refusal).not.toBe("");
  expect(result.after).toEqual(result.before);
});
}

test("source staging rejects an advertised body beyond its OPFS bound", async ({ playwright, browserName, baseURL }, testInfo) => {
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
    return page.evaluate(async (sourceStageUrl) => {
      const { MAX_STAGED_VFS_IMAGE_BYTES, stageRawVfsSourceImage } = await import(sourceStageUrl);
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(
        "kandelo-persistent-overlay", { create: true },
      );
      const before: string[] = [];
      for await (const name of directory.keys()) before.push(name);
      const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close(); },
      }), { headers: { "content-length": String(MAX_STAGED_VFS_IMAGE_BYTES + 1) } });
      let error = "";
      try {
        await stageRawVfsSourceImage(response, () => {}, directory);
      } catch (caught) {
        error = String(caught);
      }
      const staged: string[] = [];
      for await (const name of directory.keys()) staged.push(name);
      return { error, before: before.sort(), staged: staged.sort(), bound: MAX_STAGED_VFS_IMAGE_BYTES };
    }, new URL(`/@fs/${sourceStagePath}`, baseURL).href);
  });
  expect(result.bound).toBe(64 * 1024 * 1024 * 1024);
  expect(result.error).toContain("VFS source exceeds its staged byte bound");
  expect(result.staged).toEqual(result.before);
});

test("compressed source rejects oversized windows without publishing a stage", async ({ playwright, browserName, baseURL }, testInfo) => {
  const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff, 0x01, 0x00, 0x00]);
  const imageUrl = new URL("/fixed-composer-bad-window.vfs.zst", baseURL).href;
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
    await page.route(imageUrl, (route) => route.fulfill({ body: frame }));
    return page.evaluate(async ({ sourceStageUrl, imageUrl }) => {
      const { stageRawVfsSourceImage } = await import(sourceStageUrl);
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(
        "kandelo-persistent-overlay", { create: true },
      );
      const before: string[] = [];
      for await (const name of directory.keys()) before.push(name);
      let error = "";
      try {
        await stageRawVfsSourceImage(await fetch(imageUrl), () => {}, directory);
      } catch (caught) {
        error = String(caught);
      }
      const after: string[] = [];
      for await (const name of directory.keys()) after.push(name);
      return { error, before: before.sort(), after: after.sort() };
    }, {
      sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
      imageUrl,
    });
  });
  expect(result.error).toContain("streaming window bound");
  expect(result.after).toEqual(result.before);
});

test("compressed source larger than the composer VFS budget stages without a decoded page buffer", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const image = await imageWithState("compressed-large", 68 * 1024 * 1024);
  const compressed = zstdCompressSync(Buffer.from(image));
  const imageUrl = new URL("/fixed-composer-large-compressed.vfs.zst", baseURL).href;
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
    await page.route(imageUrl, (route) => route.fulfill({ body: compressed }));
    return page.evaluate(async ({ sourceStageUrl, imageUrl }) => {
      const { stageRawVfsSourceImage } = await import(sourceStageUrl);
      let memory: { wasmPages: number; inputWindowPeak: number; callerInputChunkPeak: number; callerInputBackingPeak: number } | undefined;
      const source = await stageRawVfsSourceImage(await fetch(imageUrl), () => {}, undefined, undefined, undefined,
        { onMemoryUsage: (usage) => { memory = usage; } });
      try {
        const file = await source.file.getFile();
        return {
          length: source.integrity.length,
          fileLength: file.size,
          magic: Array.from(new Uint8Array(await file.slice(0, 4).arrayBuffer())),
          memory,
        };
      } finally {
        await source.remove();
      }
    }, {
      sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
      imageUrl,
    });
  });
  expect(result.length).toBe(image.byteLength);
  expect(result.length).toBeGreaterThan(64 * 1024 * 1024);
  expect(result.fileLength).toBe(image.byteLength);
  expect(result.magic).toEqual(Array.from(image.subarray(0, 4)));
  expect(result.memory).toBeDefined();
  expect(result.memory!.wasmPages).toBeLessThanOrEqual(1024);
  expect(result.memory!.inputWindowPeak).toBeLessThanOrEqual(65536);
  expect(result.memory!.callerInputChunkPeak).toBeLessThanOrEqual(65536);
  expect(result.memory!.callerInputBackingPeak).toBeLessThanOrEqual(65536);
});

test("compressed source stages more than 1 GiB without an image-sized buffer", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.skip(!process.env.KANDELO_LARGE_SOURCE_STAGE, "requires the opt-in large source staging run");
  test.setTimeout(600_000);
  const frameBytes = 1024 * 1024;
  const frameCount = 1025;
  const frame = zstdCompressSync(Buffer.alloc(frameBytes));
  const compressed = Buffer.concat(Array.from({ length: frameCount }, () => frame));
  const imageUrl = new URL("/fixed-composer-over-gib-compressed.vfs.zst", baseURL).href;
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
    await page.route(imageUrl, (route) => route.fulfill({ body: compressed }));
    return page.evaluate(async ({ sourceStageUrl, imageUrl }) => {
      const { stageRawVfsSourceImage } = await import(sourceStageUrl);
      const source = await stageRawVfsSourceImage(await fetch(imageUrl), () => {});
      try {
        const file = await source.file.getFile();
        return {
          length: source.integrity.length,
          fileLength: file.size,
          chunks: source.integrity.imageSha256 === undefined ? 0 : 1,
          lastByte: new Uint8Array(await file.slice(-1).arrayBuffer())[0],
        };
      } finally {
        await source.remove();
      }
    }, {
      sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
      imageUrl,
    });
  });
  expect(result).toEqual({
    length: frameBytes * frameCount,
    fileLength: frameBytes * frameCount,
    chunks: 1,
    lastByte: 0,
  });
});

test("compressed source accepts concatenated frames and skips bounded padding", async ({ playwright, browserName, baseURL }, testInfo) => {
  const image = await imageWithState("concatenated");
  const middle = Math.floor(image.byteLength / 2);
  const padding = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x03, 0x00, 0x00, 0x00, 1, 2, 3]);
  const compressed = Buffer.concat([
    zstdCompressSync(Buffer.from(image.subarray(0, middle))),
    padding,
    zstdCompressSync(Buffer.from(image.subarray(middle))),
  ]);
  const imageUrl = new URL("/fixed-composer-multiframe.vfs.zst", baseURL).href;
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
    await page.route(imageUrl, (route) => route.fulfill({ body: compressed }));
    return page.evaluate(async ({ sourceStageUrl, imageUrl }) => {
      const { stageRawVfsSourceImage } = await import(sourceStageUrl);
      const source = await stageRawVfsSourceImage(await fetch(imageUrl), () => {});
      try {
        const bytes = new Uint8Array(await (await source.file.getFile()).arrayBuffer());
        return { length: bytes.byteLength, last: Array.from(bytes.subarray(-16)) };
      } finally {
        await source.remove();
      }
    }, {
      sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
      imageUrl,
    });
  });
  expect(result).toEqual({ length: image.byteLength, last: Array.from(image.subarray(-16)) });
});

test("truncated compressed source removes its partial OPFS stage", async ({ playwright, browserName, baseURL }, testInfo) => {
  const compressed = zstdCompressSync(Buffer.from(await imageWithState("truncated")));
  const imageUrl = new URL("/fixed-composer-truncated.vfs.zst", baseURL).href;
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
    await page.route(imageUrl, (route) => route.fulfill({ body: compressed.subarray(0, compressed.byteLength - 4) }));
    return page.evaluate(async ({ sourceStageUrl, imageUrl }) => {
      const { stageRawVfsSourceImage } = await import(sourceStageUrl);
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(
        "kandelo-persistent-overlay", { create: true },
      );
      const before: string[] = [];
      for await (const name of directory.keys()) before.push(name);
      let error = "";
      try {
        await stageRawVfsSourceImage(await fetch(imageUrl), () => {}, directory);
      } catch (caught) {
        error = String(caught);
      }
      const after: string[] = [];
      for await (const name of directory.keys()) after.push(name);
      return { error, before: before.sort(), after: after.sort() };
    }, {
      sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
      imageUrl,
    });
  });
  expect(result.error).toContain("truncated");
  expect(result.after).toEqual(result.before);
});

test("source staging reclaims abandoned files without deleting an active source", async ({ playwright, browserName, baseURL }, testInfo) => {
  const image = await imageWithState("source-lock");
  const imageUrl = new URL("/fixed-composer-source-lock.vfs", baseURL).href;
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
    await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
    return page.evaluate(async ({ sourceStageUrl, imageUrl }) => {
      const { stageRawVfsSourceImage } = await import(sourceStageUrl);
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(
        "kandelo-persistent-overlay", { create: true },
      );
      const orphanName = `source-${crypto.randomUUID()}.vfs`;
      const orphan = await directory.getFileHandle(orphanName, { create: true });
      const writable = await orphan.createWritable();
      await writable.write(new Uint8Array([1, 2, 3]));
      await writable.close();
      const first = await stageRawVfsSourceImage(await fetch(imageUrl), () => {}, directory);
      try {
        const second = await stageRawVfsSourceImage(await fetch(imageUrl), () => {}, directory);
        try {
          const names: string[] = [];
          for await (const name of directory.keys()) names.push(name);
          return {
            orphanPresent: names.includes(orphanName),
            activeSources: names.filter((name) => name.startsWith("source-")).length,
            firstLength: (await first.file.getFile()).size,
            secondLength: (await second.file.getFile()).size,
          };
        } finally {
          await second.remove();
        }
      } finally {
        await first.remove();
      }
    }, {
      sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
      imageUrl,
    });
  });
  expect(result).toEqual({
    orphanPresent: false,
    activeSources: 2,
    firstLength: image.byteLength,
    secondLength: image.byteLength,
  });
});

test("Pages product streams authenticated compressed bytes without eager activation", async ({ playwright, browserName, baseURL }, testInfo) => {
  const image = await imageWithState("pages-positioned");
  const compressed = zstdCompressSync(Buffer.from(image));
  const digest = createHash("sha256").update(compressed).digest("hex");
  const productPath = `/products/browser-main-shell/sha256-${digest}/browser-main-shell-1.vfs.zst`;
  const badDigest = "0".repeat(64);
  const badPath = `/products/browser-main-shell/sha256-${badDigest}/browser-main-shell-1.vfs.zst`;
  const result = await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
    await page.route(new URL(productPath, baseURL).href, (route) => route.fulfill({ body: compressed }));
    await page.route(new URL(badPath, baseURL).href, (route) => route.fulfill({ body: compressed }));
    return page.evaluate(async ({ loaderUrl, productPath, badPath, digest, badDigest, encodedLength }) => {
      const { createPagesVfsProductLoaderForBase } = await import(loaderUrl);
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(
        "kandelo-persistent-overlay", { create: true },
      );
      const makeEntry = (path: string, sha256: string) => ({
        id: "browser-main-shell", load: "eager" as const,
        path, sha256, bytes: encodedLength,
      });
      let requests = 0;
      const loader = createPagesVfsProductLoaderForBase(
        [makeEntry(productPath, digest)],
        (url: string, init: RequestInit) => { requests++; return fetch(url, init); },
        "/",
        { prefetchEager: false },
      );
      const resolved = await loader.resolve("browser-main-shell");
      const beforeActivation = requests;
      const activation = await loader.activatePositioned("browser-main-shell", directory);
      const length = activation.source.integrity.length;
      const fileLength = (await activation.source.file.getFile()).size;
      await activation.source.remove();
      const badLoader = createPagesVfsProductLoaderForBase(
        [makeEntry(badPath, badDigest)],
        (url: string, init: RequestInit) => fetch(url, init),
        "/",
        { prefetchEager: false },
      );
      let error = "";
      try {
        await badLoader.activatePositioned("browser-main-shell", directory);
      } catch (caught) {
        error = String(caught);
      }
      const names: string[] = [];
      for await (const name of directory.keys()) names.push(name);
      return {
        resolvedUrl: resolved.imageUrl,
        beforeActivation,
        requests,
        length,
        fileLength,
        error,
        sourceFiles: names.filter((name) => name.startsWith("source-")),
      };
    }, {
      loaderUrl: new URL(`/@fs/${pagesLoaderPath}`, baseURL).href,
      productPath,
      badPath,
      digest,
      badDigest,
      encodedLength: compressed.byteLength,
    });
  });
  expect(result.resolvedUrl).toBe(new URL(productPath, baseURL).href);
  expect(result.beforeActivation).toBe(0);
  expect(result.requests).toBe(1);
  expect(result.length).toBe(image.byteLength);
  expect(result.fileLength).toBe(image.byteLength);
  expect(result.error).toContain("SHA-256");
  expect(result.sourceFiles).toEqual([]);
});

for (const scenario of [
  { title: "composer VFS budget", fileBytes: 68 * 1024 * 1024, budgetBytes: 64 * 1024 * 1024, memoryProfile: undefined, resizable: false },
  { title: "@slow constrained kernel memory budget", fileBytes: 772 * 1024 * 1024, budgetBytes: 768 * 1024 * 1024, memoryProfile: "constrained", resizable: true },
] as const) {
  test(`positioned install persists writes to an image larger than the ${scenario.title}`, async ({ playwright, browserName, baseURL }, testInfo) => {
    test.setTimeout(scenario.memoryProfile === undefined ? 180_000 : 600_000);
    test.skip(kernelPath === null, "kernel artifact is required");
    const image = await imageWithState("large-image", scenario.fileBytes);
    expect(image.byteLength).toBeGreaterThan(scenario.budgetBytes);
    const fixtureDir = mkdtempSync(join(repoRoot, ".context/large-source-"));
    const imagePath = join(fixtureDir, "image.vfs");
    writeFileSync(imagePath, image);
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(image.byteLength),
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      });
      void (async () => {
        for await (const bytes of createReadStream(imagePath, { highWaterMark: 64 * 1024 })) {
          if (!response.write(bytes)) await once(response, "drain");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        response.end();
      })().catch(() => response.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("source server has no port");
    const imageUrl = `http://127.0.0.1:${address.port}/image.vfs`;
    const kernelUrl = new URL("/fixed-composer-kernel.wasm", baseURL).href;
    const projectUse = testInfo.project.use as {
      channel?: string;
      launchOptions?: Record<string, unknown>;
      proxy?: Record<string, unknown>;
      extraHTTPHeaders?: Record<string, string>;
    };
    const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-composer-large-"));
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      await routeCurrentImageModules(context);
      const page = context.pages()[0] ?? await context.newPage();
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ sourceStageUrl, composerUrl, persistenceUrl, browserKernelUrl, imageUrl, kernelUrl, memoryProfile, resizable }) => {
        const { stageRawVfsSourceImage } = await import(sourceStageUrl);
        const { composeImageInWorker } = await import(composerUrl);
        const { loadFixedPersistenceImageHandle } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const stagingDirectory = await (await navigator.storage.getDirectory()).getDirectoryHandle(
          "kandelo-persistent-overlay", { create: true },
        );
        const response = await fetch(imageUrl);
        const source = await stageRawVfsSourceImage(response, () => {}, stagingDirectory);
        if (source instanceof Uint8Array) throw new Error("large source was materialized");
        const name = `large-${crypto.randomUUID()}`;
        const identity = "large positioned install";
        let composed;
        try {
          composed = await composeImageInWorker({
            imageBytes: new Uint8Array(),
            positionedSource: { file: source.file, integrity: source.integrity },
            persistentImage: { integrityPolicy: "crc32c", name, identity },
            maxVfsByteLength: 64 * 1024 * 1024,
            imageLabel: "large positioned install",
            requestedProfileId: "probe",
            requestedProfileSource: "test",
            hasCandidateEvidence: false,
            descriptor: { boot: { inputs: [] } } as never,
            appPath: "/pages/kandelo/",
            proto: "http",
            preforkServiceProcesses: 1,
          }, {
            onTick: () => {},
            isCurrent: () => true,
            supersededError: () => new Error("superseded"),
          });
        } finally {
          await source.remove();
        }
        const restored = await loadFixedPersistenceImageHandle(name, identity);
        if (restored === null) throw new Error("large image was not published");
        const kernel = new BrowserKernel({ kernelOwnedFs: true, memoryProfile });
        let state: string;
        let largeFileSize: number | undefined;
        let written: string;
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: restored.file, persistentImageBinding: restored.persistentImageBinding,
            ...(resizable ? { experimentalResizablePersistenceName: name } : { experimentalFixedPersistenceName: name }),
            persistentComputerName: name,
          });
          state = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
          largeFileSize = (await kernel.statVfsPath("/large"))?.size;
          const { exit } = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
          if (await exit !== 0) throw new Error("large-image guest overwrite failed");
          const tailWrite = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "large-tail"]);
          if (await tailWrite.exit !== 0) throw new Error("large-image guest tail write failed");
          if (resizable) {
            const created = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "create-tree"]);
            if (await created.exit !== 0) throw new Error("large-image namespace creation failed");
          }
          written = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
        } finally {
          await kernel.destroy();
        }
        let snapshotIntegrity: OpfsImageIntegrity | undefined;
        if (memoryProfile === "constrained") {
          const snapshotKernel = new BrowserKernel({ kernelOwnedFs: true, memoryProfile });
          try {
            await snapshotKernel.initFromOpfsImage({
              kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
              vfsImageFile: restored.file, persistentImageBinding: restored.persistentImageBinding,
              ...(resizable ? { experimentalResizablePersistenceName: name } : { experimentalFixedPersistenceName: name }),
              persistentComputerName: name,
            });
            const snapshotFile = await stagingDirectory.getFileHandle(`${name}.snapshot`, { create: true });
            snapshotIntegrity = await snapshotKernel.exportRootfsImageToFile(snapshotFile);
          } finally {
            await snapshotKernel.destroy();
          }
        }
        return {
          name,
          identity,
          sourceLength: source.integrity.length,
          composedLength: composed.imageFile?.length,
          returnedBytes: composed.imageBytes.byteLength,
          memoryUsage: composed.memoryUsage,
          state,
          written,
          largeFileSize,
          snapshotIntegrity,
        };
      }, {
        sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
        composerUrl: new URL(`/@fs/${composerPath}`, baseURL).href,
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        imageUrl,
        kernelUrl,
        memoryProfile: scenario.memoryProfile,
        resizable: scenario.resizable,
      });
      expect(result.sourceLength).toBeGreaterThan(scenario.budgetBytes);
      expect(result.memoryUsage).toBeDefined();
      expect(result.memoryUsage!.sourceBytes).toBe(0);
      expect(result.memoryUsage!.frozenSourceBytes).toBe(0);
      expect(result.memoryUsage!.returnedBytes).toBe(0);
      expect(result.memoryUsage!.wasmPages * 65536).toBeLessThan(result.sourceLength);
      expect(result.memoryUsage!.manifest?.used).toBe(0);
      expect(result.memoryUsage!.manifest!.peak).toBeGreaterThan(0);
      expect(result.memoryUsage!.manifest!.peak).toBeLessThanOrEqual(result.memoryUsage!.manifest!.limit);
      await testInfo.attach("positioned-composer-memory", { contentType: "application/json", body: JSON.stringify(result.memoryUsage) });
      expect(result.composedLength).toBeGreaterThan(scenario.budgetBytes);
      expect(result.returnedBytes).toBe(0);
      expect(result.state).toBe("large-image");
      expect(result.written).toBe("XYrge-image");
      expect(result.largeFileSize).toBe(scenario.fileBytes);
      if (scenario.memoryProfile === "constrained") {
        expect(result.snapshotIntegrity?.length).toBeGreaterThan(scenario.budgetBytes);
      }
      await page.reload();
      const recovered = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, kernelUrl, name, identity, memoryProfile, snapshotIntegrity, resizable }) => {
        const { loadFixedPersistenceImageHandle } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const restored = await loadFixedPersistenceImageHandle(name, identity);
        if (restored === null) throw new Error("large image was not retained across page reload");
        const kernel = new BrowserKernel({ kernelOwnedFs: true, memoryProfile });
        let state: string;
        let largeFileSize: number | undefined;
        let tailVerified: boolean;
        let tree: string | undefined;
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: restored.file, persistentImageBinding: restored.persistentImageBinding,
            ...(resizable ? { experimentalResizablePersistenceName: name } : { experimentalFixedPersistenceName: name }),
            persistentComputerName: name,
          });
          const tailVerify = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "verify-large-tail"]);
          state = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
          largeFileSize = (await kernel.statVfsPath("/large"))?.size;
          tailVerified = await tailVerify.exit === 0;
          if (resizable) tree = new TextDecoder().decode((await kernel.readFileFromVfs("/persist-tree/nested/file"))!);
        } finally {
          await kernel.destroy();
        }
        let snapshotState: string | undefined;
        let snapshotTailVerified: boolean | undefined;
        let snapshotTree: string | undefined;
        if (snapshotIntegrity !== undefined) {
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
          const snapshotFile = await directory.getFileHandle(`${name}.snapshot`);
          const snapshotKernel = new BrowserKernel({ kernelOwnedFs: true, memoryProfile });
          try {
            await snapshotKernel.initFromOpfsImage({
              kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
              vfsImageFile: snapshotFile,
              integrity: snapshotIntegrity,
            });
            snapshotState = new TextDecoder().decode(await snapshotKernel.readFileFromVfs("/state"));
            const verify = await snapshotKernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "verify-large-tail"]);
            snapshotTailVerified = await verify.exit === 0;
            if (resizable) snapshotTree = new TextDecoder().decode((await snapshotKernel.readFileFromVfs("/persist-tree/nested/file"))!);
          } finally {
            await snapshotKernel.destroy();
          }
        }
        return { state, largeFileSize, tailVerified, snapshotState, snapshotTailVerified, tree, snapshotTree };
      }, {
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: result.name,
        identity: result.identity,
        memoryProfile: scenario.memoryProfile,
        resizable: scenario.resizable,
        snapshotIntegrity: result.snapshotIntegrity,
      });
      expect(recovered).toEqual({
        state: "XYrge-image",
        largeFileSize: scenario.fileBytes,
        tailVerified: true,
        tree: scenario.resizable ? "TREE" : undefined,
        snapshotTree: scenario.resizable ? "TREE" : undefined,
        snapshotState: scenario.memoryProfile === "constrained" ? "XYrge-image" : undefined,
        snapshotTailVerified: scenario.memoryProfile === "constrained" ? true : undefined,
      });
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
}

test("composer stages a persistent image in OPFS without returning its bytes", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(kernelPath === null, "kernel artifact is required");
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-composer-stream-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      await routeCurrentImageModules(context);
      const page = context.pages()[0] ?? await context.newPage();
      const image = await imageWithState("abcdefgh");
      const replacementImage = await imageWithState("replacement");
      const imageUrl = new URL("/fixed-composer-stream.vfs", baseURL).href;
      const replacementUrl = new URL("/fixed-composer-replacement.vfs", baseURL).href;
      const kernelUrl = new URL("/fixed-composer-kernel.wasm", baseURL).href;
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.route(replacementUrl, (route) => route.fulfill({ body: Buffer.from(replacementImage) }));
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ composerUrl, sourceStageUrl, persistenceUrl, browserKernelUrl, imageUrl, kernelUrl }) => {
        const { composeImageInWorker } = await import(composerUrl);
        const { stageRawVfsSourceImage } = await import(sourceStageUrl);
        const { loadFixedPersistenceImageHandle, markFixedPersistenceJournalInitialized } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const name = `composer-${crypto.randomUUID()}`;
        const identity = "composer stream probe";
        const journalName = `j-${crypto.randomUUID()}`;
        const ticks: string[] = [];
        const source = await stageRawVfsSourceImage(await fetch(imageUrl), () => {});
        if (source instanceof Uint8Array) throw new Error("raw fixture was treated as compressed");
        const composed = await composeImageInWorker({
          imageBytes: new Uint8Array(),
          positionedSource: {
            file: source.file,
            integrity: source.integrity,
          },
          persistentImage: { integrityPolicy: "crc32c", name, identity, journalName },
          maxVfsByteLength: 64 * 1024 * 1024,
          imageLabel: "persistence probe",
          requestedProfileId: "probe",
          requestedProfileSource: "test",
          hasCandidateEvidence: false,
          descriptor: { boot: { inputs: [] } } as never,
          appPath: "/pages/kandelo/",
          proto: "http",
          preforkServiceProcesses: 1,
        }, {
          onTick: (message) => ticks.push(message),
          isCurrent: () => true,
          supersededError: () => new Error("superseded"),
        }).catch((error: unknown) => {
          throw new Error(`${String(error)}; composer ticks: ${ticks.join(" | ")}`);
        });
        await source.remove();
        const restored = await loadFixedPersistenceImageHandle(name, identity);
        if (restored?.journalName !== journalName) throw new Error("journal namespace was not retained");
        const initialJournalPending = restored.journalInitialized === false;
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const open = async (requireExistingRootfsPersistence = false) => {
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm: kernelBytes,
              vfsImageFile: restored!.file, persistentImageBinding: restored!.persistentImageBinding,
              experimentalFixedPersistenceName: restored.journalName,
              persistentComputerName: name,
              requireExistingRootfsPersistence,
            });
            return kernel;
          } catch (error) {
            await kernel.destroy();
            throw error;
          }
        };
        const firstKernel = await open();
        let initial: string;
        try {
          await markFixedPersistenceJournalInitialized(name, identity, restored);
          initial = new TextDecoder().decode(await firstKernel.readFileFromVfs("/state"));
          const { exit } = await firstKernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
          if (await exit !== 0) throw new Error("guest persistence write failed");
        } finally {
          await firstKernel.destroy();
        }
        const journalReady = (await loadFixedPersistenceImageHandle(name, identity))?.journalInitialized === true;
        const secondKernel = await open(true);
        let recovered: string;
        try {
          recovered = new TextDecoder().decode(await secondKernel.readFileFromVfs("/state"));
        } finally {
          await secondKernel.destroy();
        }
        const overlayDirectory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        await overlayDirectory.removeEntry(`${journalName}.journal`);
        let missingJournalRejected = false;
        try {
          const unexpectedlyOpened = await open(true);
          await unexpectedlyOpened.destroy();
        } catch (error) {
          missingJournalRejected = String(error).includes("refusing to reset");
        }
        let missingJournalRecreated = true;
        try {
          await overlayDirectory.getFileHandle(`${journalName}.journal`);
        } catch (error) {
          missingJournalRecreated = !(error instanceof DOMException && error.name === "NotFoundError");
        }
        const emptyJournal = await overlayDirectory.getFileHandle(`${journalName}.journal`, { create: true });
        let emptyJournalRejected = false;
        try {
          const unexpectedlyOpened = await open(true);
          await unexpectedlyOpened.destroy();
        } catch (error) {
          emptyJournalRejected = String(error).includes("refusing to reset");
        }
        const supersededName = `composer-${crypto.randomUUID()}`;
        let current = true;
        let superseded = false;
        try {
          await composeImageInWorker({
            imageBytes: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
            persistentImage: { integrityPolicy: "crc32c", name: supersededName, identity },
            maxVfsByteLength: 64 * 1024 * 1024,
            imageLabel: "persistence probe",
            requestedProfileId: "probe",
            requestedProfileSource: "test",
            hasCandidateEvidence: false,
            descriptor: { boot: { inputs: [] } } as never,
            appPath: "/pages/kandelo/",
            proto: "http",
            preforkServiceProcesses: 1,
          }, {
            onTick: (message) => {
              if (message === "persistent image readback verified") current = false;
            },
            isCurrent: () => current,
            supersededError: () => new Error("superseded"),
          });
        } catch (error) {
          superseded = String(error).includes("superseded");
        }
        const damagedSource = await stageRawVfsSourceImage(await fetch(imageUrl), () => {});
        if (damagedSource instanceof Uint8Array) throw new Error("raw fixture was treated as compressed");
        const damagedBytes = new Uint8Array(await (await fetch(imageUrl)).arrayBuffer());
        damagedBytes[damagedBytes.byteLength - 1] ^= 1;
        const damagedWriter = await damagedSource.file.createWritable();
        await damagedWriter.write(damagedBytes);
        await damagedWriter.close();
        const damagedName = `composer-damaged-${crypto.randomUUID()}`;
        let damagedRefused = false;
        try {
          await composeImageInWorker({
            imageBytes: new Uint8Array(),
            positionedSource: { file: damagedSource.file, integrity: damagedSource.integrity },
            persistentImage: { integrityPolicy: "crc32c", name: damagedName, identity },
            maxVfsByteLength: 64 * 1024 * 1024,
            imageLabel: "persistence probe",
            requestedProfileId: "probe",
            requestedProfileSource: "test",
            hasCandidateEvidence: false,
            descriptor: { boot: { inputs: [] } } as never,
            appPath: "/pages/kandelo/",
            proto: "http",
            preforkServiceProcesses: 1,
          }, {
            onTick: () => {},
            isCurrent: () => true,
            supersededError: () => new Error("superseded"),
          });
        } catch (error) {
          damagedRefused = (error as { errno?: number }).errno === 5 && String(error).includes("verifyPositionedSource");
        } finally {
          await damagedSource.remove();
        }
        const pendingName = `composer-pending-${crypto.randomUUID()}`;
        await composeImageInWorker({
          imageBytes: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
          persistentImage: { integrityPolicy: "crc32c", name: pendingName, identity },
          maxVfsByteLength: 64 * 1024 * 1024,
          imageLabel: "persistence probe",
          requestedProfileId: "probe",
          requestedProfileSource: "test",
          hasCandidateEvidence: false,
          descriptor: { boot: { inputs: [] } } as never,
          appPath: "/pages/kandelo/",
          proto: "http",
          preforkServiceProcesses: 1,
        }, {
          onTick: () => {},
          isCurrent: () => true,
          supersededError: () => new Error("superseded"),
        });
        return {
          pendingName,
          returnedBytes: composed.imageBytes.byteLength,
          stagedLength: composed.imageFile?.length,
          restoredLength: restored?.length,
          profile: restored?.composition.profileId,
          initial,
          recovered,
          initialJournalPending,
          journalReady,
          missingJournalRejected,
          missingJournalRecreated,
          emptyJournalRejected,
          emptyJournalSize: (await emptyJournal.getFile()).size,
          fileMatches: composed.imageFile !== undefined && restored !== null
            ? await composed.imageFile.file.isSameEntry(restored.file)
            : false,
          superseded,
          supersededUnpublished: await loadFixedPersistenceImageHandle(supersededName, identity) === null,
          damagedRefused,
          damagedUnpublished: await loadFixedPersistenceImageHandle(damagedName, identity) === null,
        };
      }, {
        composerUrl: new URL(`/@fs/${composerPath}`, baseURL).href,
        sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        imageUrl,
        kernelUrl,
      });
      expect(result.returnedBytes).toBe(0);
      expect(result.stagedLength).toBeGreaterThan(0);
      expect(result.restoredLength).toBe(result.stagedLength);
      expect(result.profile).toBe("probe");
      expect(result.initial).toBe("abcdefgh");
      expect(result.recovered).toBe("XYcdefgh");
      expect(result.initialJournalPending).toBe(true);
      expect(result.journalReady).toBe(true);
      expect(result.missingJournalRejected).toBe(true);
      expect(result.missingJournalRecreated).toBe(false);
      expect(result.emptyJournalRejected).toBe(true);
      expect(result.emptyJournalSize).toBe(0);
      expect(result.fileMatches).toBe(true);
      expect(result.superseded).toBe(true);
      expect(result.supersededUnpublished).toBe(true);
      expect(result.damagedRefused).toBe(true);
      expect(result.damagedUnpublished).toBe(true);
      await page.reload();
      const pendingBoot = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, kernelUrl, name }) => {
        const { loadFixedPersistenceImageHandle, markFixedPersistenceJournalInitialized } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const identity = "composer stream probe";
        const pending = await loadFixedPersistenceImageHandle(name, identity);
        if (pending === null) throw new Error("pending image disappeared after reload");
        const overlayDirectory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        let journalMissingBeforeBoot = false;
        try {
          await overlayDirectory.getFileHandle(`${pending.journalName}.journal`);
        } catch (error) {
          journalMissingBeforeBoot = error instanceof DOMException && error.name === "NotFoundError";
        }
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: pending.file, persistentImageBinding: pending.persistentImageBinding,
            experimentalFixedPersistenceName: pending.journalName,
            persistentComputerName: name,
            requireExistingRootfsPersistence: pending.journalInitialized,
          });
          await markFixedPersistenceJournalInitialized(name, identity, pending);
          const { exit } = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
          if (await exit !== 0) throw new Error("pending-image guest write failed");
        } finally {
          await kernel.destroy();
        }
        return {
          wasPending: pending.journalInitialized === false,
          journalMissingBeforeBoot,
          nowReady: (await loadFixedPersistenceImageHandle(name, identity))?.journalInitialized === true,
        };
      }, {
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: result.pendingName,
      });
      expect(pendingBoot).toEqual({ wasPending: true, journalMissingBeforeBoot: true, nowReady: true });
      await page.reload();
      const readyBoot = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, kernelUrl, name }) => {
        const { loadFixedPersistenceImageHandle } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const ready = await loadFixedPersistenceImageHandle(name, "composer stream probe");
        if (ready === null) throw new Error("ready image disappeared after reload");
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: ready.file, persistentImageBinding: ready.persistentImageBinding,
            experimentalFixedPersistenceName: ready.journalName,
            persistentComputerName: name,
            requireExistingRootfsPersistence: ready.journalInitialized,
          });
          return {
            ready: ready.journalInitialized,
            state: new TextDecoder().decode(await kernel.readFileFromVfs("/state")),
          };
        } finally {
          await kernel.destroy();
        }
      }, {
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: result.pendingName,
      });
      expect(readyBoot).toEqual({ ready: true, state: "XYcdefgh" });
      const replacement = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, kernelUrl, replacementUrl, name }) => {
        const {
          acquireFixedPersistenceRuntimeLease,
          discardFixedPersistenceStagedReplacement,
          loadFixedPersistenceImageHandle,
          publishFixedPersistenceReplacement,
          stageFixedPersistenceReplacementFromFile,
        } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const identity = "composer stream probe";
        const previous = await loadFixedPersistenceImageHandle(name, identity);
        if (previous === null) throw new Error("replacement source disappeared");
        let sameGenerationRejected = false;
        try {
          await publishFixedPersistenceReplacement(name, identity, previous, previous);
        } catch (error) {
          sameGenerationRejected = String(error).includes("replacement source changed");
        }
        const imageBytes = new Uint8Array(await (await fetch(replacementUrl)).arrayBuffer());
        const overlayDirectory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const sourceName = `replacement-source-${crypto.randomUUID()}`;
        const sourceFile = await overlayDirectory.getFileHandle(sourceName, { create: true });
        const sourceWriter = await sourceFile.createWritable();
        await sourceWriter.write(imageBytes);
        await sourceWriter.close();
        const chunkSha256: string[] = [];
        for (let offset = 0; offset < imageBytes.byteLength; offset += 1024 * 1024) {
          const chunk = imageBytes.subarray(offset, offset + 1024 * 1024);
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", chunk));
          chunkSha256.push(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""));
        }
        const staged = await stageFixedPersistenceReplacementFromFile(
          name, identity, sourceFile,
          { length: imageBytes.byteLength, chunkBytes: 1024 * 1024, chunkSha256 },
          previous.lazyAssets, previous.composition, previous.integrityPolicy,
        );
        await overlayDirectory.removeEntry(sourceName);
        const beforePublish = await loadFixedPersistenceImageHandle(name, identity);
        const currentManifestFile = await overlayDirectory.getFileHandle(`${name}.base.json`);
        const originalManifest = await (await currentManifestFile.getFile()).text();
        const changedManifest = JSON.parse(originalManifest) as {
          composition: { requiredServices: string[] };
          compositionSha256: string;
        };
        changedManifest.composition.requiredServices.push("unexpected-service");
        const changedDigest = await crypto.subtle.digest(
          "SHA-256", new TextEncoder().encode(JSON.stringify(changedManifest.composition)),
        );
        changedManifest.compositionSha256 = Array.from(new Uint8Array(changedDigest),
          (byte) => byte.toString(16).padStart(2, "0")).join("");
        const changedWriter = await currentManifestFile.createWritable();
        await changedWriter.write(JSON.stringify(changedManifest));
        await changedWriter.close();
        let changedSourceManifestRejected = false;
        try {
          await publishFixedPersistenceReplacement(name, identity, previous, staged);
        } catch (error) {
          changedSourceManifestRejected = (error as { recovery?: string }).recovery === "unproven-image-freshness";
        } finally {
          const restoreWriter = await currentManifestFile.createWritable();
          await restoreWriter.write(originalManifest);
          await restoreWriter.close();
        }
        let prematurePublishRejected = false;
        try {
          await publishFixedPersistenceReplacement(name, identity, previous, staged);
        } catch (error) {
          prematurePublishRejected = String(error).includes("journal does not belong to this image or is not initialized");
        }
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        let stagedState: string;
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: staged.file,
            persistentImageBinding: staged.persistentImageBinding,
            experimentalFixedPersistenceName: staged.journalName,
            persistentComputerName: name,
          });
          stagedState = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
        } finally {
          await kernel.destroy();
        }
        const releaseRuntimeLease = await acquireFixedPersistenceRuntimeLease(name);
        let busyPublishRejected = false;
        try {
          await publishFixedPersistenceReplacement(name, identity, previous, staged);
        } catch (error) {
          busyPublishRejected = String(error).includes("already running in another tab");
        } finally {
          await releaseRuntimeLease();
        }
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const journalWriterRejected: boolean[] = [];
        for (const candidate of [previous, staged]) {
          const competing = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await competing.initFromOpfsImage({
              kernelWasm: kernelBytes,
              vfsImageFile: candidate.file, persistentImageBinding: candidate.persistentImageBinding,
              experimentalFixedPersistenceName: candidate.journalName,
              persistentComputerName: `other-${crypto.randomUUID()}`,
              requireExistingRootfsPersistence: true,
            });
            let rejected = false;
            try {
              await publishFixedPersistenceReplacement(name, identity, previous, staged);
            } catch (error) {
              rejected = String(error).includes("journal is already open");
            }
            journalWriterRejected.push(rejected);
          } finally {
            await competing.destroy();
          }
        }
        const filePrototype = Object.getPrototypeOf(previous.file) as FileSystemFileHandle;
        const originalCreateWritable = filePrototype.createWritable;
        const manifestFailures: boolean[] = [];
        for (const fileName of [`${name}.previous.base.json`, `${name}.base.json`]) {
          for (const operation of ["write", "close"] as const) {
            await overlayDirectory.removeEntry(`${name}.previous.base.json`).catch((error) => {
              if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
            });
            let injected = false;
            filePrototype.createWritable = async function (this: FileSystemFileHandle, options) {
              const writer = await originalCreateWritable.call(this, options);
              if (this.name !== fileName) return writer;
              return {
                write: async (...args: Parameters<typeof writer.write>) => {
                  if (operation === "write" && !injected) {
                    injected = true;
                    throw new DOMException("injected manifest write failure", "QuotaExceededError");
                  }
                  return writer.write(...args);
                },
                close: async () => {
                  if (operation === "close" && !injected) {
                    injected = true;
                    throw new DOMException("injected manifest close failure", "QuotaExceededError");
                  }
                  return writer.close();
                },
                abort: () => writer.abort(),
              } as unknown as FileSystemWritableFileStream;
            };
            let rejected = false;
            try {
              await publishFixedPersistenceReplacement(name, identity, previous, staged);
            } catch (error) {
              rejected = String(error).includes("injected manifest");
            } finally {
              filePrototype.createWritable = originalCreateWritable;
            }
            const afterFailure = await loadFixedPersistenceImageHandle(name, identity);
            manifestFailures.push(injected && rejected && afterFailure !== null &&
              await afterFailure.file.isSameEntry(previous.file));
          }
        }
        const interruptedPublications: boolean[] = [];
        for (let cut = 1; cut <= Math.ceil(staged.length / (1024 * 1024)) + 5; cut++) {
          let publicationChecks = 0;
          let interrupted = false;
          try {
            await publishFixedPersistenceReplacement(name, identity, previous, staged, () => {
              if (++publicationChecks === cut) throw new Error("publication interrupted before close");
            });
          } catch (error) {
            interrupted = String(error).includes("publication interrupted before close");
          }
          const afterInterruption = await loadFixedPersistenceImageHandle(name, identity);
          interruptedPublications.push(interrupted && afterInterruption !== null &&
            await afterInterruption.file.isSameEntry(previous.file));
        }
        const lostCloseAcknowledgements: string[] = [];
        filePrototype.createWritable = async function (this: FileSystemFileHandle, options) {
          const writer = await originalCreateWritable.call(this, options);
          const fileName = this.name;
          if (fileName !== `${name}.base.json` && fileName !== `${name}.previous.base.json`) return writer;
          return {
            write: (...args: Parameters<typeof writer.write>) => writer.write(...args),
            close: async () => {
              await writer.close();
              lostCloseAcknowledgements.push(fileName);
              throw new Error("injected lost manifest close acknowledgement");
            },
            abort: () => writer.abort(),
          } as FileSystemWritableFileStream;
        };
        try {
          await publishFixedPersistenceReplacement(name, identity, previous, staged);
        } finally {
          filePrototype.createWritable = originalCreateWritable;
        }
        const current = await loadFixedPersistenceImageHandle(name, identity);
        const publishedStagePreserved = await discardFixedPersistenceStagedReplacement(name, identity, staged) === false;
        let retryManifestWrites = 0;
        filePrototype.createWritable = async function (this: FileSystemFileHandle, options) {
          if (this.name === `${name}.base.json` || this.name === `${name}.previous.base.json`) {
            retryManifestWrites++;
          }
          return originalCreateWritable.call(this, options);
        };
        try {
          await publishFixedPersistenceReplacement(name, identity, previous, staged);
        } finally {
          filePrototype.createWritable = originalCreateWritable;
        }
        const backupFile = await overlayDirectory.getFileHandle(`${name}.previous.base.json`);
        const backupBytes = await (await backupFile.getFile()).arrayBuffer();
        const damagedBackupWriter = await backupFile.createWritable();
        await damagedBackupWriter.write("{}");
        await damagedBackupWriter.close();
        let damagedBackupRejected = false;
        try {
          await publishFixedPersistenceReplacement(name, identity, previous, staged);
        } catch (error) {
          damagedBackupRejected = String(error).includes("base image belongs to a different computer");
        } finally {
          const restoreBackupWriter = await backupFile.createWritable();
          await restoreBackupWriter.write(backupBytes);
          await restoreBackupWriter.close();
        }
        return {
          oldStillCurrentBeforePublish: beforePublish !== null && await beforePublish.file.isSameEntry(previous.file),
          changedSourceManifestRejected,
          sameGenerationRejected,
          prematurePublishRejected,
          busyPublishRejected,
          journalWriterRejected,
          manifestFailures,
          interruptedPublications,
          lostCloseAcknowledgements,
          publishedStagePreserved,
          retryManifestWrites,
          damagedBackupRejected,
          stagedState,
          newReady: current?.journalInitialized === true,
          newCurrent: current !== null && await current.file.isSameEntry(staged.file),
        };
      }, {
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        replacementUrl,
        name: result.pendingName,
      });
      expect(replacement).toEqual({
        oldStillCurrentBeforePublish: true,
        changedSourceManifestRejected: true,
        sameGenerationRejected: true,
        prematurePublishRejected: true,
        busyPublishRejected: true,
        journalWriterRejected: [true, true],
        manifestFailures: [true, true, true, true],
        interruptedPublications: [true, true, true, true, true, true],
        lostCloseAcknowledgements: [`${result.pendingName}.previous.base.json`, `${result.pendingName}.base.json`],
        publishedStagePreserved: true,
        retryManifestWrites: 0,
        damagedBackupRejected: true,
        stagedState: "replacement",
        newReady: true,
        newCurrent: true,
      });
      await page.reload();
      const replacementBoot = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, kernelUrl, name }) => {
        const { loadFixedPersistenceImageHandle } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const current = await loadFixedPersistenceImageHandle(name, "composer stream probe");
        if (current === null) throw new Error("replacement disappeared after reload");
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: current.file, persistentImageBinding: current.persistentImageBinding,
            experimentalFixedPersistenceName: current.journalName,
            persistentComputerName: name,
            requireExistingRootfsPersistence: current.journalInitialized,
          });
          return new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
        } finally {
          await kernel.destroy();
        }
      }, {
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: result.pendingName,
      });
      expect(replacementBoot).toBe("replacement");
      const journalGenerationFallback = await page.evaluate(async ({ persistenceUrl, overlaySelectionUrl, browserKernelUrl, kernelUrl, name }) => {
        const { loadFixedPersistenceImageHandle, loadPreviousFixedPersistenceImageHandle } = await import(persistenceUrl);
        const { isNoValidOverlayGenerationError } = await import(overlaySelectionUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const identity = "composer stream probe";
        const current = await loadFixedPersistenceImageHandle(name, identity);
        if (current === null) throw new Error("replacement disappeared before fault injection");
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const legacyName = `${current.journalName}.journal`;
        const legacy = await directory.getFileHandle(legacyName);
        const legacyBytes = new Uint8Array(await (await legacy.getFile()).arrayBuffer());
        await directory.removeEntry(legacyName);
        const failedGenerationName = `${current.journalName}.g0.journal`;
        const failedSealName = `${current.journalName}.g0.seal`;
        const failedGeneration = await directory.getFileHandle(failedGenerationName, { create: true });
        const failedGenerationWriter = await failedGeneration.createWritable();
        await failedGenerationWriter.write(new Uint8Array([1, 2, 3]));
        await failedGenerationWriter.close();
        const failedSeal = await directory.getFileHandle(failedSealName, { create: true });
        const failedSealWriter = await failedSeal.createWritable();
        await failedSealWriter.write(new Uint8Array([4, 5, 6]));
        await failedSealWriter.close();
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const damaged = new BrowserKernel({ kernelOwnedFs: true });
        let typedFailure = false;
        let failureDetail = "no error";
        try {
          await damaged.initFromOpfsImage({
            kernelWasm: kernelBytes,
            vfsImageFile: current.file, persistentImageBinding: current.persistentImageBinding,
            experimentalFixedPersistenceName: current.journalName,
            persistentComputerName: name,
            requireExistingRootfsPersistence: true,
          });
        } catch (error) {
          typedFailure = isNoValidOverlayGenerationError(error);
          failureDetail = `${error instanceof Error ? error.name : typeof error}: ${String(error)}`;
        } finally {
          await damaged.destroy();
        }
        const previous = await loadPreviousFixedPersistenceImageHandle(name, identity, current);
        const restoredLegacy = await directory.getFileHandle(legacyName, { create: true });
        const restoredWriter = await restoredLegacy.createWritable();
        await restoredWriter.write(legacyBytes);
        await restoredWriter.close();
        await directory.removeEntry(failedGenerationName);
        await directory.removeEntry(failedSealName);
        return { typedFailure, failureDetail, staleFallbackRefused: previous === null };
      }, {
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        overlaySelectionUrl: new URL(`/@fs/${resolve(repoRoot, "host/src/vfs/overlay-generation-selection.ts")}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: result.pendingName,
      });
      expect(journalGenerationFallback.typedFailure, journalGenerationFallback.failureDetail).toBe(true);
      expect(journalGenerationFallback.staleFallbackRefused).toBe(true);
      const damagedGeneration = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, kernelUrl, name }) => {
        const { loadFixedPersistenceImageHandle } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const boot = async (handle: NonNullable<Awaited<ReturnType<typeof loadFixedPersistenceImageHandle>>>) => {
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm: kernelBytes,
              vfsImageFile: handle.file,
              persistentImageBinding: handle.persistentImageBinding,
              experimentalFixedPersistenceName: handle.journalName,
              persistentComputerName: name,
              requireExistingRootfsPersistence: handle.journalInitialized,
            });
            return new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
          } finally {
            await kernel.destroy();
          }
        };
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const manifest = JSON.parse(await (await directory.getFileHandle(`${name}.base.json`)).getFile().then((file) => file.text())) as {
          imageFileName: string;
          journalName: string;
        };
        const imageFile = await directory.getFileHandle(manifest.imageFileName);
        const originalImage = new Uint8Array(await (await imageFile.getFile()).arrayBuffer());
        const damagedImage = originalImage.slice();
        damagedImage[0] ^= 1;
        const imageWriter = await imageFile.createWritable();
        await imageWriter.write(damagedImage);
        await imageWriter.close();
        const refusesDamaged = async () => {
          try {
            const selected = await loadFixedPersistenceImageHandle(name, "composer stream probe");
            if (selected === null) throw new Error("damaged computer was silently reset");
            await boot(selected);
            return false;
          } catch (error) {
            return (error as { recovery?: string }).recovery === "unproven-image-freshness"
              || String(error).includes("damaged") || String(error).includes("NoValidOverlayGenerationError");
          }
        };
        const imageRefused = await refusesDamaged();
        const imageRestore = await imageFile.createWritable();
        await imageRestore.write(originalImage);
        await imageRestore.close();
        const journalFile = await directory.getFileHandle(`${manifest.journalName}.journal`);
        const originalJournal = new Uint8Array(await (await journalFile.getFile()).arrayBuffer());
        const damagedJournal = originalJournal.slice();
        damagedJournal[0] ^= 1;
        const journalWriter = await journalFile.createWritable();
        await journalWriter.write(damagedJournal);
        await journalWriter.close();
        const journalRefused = await refusesDamaged();
        const journalRestore = await journalFile.createWritable();
        await journalRestore.write(originalJournal);
        await journalRestore.close();
        return { imageRefused, journalRefused };
      }, {
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: result.pendingName,
      });
      expect(damagedGeneration).toEqual({
        imageRefused: true,
        journalRefused: true,
      });
      await page.evaluate(async (name) => {
        const overlayDirectory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const currentManifest = await overlayDirectory.getFileHandle(`${name}.base.json`);
        const damagedWriter = await currentManifest.createWritable();
        await damagedWriter.write("{");
        await damagedWriter.close();
      }, result.pendingName);
      await page.reload();
      const fallbackBoot = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, kernelUrl, name }) => {
        const { loadFixedPersistenceImageHandle, promoteFixedPersistenceRecovery } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const overlayDirectory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const fallback = await loadFixedPersistenceImageHandle(name, "composer stream probe");
        if (fallback === null) throw new Error("fallback manifest was not retained");
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        let state: string;
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: fallback.file, persistentImageBinding: fallback.persistentImageBinding,
            experimentalFixedPersistenceName: fallback.journalName,
            persistentComputerName: name,
            requireExistingRootfsPersistence: fallback.journalInitialized,
          });
          state = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
        } finally {
          await kernel.destroy();
        }
        const selectedPrevious = fallback.recovery !== undefined;
        const currentManifest = await overlayDirectory.getFileHandle(`${name}.base.json`);
        const changedWriter = await currentManifest.createWritable();
        await changedWriter.write("[]");
        await changedWriter.close();
        let changedManifestRejected = false;
        try {
          await promoteFixedPersistenceRecovery(name, "composer stream probe", fallback);
        } catch {
          changedManifestRejected = true;
        }
        const restoreWriter = await currentManifest.createWritable();
        await restoreWriter.write("{");
        await restoreWriter.close();
        await promoteFixedPersistenceRecovery(name, "composer stream probe", fallback);
        await promoteFixedPersistenceRecovery(name, "composer stream probe", fallback);
        const promoted = await loadFixedPersistenceImageHandle(name, "composer stream probe");
        const recoveryPromoted = promoted !== null && promoted.recovery === undefined &&
          await promoted.file.isSameEntry(fallback.file);
        const previousManifest = await overlayDirectory.getFileHandle(`${name}.previous.base.json`);
        const previousWriter = await previousManifest.createWritable();
        await previousWriter.write("{");
        await previousWriter.close();
        const afterBackupDamage = await loadFixedPersistenceImageHandle(name, "composer stream probe");
        const retainedAfterBackupDamage = afterBackupDamage !== null &&
          await afterBackupDamage.file.isSameEntry(fallback.file);
        const currentWriter = await currentManifest.createWritable();
        await currentWriter.write("{");
        await currentWriter.close();
        const active = await overlayDirectory.getFileHandle(`${name}.active.base.json`);
        const activeWriter = await active.createWritable();
        await activeWriter.write("{");
        await activeWriter.close();
        let bothDamagedRejected = false;
        try {
          await loadFixedPersistenceImageHandle(name, "composer stream probe");
        } catch {
          bothDamagedRejected = true;
        }
        return { fallbackReady: fallback.journalInitialized, state, selectedPrevious, changedManifestRejected, recoveryPromoted, retainedAfterBackupDamage, bothDamagedRejected };
      }, {
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: result.pendingName,
      });
      expect(fallbackBoot).toEqual({
        fallbackReady: true,
        state: "replacement",
        selectedPrevious: true,
        changedManifestRejected: true,
        recoveryPromoted: true,
        retainedAfterBackupDamage: true,
        bothDamagedRejected: true,
      });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

for (const mode of ["fixed", "resizable"] as const) {
  test(`page checkpoints a running ${mode} persistent computer and reboots the published snapshot`, async ({ playwright, browserName, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(kernelPath === null, "kernel artifact is required");
    test.skip(!fullBrowserProductsReady, "complete browser package artifacts are required");
    const image = await imageWithState("abcdefgh");
    const imageServer = createServer((_request, response) => {
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Type": "application/octet-stream",
      });
      response.end(Buffer.from(image));
    });
    imageServer.listen(0, "127.0.0.1");
    await once(imageServer, "listening");
    try {
      const address = imageServer.address();
      if (address === null || typeof address === "string") throw new Error("image server has no TCP port");
      await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
        const result = await page.evaluate(async ({ liveSetupUrl, imageUrl, mode }) => {
          const { createLiveHost } = await import(liveSetupUrl);
          const name = `page-checkpoint-${crypto.randomUUID()}`;
          const host = await createLiveHost({ vfsUrl: imageUrl, profile: "probe", experimentalPersistenceName: name, experimentalPersistenceMode: mode });
          let phase = "initial boot";
          const waitForStatus = (expected: string) => new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => {
              unsubscribe();
              reject(new Error(`persistent page did not reach ${expected}: ${host.dmesgHistory().map((line) => line.msg).join(" | ")}`));
            }, 60_000);
            const unsubscribe = host.subscribeStatus((status) => {
              if (status === "error") {
                window.clearTimeout(timeout);
                unsubscribe();
                reject(new Error(`persistent page failed during ${phase}: ${host.dmesgHistory().map((line) => line.msg).join(" | ")}`));
              } else if (status === expected) {
                window.clearTimeout(timeout);
                unsubscribe();
                resolve();
              }
            });
            if (host.getStatus() === expected) {
              window.clearTimeout(timeout);
              unsubscribe();
              resolve();
            }
          });
          await waitForStatus("running");
          await host.startOwnedJob("checkpoint-write", "/bin/persistence-overwrite", ["persistence-overwrite"], { timeoutMs: 10_000 });
          let before = "";
          for (let attempt = 0; attempt < 50; attempt++) {
            before = new TextDecoder().decode((await host.readVfsFile("/state")) ?? new Uint8Array());
            if (before === "XYcdefgh") break;
            await new Promise((resolve) => window.setTimeout(resolve, 100));
          }
          if (before !== "XYcdefgh") throw new Error(`guest write did not become visible: ${before}`);
          if (mode === "resizable") {
            await host.startOwnedJob("checkpoint-create", "/bin/persistence-overwrite", ["persistence-overwrite", "create-tree"], { timeoutMs: 10_000 });
            let created: Uint8Array | null = null;
            for (let attempt = 0; attempt < 50; attempt++) {
              created = await host.readVfsFile("/persist-tree/nested/file");
              if (created !== null) break;
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            if (new TextDecoder().decode(created ?? new Uint8Array()) !== "TREE") {
              throw new Error("guest-created tree did not become visible");
            }
          }
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
          const manifestFile = await directory.getFileHandle(`${name}.base.json`);
          const firstManifest = JSON.parse(await (await manifestFile.getFile()).text());
          if (!host.supportsPersistentImageCheckpoint()) throw new Error("page did not expose checkpoint");
          phase = "checkpoint reboot";
          await host.checkpointPersistentImage();
          await waitForStatus("running");
          const after = new TextDecoder().decode((await host.readVfsFile("/state")) ?? new Uint8Array());
          const afterTree = mode === "resizable"
            ? new TextDecoder().decode((await host.readVfsFile("/persist-tree/nested/file")) ?? new Uint8Array())
            : null;
          const secondManifest = JSON.parse(await (await manifestFile.getFile()).text());
          const backupFile = await directory.getFileHandle(`${name}.previous.base.json`);
          const backupManifest = JSON.parse(await (await backupFile.getFile()).text());
          return {
            before,
            after,
            afterTree,
            firstJournal: firstManifest.journalName,
            secondJournal: secondManifest.journalName,
            backupJournal: backupManifest.journalName,
            secondReady: secondManifest.journalInitialized,
          };
        }, {
          liveSetupUrl: new URL(`/@fs/${resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts")}`, baseURL).href,
          imageUrl: `http://127.0.0.1:${address.port}/page-checkpoint.vfs`,
          mode,
        });
        expect(result.before).toBe("XYcdefgh");
        expect(result.after).toBe("XYcdefgh");
        expect(result.afterTree).toBe(mode === "resizable" ? "TREE" : null);
        expect(result.secondJournal).not.toBe(result.firstJournal);
        expect(result.backupJournal).toBe(result.firstJournal);
        expect(result.secondReady).toBe(true);
      });
    } finally {
      imageServer.close();
      await once(imageServer, "close");
    }
  });
}

test("strict native admission rejects a committed invalid namespace without modifying the journal", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(kernelPath === null, "kernel artifact is required");
  const image = await imageWithState("native-admission");
  await withOpfsPage(playwright, browserName, baseURL!, testInfo, async page => {
    const imageUrl = new URL("/native-admission.vfs", baseURL).href;
    const kernelUrl = new URL("/native-admission-kernel.wasm", baseURL).href;
    await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath!) }));
    const result = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, imageUrl, kernelUrl }) => {
        const imageSource = (chunks: Iterable<Uint8Array>, payloadLength = Array.isArray(chunks) ? chunks.reduce((total, chunk) => total + chunk.byteLength, 0) : 0) => ({ chunks, payloadLength, integrityPolicy: "crc32c" as const });
      const { loadFixedPersistenceImageHandle, markFixedPersistenceJournalInitialized,
        saveFixedPersistenceImageStream } = await import(persistenceUrl);
      const { BrowserKernel } = await import(browserKernelUrl);
      const name = `native-admission-${crypto.randomUUID()}`;
      const identity = "strict native admission";
      const composition = {
        imageConfig: { version: 1, defaultProfile: "probe", profiles: { probe: {} } }, profileId: "probe",
        terminalSession: { kind: "kandelo-experimental-terminal-session", version: 1,
          initial: { path: "/bin/persistence-overwrite", argv: ["persistence-overwrite"], uid: 0, gid: 0 } },
        requiredServices: [],
      };
      const image = await saveFixedPersistenceImageStream(name, identity,
        imageSource([new Uint8Array(await (await fetch(imageUrl)).arrayBuffer())]), undefined, composition);
      const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
      const first = new BrowserKernel({ kernelOwnedFs: true });
      try {
        await first.initFromOpfsImage({ kernelWasm, vfsImageFile: image.file, persistentImageBinding: image.persistentImageBinding,
          experimentalFixedPersistenceName: image.journalName, persistentComputerName: name });
        await markFixedPersistenceJournalInitialized(name, identity, image);
      } finally { await first.destroy(); }
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
      const journal = await directory.getFileHandle(`${image.journalName}.journal`);
      const original = new Uint8Array(await (await journal.getFile()).arrayBuffer());
      if (original.length !== 72) throw new Error(`Unexpected empty journal length: ${original.length}`);
      const frame = new Uint8Array(83);
      const fields = new DataView(frame.buffer);
      frame.set([75, 84, 88, 78]);
      fields.setUint32(4, frame.length, true);
      fields.setBigUint64(8, 1n, true);
      fields.setUint32(16, 1, true);
      fields.setUint32(20, (~frame.length) >>> 0, true);
      frame.set([1, 255], 24);
      frame.set(new Uint8Array(await crypto.subtle.digest("SHA-256", frame.slice(0, -36))), frame.length - 36);
      frame.set([68, 79, 78, 69], frame.length - 4);
      const damaged = new Uint8Array(original.length + frame.length);
      damaged.set(original);
      damaged.set(frame, original.length);
      const writer = await journal.createWritable();
      await writer.write(damaged);
      await writer.close();
      const selected = await loadFixedPersistenceImageHandle(name, identity);
      if (selected === null) throw new Error("Native-only damage silently reset the computer");
      const kernel = new BrowserKernel({ kernelOwnedFs: true });
      let recovery: string | undefined;
      try {
        await kernel.initFromOpfsImage({ kernelWasm, vfsImageFile: selected.file, persistentImageBinding: selected.persistentImageBinding,
          experimentalFixedPersistenceName: selected.journalName, persistentComputerName: name,
          requireExistingRootfsPersistence: true });
      } catch (error) { recovery = (error as { recovery?: string }).recovery; }
      finally { await kernel.destroy(); }
      const after = new Uint8Array(await (await journal.getFile()).arrayBuffer());
      return { selectedOriginal: selected.journalName === image.journalName, recovery,
        unchanged: after.length === damaged.length && after.every((byte, index) => byte === damaged[index]) };
    }, { persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
      browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, imageUrl, kernelUrl });
    expect(result).toEqual({ selectedOriginal: true, recovery: "no-valid-overlay-generation", unchanged: true });
  });
});

for (const activation of ["prepared", "active"] as const) {
for (const corruption of ["header", "committed-record"] as const) {
test(`page handles an invalid ${activation} replacement journal without stale recovery (${corruption})`, async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(kernelPath === null, "kernel artifact is required");
  test.skip(!fullBrowserProductsReady, "complete browser package artifacts are required");
  const oldImage = await imageWithState("oldval");
  const newImage = await imageWithState("newval");
  const imageServer = createServer((request, response) => {
    const image = request.url === "/page-recovery-old.vfs" ? oldImage
      : request.url === "/page-recovery-new.vfs" ? newImage : null;
    if (image === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Type": "application/octet-stream",
    });
    response.end(Buffer.from(image));
  });
  imageServer.listen(0, "127.0.0.1");
  await once(imageServer, "listening");
  try {
    const address = imageServer.address();
    if (address === null || typeof address === "string") throw new Error("image server has no TCP port");
    await withOpfsPage(playwright, browserName, baseURL!, testInfo, async (page) => {
      const oldUrl = `http://127.0.0.1:${address.port}/page-recovery-old.vfs`;
      const newUrl = `http://127.0.0.1:${address.port}/page-recovery-new.vfs`;
      const kernelUrl = new URL("/page-recovery-kernel.wasm", baseURL).href;
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      const prepared = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, memoryProfileUrl, oldUrl, newUrl, kernelUrl, appPath, activation }) => {
        const imageSource = (chunks: Iterable<Uint8Array>, payloadLength = Array.isArray(chunks) ? chunks.reduce((total, chunk) => total + chunk.byteLength, 0) : 0) => ({ chunks, payloadLength, integrityPolicy: "crc32c" as const });
        const {
          loadFixedPersistenceImageHandle,
          markFixedPersistenceJournalInitialized,
          publishFixedPersistenceReplacement,
          saveFixedPersistenceImageStream,
          stageFixedPersistenceReplacement,
        } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const { detectRuntimeMemoryProfile } = await import(memoryProfileUrl);
        const name = `page-recovery-${crypto.randomUUID()}`;
        const identity = JSON.stringify({
          vfsUrl: oldUrl,
          profileId: "probe",
          appPath,
          proto: location.protocol === "https:" ? "https" : "http",
          preforkServiceProcesses: detectRuntimeMemoryProfile({
            userAgent: navigator.userAgent,
            maxTouchPoints: navigator.maxTouchPoints,
          }).preforkServiceProcesses,
          mounts: [
            { path: "/", source: "image", ref: oldUrl, readonly: false },
            { path: "/tmp", source: "scratch", ephemeral: true },
          ],
        });
        const composition = {
          imageConfig: {
            version: 1 as const,
            defaultProfile: "probe",
            profiles: {
              probe: {
                identity: {
                  title: "Persistence probe",
                  summary: "Fixed-size overwrite test",
                  accent: "#123456",
                  glyph: "sh",
                },
              },
            },
          },
          profileId: "probe",
          terminalSession: {
            kind: "kandelo-experimental-terminal-session" as const,
            version: 1 as const,
            initial: { path: "/bin/persistence-overwrite", argv: ["persistence-overwrite"], uid: 0, gid: 0 },
          },
          requiredServices: [],
        };
        const journalName = `j-${crypto.randomUUID()}`;
        const previous = await saveFixedPersistenceImageStream(
          name, identity, imageSource([new Uint8Array(await (await fetch(oldUrl)).arrayBuffer())]),
          undefined, composition, undefined, undefined, journalName,
        );
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const firstKernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await firstKernel.initFromOpfsImage({
            kernelWasm: kernelBytes,
            vfsImageFile: previous.file, persistentImageBinding: previous.persistentImageBinding,
            experimentalFixedPersistenceName: previous.journalName,
            persistentComputerName: name,
          });
          await markFixedPersistenceJournalInitialized(name, identity, previous);
        } finally {
          await firstKernel.destroy();
        }
        const ready = await loadFixedPersistenceImageHandle(name, identity);
        if (ready === null || !ready.journalInitialized) throw new Error("first journal is not ready");
        const staged = await stageFixedPersistenceReplacement(
          name, identity, imageSource([new Uint8Array(await (await fetch(newUrl)).arrayBuffer())]),
          undefined, composition,
        );
        const stagedKernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await stagedKernel.initFromOpfsImage({
            kernelWasm: kernelBytes,
            vfsImageFile: staged.file, persistentImageBinding: staged.persistentImageBinding,
            experimentalFixedPersistenceName: staged.journalName,
            persistentComputerName: name,
          });
        } finally {
          await stagedKernel.destroy();
        }
        const prototype = Object.getPrototypeOf(staged.file);
        const createWritable = prototype.createWritable;
        let bindings = 0;
        prototype.createWritable = async function (this: FileSystemFileHandle, options: FileSystemCreateWritableOptions) {
          const writer = await createWritable.call(this, options);
          if (activation !== "prepared" || this.name !== `${name}.active.base.json` || ++bindings !== 2) return writer;
          return {
            write: (...args: Parameters<typeof writer.write>) => writer.write(...args),
            close: async () => { throw new Error("cut before replacement activation"); },
            abort: () => writer.abort(),
          };
        };
        try { await publishFixedPersistenceReplacement(name, identity, ready, staged); }
        catch (error) { if (activation !== "prepared" || !String(error).includes("cut before replacement activation")) throw error; }
        finally { prototype.createWritable = createWritable; }
        return { name, identity, currentJournal: staged.journalName };
      }, {
        persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        memoryProfileUrl: new URL(`/@fs/${resolve(repoRoot, "host/src/runtime-memory-profile.ts")}`, baseURL).href,
        oldUrl,
        newUrl,
        kernelUrl,
        appPath: new URL("/computer", baseURL).pathname,
        activation,
      });
      const damage = await page.evaluate(async ({ journalName, corruption }) => {
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        if (corruption === "committed-record") {
          const file = await directory.getFileHandle(`${journalName}.journal`);
          const original = new Uint8Array(await (await file.getFile()).arrayBuffer());
          let position = 72;
          let sequence = 0n;
          while (position < original.length) {
            const view = new DataView(original.buffer, position);
            const length = view.getUint32(4, true);
            if (length < 60 || position + length > original.length) throw new Error("Invalid fixture journal frame");
            sequence = view.getBigUint64(8, true);
            position += length;
          }
          const record = new Uint8Array(83);
          const fields = new DataView(record.buffer);
          record.set([75, 84, 88, 78]);
          fields.setUint32(4, record.length, true);
          fields.setBigUint64(8, sequence + 1n, true);
          fields.setUint32(16, 1, true);
          fields.setUint32(20, (~record.length) >>> 0, true);
          record.set([1, 255], 24);
          record.set(new Uint8Array(await crypto.subtle.digest("SHA-256", record.slice(0, -36))), record.length - 36);
          record.set([68, 79, 78, 69], record.length - 4);
          const damaged = new Uint8Array(original.length + record.length);
          damaged.set(original);
          damaged.set(record, original.length);
          const writer = await file.createWritable();
          await writer.write(damaged);
          await writer.close();
          return { digest: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", damaged)),
            byte => byte.toString(16).padStart(2, "0")).join("") };
        }
        await directory.removeEntry(`${journalName}.journal`);
        const generation = await directory.getFileHandle(`${journalName}.g0.journal`, { create: true });
        const writer = await generation.createWritable();
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.close();
        return { digest: null };
      }, { journalName: prepared.currentJournal, corruption });
      if (corruption === "committed-record") {
        const admission = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, kernelUrl, name, identity, journalName }) => {
          const { loadFixedPersistenceImageHandle } = await import(persistenceUrl);
          const { BrowserKernel } = await import(browserKernelUrl);
          const selected = await loadFixedPersistenceImageHandle(name, identity);
          if (selected === null) throw new Error("Committed-record damage reset the computer");
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          let recovery: string | undefined;
          try {
            await kernel.initFromOpfsImage({ kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
              vfsImageFile: selected.file, persistentImageBinding: selected.persistentImageBinding,
              experimentalFixedPersistenceName: selected.journalName, persistentComputerName: name,
              requireExistingRootfsPersistence: true });
          } catch (error) { recovery = (error as { recovery?: string }).recovery; }
          finally { await kernel.destroy(); }
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
          const bytes = await (await directory.getFileHandle(`${journalName}.journal`)).getFile();
          return { selectedTarget: selected.journalName === journalName, recovery,
            digest: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await bytes.arrayBuffer())),
              byte => byte.toString(16).padStart(2, "0")).join("") };
        }, { persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
          browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl,
          name: prepared.name, identity: prepared.identity, journalName: prepared.currentJournal });
        expect(admission).toEqual({ selectedTarget: true, recovery: "no-valid-overlay-generation", digest: damage.digest });
      }
      const boot = await page.evaluate(async ({ liveSetupUrl, name, oldUrl }) => {
        const { createLiveHost } = await import(liveSetupUrl);
        const host = await createLiveHost({ vfsUrl: oldUrl, profile: "probe", experimentalPersistenceName: name });
        return new Promise<{ status: string; state: string | null; fallbackReported: boolean; dmesg: string[] }>((resolve) => {
          let unsubscribe = () => {};
          let settled = false;
          let timeout = 0;
          const finish = async () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            unsubscribe();
            const state = host.getStatus() === "running"
              ? new TextDecoder().decode((await host.readVfsFile("/state")) ?? new Uint8Array())
              : null;
            const dmesg = host.dmesgHistory().map((line) => line.msg);
            resolve({
              status: host.getStatus(),
              state,
              fallbackReported: dmesg.some((line) => line.includes("restored a verified current image and journal binding")),
              dmesg,
            });
          };
          timeout = window.setTimeout(() => { void finish(); }, 45_000);
          unsubscribe = host.subscribeStatus((status) => {
            if (status === "running" || status === "error") void finish();
          });
          if (host.getStatus() === "running" || host.getStatus() === "error") void finish();
        });
      }, {
        liveSetupUrl: new URL(`/@fs/${resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts")}`, baseURL).href,
        name: prepared.name,
        oldUrl,
      });
      expect(boot.status, boot.dmesg.join("\n")).toBe(activation === "prepared" ? "running" : "error");
      expect(boot.fallbackReported).toBe(activation === "prepared");
      if (activation === "prepared") expect(boot.state).toMatch(/dval$/);
      else expect(boot.state).toBeNull();
    });
  } finally {
    imageServer.close();
    await once(imageServer, "close");
  }
});
}
}
