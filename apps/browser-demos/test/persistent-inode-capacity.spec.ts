import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test as baseTest } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import { startDeferredByteServer, type DeferredByteServer } from "../../../host/test/fixtures/deferred-byte-server";
import { startDeferredArchiveServer } from "../../../host/test/fixtures/deferred-archive-server";
import { oversizedDeferredMetadataImage } from "../../../host/test/fixtures/oversized-metadata-image";
import { wideDirectoryImage } from "../../../host/test/fixtures/wide-directory-image";
import { hostTransportMetadataImage } from "../../../host/test/fixtures/host-transport-metadata-image";
import type { OpfsImageIntegrity } from "../../../host/src/vfs/image-integrity";

const repoRoot = resolve(import.meta.dirname, "../../..");
const kernelPath = tryResolveBinary("kernel.wasm");
const bashPath = tryResolveBinary("programs/wasm32/bash.wasm");
const coreutilsPath = tryResolveBinary("programs/wasm32/coreutils.wasm");
const mappingPath = tryResolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm");
const script = readFileSync(join(repoRoot, "host/test/fixtures/persistent-inode-capacity.sh"), "utf8");

const test = baseTest.extend<{
  deferredServer: DeferredByteServer;
  slowServer: DeferredByteServer;
  stalledServer: DeferredByteServer;
}>({
  stalledServer: async ({}, use) => {
    const server = await startDeferredByteServer(bashPath === null ? 8 : readFileSync(bashPath).byteLength, { stall: true });
    try { await use(server); } finally { await server.close(); }
  },
  slowServer: async ({}, use) => {
    const server = await startDeferredByteServer(5 * 64 * 1024, { chunkBytes: 64 * 1024, chunkDelayMs: 8_000 });
    try { await use(server); } finally { await server.close(); }
  },
  deferredServer: async ({}, use) => {
    const server = await startDeferredByteServer(96 * 1024 * 1024);
    try { await use(server); } finally { await server.close(); }
  },
  page: async ({ playwright, browserName }, use, testInfo) => {
    const profile = mkdtempSync(join(tmpdir(), "kandelo-inode-capacity-browser-"));
    const projectUse = testInfo.project.use as {
      channel?: string;
      launchOptions?: Record<string, unknown>;
      proxy?: Record<string, unknown>;
      extraHTTPHeaders?: Record<string, string>;
    };
    try {
      const context = await playwright[browserName].launchPersistentContext(profile, {
        channel: projectUse.channel,
        proxy: projectUse.proxy as never,
        extraHTTPHeaders: projectUse.extraHTTPHeaders,
        ...(projectUse.launchOptions ?? {}),
      });
      try {
        await use(context.pages()[0] ?? await context.newPage());
      } finally {
        await context.close();
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  },
});

for (const scenario of [
  { title: "OPFS preserves a sparse-file mapping after oversized mmap and mremap refuse under a 64 MiB kernel",
    fixture: "persistence-mapping-memory.wasm", capacity: 64 * 1024 * 1024,
    marker: "MAPPING_MEMORY_REFUSAL_VERIFIED" },
  { title: "OPFS bounds combined namespace, mapping and writeback pressure and recovers accepted state",
    fixture: "persistence-aggregate-pressure.wasm", capacity: 512 * 1024 * 1024,
    marker: "AGGREGATE_PRESSURE_VERIFIED" },
]) {
  test(scenario.title, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    if (kernelPath === null) throw new Error("kernel artifact is required");
    const filesystem = KandeloImageFs.create();
    filesystem.setImageCapacity(scenario.capacity);
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile("/bin/mapping-memory", readFileSync(join(repoRoot,
      "local-binaries/test-fixtures/wasm32", scenario.fixture)), 0o755);
    const image = await filesystem.saveImage();
    const kernelUrl = new URL("/mapping-memory-kernel.wasm", baseURL).href;
    const imageUrl = new URL("/mapping-memory.vfs", baseURL).href;
    const moduleUrl = new URL("/@fs/" + join(repoRoot, "host/src/browser-kernel-host.ts"), baseURL).href;
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath) }));
    await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ kernelUrl, imageUrl, moduleUrl }) => {
      const { BrowserKernel } = await import(moduleUrl);
      const root = await navigator.storage.getDirectory();
      const name = "mapping-memory-" + crypto.randomUUID();
      const directory = await root.getDirectoryHandle(name, { create: true });
      const base = await directory.getFileHandle("base", { create: true });
      const writer = await base.createWritable();
      await writer.write(await (await fetch(imageUrl)).arrayBuffer());
      await writer.close();
      const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
      const phases: { recovered: boolean; code: number; output: string; pages: number }[] = [];
      let closed = true;
      try {
        for (const recovered of [false, true]) {
          let output = "";
          const decoder = new TextDecoder();
          const kernel = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024,
            onStdout: bytes => { output = (output + decoder.decode(bytes)).slice(-16384); },
            onStderr: bytes => { output = (output + decoder.decode(bytes)).slice(-16384); },
          });
          closed = false;
          try {
            await kernel.initFromOpfsImage({
              kernelWasm, vfsImageFile: base, persistentComputerName: name,
              experimentalResizablePersistenceName: name, requireExistingRootfsPersistence: recovered,
            });
            const { exit } = await kernel.spawnFromVfs("/bin/mapping-memory",
              ["mapping-memory", recovered ? "verify" : "write"], { uid: 0, gid: 0 });
            phases.push({ recovered, code: await exit, output, pages: await kernel.getKernelMemoryPages() });
          } finally {
            await kernel.destroy();
            closed = true;
          }
        }
        return phases;
      } finally {
        if (closed) {
          await root.removeEntry(name, { recursive: true });
          const overlays = await root.getDirectoryHandle("kandelo-persistent-overlay");
          for await (const [entry] of (overlays as any).entries()) {
            if (entry.startsWith(name + ".")) await overlays.removeEntry(entry, { recursive: true });
          }
        }
      }
    }, { kernelUrl, imageUrl, moduleUrl });
    await testInfo.attach("mapping-memory-phases", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result).toHaveLength(2);
    for (const phase of result) {
      expect(phase.code, phase.output).toBe(0);
      expect(phase.output).toContain(scenario.marker);
      expect(phase.pages).toBeLessThanOrEqual(1024);
    }
    if (scenario.fixture === "persistence-aggregate-pressure.wasm") {
      expect(result[0]!.output).toMatch(/PRESSURE_REFUSAL created=\d+ errno=12/);
    }
  });
}

