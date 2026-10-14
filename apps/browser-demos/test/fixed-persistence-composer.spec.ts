import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const imageModulePath = [
  resolve(repoRoot, "local-binaries/kandelo_image_module32.wasm"),
  resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_image_module.wasm"),
].find((path) => existsSync(path) && WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(path))).length === 0) ?? null;
const programPath = tryResolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm");
const composerPath = resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/image-composer-client.ts");
const sourceStagePath = resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/opfs-source-image.ts");
const persistenceModulePath = resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/fixed-persistence-image.ts");
const browserKernelPath = resolve(repoRoot, "host/src/browser-kernel-host.ts");
const kernelPath = [
  resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"),
  resolve(repoRoot, "local-binaries/kernel.wasm"),
].find(existsSync) ?? null;

test.skip(imageModulePath === null || programPath === null, "image writer and guest fixture are required");

async function imageWithState(state: string, largeFileBytes = 0): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.setImageCapacity(largeFileBytes > 0 ? 96 * 1024 * 1024 : 64 * 1024 * 1024);
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

test("compressed source retains the resident fallback", async ({ page, baseURL }) => {
  const compressed = zstdCompressSync(Buffer.from(await imageWithState("compressed")));
  const imageUrl = new URL("/fixed-composer-compressed.vfs.zst", baseURL).href;
  await page.route(imageUrl, (route) => route.fulfill({ body: compressed }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ sourceStageUrl, imageUrl }) => {
    const { stageRawVfsSourceImage } = await import(sourceStageUrl);
    const source = await stageRawVfsSourceImage(await fetch(imageUrl), () => {});
    return source instanceof Uint8Array
      ? { length: source.byteLength, magic: Array.from(source.subarray(0, 4)) }
      : { length: 0, magic: [] };
  }, {
    sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
    imageUrl,
  });
  expect(result).toEqual({ length: compressed.byteLength, magic: [0x28, 0xb5, 0x2f, 0xfd] });
});

test("positioned install boots an image larger than the composer VFS budget", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  test.skip(kernelPath === null, "kernel artifact is required");
  const image = await imageWithState("large-image", 68 * 1024 * 1024);
  expect(image.byteLength).toBeGreaterThan(64 * 1024 * 1024);
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
    const page = context.pages()[0] ?? await context.newPage();
    await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ sourceStageUrl, composerUrl, persistenceUrl, browserKernelUrl, imageUrl, kernelUrl }) => {
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
          persistentImage: { name, identity },
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
      const kernel = new BrowserKernel({ kernelOwnedFs: true });
      try {
        await kernel.initFromOpfsImage({
          kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
          vfsImageFile: restored.file,
          experimentalFixedPersistenceName: name,
        });
        return {
          sourceLength: source.integrity.length,
          composedLength: composed.imageFile?.length,
          returnedBytes: composed.imageBytes.byteLength,
          state: new TextDecoder().decode(await kernel.readFileFromVfs("/state")),
        };
      } finally {
        await kernel.destroy();
      }
    }, {
      sourceStageUrl: new URL(`/@fs/${sourceStagePath}`, baseURL).href,
      composerUrl: new URL(`/@fs/${composerPath}`, baseURL).href,
      persistenceUrl: new URL(`/@fs/${persistenceModulePath}`, baseURL).href,
      browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
      imageUrl,
      kernelUrl,
    });
    expect(result.sourceLength).toBeGreaterThan(64 * 1024 * 1024);
    expect(result.composedLength).toBeGreaterThan(64 * 1024 * 1024);
    expect(result.returnedBytes).toBe(0);
    expect(result.state).toBe("large-image");
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

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
      const page = context.pages()[0] ?? await context.newPage();
      const image = await imageWithState("abcdefgh");
      const imageUrl = new URL("/fixed-composer-stream.vfs", baseURL).href;
      const kernelUrl = new URL("/fixed-composer-kernel.wasm", baseURL).href;
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ composerUrl, sourceStageUrl, persistenceUrl, browserKernelUrl, imageUrl, kernelUrl }) => {
        const { composeImageInWorker } = await import(composerUrl);
        const { stageRawVfsSourceImage } = await import(sourceStageUrl);
        const { loadFixedPersistenceImageHandle } = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const name = `composer-${crypto.randomUUID()}`;
        const identity = "composer stream probe";
        const ticks: string[] = [];
        const source = await stageRawVfsSourceImage(await fetch(imageUrl), () => {});
        if (source instanceof Uint8Array) throw new Error("raw fixture was treated as compressed");
        const composed = await composeImageInWorker({
          imageBytes: new Uint8Array(),
          positionedSource: {
            file: source.file,
            integrity: source.integrity,
          },
          persistentImage: { name, identity },
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
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const open = async () => {
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          await kernel.initFromOpfsImage({
            kernelWasm: kernelBytes,
            vfsImageFile: restored!.file,
            experimentalFixedPersistenceName: name,
          });
          return kernel;
        };
        const firstKernel = await open();
        let initial: string;
        try {
          initial = new TextDecoder().decode(await firstKernel.readFileFromVfs("/state"));
          const { exit } = await firstKernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
          if (await exit !== 0) throw new Error("guest persistence write failed");
        } finally {
          await firstKernel.destroy();
        }
        const secondKernel = await open();
        let recovered: string;
        try {
          recovered = new TextDecoder().decode(await secondKernel.readFileFromVfs("/state"));
        } finally {
          await secondKernel.destroy();
        }
        const supersededName = `composer-${crypto.randomUUID()}`;
        let current = true;
        let superseded = false;
        try {
          await composeImageInWorker({
            imageBytes: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
            persistentImage: { name: supersededName, identity },
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
            persistentImage: { name: damagedName, identity },
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
          damagedRefused = String(error).includes("damaged");
        } finally {
          await damagedSource.remove();
        }
        return {
          returnedBytes: composed.imageBytes.byteLength,
          stagedLength: composed.imageFile?.length,
          restoredLength: restored?.length,
          profile: restored?.composition.profileId,
          initial,
          recovered,
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
      expect(result.fileMatches).toBe(true);
      expect(result.superseded).toBe(true);
      expect(result.supersededUnpublished).toBe(true);
      expect(result.damagedRefused).toBe(true);
      expect(result.damagedUnpublished).toBe(true);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
