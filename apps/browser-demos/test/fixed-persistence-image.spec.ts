import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const modulePath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../pages/kandelo/kernel-host/fixed-persistence-image.ts");
const streamWorkerPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures/fixed-persistence-stream-worker.ts");

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
        const { loadFixedPersistenceImageHandle, publishFixedPersistenceSnapshot, saveFixedPersistenceImageStream } = await import(url);
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
          missingJournalRejected,
          legacyJournalName,
          orphanRemoved,
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
      const { cloneName, journalName, restoredJournalName, name, legacyJournalName, ...observed } = result;
      expect(restoredJournalName).toBe(journalName);
      expect(legacyJournalName).toBe(name);
      expect(observed).toEqual({
        savedLength: 1024 * 1024 + 3,
        clonedFileLength: 1024 * 1024 + 3,
        restoredLength: 1024 * 1024 + 3,
        digestCount: 2,
        journalBindingRejected: true,
        missingJournalRejected: true,
        orphanRemoved: true,
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