test("OPFS refuses host transport metadata before opening a journal and permits a smaller-image retry", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  if (kernelPath === null) throw new Error("kernel artifact is required");
  const oversized = await hostTransportMetadataImage(true);
  const smaller = await hostTransportMetadataImage(false);
  const imageUrl = new URL("/host-metadata-pressure.vfs", baseURL).href;
  const retryUrl = new URL("/host-metadata-retry.vfs", baseURL).href;
  const kernelUrl = new URL("/host-metadata-kernel.wasm", baseURL).href;
  const moduleUrl = new URL("/@fs/" + join(repoRoot, "host/src/browser-kernel-host.ts"), baseURL).href;
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(oversized) }));
  await page.route(retryUrl, route => route.fulfill({ body: Buffer.from(smaller) }));
  await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ imageUrl, retryUrl, kernelUrl, moduleUrl }) => {
    const { BrowserKernel } = await import(moduleUrl);
    const root = await navigator.storage.getDirectory();
    const name = "host-metadata-" + crypto.randomUUID();
    const directory = await root.getDirectoryHandle(name, { create: true });
    const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
    let closed = true;
    try {
      const base = await directory.getFileHandle("base", { create: true });
      const writer = await base.createWritable();
      await writer.write(await (await fetch(imageUrl)).arrayBuffer());
      await writer.close();
      const oversized = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 4096 });
      let failure = "";
      closed = false;
      try {
        await oversized.initFromOpfsImage({ kernelWasm, vfsImageFile: base,
          persistentComputerName: name, experimentalResizablePersistenceName: name });
      } catch (error) { failure = String(error); }
      finally { await oversized.destroy(); closed = true; }
      const journals: string[] = [];
      try {
        const overlays = await root.getDirectoryHandle("kandelo-persistent-overlay");
        for await (const filename of (overlays as any).keys()) {
          if (filename.startsWith(name + ".")) journals.push(filename);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      }
      const retryFile = await directory.getFileHandle("retry", { create: true });
      const retryWriter = await retryFile.createWritable();
      await retryWriter.write(await (await fetch(retryUrl)).arrayBuffer());
      await retryWriter.close();
      const retry = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 4096 });
      closed = false;
      try {
        await retry.initFromOpfsImage({ kernelWasm, vfsImageFile: retryFile,
          persistentComputerName: name, experimentalResizablePersistenceName: name });
        const stat = await retry.statVfsPath("/asset-0");
        return { failure, journals, size: stat?.size, pages: await retry.getKernelMemoryPages() };
      } finally { await retry.destroy(); closed = true; }
    } finally {
      if (closed) {
        await root.removeEntry(name, { recursive: true });
        try {
          const overlays = await root.getDirectoryHandle("kandelo-persistent-overlay");
          for await (const filename of (overlays as any).keys()) {
            if (filename.startsWith(name + ".")) await overlays.removeEntry(filename);
          }
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
        }
      }
    }
  }, { imageUrl, retryUrl, kernelUrl, moduleUrl });
  await testInfo.attach("host-metadata-admission", { body: JSON.stringify(result), contentType: "application/json" });
  expect(result.failure).toContain("Host storage metadata memory budget exhausted");
  expect(result.journals).toEqual([]);
  expect(result.size).toBe(1);
  expect(result.pages).toBeLessThanOrEqual(4096);
});

