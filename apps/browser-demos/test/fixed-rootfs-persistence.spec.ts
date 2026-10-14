import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import type { OpfsImageIntegrity } from "../../../host/src/vfs/opfs-image-reader";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDirectory, "../../..");
const directKernelPath = resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm");
const kernelPath = tryResolveBinary("kernel.wasm") ?? (existsSync(directKernelPath) ? directKernelPath : null);
const directImageModulePath = resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_image_module.wasm");
const publishedImageModulePath = resolve(repoRoot, "local-binaries/kandelo_image_module32.wasm");
const imageModulePath = [publishedImageModulePath, directImageModulePath].find((path) => {
  if (!existsSync(path)) return false;
  return WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(path))).length === 0;
}) ?? null;
const browserKernelPath = resolve(repoRoot, "host/src/browser-kernel-host.ts");
const overlaySelectionPath = resolve(repoRoot, "host/src/vfs/overlay-generation-selection.ts");
const guestProgramPath = tryResolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm");

test.skip(kernelPath === null || imageModulePath === null, "kernel and standalone image module artifacts are required");
test.skip(guestProgramPath === null, "persistence guest fixture is required");

test("browser streams a composed resizable snapshot to OPFS and reboots without its journal", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
  const image = await filesystem.saveImage();
  const kernelUrl = new URL("/resizable-export-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/resizable-export-image.vfs", baseURL).href;
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-resizable-export-browser-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const name = `resizable-export-${crypto.randomUUID()}`;
        const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
        const imageWriter = await imageFile.createWritable();
        await imageWriter.write(await (await fetch(imageUrl)).arrayBuffer());
        await imageWriter.close();
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const bootPersistent = async () => {
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          await kernel.initFromOpfsImage({
            kernelWasm,
            vfsImageFile: imageFile,
            experimentalResizablePersistenceName: name,
          });
          return kernel;
        };
        const first = await bootPersistent();
        try {
          await first.writeFileToVfs("/state", new TextEncoder().encode("SNAP"));
          await first.writeFileToVfs("/created", new TextEncoder().encode("created"));
        } finally {
          await first.destroy();
        }
        const reopened = await bootPersistent();
        const snapshotFile = await directory.getFileHandle(`${name}.snapshot`, { create: true });
        let snapshotIntegrity: OpfsImageIntegrity;
        try {
          snapshotIntegrity = await reopened.exportRootfsImageToFile(snapshotFile);
          let overwriteRejected = false;
          try {
            await reopened.exportRootfsImageToFile(snapshotFile);
          } catch {
            overwriteRejected = true;
          }
          if (!overwriteRejected || (await snapshotFile.getFile()).size !== snapshotIntegrity.length) {
            throw new Error("snapshot export replaced a nonempty OPFS file");
          }
        } finally {
          await reopened.destroy();
        }
        const restored = new BrowserKernel({ kernelOwnedFs: true });
        let state: string;
        let created: string;
        try {
          await restored.initFromOpfsImage({ kernelWasm, vfsImageFile: snapshotFile, integrity: snapshotIntegrity });
          state = new TextDecoder().decode((await restored.readFileFromVfs("/state"))!);
          created = new TextDecoder().decode((await restored.readFileFromVfs("/created"))!);
        } finally {
          await restored.destroy();
        }
        const corrupter = await snapshotFile.createWritable({ keepExistingData: true });
        await corrupter.write({ type: "write", position: 0, data: Uint8Array.of(0) });
        await corrupter.close();
        const damaged = new BrowserKernel({ kernelOwnedFs: true });
        let damageRejected = false;
        try {
          await damaged.initFromOpfsImage({ kernelWasm, vfsImageFile: snapshotFile, integrity: snapshotIntegrity });
        } catch (error) {
          damageRejected = String(error).includes("damaged");
        } finally {
          await damaged.destroy();
        }
        return { state, created, snapshotBytes: snapshotIntegrity.length, damageRejected };
      }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, imageUrl });
      expect(result).toEqual({ state: "SNAP", created: "created", snapshotBytes: expect.any(Number), damageRejected: true });
      expect(result.snapshotBytes).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("browser reopens sparse image and created files after namespace changes", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
  const image = await filesystem.saveImage();
  const kernelUrl = new URL("/resizable-rootfs-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/resizable-rootfs-image.vfs", baseURL).href;
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-resizable-rootfs-browser-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const imageBytes = await (await fetch(imageUrl)).arrayBuffer();
        const name = `resizable-rootfs-${crypto.randomUUID()}`;
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
        const writer = await imageFile.createWritable();
        await writer.write(imageBytes);
        await writer.close();
        const statuses = [];
        for (const mode of ["resize", "verify-resize", "verify-zero", "rename-state", "verify-rename", "unlink-state", "verify-unlink", "create-file", "verify-created", "verify-created-shrunk", "verify-created-link", "create-symlink", "verify-symlink", "verify-symlink-moved", "create-tree", "verify-tree", "verify-tree-moved", "verify-tree-removed", "set-metadata", "verify-metadata", "replace-open", "verify-replacement"]) {
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm,
              vfsImageFile: imageFile,
              experimentalResizablePersistenceName: name,
            });
            const { exit } = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", mode]);
            statuses.push(await exit);
          } finally {
            await kernel.destroy();
          }
        }
        const journal = await (await directory.getFileHandle(`${name}.journal`)).getFile();
        return { statuses, journalSize: journal.size };
      }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, imageUrl });
      expect(result.statuses).toEqual(Array(22).fill(0));
      expect(result.journalSize).toBeLessThan(64 * 1024);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("browser kernel mounts a named OPFS journal and reopens it after destroy", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
  const cacheProbe = Uint8Array.from({ length: 5 * 1024 * 1024 }, (_, index) => index % 251);
  filesystem.writeFile("/cache-probe", cacheProbe, 0o644);
  const image = await filesystem.saveImage();
  const kernelUrl = new URL("/fixed-rootfs-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/fixed-rootfs-image.vfs", baseURL).href;
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-browser-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);

      const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const imageBytes = new Uint8Array(await (await fetch(imageUrl)).arrayBuffer());
        const name = `fixed-rootfs-${crypto.randomUUID()}`;
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
        const imageWriter = await imageFile.createWritable();
        await imageWriter.write(imageBytes);
        await imageWriter.close();
        const control = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await control.initFromImage({ kernelWasm: kernelBytes, vfsImage: imageBytes });
        } catch (error) {
          throw new Error(`control boot: ${error}`);
        } finally {
          await control.destroy();
        }
        const open = async (phase: string) => {
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
          } catch (error) {
            throw new Error(`${phase}: ${error}`);
          }
          return kernel;
        };
        const first = await open("first boot");
        let initial: string;
        let written: string;
        let cacheProbeMatches: boolean;
        let rejected = false;
        let locked = false;
        try {
          initial = new TextDecoder().decode(await first.readFileFromVfs("/state"));
          const cacheProbe = await first.readFileFromVfs("/cache-probe");
          cacheProbeMatches = cacheProbe?.byteLength === 5 * 1024 * 1024
            && cacheProbe[0] === 0
            && cacheProbe[64 * 1024 + 1] === (64 * 1024 + 1) % 251
            && cacheProbe[cacheProbe.byteLength - 1] === (cacheProbe.byteLength - 1) % 251;
          const competing = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await competing.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
          } catch (error) {
            locked = String(error).includes("journal is already open");
          } finally {
            await competing.destroy();
          }
          try {
            await first.writeFileToVfs("/state", new TextEncoder().encode("changed"));
          } catch {
            rejected = true;
          }
          const { exit } = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "unsynced"]);
          if (await exit !== 0) throw new Error("guest overwrite failed");
          written = new TextDecoder().decode(await first.readFileFromVfs("/state"));
        } finally {
          await first.destroy();
        }
        const second = await open("second boot");
        try {
          const journal = await (await directory.getFileHandle(`${name}.journal`)).getFile();
          return {
            name,
            journalBytes: Array.from(new Uint8Array(await journal.arrayBuffer())),
            initial,
            written,
            locked,
            rejected,
            cacheProbeMatches,
            recovered: new TextDecoder().decode(await second.readFileFromVfs("/state")),
          };
        } finally {
          await second.destroy();
        }
      }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, imageUrl });
      expect(result).toMatchObject({ initial: "abcdefgh", written: "XYcdefgh", locked: true, rejected: true, cacheProbeMatches: true, recovered: "XYcdefgh" });

      const original = Buffer.from(result.journalBytes);
      const transactionLength = original.readUInt32LE(76);
      expect(original.byteLength).toBe(72 + transactionLength);
      const transaction = Buffer.from(original.subarray(72));
      transaction.writeBigUInt64LE(2n, 8);
      createHash("sha256")
        .update(transaction.subarray(0, transaction.length - 36))
        .digest()
        .copy(transaction, transaction.length - 36);
      const cuts = [1, 24, 60, transaction.length - 1];
      const tornWrites = await page.evaluate(async ({ moduleUrl, kernelUrl, name, journalBytes, transactionBytes, cuts }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const journalFile = await directory.getFileHandle(`${name}.journal`);
        const imageFile = await directory.getFileHandle(`${name}.base`);
        const outcomes = [];
        for (const cut of cuts) {
          const bytes = new Uint8Array(journalBytes.length + cut);
          bytes.set(journalBytes);
          bytes.set(transactionBytes.slice(0, cut), journalBytes.length);
          const writer = await journalFile.createWritable();
          await writer.write(bytes);
          await writer.close();
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
              vfsImageFile: imageFile,
              experimentalFixedPersistenceName: name,
            });
            outcomes.push({
              cut,
              state: new TextDecoder().decode(await kernel.readFileFromVfs("/state")),
              journalSize: (await journalFile.getFile()).size,
            });
          } finally {
            await kernel.destroy();
          }
        }
        return outcomes;
      }, {
        moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: result.name,
        journalBytes: result.journalBytes,
        transactionBytes: Array.from(transaction),
        cuts,
      });
      expect(tornWrites).toEqual(cuts.map((cut) => ({ cut, state: "XYcdefgh", journalSize: original.length })));
      const count = Math.ceil((32 * 1024 * 1024 - original.byteLength) / transactionLength) + 1;
      const repeated = Buffer.allocUnsafe(count * transactionLength);
      for (let index = 0; index < count; index++) {
        const offset = index * transactionLength;
        original.copy(repeated, offset, 72);
        repeated.writeBigUInt64LE(BigInt(index + 2), offset + 8);
        createHash("sha256")
          .update(repeated.subarray(offset, offset + transactionLength - 36))
          .digest()
          .copy(repeated, offset + transactionLength - 36);
      }
      const journalUrl = new URL("/fixed-rootfs-large-journal.bin", baseURL).href;
      await page.route(journalUrl, (route) => route.fulfill({ body: Buffer.concat([original, repeated]) }));
      const compacted = await page.evaluate(async ({ moduleUrl, kernelUrl, journalUrl, name }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const journalFile = await directory.getFileHandle(`${name}.journal`);
        const response = await fetch(journalUrl);
        if (!response.ok) throw new Error(`large journal fetch failed: ${response.status}`);
        const writer = await journalFile.createWritable();
        await writer.write(await response.arrayBuffer());
        await writer.close();
        const imageFile = await directory.getFileHandle(`${name}.base`);
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: imageFile,
            experimentalFixedPersistenceName: name,
          });
          const state = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
          const sealed = await (await directory.getFileHandle(`${name}.g0.seal`)).getFile();
          const index = await (await directory.getFileHandle(`${name}.g0.index`)).getFile();
          const compactJournal = await (await directory.getFileHandle(`${name}.g0.journal`)).getFile();
          const sealVersion = new DataView(await sealed.slice(0, 8).arrayBuffer()).getUint32(4, true);
          return { state, sealed: sealed.size > 88, indexBytes: index.size, sealVersion, compactBytes: compactJournal.size };
        } finally {
          await kernel.destroy();
        }
      }, {
        moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        journalUrl,
        name: result.name,
      });
      expect(compacted.state).toBe("XYcdefgh");
      expect(compacted.sealed).toBe(true);
      expect(compacted.indexBytes).toBeGreaterThan(160);
      expect(compacted.sealVersion).toBe(2);
      expect(compacted.compactBytes).toBeLessThan(original.byteLength + repeated.byteLength / 2);
      const recovery = await page.evaluate(async ({ moduleUrl, overlaySelectionUrl, kernelUrl, name }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const { isNoValidOverlayGenerationError } = await import(overlaySelectionUrl);
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const sealFile = await directory.getFileHandle(`${name}.g0.seal`);
        const tearSeal = async () => {
          const writer = await sealFile.createWritable();
          await writer.write(new Uint8Array([1, 2, 3]));
          await writer.close();
        };
        const imageFile = await directory.getFileHandle(`${name}.base`);
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const indexed = new BrowserKernel({ kernelOwnedFs: true });
        let indexedState: string;
        try {
          await indexed.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
          indexedState = new TextDecoder().decode(await indexed.readFileFromVfs("/state"));
        } finally {
          await indexed.destroy();
        }
        await tearSeal();
        const fallback = new BrowserKernel({ kernelOwnedFs: true });
        let state: string;
        try {
          await fallback.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
          state = new TextDecoder().decode(await fallback.readFileFromVfs("/state"));
        } finally {
          await fallback.destroy();
        }
        await directory.removeEntry(`${name}.journal`);
        await tearSeal();
        const missing = new BrowserKernel({ kernelOwnedFs: true });
        let rejected = false;
        try {
          await missing.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
        } catch (error) {
          rejected = isNoValidOverlayGenerationError(error);
        } finally {
          await missing.destroy();
        }
        return { indexedState, state, rejected };
      }, {
        moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        overlaySelectionUrl: new URL(`/@fs/${overlaySelectionPath}`, baseURL).href,
        kernelUrl,
        name: result.name,
      });
      expect(recovery).toEqual({ indexedState: "XYcdefgh", state: "XYcdefgh", rejected: true });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

