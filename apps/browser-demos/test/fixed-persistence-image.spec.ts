import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const modulePath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../pages/kandelo/kernel-host/fixed-persistence-image.ts");
const streamWorkerPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures/fixed-persistence-stream-worker.ts");
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const imageModulePath = [
  resolve(repoRoot, "local-binaries/kandelo_image_module32.wasm"),
  resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_image_module.wasm"),
].find((path) => existsSync(path) && WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(path))).length === 0) ?? null;
const kernelPath = tryResolveBinary("kernel.wasm") ?? [
  resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"),
].find(existsSync) ?? null;
const guestProgramPath = tryResolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm");
const browserKernelPath = resolve(repoRoot, "host/src/browser-kernel-host.ts");

test("experimental computer keeps exact base bytes and rejects damaged images", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-fixed-image-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async (url) => {
        const { loadFixedPersistenceImage, loadFixedPersistenceImageHandle, saveFixedPersistenceImage } = await import(url);
        const name = `image-${crypto.randomUUID()}`;
        const identity = "source A, profile A";
        const proposed = new Uint8Array([1, 2, 3, 4]);
        const lazyAssets = {
          deploymentBase: `${location.origin}/`,
          directoryUrl: `${location.origin}/assets/`,
          manifestUrl: `${location.origin}/assets/manifest.json`,
        };
        const before = await loadFixedPersistenceImage(name, identity);
        const composition = {
          imageConfig: { version: 1 as const, defaultProfile: "probe", profiles: { probe: {} } },
          profileId: "probe",
          terminalSession: {
            kind: "kandelo-experimental-terminal-session" as const,
            version: 1 as const,
            initial: { path: "/bin/probe", argv: ["probe"], uid: 0, gid: 0 },
          },
          requiredServices: [],
        };
        const saved = await saveFixedPersistenceImage(name, identity, proposed, lazyAssets, composition);
        const restored = await loadFixedPersistenceImage(name, identity);
        const imageHandle = await loadFixedPersistenceImageHandle(name, identity);
        let wrongIdentity = false;
        try {
          await loadFixedPersistenceImage(name, "source B, profile A");
        } catch {
          wrongIdentity = true;
        }
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const manifestFile = await directory.getFileHandle(`${name}.base.json`);
        const manifestText = await (await manifestFile.getFile()).text();
        const writeManifest = async (value: string) => {
          const writer = await manifestFile.createWritable();
          await writer.write(value);
          await writer.close();
        };
        const damagedManifest = JSON.parse(manifestText);
        damagedManifest.lazyAssets.manifestUrl = `${location.origin}/wrong.json`;
        await writeManifest(JSON.stringify(damagedManifest));
        let damagedMetadata = false;
        try {
          await loadFixedPersistenceImage(name, identity);
        } catch {
          damagedMetadata = true;
        }
        const damagedChunksManifest = JSON.parse(manifestText);
        damagedChunksManifest.chunkSha256[0] = "0".repeat(64);
        await writeManifest(JSON.stringify(damagedChunksManifest));
        let damagedChunks = false;
        try {
          await loadFixedPersistenceImageHandle(name, identity);
        } catch {
          damagedChunks = true;
        }
        const legacyManifest = JSON.parse(manifestText);
        delete legacyManifest.lazyAssets;
        delete legacyManifest.lazyAssetsSha256;
        delete legacyManifest.chunkSha256;
        delete legacyManifest.chunkSha256Digest;
        delete legacyManifest.composition;
        delete legacyManifest.compositionSha256;
        await writeManifest(JSON.stringify(legacyManifest));
        const legacy = await loadFixedPersistenceImage(name, identity);
        const baseFile = await directory.getFileHandle(`${name}.base`);
        const writer = await baseFile.createWritable();
        await writer.write(new Uint8Array([9, 2, 3, 4]));
        await writer.close();
        let damaged = false;
        try {
          await loadFixedPersistenceImage(name, identity);
        } catch {
          damaged = true;
        }
        return {
          before,
          saved: Array.from(saved.imageBytes),
          restored: Array.from(restored?.imageBytes ?? []),
          lazyAssets: restored?.lazyAssets,
          recorded: restored?.lazyAssetsRecorded,
          handleLength: imageHandle?.length,
          handleProfile: imageHandle?.composition.profileId,
          legacyRecorded: legacy?.lazyAssetsRecorded,
          damagedMetadata,
          damagedChunks,
          wrongIdentity,
          damaged,
        };
      }, new URL(`/@fs/${modulePath}`, baseURL).href);
      expect(result).toEqual({
        before: null,
        saved: [1, 2, 3, 4],
        restored: [1, 2, 3, 4],
        lazyAssets: {
          deploymentBase: new URL("/", baseURL).href,
          directoryUrl: new URL("/assets/", baseURL).href,
          manifestUrl: new URL("/assets/manifest.json", baseURL).href,
        },
        recorded: true,
        handleLength: 4,
        handleProfile: "probe",
        legacyRecorded: false,
        damagedMetadata: true,
        damagedChunks: true,
        wrongIdentity: true,
        damaged: true,
      });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("streamed OPFS installation publishes only a verified complete image", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-streamed-image-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ url, workerUrl }) => {
        const { loadFixedPersistenceImageHandle, markFixedPersistenceJournalInitialized, publishFixedPersistenceSnapshot, saveFixedPersistenceImageStream } = await import(url);
        const name = `stream-${crypto.randomUUID()}`;
        const identity = "streamed image";
        const journalName = `j-${crypto.randomUUID()}`;
        const composition = {
          imageConfig: { version: 1 as const, defaultProfile: "probe", profiles: { probe: {} } },
          profileId: "probe",
          terminalSession: {
            kind: "kandelo-experimental-terminal-session" as const,
            version: 1 as const,
            initial: { path: "/bin/probe", argv: ["probe"], uid: 0, gid: 0 },
          },
          requiredServices: [],
        };
        const first = new Uint8Array(1024 * 1024).fill(7);
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const orphanName = `${name}.${crypto.randomUUID()}.base`;
        const orphan = await directory.getFileHandle(orphanName, { create: true });
        const orphanWriter = await orphan.createWritable();
        await orphanWriter.write(Uint8Array.of(99));
        await orphanWriter.close();
        const worker = new Worker(workerUrl, { type: "module" });
        const saved = await new Promise<{ file: FileSystemFileHandle; length: number }>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<{ type: string; file?: FileSystemFileHandle; length?: number; message?: string }>) => {
            if (event.data.type === "done" && event.data.file && event.data.length !== undefined) {
              resolve({ file: event.data.file, length: event.data.length });
            } else {
              reject(new Error(event.data.message ?? "stream worker failed"));
            }
          };
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({ name, identity, journalName });
        }).finally(() => worker.terminate());
        const restored = await loadFixedPersistenceImageHandle(name, identity);
        let prematureInitializationRejected = false;
        try {
          await markFixedPersistenceJournalInitialized(name, identity, restored!);
        } catch {
          prematureInitializationRejected = true;
        }
        const stillPending = (await loadFixedPersistenceImageHandle(name, identity))?.journalInitialized === false;
        const foreignHeader = new Uint8Array(72);
        foreignHeader.set(new TextEncoder().encode("KOVL"));
        new DataView(foreignHeader.buffer).setUint32(4, 1, true);
        foreignHeader.fill(3, 8, 40);
        foreignHeader.set(new Uint8Array(await crypto.subtle.digest("SHA-256", foreignHeader.subarray(0, 40))), 40);
        const foreignJournal = await directory.getFileHandle(`${journalName}.journal`, { create: true });
        const foreignWriter = await foreignJournal.createWritable();
        await foreignWriter.write(foreignHeader);
        await foreignWriter.close();
        let foreignJournalRejected = false;
        try {
          await markFixedPersistenceJournalInitialized(name, identity, restored!);
        } catch {
          foreignJournalRejected = true;
        }
        await directory.removeEntry(`${journalName}.journal`);
        const cloneName = `snapshot-${crypto.randomUUID()}`;
        const integrity = {
          length: restored!.length,
          chunkBytes: 1024 * 1024,
          chunkSha256: restored!.chunkSha256,
        };
        await publishFixedPersistenceSnapshot(
          cloneName, identity, restored!.file, integrity, restored!.lazyAssets, restored!.composition,
        );
        const clone = await loadFixedPersistenceImageHandle(cloneName, identity);
        const manifestFile = await directory.getFileHandle(`${name}.base.json`);
        const manifestText = await (await manifestFile.getFile()).text();
        const changedManifest = JSON.parse(manifestText);
        changedManifest.journalName = `j-${crypto.randomUUID()}`;
        const changedWriter = await manifestFile.createWritable();
        await changedWriter.write(JSON.stringify(changedManifest));
        await changedWriter.close();
        let journalBindingRejected = false;
        try {
          await loadFixedPersistenceImageHandle(name, identity);
        } catch {
          journalBindingRejected = true;
        }
        const restoreWriter = await manifestFile.createWritable();
        await restoreWriter.write(manifestText);
        await restoreWriter.close();
        const version3Manifest = JSON.parse(manifestText);
        version3Manifest.format = "kandelo-fixed-rootfs-image-v3";
        delete version3Manifest.journalInitialized;
        delete version3Manifest.imageSha256;
        const version3Binding = new TextEncoder().encode(JSON.stringify([
          identity, version3Manifest.imageFileName, journalName,
        ]));
        version3Manifest.journalNameSha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", version3Binding)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        const version3Writer = await manifestFile.createWritable();
        await version3Writer.write(JSON.stringify(version3Manifest));
        await version3Writer.close();
        const version3Handle = await loadFixedPersistenceImageHandle(name, identity);
        const legacyManifest = JSON.parse(manifestText);
        delete legacyManifest.journalName;
        delete legacyManifest.journalNameSha256;
        const legacyWriter = await manifestFile.createWritable();
        await legacyWriter.write(JSON.stringify(legacyManifest));
        await legacyWriter.close();
        let missingJournalRejected = false;
        try {
          await loadFixedPersistenceImageHandle(name, identity);
        } catch {
          missingJournalRejected = true;
        }
        legacyManifest.format = "kandelo-fixed-rootfs-image-v2";
        delete legacyManifest.journalInitialized;
        delete legacyManifest.imageSha256;
        const legacyVersionWriter = await manifestFile.createWritable();
        await legacyVersionWriter.write(JSON.stringify(legacyManifest));
        await legacyVersionWriter.close();
        const legacyJournalName = (await loadFixedPersistenceImageHandle(name, identity))?.journalName;
        const restoreBoundWriter = await manifestFile.createWritable();
        await restoreBoundWriter.write(manifestText);
        await restoreBoundWriter.close();
        let orphanRemoved = false;
        try {
          await directory.getFileHandle(orphanName);
        } catch (error) {
          orphanRemoved = error instanceof DOMException && error.name === "NotFoundError";
        }
        const readWorker = new Worker(workerUrl, { type: "module" });
        const positionedRead = await new Promise<{
          first: number[];
          last: number[];
          firstRead: number;
          lastRead: number;
        }>((resolve, reject) => {
          readWorker.onmessage = (event: MessageEvent<{
            type: string;
            first?: number[];
            last?: number[];
            firstRead?: number;
            lastRead?: number;
            message?: string;
          }>) => {
            if (event.data.type === "read") {
              resolve({
                first: event.data.first!,
                last: event.data.last!,
                firstRead: event.data.firstRead!,
                lastRead: event.data.lastRead!,
              });
            } else {
              reject(new Error(event.data.message ?? "positioned read failed"));
            }
          };
          readWorker.onerror = (event) => reject(new Error(event.message));
          readWorker.postMessage({ file: restored!.file, length: restored!.length, chunkSha256: restored!.chunkSha256 });
        }).finally(() => readWorker.terminate());
        const file = await restored?.file.getFile();
        const last = file === undefined
          ? []
          : [...new Uint8Array(await file.slice(file.size - 3).arrayBuffer())];
        const filePrototype = Object.getPrototypeOf(restored!.file) as FileSystemFileHandle;
        const originalCreateWritable = filePrototype.createWritable;
        const lostAckName = `stream-${crypto.randomUUID()}`;
        let lostAckInjected = false;
        filePrototype.createWritable = async function (this: FileSystemFileHandle, options) {
          const writer = await originalCreateWritable.call(this, options);
          if (this.name !== `${lostAckName}.base.json`) return writer;
          return {
            write: (...args: Parameters<typeof writer.write>) => writer.write(...args),
            close: async () => {
              await writer.close();
              lostAckInjected = true;
              throw new Error("injected lost install close acknowledgement");
            },
            abort: () => writer.abort(),
          } as FileSystemWritableFileStream;
        };
        let lostAckSaved: Awaited<ReturnType<typeof saveFixedPersistenceImageStream>>;
        try {
          lostAckSaved = await saveFixedPersistenceImageStream(
            lostAckName, identity, [first], undefined, composition,
          );
        } finally {
          filePrototype.createWritable = originalCreateWritable;
        }
        const lostAckRestored = await loadFixedPersistenceImageHandle(lostAckName, identity);
        const lostAckCommitted = lostAckRestored !== null &&
          await lostAckRestored.file.isSameEntry(lostAckSaved.file);
        const rejectedCloseName = `stream-${crypto.randomUUID()}`;
        filePrototype.createWritable = async function (this: FileSystemFileHandle, options) {
          const writer = await originalCreateWritable.call(this, options);
          if (this.name !== `${rejectedCloseName}.base.json`) return writer;
          return {
            write: (...args: Parameters<typeof writer.write>) => writer.write(...args),
            close: async () => { throw new Error("injected install close failure"); },
            abort: () => writer.abort(),
          } as FileSystemWritableFileStream;
        };
        let rejectedCloseFailed = false;
        try {
          await saveFixedPersistenceImageStream(
            rejectedCloseName, identity, [first], undefined, composition,
          );
        } catch (error) {
          rejectedCloseFailed = String(error).includes("injected install close failure");
        } finally {
          filePrototype.createWritable = originalCreateWritable;
        }
        const rejectedCloseUnpublished = await loadFixedPersistenceImageHandle(rejectedCloseName, identity) === null;
        const abandonedImages: string[] = [];
        for await (const [entryName] of (directory as FileSystemDirectoryHandle & {
          entries(): AsyncIterable<[string, FileSystemHandle]>;
        }).entries()) {
          if (entryName.startsWith(`${rejectedCloseName}.`) && entryName.endsWith(".base")) {
            abandonedImages.push(entryName);
          }
        }
        const retriedInstall = await saveFixedPersistenceImageStream(
          rejectedCloseName, identity, [first], undefined, composition,
        );
        const retriedRestored = await loadFixedPersistenceImageHandle(rejectedCloseName, identity);
        let abandonedRemoved = abandonedImages.length === 1 && retriedRestored !== null &&
          await retriedRestored.file.isSameEntry(retriedInstall.file);
        for (const entryName of abandonedImages) {
          try {
            await directory.getFileHandle(entryName);
            abandonedRemoved = false;
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== "NotFoundError") abandonedRemoved = false;
          }
        }
        const damagedFirst = first.slice();
        damagedFirst[0] = 8;
        const damageWriter = await restored!.file.createWritable();
        await damageWriter.write(damagedFirst);
        await damageWriter.write(Uint8Array.of(1, 2, 3));
        await damageWriter.close();
        const failedName = `snapshot-${crypto.randomUUID()}`;
        let damagedSnapshotRejected = false;
        try {
          await publishFixedPersistenceSnapshot(
            failedName, identity, restored!.file, integrity, restored!.lazyAssets, restored!.composition,
          );
        } catch {
          damagedSnapshotRejected = true;
        }
        const failedSnapshot = await loadFixedPersistenceImageHandle(failedName, identity);
        const cloneFile = await clone!.file.getFile();
        const cloneTail = [...new Uint8Array(await cloneFile.slice(cloneFile.size - 3).arrayBuffer())];
        const corruptWorker = new Worker(workerUrl, { type: "module" });
        const corruptionRejected = await new Promise<boolean>((resolve, reject) => {
          corruptWorker.onmessage = (event: MessageEvent<{ type: string; message?: string }>) => {
            resolve(event.data.type === "error" && /damaged/.test(event.data.message ?? ""));
          };
          corruptWorker.onerror = (event) => reject(new Error(event.message));
          corruptWorker.postMessage({ file: restored!.file, length: restored!.length, chunkSha256: restored!.chunkSha256 });
        }).finally(() => corruptWorker.terminate());
        const interruptedName = `stream-${crypto.randomUUID()}`;
        function* interrupted(): IterableIterator<Uint8Array> {
          yield first;
          throw new Error("injected interruption");
        }
        let interruptedRejected = false;
        try {
          await saveFixedPersistenceImageStream(
            interruptedName,
            identity,
            interrupted(),
            undefined,
            composition,
          );
        } catch {
          interruptedRejected = true;
        }
        const incomplete = await loadFixedPersistenceImageHandle(interruptedName, identity);
        return {
          savedLength: saved.length,
          clonedFileLength: (await saved.file.getFile()).size,
          restoredLength: restored?.length,
          name,
          journalName,
          restoredJournalName: restored?.journalName,
          digestCount: restored?.chunkSha256.length,
          journalBindingRejected,
          version3JournalName: version3Handle?.journalName,
          version3Ready: version3Handle?.journalInitialized,
          prematureInitializationRejected,
          stillPending,
          foreignJournalRejected,
          missingJournalRejected,
          legacyJournalName,
          orphanRemoved,
          lostAckInjected,
          lostAckCommitted,
          rejectedCloseFailed,
          rejectedCloseUnpublished,
          abandonedRemoved,
          last,
          positionedRead,
          corruptionRejected,
          cloneName,
          cloneLength: clone?.length,
          cloneJournalName: clone?.journalName,
          cloneTail,
          damagedSnapshotRejected,
          failedSnapshotUnpublished: failedSnapshot === null,
          interruptedRejected,
          incomplete: incomplete === null,
        };
      }, {
        url: new URL(`/@fs/${modulePath}`, baseURL).href,
        workerUrl: new URL(`/@fs/${streamWorkerPath}`, baseURL).href,
      });
      const { cloneName, journalName, restoredJournalName, version3JournalName, name, legacyJournalName, ...observed } = result;
      expect(restoredJournalName).toBe(journalName);
      expect(version3JournalName).toBe(journalName);
      expect(legacyJournalName).toBe(name);
      expect(observed).toEqual({
        savedLength: 1024 * 1024 + 3,
        clonedFileLength: 1024 * 1024 + 3,
        restoredLength: 1024 * 1024 + 3,
        digestCount: 2,
        journalBindingRejected: true,
        version3Ready: true,
        prematureInitializationRejected: true,
        stillPending: true,
        foreignJournalRejected: true,
        missingJournalRejected: true,
          orphanRemoved: true,
          lostAckInjected: true,
          lostAckCommitted: true,
          rejectedCloseFailed: true,
          rejectedCloseUnpublished: true,
          abandonedRemoved: true,
        last: [1, 2, 3],
        positionedRead: { first: [7, 7, 7], last: [1, 2, 3], firstRead: 3, lastRead: 3 },
        corruptionRejected: true,
        cloneLength: 1024 * 1024 + 3,
        cloneJournalName: cloneName,
        cloneTail: [1, 2, 3],
        damagedSnapshotRejected: true,
        failedSnapshotUnpublished: true,
        interruptedRejected: true,
        incomplete: true,
      });
      await page.reload();
      const reloadedClone = await page.evaluate(async ({ url, name }) => {
        const { loadFixedPersistenceImageHandle } = await import(url);
        const clone = await loadFixedPersistenceImageHandle(name, "streamed image");
        if (clone === null) return null;
        const file = await clone.file.getFile();
        return {
          length: clone.length,
          tail: [...new Uint8Array(await file.slice(file.size - 3).arrayBuffer())],
        };
      }, { url: new URL(`/@fs/${modulePath}`, baseURL).href, name: cloneName });
      expect(reloadedClone).toEqual({ length: 1024 * 1024 + 3, tail: [1, 2, 3] });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