test("OPFS streams a many-file namespace without staging sibling directory names and paths", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = wideDirectoryImage();
  const imageUrl = new URL("/wide-directory-image.vfs", baseURL).href;
  const moduleUrl = new URL("/wide-directory-positioned-module.wasm", baseURL).href;
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(fixture.image) }));
  await page.route(moduleUrl, route => route.fulfill({ body: readFileSync(join(repoRoot,
    "local-binaries/kandelo_image_module_positioned32.wasm")) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async (parameters) => {
    const root = await navigator.storage.getDirectory();
    const name = `wide-directory-${crypto.randomUUID()}`;
    const directory = await root.getDirectoryHandle(name, { create: true });
    const file = await directory.getFileHandle("base", { create: true });
    const writer = await file.createWritable();
    await writer.write(await (await fetch(parameters.imageUrl)).arrayBuffer());
    await writer.close();
    const workerUrl = URL.createObjectURL(new Blob([`
      self.onmessage = async ({ data }) => {
        let handle;
        let result;
        try {
          const { KandeloImageFs } = await import(data.bridgeUrl);
          const root = await navigator.storage.getDirectory();
          const directory = await root.getDirectoryHandle(data.name);
          const file = await directory.getFileHandle("base");
          handle = await file.createSyncAccessHandle();
          const bytes = new Uint8Array(await (await fetch(data.moduleUrl)).arrayBuffer());
          let observedModuleBytes = 0;
          let firstChildModuleBytes;
          let largestRead = 0;
          const filesystem = KandeloImageFs.createFromPositionedImage(bytes, handle.getSize(), (offset, destination) => {
            observedModuleBytes = Math.max(observedModuleBytes, destination.buffer.byteLength);
            largestRead = Math.max(largestRead, destination.byteLength);
            if (offset === data.firstChildBlockOffset && firstChildModuleBytes === undefined) {
              firstChildModuleBytes = destination.buffer.byteLength;
            }
            return handle.read(destination, { at: offset });
          });
          const rootEntries = filesystem.readDirNames("/").length;
          const sample = new TextDecoder().decode(filesystem.readFile(data.samplePath));
          const mode = filesystem.stat(data.samplePath).mode & 0o777;
          result = { observedModuleBytes, firstChildModuleBytes, largestRead, rootEntries, sample, mode };
        } catch (error) { result = { error: String(error) }; }
        finally {
          try { handle?.close(); } catch (error) { result = { error: String(error) }; }
        }
        self.postMessage(result);
      };
    `], { type: "text/javascript" }));
    const worker = new Worker(workerUrl, { type: "module" });
    try {
      return await new Promise<{
        observedModuleBytes?: number; firstChildModuleBytes?: number; largestRead?: number;
        rootEntries?: number; sample?: string; mode?: number; error?: string;
      }>((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage({ ...parameters, name });
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      await root.removeEntry(name, { recursive: true });
    }
  }, { imageUrl, moduleUrl, firstChildBlockOffset: fixture.firstChildBlockOffset, samplePath: fixture.samplePath,
    bridgeUrl: new URL(`/@fs/${repoRoot}/images/vfs/lib/kandelo-image-fs.ts`, baseURL).href });
  await testInfo.attach("many-file-directory-memory", { contentType: "application/json",
    body: JSON.stringify({ imageBytes: fixture.image.byteLength, imageSha256: fixture.sha256, ...result }) });
  expect(result.error).toBeUndefined();
  expect(result.rootEntries).toBe(fixture.rootEntries);
  expect(result.sample).toBe("payload");
  expect(result.mode).toBe(0o640);
  expect(result.firstChildModuleBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(result.observedModuleBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(result.largestRead).toBeLessThanOrEqual(4096);
});

test("OPFS rejects oversized deferred metadata without allocating its declared body", async ({ page, baseURL }, testInfo) => {
  const fixture = oversizedDeferredMetadataImage();
  const moduleUrl = new URL("/metadata-input-positioned-module.wasm", baseURL).href;
  await page.route(moduleUrl, route => route.fulfill({ body: readFileSync(join(repoRoot,
    "local-binaries/kandelo_image_module_positioned32.wasm")) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ prefix, length, moduleUrl, bridgeUrl }) => {
    const root = await navigator.storage.getDirectory();
    const name = `metadata-input-${crypto.randomUUID()}`;
    const directory = await root.getDirectoryHandle(name, { create: true });
    const file = await directory.getFileHandle("base", { create: true });
    const writer = await file.createWritable();
    await writer.truncate(length);
    await writer.write({ type: "write", position: 0, data: new Uint8Array(prefix) });
    await writer.close();
    const workerUrl = URL.createObjectURL(new Blob([`
      self.onmessage = async ({ data }) => {
        let handle;
        let result;
        try {
          const { KandeloImageFs } = await import(data.bridgeUrl);
          const root = await navigator.storage.getDirectory();
          const directory = await root.getDirectoryHandle(data.name);
          const file = await directory.getFileHandle("base");
          handle = await file.createSyncAccessHandle();
          const bytes = new Uint8Array(await (await fetch(data.moduleUrl)).arrayBuffer());
          let observedModuleBytes = 0;
          let largestRead = 0;
          let errno;
          try {
            KandeloImageFs.createFromPositionedImage(bytes, handle.getSize(), (offset, destination) => {
              observedModuleBytes = Math.max(observedModuleBytes, destination.buffer.byteLength);
              largestRead = Math.max(largestRead, destination.byteLength);
              return handle.read(destination, { at: offset });
            });
          } catch (error) { errno = error.errno; }
          result = { observedModuleBytes, largestRead, errno };
        } catch (error) { result = { error: String(error) }; }
        finally {
          try { handle?.close(); } catch (error) { result = { error: String(error) }; }
        }
        self.postMessage(result);
      };
    `], { type: "text/javascript" }));
    const worker = new Worker(workerUrl, { type: "module" });
    try {
      return await new Promise<{ observedModuleBytes?: number; largestRead?: number; errno?: number; error?: string }>((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage({ name, moduleUrl, bridgeUrl });
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      await root.removeEntry(name, { recursive: true });
    }
  }, { prefix: Array.from(fixture.prefix), length: fixture.length, moduleUrl,
    bridgeUrl: new URL(`/@fs/${repoRoot}/images/vfs/lib/kandelo-image-fs.ts`, baseURL).href });
  await testInfo.attach("deferred-metadata-memory", { contentType: "application/json",
    body: JSON.stringify({ imageBytes: fixture.length, prefixBytes: fixture.prefix.byteLength, ...result }) });
  expect(result.error).toBeUndefined();
  expect(result.errno).toBe(22);
  expect(result.observedModuleBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(result.largestRead).toBeLessThanOrEqual(4096);
});

for (const deflated of [false, true]) {
  test(`OPFS streams large archive members under a 64 MiB kernel ceiling (deflated=${deflated})`, async ({ page, baseURL }, testInfo) => {
    test.skip(kernelPath === null || coreutilsPath === null, "ABI-matched kernel and coreutils are required");
    test.setTimeout(180_000);
    const server = await startDeferredArchiveServer(96 * 1024 * 1024, deflated);
    try {
      const filesystem = KandeloImageFs.create();
      filesystem.setImageCapacity(8 * 1024 * 1024);
      const memberPaths = ["/large", "/reader-1/large", "/reader-2/large"];
      for (const [index, memberPath] of memberPaths.entries()) {
        filesystem.registerLazyArchive({
          url: index === 0 ? server.url : `${server.url}?reader=${index}`,
          entries: server.entries, mountPrefix: memberPath.slice(0, -"large".length),
          integrity: { sha256: server.sha256, bytes: server.size },
        });
      }
      filesystem.mkdir("/bin", 0o755);
      filesystem.writeFile("/bin/coreutils", readFileSync(coreutilsPath!), 0o755);
      const image = await filesystem.saveImage();
      const imageUrl = new URL("/large-archive.vfs", baseURL).href;
      const kernelUrl = new URL("/large-archive-kernel.wasm", baseURL).href;
      const moduleUrl = new URL("/@fs/" + join(repoRoot, "host/src/browser-kernel-host.ts"), baseURL).href;
      const name = "archive-" + crypto.randomUUID();
      await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ imageUrl, kernelUrl, moduleUrl, name, size, memberPaths }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
        const original = await directory.getFileHandle("base", { create: true });
        const checkpoint = await directory.getFileHandle("checkpoint", { create: true });
        const writer = await original.createWritable();
        await writer.write(await (await fetch(imageUrl)).arrayBuffer());
        await writer.close();
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const memory: { phase: string; pages: number }[] = [];
        for (const phase of ["initial", "recover", "checkpoint"]) {
          let stderr = "";
          const kernel = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024,
            onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
          });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm, vfsImageFile: phase === "checkpoint" ? checkpoint : original,
              experimentalResizablePersistenceName: phase === "checkpoint" ? name + "-checkpoint" : name,
              persistentComputerName: phase === "checkpoint" ? name + "-checkpoint" : name,
              requireExistingRootfsPersistence: phase === "recover",
            });
            for (const memberPath of memberPaths) {
              const { exit } = await kernel.spawnFromVfs("/bin/coreutils", ["dd", `if=${memberPath}`, "of=/dev/null", "bs=65536", "status=none"], {
                env: ["PATH=/bin", "HOME=/"], uid: 0, gid: 0,
              });
              if (await exit !== 0) throw new Error("Archive guest read failed: " + stderr);
            }
            const tail = await kernel.readFileRangeFromVfs("/large", size - 65_537, 65_537);
            if (tail?.length !== 65_537 || !tail.every(byte => byte === 86)) throw new Error("Wrong archive tail bytes");
            let total = 0;
            for (let offset = 0; offset < size; offset += 1024 * 1024) {
              const bytes = await kernel.readFileRangeFromVfs("/large", offset, 1024 * 1024);
              if (bytes?.length !== 1024 * 1024 || !bytes.every(byte => byte === 86)) throw new Error("Wrong archive member bytes");
              total += bytes.length;
            }
            if (total !== size) throw new Error("Short archive member");
            memory.push({ phase, pages: await kernel.getKernelMemoryPages() });
            if (phase === "recover") await kernel.exportRootfsImageToFile(checkpoint);
          } finally {
            await kernel.destroy();
          }
        }
        return memory;
      }, { imageUrl, kernelUrl, moduleUrl, name, size: server.memberSize, memberPaths });
      expect(server.requests()).toBe(9);
      expect(result).toHaveLength(3);
      for (const entry of result) expect(entry.pages).toBeLessThanOrEqual(1024);
      await testInfo.attach("archive-kernel-memory-pages", { body: JSON.stringify({ deflated, cachedReaders: 2, activeReaders: 1, memory: result }), contentType: "application/json" });
    } finally {
      await server.close();
    }
  });
}