for (const mode of ["fixed", "resizable"] as const) {
test(`browser ${mode} mode rejects a semantically invalid indexed generation and restores the prior slot`, async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
  const image = await filesystem.saveImage();
  const kernelUrl = new URL("/fixed-index-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/fixed-index-image.vfs", baseURL).href;
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-fixed-index-browser-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, mode }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const name = `${mode}-index-${crypto.randomUUID()}`;
        const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
        const imageWriter = await imageFile.createWritable();
        await imageWriter.write(await (await fetch(imageUrl)).arrayBuffer());
        await imageWriter.close();
        const boot = async () => {
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
              vfsImageFile: imageFile,
              ...(mode === "fixed"
                ? { experimentalFixedPersistenceName: name }
                : { experimentalResizablePersistenceName: name }),
            });
            return kernel;
          } catch (error) {
            await kernel.destroy();
            throw error;
          }
        };
        const first = await boot();
        try {
          const { exit } = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
          if (await exit !== 0) throw new Error("guest write failed");
        } finally {
          await first.destroy();
        }
        const legacyFile = await directory.getFileHandle(`${name}.journal`);
        const committed = new Uint8Array(await (await legacyFile.getFile()).arrayBuffer());
        const baseDigest = committed.slice(8, 40);
        const writeBytes = async (suffix: string, bytes: Uint8Array) => {
          const file = await directory.getFileHandle(`${name}.${suffix}`, { create: true });
          const writer = await file.createWritable();
          await writer.write(bytes);
          await writer.close();
        };
        const hash = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
        const seal = async (journal: Uint8Array, generation: number, index?: Uint8Array) => {
          const indexed = index !== undefined;
          const headerDataBytes = indexed ? 64 : 56;
          const header = new Uint8Array(headerDataBytes + 32);
          header.set(new TextEncoder().encode("KOGS"));
          const view = new DataView(header.buffer);
          view.setUint32(4, indexed ? 2 : 1, true);
          view.setBigUint64(8, BigInt(generation), true);
          view.setBigUint64(16, BigInt(journal.length), true);
          header.set(baseDigest, 24);
          if (index) view.setBigUint64(56, BigInt(index.length), true);
          header.set(await hash(header.subarray(0, headerDataBytes)), headerDataBytes);
          const sources = index ? [journal, index] : [journal];
          const chunks = sources.reduce((total, source) => total + Math.ceil(source.length / (1024 * 1024)), 0);
          const bytes = new Uint8Array(header.length + chunks * 32);
          bytes.set(header);
          let position = header.length;
          for (const source of sources) {
            for (let offset = 0; offset < source.length; offset += 1024 * 1024) {
              bytes.set(await hash(source.subarray(offset, offset + 1024 * 1024)), position);
              position += 32;
            }
          }
          return bytes;
        };
        const priorJournal = committed.slice(0, 72);
        const index = Uint8Array.of(1, 2, 3);
        await writeBytes("g0.journal", priorJournal);
        await writeBytes("g0.seal", await seal(priorJournal, 1));
        await writeBytes("g1.journal", committed);
        await writeBytes("g1.index", index);
        await writeBytes("g1.seal", await seal(committed, 2, index));
        const legacyWriter = await legacyFile.createWritable();
        await legacyWriter.write(new TextEncoder().encode("damaged legacy"));
        await legacyWriter.close();
        const readState = async () => {
          const kernel = await boot();
          try {
            return new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
          } finally {
            await kernel.destroy();
          }
        };
        const newest = await readState();
        await writeBytes("g1.index", Uint8Array.of(0, 2, 3));
        const fallback = await readState();
        await writeBytes("g0.seal", Uint8Array.of(0));
        let refused = false;
        try {
          await readState();
        } catch (error) {
          refused = String(error).includes(`kernel refused ${mode} rootfs persistence`);
        }
        return { newest, fallback, refused };
      }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, imageUrl, mode });
      expect(result).toEqual({ newest: "abcdefgh", fallback: "abcdefgh", refused: true });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
}