for (const cut of ["before", "after"] as const) {
test(`closing a tab ${cut} replacement manifest commit selects the right generation`, async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(imageModulePath === null || kernelPath === null || guestProgramPath === null,
    "kernel, image writer, and guest artifacts are required");
  const imageModule = new Uint8Array(readFileSync(imageModulePath!));
  const guestProgram = new Uint8Array(readFileSync(guestProgramPath!));
  const makeImage = async (state: string) => {
    const filesystem = KandeloImageFs.create(imageModule);
    filesystem.setImageCapacity(8 * 1024 * 1024);
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile("/bin/persistence-overwrite", guestProgram, 0o755);
    filesystem.writeFile("/state", new TextEncoder().encode(state), 0o644);
    return filesystem.saveImage();
  };
  const previousImage = await makeImage("abcdefgh");
  const replacementImage = await makeImage("replacement");
  const kernelUrl = new URL("/replacement-tab-close-kernel.wasm", baseURL).href;
  const previousImageUrl = new URL("/replacement-tab-close-previous.vfs", baseURL).href;
  const replacementImageUrl = new URL("/replacement-tab-close-staged.vfs", baseURL).href;
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-replacement-tab-close-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      await context.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await context.route(previousImageUrl, (route) => route.fulfill({ body: Buffer.from(previousImage) }));
      await context.route(replacementImageUrl, (route) => route.fulfill({ body: Buffer.from(replacementImage) }));
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const primaryClosed = page.waitForEvent("console", {
        predicate: (message) => message.text() === `replacement primary manifest ${cut} close`,
        timeout: 30_000,
      });
      const { name, identity, stagedJournalName, previousJournalName } = await page.evaluate(async ({
        url, browserKernelUrl, kernelUrl, previousImageUrl, replacementImageUrl, cut,
      }) => {
        const {
          loadFixedPersistenceImageHandle,
          markFixedPersistenceJournalInitialized,
          publishFixedPersistenceReplacement,
          saveFixedPersistenceImageStream,
          stageFixedPersistenceReplacement,
        } = await import(url);
        const { BrowserKernel } = await import(browserKernelUrl);
        const name = `crash-replacement-${crypto.randomUUID()}`;
        const identity = "replacement crash boundary";
        const composition = {
          imageConfig: { version: 1 as const, defaultProfile: "probe", profiles: { probe: {} } },
          profileId: "probe",
          terminalSession: {
            kind: "kandelo-experimental-terminal-session" as const,
            version: 1 as const,
            initial: { path: "/bin/probe", argv: ["probe"], uid: 0, gid: 0 },
          },
          requiredServices: [],
        };
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const previousImage = new Uint8Array(await (await fetch(previousImageUrl)).arrayBuffer());
        const replacementImage = new Uint8Array(await (await fetch(replacementImageUrl)).arrayBuffer());
        const previous = await saveFixedPersistenceImageStream(
          name, identity, [previousImage], undefined, composition,
        );
        const first = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await first.initFromOpfsImage({
            kernelWasm,
            vfsImageFile: previous.file,
            integrity: { length: previous.length, chunkBytes: 1024 * 1024, chunkSha256: previous.chunkSha256 },
            experimentalFixedPersistenceName: previous.journalName,
            persistentComputerName: name,
          });
          await markFixedPersistenceJournalInitialized(name, identity, previous);
          const { exit } = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
          if (await exit !== 0) throw new Error("prior guest write failed");
        } finally {
          await first.destroy();
        }
        const ready = await loadFixedPersistenceImageHandle(name, identity);
        if (ready === null) throw new Error("prior generation did not become ready");
        const staged = await stageFixedPersistenceReplacement(
          name, identity, [replacementImage], undefined, composition,
        );
        const stagedKernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await stagedKernel.initFromOpfsImage({
            kernelWasm,
            vfsImageFile: staged.file,
            integrity: { length: staged.length, chunkBytes: 1024 * 1024, chunkSha256: staged.chunkSha256 },
            experimentalFixedPersistenceName: staged.journalName,
            persistentComputerName: name,
          });
          const state = new TextDecoder().decode(await stagedKernel.readFileFromVfs("/state"));
          if (state !== "replacement") throw new Error("staged generation did not boot");
        } finally {
          await stagedKernel.destroy();
        }
        const filePrototype = Object.getPrototypeOf(staged.file) as FileSystemFileHandle;
        const originalCreateWritable = filePrototype.createWritable;
        filePrototype.createWritable = async function (this: FileSystemFileHandle, options) {
          const writer = await originalCreateWritable.call(this, options);
          if (this.name !== `${name}.base.json`) return writer;
          return {
            write: (...args: Parameters<typeof writer.write>) => writer.write(...args),
            close: async () => {
              if (cut === "after") await writer.close();
              console.log(`replacement primary manifest ${cut} close`);
              await new Promise<never>(() => {});
            },
            abort: () => writer.abort(),
          } as FileSystemWritableFileStream;
        };
        void publishFixedPersistenceReplacement(name, identity, ready, staged);
        return { name, identity, stagedJournalName: staged.journalName, previousJournalName: ready.journalName };
      }, {
        url: new URL(`/@fs/${modulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        previousImageUrl,
        replacementImageUrl,
        cut,
      });
      await primaryClosed;
      await page.close();
      const reopened = await context.newPage();
      try {
        await reopened.goto(new URL("/trap-signal-test.html", baseURL).href);
        const recovered = await reopened.evaluate(async ({ url, browserKernelUrl, kernelUrl, name, identity }) => {
          const { loadFixedPersistenceImageHandle, loadPreviousFixedPersistenceImageHandle } = await import(url);
          const { BrowserKernel } = await import(browserKernelUrl);
          const current = await loadFixedPersistenceImageHandle(name, identity);
          if (current === null) throw new Error("committed replacement disappeared after tab close");
          const previous = await loadPreviousFixedPersistenceImageHandle(name, identity, current);
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
              vfsImageFile: current.file,
              integrity: { length: current.length, chunkBytes: 1024 * 1024, chunkSha256: current.chunkSha256 },
              experimentalFixedPersistenceName: current.journalName,
              persistentComputerName: name,
              requireExistingRootfsPersistence: true,
            });
            const state = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
            return { current: current.journalName, previous: previous?.journalName ?? null, state };
          } finally {
            await kernel.destroy();
          }
        }, {
          url: new URL(`/@fs/${modulePath}`, baseURL).href,
          browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
          kernelUrl,
          name,
          identity,
        });
        expect(recovered).toEqual(cut === "after"
          ? { current: stagedJournalName, previous: previousJournalName, state: "replacement" }
          : { current: previousJournalName, previous: null, state: "XYcdefgh" });
      } finally {
        await reopened.close();
      }
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
}

test("a guest-written snapshot replaces a computer after staged boot", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(imageModulePath === null || kernelPath === null || guestProgramPath === null,
    "kernel, image writer, and guest artifacts are required");
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-snapshot-replacement-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
      filesystem.setImageCapacity(8 * 1024 * 1024);
      filesystem.mkdir("/bin", 0o755);
      filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
      filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
      const image = await filesystem.saveImage();
      const kernelUrl = new URL("/snapshot-replacement-kernel.wasm", baseURL).href;
      const imageUrl = new URL("/snapshot-replacement-base.vfs", baseURL).href;
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const staged = await page.evaluate(async ({ moduleUrl, browserKernelUrl, kernelUrl, imageUrl }) => {
        const {
          loadFixedPersistenceImageHandle,
          markFixedPersistenceJournalInitialized,
          publishFixedPersistenceReplacement,
          saveFixedPersistenceImageStream,
          stageFixedPersistenceSnapshotReplacement,
        } = await import(moduleUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const name = `snapshot-replacement-${crypto.randomUUID()}`;
        const identity = "snapshot replacement";
        const composition = {
          imageConfig: { version: 1 as const, defaultProfile: "probe", profiles: { probe: {} } },
          profileId: "probe",
          terminalSession: {
            kind: "kandelo-experimental-terminal-session" as const,
            version: 1 as const,
            initial: { path: "/bin/persistence-overwrite", argv: ["persistence-overwrite"], uid: 0, gid: 0 },
          },
          requiredServices: [],
        };
        const previous = await saveFixedPersistenceImageStream(
          name, identity, [new Uint8Array(await (await fetch(imageUrl)).arrayBuffer())], undefined, composition,
        );
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const first = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await first.initFromOpfsImage({
            kernelWasm,
            vfsImageFile: previous.file,
            integrity: { length: previous.length, chunkBytes: 1024 * 1024, chunkSha256: previous.chunkSha256 },
            experimentalFixedPersistenceName: previous.journalName,
            persistentComputerName: name,
          });
          await markFixedPersistenceJournalInitialized(name, identity, previous);
          const { exit } = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
          if (await exit !== 0) throw new Error("guest write failed");
        } finally {
          await first.destroy();
        }
        const ready = await loadFixedPersistenceImageHandle(name, identity);
        if (ready === null) throw new Error("previous generation disappeared");
        const snapshotDirectory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const snapshotName = `${name}.snapshot`;
        const snapshotFile = await snapshotDirectory.getFileHandle(snapshotName, { create: true });
        const source = new BrowserKernel({ kernelOwnedFs: true });
        let integrity;
        try {
          await source.initFromOpfsImage({
            kernelWasm,
            vfsImageFile: ready.file,
            integrity: { length: ready.length, chunkBytes: 1024 * 1024, chunkSha256: ready.chunkSha256 },
            experimentalFixedPersistenceName: ready.journalName,
            persistentComputerName: name,
            requireExistingRootfsPersistence: true,
          });
          integrity = await source.exportRootfsImageToFile(snapshotFile);
        } finally {
          await source.destroy();
        }
        const replacement = await stageFixedPersistenceSnapshotReplacement(
          name, identity, snapshotFile, integrity, ready.lazyAssets, ready.composition,
        );
        await snapshotDirectory.removeEntry(snapshotName);
        const candidate = new BrowserKernel({ kernelOwnedFs: true });
        let stagedState: string;
        try {
          await candidate.initFromOpfsImage({
            kernelWasm,
            vfsImageFile: replacement.file,
            integrity: { length: replacement.length, chunkBytes: 1024 * 1024, chunkSha256: replacement.chunkSha256 },
            experimentalFixedPersistenceName: replacement.journalName,
            persistentComputerName: name,
          });
          stagedState = new TextDecoder().decode(await candidate.readFileFromVfs("/state"));
        } finally {
          await candidate.destroy();
        }
        await publishFixedPersistenceReplacement(name, identity, ready, replacement);
        return { name, identity, previousJournal: ready.journalName, stagedJournal: replacement.journalName, stagedState };
      }, {
        moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        imageUrl,
      });
      expect(staged.stagedState).toBe("XYcdefgh");
      expect(staged.stagedJournal).not.toBe(staged.previousJournal);
      await page.reload();
      const reopened = await page.evaluate(async ({ moduleUrl, browserKernelUrl, kernelUrl, name, identity }) => {
        const { loadFixedPersistenceImageHandle, loadPreviousFixedPersistenceImageHandle } = await import(moduleUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const current = await loadFixedPersistenceImageHandle(name, identity);
        if (current === null) throw new Error("replacement disappeared after reload");
        const previous = await loadPreviousFixedPersistenceImageHandle(name, identity, current);
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: current.file,
            integrity: { length: current.length, chunkBytes: 1024 * 1024, chunkSha256: current.chunkSha256 },
            experimentalFixedPersistenceName: current.journalName,
            persistentComputerName: name,
            requireExistingRootfsPersistence: true,
          });
          return {
            currentJournal: current.journalName,
            previousJournal: previous?.journalName ?? null,
            state: new TextDecoder().decode(await kernel.readFileFromVfs("/state")),
          };
        } finally {
          await kernel.destroy();
        }
      }, {
        moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: staged.name,
        identity: staged.identity,
      });
      expect(reopened).toEqual({
        currentJournal: staged.stagedJournal,
        previousJournal: staged.previousJournal,
        state: "XYcdefgh",
      });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("experimental computer refuses URL scripts and invalid names", async ({ page, baseURL }) => {
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const rejected = await page.evaluate(async (url) => {
    const { assertFixedPersistenceBootAllowed } = await import(url);
    const refuses = (name: string, candidate: boolean, boot: object) => {
      try {
        assertFixedPersistenceBootAllowed(name, candidate, boot);
        return false;
      } catch {
        return true;
      }
    };
    return {
      named: refuses("my-computer", false, {}),
      invalidName: refuses("../other", false, {}),
      protectedCandidate: refuses("my-computer", true, {}),
      bootInput: refuses("my-computer", false, { inputs: [{ id: "script" }] }),
      script: refuses("my-computer", false, { parameters: { runScript: "script" } }),
    };
  }, new URL(`/@fs/${modulePath}`, baseURL).href);
  expect(rejected).toEqual({
    named: false,
    invalidName: true,
    protectedCandidate: true,
    bootInput: true,
    script: true,
  });
});

test("persistent computer runtime lease excludes other tabs until teardown", async ({ playwright, browserName, baseURL }, testInfo) => {
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-runtime-lease-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const first = context.pages()[0] ?? await context.newPage();
      const second = await context.newPage();
      const url = new URL(`/@fs/${modulePath}`, baseURL).href;
      const fixtureUrl = new URL("/trap-signal-test.html", baseURL).href;
      await Promise.all([first.goto(fixtureUrl), second.goto(fixtureUrl)]);
      await first.evaluate(async (moduleUrl) => {
        const { acquireFixedPersistenceRuntimeLease } = await import(moduleUrl);
        (window as Window & { releasePersistenceLease?: () => Promise<void> }).releasePersistenceLease =
          await acquireFixedPersistenceRuntimeLease("computer-lease-probe");
      }, url);
      const blocked = await second.evaluate(async (moduleUrl) => {
        const { acquireFixedPersistenceRuntimeLease } = await import(moduleUrl);
        try {
          const release = await acquireFixedPersistenceRuntimeLease("computer-lease-probe");
          await release();
          return false;
        } catch (error) {
          return error instanceof Error && error.message.includes("already running in another tab");
        }
      }, url);
      expect(blocked).toBe(true);
      await first.evaluate(async () => {
        await (window as Window & { releasePersistenceLease?: () => Promise<void> }).releasePersistenceLease?.();
      });
      await second.evaluate(async (moduleUrl) => {
        const { acquireFixedPersistenceRuntimeLease } = await import(moduleUrl);
        (window as Window & { releasePersistenceLease?: () => Promise<void> }).releasePersistenceLease =
          await acquireFixedPersistenceRuntimeLease("computer-lease-probe");
      }, url);
      await second.close();
      const third = await context.newPage();
      await third.goto(fixtureUrl);
      const reacquired = await third.evaluate(async (moduleUrl) => {
        const { acquireFixedPersistenceRuntimeLease } = await import(moduleUrl);
        const release = await acquireFixedPersistenceRuntimeLease("computer-lease-probe");
        await release();
        return true;
      }, url);
      expect(reacquired).toBe(true);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