test("OPFS shutdown cancels admitted deferred exec and preserves dirty files", async ({ page, baseURL, stalledServer }) => {
  test.skip(kernelPath === null || bashPath === null, "ABI-matched kernel and Bash are required");
  test.setTimeout(60_000);
  const program = readFileSync(bashPath!);
  const filesystem = KandeloImageFs.create();
  filesystem.setImageCapacity(8 * 1024 * 1024);
  filesystem.registerLazyFile("/blocked", stalledServer.url, program.byteLength, 0o755,
    createHash("sha256").update(program).digest("hex"));
  const image = await filesystem.saveImage();
  const imageUrl = new URL("/cancel-deferred.vfs", baseURL).href;
  const kernelUrl = new URL("/cancel-deferred-kernel.wasm", baseURL).href;
  const moduleUrl = new URL("/@fs/" + join(repoRoot, "host/src/browser-kernel-host.ts"), baseURL).href;
  const name = "cancel-read-" + crypto.randomUUID();
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
  await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath!) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  await page.evaluate(async ({ imageUrl, kernelUrl, moduleUrl, name }) => {
    const { BrowserKernel } = await import(moduleUrl);
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    const file = await directory.getFileHandle("base", { create: true });
    const writer = await file.createWritable();
    await writer.write(await (await fetch(imageUrl)).arrayBuffer());
    await writer.close();
    const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
    const diagnostics: string[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      kernelMaxPages: 1024,
      onHostDiagnostic: diagnostic => diagnostics.push(diagnostic.source + ": " + diagnostic.message),
    });
    const options = {
      kernelWasm, vfsImageFile: file,
      experimentalResizablePersistenceName: name, persistentComputerName: name,
    };
    await kernel.initFromOpfsImage(options);
    await kernel.writeFileToVfs("/pending", new Uint8Array([1, 2, 3]));
    const pending = kernel.spawnFromVfs("/blocked", ["blocked"]).then(() => false, () => true);
    const finish = async () => {
      await kernel.destroy();
      const failures = diagnostics.filter(message => message.startsWith("kernel worker destroy:"));
      if (failures.length > 0) return { diagnostics: failures };
      const failed = await pending;
      const reopened = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024 });
      try {
        await reopened.initFromOpfsImage({ ...options, requireExistingRootfsPersistence: true });
        const bytes = await reopened.readFileFromVfs("/pending");
        return { diagnostics: failures, failed, bytes: bytes === null ? null : [...bytes] };
      } finally {
        await reopened.destroy();
      }
    };
    (globalThis as unknown as { finishPersistentShutdown: typeof finish }).finishPersistentShutdown = finish;
  }, { imageUrl, kernelUrl, moduleUrl, name });
  await stalledServer.requested;
  const result = await page.evaluate(() =>
    (globalThis as unknown as { finishPersistentShutdown(): Promise<unknown> }).finishPersistentShutdown());
  expect(result).toEqual({ diagnostics: [], failed: true, bytes: [1, 2, 3] });
  expect(stalledServer.requests()).toBe(1);
});