test("browser replays 8192 distinct blocks after live compaction", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-fixed-large-browser-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const largeWriteBytes = 32 * 1024 * 1024;
      const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
      filesystem.mkdir("/bin", 0o755);
      filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
      filesystem.writeFile("/large", new Uint8Array(largeWriteBytes), 0o644);
      const image = await filesystem.saveImage();
      const kernelUrl = new URL("/fixed-large-kernel.wasm", baseURL).href;
      const imageUrl = new URL("/fixed-large-image.vfs", baseURL).href;
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const moduleUrl = new URL(`/@fs/${browserKernelPath}`, baseURL).href;
      const name = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const name = `fixed-large-${crypto.randomUUID()}`;
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
        const writer = await imageFile.createWritable();
        await writer.write(await (await fetch(imageUrl)).arrayBuffer());
        await writer.close();
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: imageFile,
            experimentalFixedPersistenceName: name,
          });
          for (const slot of ["g0", "g1"]) {
            for (let iteration = 0; iteration < 17; iteration++) {
              const { exit } = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "large"]);
              if (await exit !== 0) throw new Error("large guest write failed");
            }
            const deadline = Date.now() + 30_000;
            let sealed = false;
            while (Date.now() < deadline) {
              try {
                const file = await (await directory.getFileHandle(`${name}.${slot}.seal`)).getFile();
                sealed = file.size > 96;
              } catch {
                sealed = false;
              }
              if (sealed) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!sealed) throw new Error(`live compaction did not seal ${slot}`);
          }
          const many = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "many"]);
          if (await many.exit !== 0) throw new Error("distinct-block guest write failed");
          const deadline = Date.now() + 60_000;
          let indexed = false;
          while (Date.now() < deadline) {
            try {
              const seal = await (await directory.getFileHandle(`${name}.g0.seal`)).getFile();
              const sealGeneration = new DataView(await seal.slice(0, 16).arrayBuffer()).getBigUint64(8, true);
              const index = await (await directory.getFileHandle(`${name}.g0.index`)).getFile();
              const blockCount = new DataView(await index.slice(0, 88).arrayBuffer()).getBigUint64(80, true);
              indexed = sealGeneration >= 3n && blockCount === 8192n;
            } catch {
              indexed = false;
            }
            if (indexed) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!indexed) throw new Error("live compaction did not checkpoint 8192 blocks");
        } finally {
          await kernel.destroy();
        }
        return name;
      }, { moduleUrl, kernelUrl, imageUrl });
      await page.reload();
      const result = await page.evaluate(async ({ moduleUrl, kernelUrl, name, largeWriteBytes }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const imageFile = await directory.getFileHandle(`${name}.base`);
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: imageFile,
            experimentalFixedPersistenceName: name,
          });
          const verification = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "verify-many"]);
          return { size: (await kernel.statVfsPath("/large"))?.size, verified: await verification.exit === 0 };
        } finally {
          await kernel.destroy();
        }
      }, { moduleUrl, kernelUrl, name, largeWriteBytes });
      expect(result).toEqual({ size: largeWriteBytes, verified: true });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