test("OPFS deferred reads survive healthy progress beyond thirty seconds", async ({ page, baseURL, slowServer }, testInfo) => {
  test.skip(kernelPath === null, "ABI-matched kernel is required");
  test.setTimeout(90_000);
  const filesystem = KandeloImageFs.create();
  filesystem.setImageCapacity(8 * 1024 * 1024);
  filesystem.registerLazyFile("/slow", slowServer.url, slowServer.size, 0o600, slowServer.sha256);
  const image = await filesystem.saveImage();
  const imageUrl = new URL("/slow-deferred.vfs", baseURL).href;
  const kernelUrl = new URL("/slow-deferred-kernel.wasm", baseURL).href;
  const moduleUrl = new URL("/@fs/" + join(repoRoot, "host/src/browser-kernel-host.ts"), baseURL).href;
  const name = "slow-read-" + crypto.randomUUID();
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
  await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath!) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const existing = await page.evaluate(async name => {
    const root = await navigator.storage.getDirectory();
    const prefix = name + ".";
    const entries: { name: string; size: number; header: number[] }[] = [];
    try {
      const directory = await root.getDirectoryHandle("kandelo-persistent-overlay");
      for await (const [name, handle] of (directory as any).entries()) {
        if (!name.startsWith(prefix) || handle.kind !== "file") continue;
        const file = await handle.getFile();
        entries.push({ name, size: file.size, header: [...new Uint8Array(await file.slice(0, 96).arrayBuffer())] });
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
    return entries;
  }, name);
  await testInfo.attach("initial-slow-read-storage", {
    body: Buffer.from(JSON.stringify({ name, imageSha256: createHash("sha256").update(image).digest("hex"), existing })),
    contentType: "application/json",
  });
  expect(existing).toEqual([]);
  const result = await page.evaluate(async ({ imageUrl, kernelUrl, moduleUrl, name }) => {
    const { BrowserKernel } = await import(moduleUrl);
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    const file = await directory.getFileHandle("base", { create: true });
    const writer = await file.createWritable();
    await writer.write(await (await fetch(imageUrl)).arrayBuffer());
    await writer.close();
    const events: { status: string; loadedBytes: number; elapsedMs: number }[] = [];
    let started = 0;
    const kernel = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024,
      onLazyDownload: event => events.push({ status: event.status, loadedBytes: event.loadedBytes, elapsedMs: performance.now() - started }),
    });
    try {
      await kernel.initFromOpfsImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImageFile: file,
        experimentalResizablePersistenceName: name,
        persistentComputerName: name,
      });
      started = performance.now();
      try {
        const bytes = await kernel.readFileFromVfs("/slow");
        return { length: bytes?.length, valid: bytes?.every(byte => byte === 86), elapsedMs: performance.now() - started, events };
      } catch (error) {
        return { error: String(error), events, elapsedMs: performance.now() - started };
      }
    } finally {
      await kernel.destroy();
    }
  }, { imageUrl, kernelUrl, moduleUrl, name });
  await testInfo.attach("slow-read-progress", {
    body: JSON.stringify({ ...result, firstChunkDelayMs: slowServer.firstChunkDelayMs() }), contentType: "application/json",
  });
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  expect(result.length).toBe(slowServer.size);
  expect(result.valid).toBe(true);
  expect(result.events.some(event => event.status === "progress" && event.loadedBytes > 0
    && event.loadedBytes < slowServer.size && event.elapsedMs < 30_000)).toBe(true);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(35_000);
  expect(slowServer.requests()).toBe(1);
});