for (const keepOpen of [false, true]) {
  test(`browser resizable compaction ${keepOpen ? "preserves open-unlinked data" : "drops closed orphan blocks"}`, async ({ playwright, browserName, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
    filesystem.writeFile("/large", new Uint8Array(32 * 1024 * 1024), 0o644);
    const image = await filesystem.saveImage();
    const kernelUrl = new URL("/resizable-orphan-kernel.wasm", baseURL).href;
    const imageUrl = new URL("/resizable-orphan-image.vfs", baseURL).href;
    const projectUse = testInfo.project.use as {
      channel?: string;
      launchOptions?: Record<string, unknown>;
      proxy?: Record<string, unknown>;
      extraHTTPHeaders?: Record<string, string>;
    };
    const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-resizable-orphan-browser-"));
    try {
      const context = await playwright[browserName].launchPersistentContext(userDataDir, {
        channel: projectUse.channel,
        proxy: projectUse.proxy as never,
        extraHTTPHeaders: projectUse.extraHTTPHeaders,
        ...(projectUse.launchOptions ?? {}),
      });
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
        await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
        await page.goto(new URL("/trap-signal-test.html", baseURL).href);
        const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, keepOpen }) => {
          const { BrowserKernel } = await import(moduleUrl);
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
          const name = `resizable-orphan-${crypto.randomUUID()}`;
          const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
          const writer = await imageFile.createWritable();
          await writer.write(await (await fetch(imageUrl)).arrayBuffer());
          await writer.close();
          const launch = async () => {
            const kernel = new BrowserKernel({ kernelOwnedFs: true });
            await kernel.initFromOpfsImage({
              kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
              vfsImageFile: imageFile,
              experimentalResizablePersistenceName: name,
            });
            return kernel;
          };
          const first = await launch();
          try {
            const write = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", keepOpen ? "open-orphan-many" : "orphan-many"]);
            if (!keepOpen && await write.exit !== 0) throw new Error("orphan guest write failed");
            const deadline = Date.now() + 60_000;
            let blockCount = -1n;
            while (Date.now() < deadline) {
              try {
                const seal = await (await directory.getFileHandle(`${name}.g0.seal`)).getFile();
                if (seal.size > 96) {
                  const index = await (await directory.getFileHandle(`${name}.g0.index`)).getFile();
                  blockCount = new DataView(await index.slice(0, 88).arrayBuffer()).getBigUint64(80, true);
                  break;
                }
              } catch {
                blockCount = -1n;
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (blockCount !== (keepOpen ? 8193n : 8192n)) throw new Error(`orphan checkpoint block count: ${blockCount}`);
            if (keepOpen) {
              await first.writeFileToVfs("/release", Uint8Array.of(1));
              if (await write.exit !== 0) throw new Error("open-orphan guest read failed");
              const next = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "many"]);
              const nextExit = await next.exit;
              if (nextExit !== 0) throw new Error(`second guest write failed: ${nextExit}`);
              const nextDeadline = Date.now() + 60_000;
              let nextBlockCount = -1n;
              while (Date.now() < nextDeadline) {
                try {
                  const seal = await (await directory.getFileHandle(`${name}.g1.seal`)).getFile();
                  if (seal.size > 96) {
                    const index = await (await directory.getFileHandle(`${name}.g1.index`)).getFile();
                    nextBlockCount = new DataView(await index.slice(0, 88).arrayBuffer()).getBigUint64(80, true);
                    break;
                  }
                } catch {
                  nextBlockCount = -1n;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              if (nextBlockCount !== 8192n) throw new Error(`closed orphan checkpoint block count: ${nextBlockCount}`);
            }
          } finally {
            await first.destroy();
          }
          const reopened = await launch();
          try {
            const verification = await reopened.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "verify-orphan-many"]);
            return await verification.exit;
          } finally {
            await reopened.destroy();
          }
        }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, imageUrl, keepOpen });
        expect(result).toBe(0);
      } finally {
        await context.close();
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}