test("OPFS file-size and inode capacities survive unlink, strict reboot, and checkpoint", async ({ page, baseURL, deferredServer }) => {
  test.skip(kernelPath === null || bashPath === null || coreutilsPath === null || mappingPath === null,
    "ABI-matched kernel, Bash, and coreutils artifacts are required");
  test.setTimeout(180_000);
  const filesystem = KandeloImageFs.create();
  filesystem.setImageCapacity(8 * 1024 * 1024);
  const verifiedUrl = deferredServer.url;
  const verifiedSize = deferredServer.size;
  const verifiedSha256 = deferredServer.sha256;
  filesystem.registerLazyFile("/verified-reader", verifiedUrl, verifiedSize, 0o600, verifiedSha256);
  filesystem.registerLazyFile("/deferred-orphan", "https://example.invalid/".padEnd(4096, "x"), 1, 0o600);
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/bin/bash", readFileSync(bashPath!), 0o755);
  filesystem.writeFile("/bin/coreutils", readFileSync(coreutilsPath!), 0o755);
  filesystem.writeFile("/bin/persistence-overwrite", readFileSync(mappingPath!), 0o755);
  for (const command of ["df", "tail", "rm", "rmdir", "sync", "mkdir", "ln", "mkfifo", "dd", "stat", "truncate"]) {
    filesystem.symlink("/bin/coreutils", "/bin/" + command);
  }
  const image = await filesystem.saveImage();
  const imageUrl = new URL("/inode-capacity.vfs", baseURL).href;
  const kernelUrl = new URL("/inode-capacity-kernel.wasm", baseURL).href;
  const moduleUrl = new URL("/@fs/" + join(repoRoot, "host/src/browser-kernel-host.ts"), baseURL).href;
  await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
  await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ imageUrl, kernelUrl, moduleUrl, script }) => {
    const { BrowserKernel } = await import(moduleUrl);
    const directory = await (await navigator.storage.getDirectory().catch((error) => {
      throw new Error("opening OPFS root failed: " + String(error));
    }))
      .getDirectoryHandle("kandelo-persistent-overlay", { create: true });
    const name = "inode-capacity-" + crypto.randomUUID();
    const file = await directory.getFileHandle(name + ".base", { create: true });
    const writer = await file.createWritable();
    await writer.write(await (await fetch(imageUrl)).arrayBuffer());
    await writer.close();
    const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
    const phases: { phase: string; code: number; output: string }[] = [];
    const memory: { phase: string; pages: number }[] = [];
    const snapshot = await directory.getFileHandle(name + ".checkpoint", { create: true });
    let integrity: OpfsImageIntegrity | undefined;
    for (const phase of ["fill", "recover", "export", "checkpoint"]) {
      let output = "";
      const decoder = new TextDecoder();
      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        kernelMaxPages: 1024,
        onStdout: (bytes) => { output += decoder.decode(bytes); },
        onStderr: (bytes) => { output += decoder.decode(bytes); },
      });
      try {
        await kernel.initFromOpfsImage({
          kernelWasm,
          vfsImageFile: phase === "checkpoint" ? snapshot : file,
          integrity: phase === "checkpoint" ? integrity : undefined,
          experimentalResizablePersistenceName: phase === "checkpoint" ? name + "-checkpoint" : name,
          persistentComputerName: phase === "checkpoint" ? name + "-checkpoint" : name,
          requireExistingRootfsPersistence: phase === "recover" || phase === "export",
        });
        if (phase === "export") {
          integrity = await kernel.exportRootfsImageToFile(snapshot);
          memory.push({ phase, pages: await kernel.getKernelMemoryPages() });
          continue;
        }
        const { exit } = await kernel.spawnFromVfs("/bin/bash", ["bash", "-c", script, "bash", phase], {
          env: ["PATH=/bin", "HOME=/"],
          uid: 0,
          gid: 0,
        });
        phases.push({ phase, code: await exit, output });
        memory.push({ phase, pages: await kernel.getKernelMemoryPages() });
      } finally {
        await kernel.destroy();
      }
    }
    return { phases, memory };
  }, { imageUrl, kernelUrl, moduleUrl, script });
  await test.info().attach("kernel-memory-pages", {
    body: JSON.stringify(result.memory),
    contentType: "application/json",
  });
  expect(result.memory).toHaveLength(4);
  expect(deferredServer.requests()).toBe(3);
  for (const entry of result.memory) {
    expect(entry.pages, entry.phase).toBeGreaterThan(0);
    expect(entry.pages, entry.phase).toBeLessThanOrEqual(1024);
  }
  expect(result.phases).toEqual([
    { phase: "fill", code: 0, output: expect.stringContaining("INODE_CAPACITY_FILLED") },
    { phase: "recover", code: 0, output: expect.stringContaining("INODE_CAPACITY_RECOVERED") },
    { phase: "checkpoint", code: 0, output: expect.stringContaining("INODE_CAPACITY_CHECKPOINTED") },
  ]);
});

test("OPFS deferred byte storage reclaims terminated owners and preserves live stores", async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const moduleUrl = new URL("/@fs/" + join(repoRoot, "host/src/vfs/opfs-deferred-byte-storage.ts"), baseURL).href;
  const result = await page.evaluate(async (moduleUrl) => {
    const script = new Blob([`
      let storage;
      self.onmessage = async ({ data }) => {
        try {
          const { openOpfsDeferredByteStorage } = await import(data.moduleUrl);
          if (data.operation === "open") {
            storage = await openOpfsDeferredByteStorage();
            storage.writeAt(0, new Uint8Array([7, 8, 9]));
          } else if (data.operation === "collect") {
            await (await openOpfsDeferredByteStorage()).close();
          } else if (data.operation === "read") {
            const bytes = new Uint8Array(3);
            storage.readAt(0, bytes);
            self.postMessage({ bytes: [...bytes] });
            return;
          } else if (data.operation === "close") {
            await storage.close();
          }
          self.postMessage({ ok: true });
        } catch (error) {
          self.postMessage({ error: data.operation + ": " + String(error) });
        }
      };
    `], { type: "text/javascript" });
    const url = URL.createObjectURL(script);
    const workers: Worker[] = [];
    const request = (worker: Worker, operation: string): Promise<{ bytes?: number[] }> => new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ moduleUrl, operation });
    });
    const open = async () => {
      const worker = new Worker(url, { type: "module" });
      workers.push(worker);
      await request(worker, "open");
      return worker;
    };
    const directory = await (await navigator.storage.getDirectory())
      .getDirectoryHandle("kandelo-deferred-bytes", { create: true });
    const count = async () => {
      let count = 0;
      for await (const name of directory.keys()) if (name.startsWith("spool-")) count++;
      return count;
    };
    await directory.getFileHandle("unrelated", { create: true });
    try {
      const abandoned = await open();
      const live = await open();
      const before = await count();
      abandoned.terminate();
      const collector = await open();
      const deadline = performance.now() + 10_000;
      while (await count() > 2 && performance.now() < deadline) {
        await request(collector, "collect");
      }
      const after = await count();
      const bytes = (await request(live, "read")).bytes;
      await request(live, "close");
      await request(collector, "close");
      const remaining = await count();
      const unrelated = await directory.getFileHandle("unrelated");
      return { before, after, bytes, remaining, unrelated: unrelated.name };
    } finally {
      for (const worker of workers) worker.terminate();
      URL.revokeObjectURL(url);
      await directory.removeEntry("unrelated");
    }
  }, moduleUrl);
  expect(result).toEqual({ before: 2, after: 2, bytes: [7, 8, 9], remaining: 0, unrelated: "unrelated" });
});