test("browser termination loses unsynced writes without damaging the last durable image", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
  const image = await filesystem.saveImage();
  const kernelUrl = new URL("/fixed-crash-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/fixed-crash-image.vfs", baseURL).href;
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-fixed-crash-browser-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const before = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const imageBytes = new Uint8Array(await (await fetch(imageUrl)).arrayBuffer());
        const name = `fixed-crash-${crypto.randomUUID()}`;
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
        const writer = await imageFile.createWritable();
        await writer.write(imageBytes);
        await writer.close();
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        await kernel.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
        const { exit } = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "unsynced"]);
        if (await exit !== 0) throw new Error("guest overwrite failed");
        (window as unknown as { crashKernel: unknown }).crashKernel = kernel;
        return { name, visible: new TextDecoder().decode(await kernel.readFileFromVfs("/state")) };
      }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, imageUrl });
      expect(before.visible).toBe("XYcdefgh");
      await page.reload();
      const recovered = await page.evaluate(async ({ moduleUrl, kernelUrl, name }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const imageFile = await directory.getFileHandle(`${name}.base`);
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
          return new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
        } finally {
          await kernel.destroy();
        }
      }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, name: before.name });
      expect(recovered).toBe("abcdefgh");
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

const quotaScenarios = (["fixed", "resizable"] as const).flatMap((mode) =>
  (["write", "partial", "flush", "evict"] as const).map((fault) => ({ mode, fault })));