test("OPFS deferred byte transport isolates deployment aliases", async ({ page, baseURL }) => {
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const modules = Object.fromEntries([
    ["spool", "host/src/vfs/deferred-byte-spool.ts"],
    ["storage", "host/src/vfs/opfs-deferred-byte-storage.ts"],
    ["lifecycle", "host/src/process-lifecycle.ts"],
  ].map(([name, path]) => [name, new URL("/@fs/" + join(repoRoot, path!), baseURL).href]));
  const result = await page.evaluate(async modules => {
    const script = new Blob([`
      self.onmessage = async ({ data }) => {
        let spool;
        try {
          const { DeferredByteSpool } = await import(data.spool);
          const { openOpfsDeferredByteStorage } = await import(data.storage);
          const { configureRootfsOverlayFromImage } = await import(data.lifecycle);
          spool = new DeferredByteSpool(await openOpfsDeferredByteStorage());
          let provider;
          let settled;
          let calls = 0;
          const addresses = [];
          const native = {
            configureRootfsOverlay(value, prefixes, nosuid, length, read, wait) {
              provider = value;
              settled = wait;
            },
            rootfsLazyResourceLimits: () => new Map([["first", 8], ["second", 8]]),
          };
          configureRootfsOverlayFromImage(native, {
            imageRead: () => 0, imageLength: 0, foreignPrefixes: [], nosuid: true,
            deferredByteSpool: spool,
            lazyUrlMap: { first: "https://same.invalid/data", second: "https://same.invalid/data" },
            lazyFetcher: async address => {
              addresses.push(address);
              return new Response(new Uint8Array(8).fill(++calls));
            },
          })();
          const reads = [];
          for (const uri of ["first", "second", "first"]) {
            const bytes = new Uint8Array(8);
            let count = provider(uri, 0n, bytes);
            if (count === -11) {
              await settled();
              count = provider(uri, 0n, bytes);
            }
            reads.push({ count, bytes: [...bytes] });
          }
          await spool.close();
          self.postMessage({ reads, addresses });
        } catch (error) {
          await spool?.close().catch(() => {});
          self.postMessage({ error: String(error) });
        }
      };
    `], { type: "text/javascript" });
    const url = URL.createObjectURL(script);
    const worker = new Worker(url, { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage(modules);
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  }, modules);
  expect(result).toEqual({
    reads: [1, 2, 1].map(value => ({ count: 8, bytes: new Array(8).fill(value) })),
    addresses: ["https://same.invalid/data", "https://same.invalid/data"],
  });
});

test("OPFS deferred transport deadlines release stalled work without late writes", async ({ page, baseURL }) => {
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const modules = Object.fromEntries([
    ["spool", "host/src/vfs/deferred-byte-spool.ts"],
    ["storage", "host/src/vfs/opfs-deferred-byte-storage.ts"],
    ["wiring", "host/src/vfs/rootfs-lazy-archives.ts"],
  ].map(([name, path]) => [name, new URL("/@fs/" + join(repoRoot, path!), baseURL).href]));
  const result = await page.evaluate(async modules => {
    const script = new Blob([`
      self.onmessage = async ({ data }) => {
        let spool;
        try {
          const { DeferredByteSpool } = await import(data.spool);
          const { openOpfsDeferredByteStorage } = await import(data.storage);
          const { buildRootfsLazyWiring } = await import(data.wiring);
          const storage = await openOpfsDeferredByteStorage();
          const writes = [];
          spool = new DeferredByteSpool({
            ...storage,
            writeAt(offset, bytes) { writes.push([...bytes]); return storage.writeAt(offset, bytes); },
          }, 1000);
          let finish;
          const wiring = buildRootfsLazyWiring(uri => spool.fetch(async () => {
            if (uri === "headers") return new Promise(resolve => { finish = resolve; });
            if (uri === "body") return new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }));
            return new Response(new Uint8Array(8).fill(uri === "first" ? 7 : 9));
          }, uri, 8));
          const drain = async () => {
            for (;;) {
              const pending = wiring.whenFetchSettles();
              if (pending === null) return;
              await pending;
            }
          };
          const target = new Uint8Array(8);
          wiring.deferredProvider("headers", 0n, target);
          wiring.deferredProvider("first", 0n, target);
          await drain();
          const headers = wiring.deferredProvider("headers", 0n, target);
          const first = wiring.deferredProvider("first", 0n, target);
          const firstBytes = [...target];
          let discarded;
          const late = new Promise(resolve => { discarded = resolve; });
          finish(new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array(8).fill(99)); },
            cancel() { discarded(); },
          })));
          await late;
          wiring.deferredProvider("body", 0n, target);
          wiring.deferredProvider("second", 0n, target);
          await drain();
          const body = wiring.deferredProvider("body", 0n, target);
          const second = wiring.deferredProvider("second", 0n, target);
          const secondBytes = [...target];
          let started;
          const active = new Promise(resolve => { started = resolve; });
          const shutdown = spool.fetch(async () => { started(); return new Promise(() => {}); }, "shutdown", 1);
          const queued = spool.fetch(async () => new Response(new Uint8Array([1])), "queued", 1);
          const closing = Promise.allSettled([shutdown, queued]);
          await active;
          await spool.close();
          const closed = (await closing).map(result => result.status);
          self.postMessage({ headers, first, firstBytes, body, second, secondBytes, writes, closed });
        } catch (error) {
          await spool?.close().catch(() => {});
          self.postMessage({ error: String(error) });
        }
      };
    `], { type: "text/javascript" });
    const url = URL.createObjectURL(script);
    const worker = new Worker(url, { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage(modules);
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  }, modules);
  expect(result).toEqual({
    headers: -110, first: 8, firstBytes: new Array(8).fill(7),
    body: -110, second: 8, secondBytes: new Array(8).fill(9),
    writes: [new Array(8).fill(7), new Array(8).fill(9)],
    closed: ["rejected", "rejected"],
  });
});