for (const { mode, fault } of quotaScenarios) {
  test(`browser ${mode} ${fault} quota failure rejects durability sync, preserves dirty reads, and recovers`, async ({ playwright, browserName, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
    filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
    if (fault === "evict") filesystem.writeFile("/large", new Uint8Array(65 * 4096), 0o644);
    const image = await filesystem.saveImage();
    const kernelUrl = new URL(`/quota-${mode}-kernel.wasm`, baseURL).href;
    const imageUrl = new URL(`/quota-${mode}-image.vfs`, baseURL).href;
    const quotaWorkerPath = resolve(testDirectory, "fixtures/opfs-overlay-write-quota-worker.ts");
    const projectUse = testInfo.project.use as {
      channel?: string;
      launchOptions?: Record<string, unknown>;
      proxy?: Record<string, unknown>;
      extraHTTPHeaders?: Record<string, string>;
    };
    const userDataDir = mkdtempSync(join(tmpdir(), `kandelo-${mode}-quota-browser-`));
    try {
      const context = await playwright[browserName].launchPersistentContext(userDataDir, {
        channel: projectUse.channel,
        proxy: projectUse.proxy as never,
        extraHTTPHeaders: projectUse.extraHTTPHeaders,
        ...(projectUse.launchOptions ?? {}),
      });
      try {
        const page = context.pages()[0] ?? await context.newPage();
        await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
        await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
        await page.goto(new URL("/trap-signal-test.html", baseURL).href);
        const before = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, quotaWorkerUrl, mode, fault }) => {
          const { BrowserKernel } = await import(moduleUrl);
          const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
          const imageBytes = await (await fetch(imageUrl)).arrayBuffer();
          const name = `${mode}-quota-${crypto.randomUUID()}`;
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
          const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
          const writer = await imageFile.createWritable();
          await writer.write(imageBytes);
          await writer.close();
          const OriginalWorker = Worker;
          let redirected = 0;
          const workerErrors: string[] = [];
          globalThis.Worker = class extends OriginalWorker {
            constructor(url: string | URL, options?: WorkerOptions) {
              if (String(url).includes("browser-kernel-worker-entry")) {
                const faultUrl = new URL(quotaWorkerUrl);
                faultUrl.searchParams.set("name", name);
                faultUrl.searchParams.set("fault", fault === "evict" ? "write" : fault);
                redirected++;
                super(faultUrl, options);
              } else {
                super(url, options);
              }
              this.addEventListener("error", (event) => workerErrors.push(event.message));
            }
          };
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          await Promise.race([
            kernel.initFromOpfsImage({
              kernelWasm: kernelBytes,
              vfsImageFile: imageFile,
              ...(mode === "fixed"
                ? { experimentalFixedPersistenceName: name }
                : { experimentalResizablePersistenceName: name }),
            }),
            new Promise<never>((_, reject) => setTimeout(
              () => reject(new Error(`quota worker init timed out: redirected=${redirected}, errors=${workerErrors.join("|")}`)),
              30_000,
            )),
          ]);
          const { exit } = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", fault === "evict" ? "quota-evict" : "quota-write"]);
          const status = await exit;
          const visible = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
          const large = fault === "evict" ? await kernel.readFileFromVfs("/large") : null;
          (window as unknown as { crashKernel: unknown }).crashKernel = kernel;
          return {
            name,
            status,
            visible,
            redirected,
            dirtyPrefix: large === null || large.subarray(0, 64 * 4096).every((byte) => byte === 88),
            unwrittenTail: large === null || large.subarray(64 * 4096).every((byte) => byte === 0),
          };
        }, {
          moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
          kernelUrl,
          imageUrl,
          quotaWorkerUrl: new URL(`/@fs/${quotaWorkerPath}`, baseURL).href,
          mode,
          fault,
        });
        expect(before).toMatchObject({
          status: 0,
          visible: fault === "evict" ? "abcdefgh" : "XYcdefgh",
          redirected: 1,
          dirtyPrefix: true,
          unwrittenTail: true,
        });
        await page.reload();
        const recovered = await page.evaluate(async ({ moduleUrl, kernelUrl, name, mode, fault }) => {
          const { BrowserKernel } = await import(moduleUrl);
          const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
          const imageFile = await directory.getFileHandle(`${name}.base`);
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm: kernelBytes,
              vfsImageFile: imageFile,
              ...(mode === "fixed"
                ? { experimentalFixedPersistenceName: name }
                : { experimentalResizablePersistenceName: name }),
            });
            const state = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
            const large = fault === "evict" ? await kernel.readFileFromVfs("/large") : null;
            return { state, largeIsZero: large === null || large.every((byte) => byte === 0) };
          } finally {
            await kernel.destroy();
          }
        }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, name: before.name, mode, fault });
        if (fault === "flush") {
          expect(["abcdefgh", "XYcdefgh"]).toContain(recovered.state);
        } else {
          expect(recovered.state).toBe("abcdefgh");
        }
        expect(recovered.largeIsZero).toBe(true);
      } finally {
        await context.close();
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
