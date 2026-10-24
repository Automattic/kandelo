import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { routeCurrentImageModules } from "./support/current-image-module";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const modulePath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../pages/kandelo/kernel-host/fixed-persistence-image.ts");
const checkpointModulePath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../pages/kandelo/kernel-host/persistent-image-checkpoint.ts");
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

for (const scenario of ["admission", "before-primary-close", "after-primary-close"] as const) {
  test(`canonical OPFS manifest preserves bounded ownership and publication (${scenario})`, async ({ playwright, browserName, baseURL }, testInfo) => {
    const profile = mkdtempSync(join(tmpdir(), "kandelo-manifest-v6-"));
    try {
      const context = await playwright[browserName].launchPersistentContext(profile, {
        ...testInfo.project.use.launchOptions,
        channel: testInfo.project.use.channel,
        proxy: testInfo.project.use.proxy,
        extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders,
      });
      try {
        await routeCurrentImageModules(context);
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(new URL("/trap-signal-test.html", baseURL).href);
        const result = await page.evaluate(async ({ url, scenario }) => {
        const imageSource = (chunks: Iterable<Uint8Array>, payloadLength = Array.isArray(chunks) ? chunks.reduce((total, chunk) => total + chunk.byteLength, 0) : 0) => ({ chunks, payloadLength, integrityPolicy: "crc32c" as const });
          const api = await import(url);
          const name = "manifest-v6-" + crypto.randomUUID();
          const identity = "versioned manifest ownership";
          const bytes = new TextEncoder().encode("original image bytes");
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
          const composition = {
            imageConfig: { version: 1, defaultProfile: "probe", profiles: { probe: {} } },
            profileId: "probe",
            terminalSession: { kind: "kandelo-experimental-terminal-session", version: 1,
              initial: { path: "/bin/probe", argv: ["probe"], uid: 0, gid: 0 } },
            requiredServices: [],
          };
          const write = async (file: FileSystemFileHandle, contents: string | Uint8Array) => {
            const writer = await file.createWritable();
            await writer.write(contents);
            await writer.close();
          };
          const seedJournal = async (image: { journalName: string; imageIdentitySha256: string }) => {
            const header = new Uint8Array(72);
            header.set(new TextEncoder().encode("KOVL"));
            new DataView(header.buffer).setUint32(4, 1, true);
            header.set(image.imageIdentitySha256.match(/../g)!.map(pair => Number.parseInt(pair, 16)), 8);
            header.set(new Uint8Array(await crypto.subtle.digest("SHA-256", header.subarray(0, 40))), 40);
            await write(await directory.getFileHandle(image.journalName + ".journal", { create: true }), header);
          };
          const installed = await api.saveFixedPersistenceImageStream(name, identity, imageSource([bytes]), undefined, composition);
          await seedJournal(installed);
          await api.markFixedPersistenceJournalInitialized(name, identity, installed);
          const primary = await directory.getFileHandle(name + ".base.json");
          const previous = await directory.getFileHandle(name + ".previous.base.json");
          const active = await directory.getFileHandle(name + ".active.base.json");
          const original = await (await primary.getFile()).text();
          const originalActive = await (await active.getFile()).text();
          if (scenario === "admission") {
            const oversized = new Uint8Array(8 * 1024 * 1024 + 1).fill(32);
            const prototype = Object.getPrototypeOf(await primary.getFile());
            const descriptor = Object.getOwnPropertyDescriptor(prototype, "text");
            const originalText = prototype.text;
            let oversizedReads = 0;
            prototype.text = function (this: File) {
              if (this.size === oversized.length) oversizedReads++;
              return originalText.call(this);
            };
            const codes: string[] = [];
            const lengths: number[] = [];
            let unknownRefused = false;
            try {
              for (const file of [primary, active]) {
                await write(file, oversized);
                try { await api.loadFixedPersistenceImageHandle(name, identity); }
                catch (error) { codes.push(String((error as { code?: unknown }).code)); }
                lengths.push((await file.getFile()).size);
                await write(file, file === primary ? original : originalActive);
              }
              let refusals = 0;
              for (const version of [1, 2, 3, 4, 5, 7]) {
                for (const control of ["primary", "target"]) {
                  const unsupported = JSON.parse(control === "primary" ? original : originalActive);
                  const manifest = control === "primary" ? unsupported : unsupported.target;
                  manifest.format = `kandelo-fixed-rootfs-image-v${version}`;
                  const contents = JSON.stringify(unsupported);
                  const file = control === "primary" ? primary : active;
                  await write(file, contents);
                  try { await api.loadFixedPersistenceImageHandle(name, identity); }
                  catch (error) {
                    if (String(error).includes("Unsupported persistent image manifest version")
                      && await (await file.getFile()).text() === contents) refusals++;
                  }
                  await write(file, control === "primary" ? original : originalActive);
                }
              }
              unknownRefused = refusals === 12;
            } finally {
              if (descriptor === undefined) delete prototype.text;
              else Object.defineProperty(prototype, "text", descriptor);
            }
            const retried = await api.loadFixedPersistenceImageHandle(name, identity);
            return { codes, lengths, oversizedReads, unknownRefused, retryLength: retried?.payloadLength,
              digest: retried?.imageIdentitySha256, expectedDigest: installed.imageIdentitySha256 };
          }
          const source = await api.loadFixedPersistenceImageHandle(name, identity);
          const targetBytes = new TextEncoder().encode("replacement image bytes");
          const target = await api.stageFixedPersistenceReplacement(name, identity, imageSource([targetBytes]), undefined, composition);
          await seedJournal(target);
          const prototype = Object.getPrototypeOf(primary);
          const createWritable = prototype.createWritable;
          let injected = false;
          let rejected = false;
          prototype.createWritable = async function (this: FileSystemFileHandle, options: FileSystemCreateWritableOptions) {
            const writer = await createWritable.call(this, options);
            if (this.name !== primary.name || injected) return writer;
            return {
              write: (...args: Parameters<typeof writer.write>) => writer.write(...args),
              abort: () => writer.abort(),
              close: async () => {
                injected = true;
                if (scenario === "before-primary-close") throw new Error("cut before v6 primary close");
                await writer.close();
                throw new Error("lost v6 primary close acknowledgement");
              },
            };
          };
          try { await api.publishFixedPersistenceReplacement(name, identity, source, target); }
          catch { rejected = true; }
          finally { prototype.createWritable = createWritable; }
          const primaryBeforeRetry = JSON.parse(await (await primary.getFile()).text());
          const previousBeforeRetry = JSON.parse(await (await previous.getFile()).text());
          const selectedBeforeRetry = await api.loadFixedPersistenceImageHandle(name, identity);
          await api.publishFixedPersistenceReplacement(name, identity, source, target);
          const current = JSON.parse(await (await primary.getFile()).text());
          const fallback = JSON.parse(await (await previous.getFile()).text());
          const selected = await api.loadFixedPersistenceImageHandle(name, identity);
          return { injected, rejected, formatsBeforeRetry: [primaryBeforeRetry.format, previousBeforeRetry.format],
            selectedSourceBeforeRetry: await selectedBeforeRetry.file.isSameEntry(source.file),
            currentFormat: current.format, fallbackFormat: fallback.format,
            oldReaderRecognizesManifest: [current, fallback].some(manifest => [1, 2, 3, 4, 5].some(version =>
              manifest.format === "kandelo-fixed-rootfs-image-v" + version)),
            hasChunkTable: [current, fallback].some(manifest => Object.hasOwn(manifest, "chunkSha256") || Object.hasOwn(manifest, "chunkSha256Digest")),
            selectedTarget: await selected.file.isSameEntry(target.file),
            fallbackSource: fallback.imageFileName === source.imageFileName };
        }, { url: new URL(`/@fs/${modulePath}`, baseURL).href, scenario });
        await testInfo.attach("manifest-v6-ownership", { body: JSON.stringify(result), contentType: "application/json" });
        if (scenario === "admission") {
          expect(result).toMatchObject({ codes: ["ENOMEM", "ENOMEM"], lengths: [8 * 1024 * 1024 + 1, 8 * 1024 * 1024 + 1],
            oversizedReads: 0, unknownRefused: true, retryLength: 20 });
          expect(result.digest).toBe(result.expectedDigest);
        } else {
          expect(result).toMatchObject({ injected: true, rejected: scenario === "before-primary-close",
            formatsBeforeRetry: ["kandelo-fixed-rootfs-image-v6", "kandelo-fixed-rootfs-image-v6"],
            selectedSourceBeforeRetry: scenario === "before-primary-close", currentFormat: "kandelo-fixed-rootfs-image-v6",
            fallbackFormat: "kandelo-fixed-rootfs-image-v6", oldReaderRecognizesManifest: false,
            hasChunkTable: false, selectedTarget: true, fallbackSource: true });
        }
      } finally { await context.close(); }
    } finally { rmSync(profile, { recursive: true, force: true }); }
  });
}

for (const damage of ["primary", "binding", "both", "base", "journal", "stale-primary", "stale-binding", "released-source", "released-target"] as const) {
  const title = damage.startsWith("released-") ? "checkpoint snapshot rejects released journal ownership"
    : "post-checkpoint recovery must not roll back fsynced guest writes";
  test(`${title} (${damage})`, async ({ playwright, browserName, baseURL }, testInfo) => {
  if (kernelPath === null || guestProgramPath === null) throw new Error("ABI-matched kernel and persistence guest are required");
  const filesystem = KandeloImageFs.create();
  filesystem.setImageCapacity(8 * 1024 * 1024);
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/bin/persistence-overwrite", readFileSync(guestProgramPath), 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o600);
  const image = await filesystem.saveImage();
  const profile = mkdtempSync(join(tmpdir(), "kandelo-manifest-freshness-"));
  console.log("freshness launch:", browserName, damage);
  try {
    const context = await playwright[browserName].launchPersistentContext(profile, {
      ...testInfo.project.use.launchOptions,
      channel: testInfo.project.use.channel,
      proxy: testInfo.project.use.proxy,
      extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders,
    });
    try {
      await routeCurrentImageModules(context);
      const page = context.pages()[0] ?? await context.newPage();
      const imageUrl = new URL("/manifest-freshness.vfs", baseURL).href;
      page.on("console", message => {
        if (message.text().startsWith("freshness phase:")) console.log(browserName, damage, message.text());
      });
      const kernelUrl = new URL("/manifest-freshness-kernel.wasm", baseURL).href;
      await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ persistenceUrl, browserKernelUrl, imageUrl, kernelUrl, damage }) => {
        const imageSource = (chunks: Iterable<Uint8Array>, payloadLength = Array.isArray(chunks) ? chunks.reduce((total, chunk) => total + chunk.byteLength, 0) : 0) => ({ chunks, payloadLength, integrityPolicy: "crc32c" as const });
        const api = await import(persistenceUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const name = "manifest-freshness-" + crypto.randomUUID();
        const identity = "post-checkpoint acknowledged writes";
        const composition = {
          imageConfig: { version: 1, defaultProfile: "probe", profiles: { probe: {} } }, profileId: "probe",
          terminalSession: { kind: "kandelo-experimental-terminal-session", version: 1,
            initial: { path: "/bin/persistence-overwrite", argv: ["persistence-overwrite"], uid: 0, gid: 0 } },
          requiredServices: [],
        };
        const wasm = await (await fetch(kernelUrl)).arrayBuffer();
        const installed = await api.saveFixedPersistenceImageStream(name, identity,
          imageSource([new Uint8Array(await (await fetch(imageUrl)).arrayBuffer())]), undefined, composition);
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const snapshot = await directory.getFileHandle(name + ".snapshot", { create: true });
        const open = async (image: any, existing: boolean) => {
          const kernel = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024 });
          try {
            await kernel.initFromOpfsImage({ kernelWasm: wasm, vfsImageFile: image.file, persistentImageBinding: image.persistentImageBinding,
              persistentComputerName: name, experimentalResizablePersistenceName: image.journalName,
              requireExistingRootfsPersistence: existing });
            return kernel;
          } catch (error) { await kernel.destroy(); throw error; }
        };
        const sourceKernel = await open(installed, false);
        let integrity;
        console.log("freshness phase: source export");
        try {
          integrity = await sourceKernel.exportRootfsImageToFile(snapshot);
          sourceKernel.reservePersistentJournalLeaseForHandoff();
        }
        finally { await sourceKernel.destroy(); }
        const sourceLease = sourceKernel.takePersistentJournalLeaseAfterDestroy();
        if (sourceLease === null) throw new Error("source handoff missing");
        await api.markFixedPersistenceJournalInitialized(name, identity, installed);
        const sourceBinding = await (await (await directory.getFileHandle(name + ".active.base.json")).getFile()).text();
        const source = await api.loadFixedPersistenceImageHandle(name, identity);
        const target = await api.stageFixedPersistenceSnapshotReplacement(name, identity, snapshot, integrity, undefined, composition, undefined, sourceLease, installed.integrityPolicy);
        console.log("freshness phase: target validation");
        const validationKernel = await open(target, false);
        validationKernel.reservePersistentJournalLeaseForHandoff();
        await validationKernel.destroy();
        const targetLease = validationKernel.takePersistentJournalLeaseAfterDestroy();
        if (targetLease === null) throw new Error("target handoff missing");
        await api.authorizeFixedPersistenceSnapshotPublication(target, sourceLease, targetLease);
        if (damage === "released-source" || damage === "released-target") {
          const released = damage === "released-source" ? sourceLease : targetLease;
          const advanced = damage === "released-source" ? source : target;
          await released();
          const writer = await open(advanced, true);
          let exitCode;
          try {
            const { exit } = await writer.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"]);
            exitCode = await exit;
            writer.reservePersistentJournalLeaseForHandoff();
          } finally { await writer.destroy(); }
          const replacementLease = writer.takePersistentJournalLeaseAfterDestroy();
          if (replacementLease === null) throw new Error("replacement owner handoff missing");
          let refusal: string | undefined;
          try {
            await api.publishFixedPersistenceReplacement(name, identity, source, target, undefined, undefined,
              { source: damage === "released-source" ? replacementLease : sourceLease,
                target: damage === "released-target" ? replacementLease : targetLease });
          } catch (error) { refusal = (error as { recovery?: string }).recovery; }
          finally { await replacementLease(); await sourceLease(); await targetLease(); }
          const selected = await api.loadFixedPersistenceImageHandle(name, identity);
          const check = await open(advanced, true);
          let durable;
          try { durable = new TextDecoder().decode(await check.readFileFromVfs("/state")); }
          finally { await check.destroy(); }
          return { exitCode, durable, refusal, selectedSource: await selected.file.isSameEntry(source.file) };
        }
        console.log("freshness phase: publication");
        try {
          await api.publishFixedPersistenceReplacement(name, identity, source, target, undefined, undefined,
            { source: sourceLease, target: targetLease });
        } finally { await sourceLease(); await targetLease(); }
        const current = await api.loadFixedPersistenceImageHandle(name, identity);
        console.log("freshness phase: acknowledged write");
        const writingKernel = await open(current, true);
        let exitCode;
        try {
          const { exit } = await writingKernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite"], { uid: 0, gid: 0 });
          exitCode = await exit;
        } finally { await writingKernel.destroy(); }
        const verificationKernel = await open(current, true);
        let acknowledged;
        try { acknowledged = new TextDecoder().decode(await verificationKernel.readFileFromVfs("/state")); }
        finally { await verificationKernel.destroy(); }
        await api.publishFixedPersistenceReplacement(name, identity, source, target);
        const write = async (file: FileSystemFileHandle, value: string | Uint8Array) => {
          const writer = await file.createWritable();
          await writer.write(value);
          await writer.close();
        };
        const manifest = await directory.getFileHandle(name + ".base.json");
        const binding = await directory.getFileHandle(name + ".active.base.json");
        let repair: (() => Promise<void>) | undefined;
        if (damage === "primary" || damage === "both") await write(manifest, "{");
        if (damage === "binding" || damage === "both") await write(binding, "{");
        if (damage === "stale-primary") {
          const archive = await directory.getFileHandle(name + ".previous.base.json");
          await write(manifest, await (await archive.getFile()).text());
        }
        if (damage === "stale-binding") await write(binding, sourceBinding);
        if (damage === "base" || damage === "journal") {
          const file = damage === "base" ? current.file : await directory.getFileHandle(current.journalName + ".journal");
          const original = new Uint8Array(await (await file.getFile()).arrayBuffer());
          const changed = original.slice();
          changed[0] ^= 1;
          await write(file, changed);
          repair = () => write(file, original);
        }
        let restored: string | undefined;
        let selectedOldPair = false;
        let refusal: string | undefined;
        try {
          console.log("freshness phase: select recovery");
          const recovered = await api.loadFixedPersistenceImageHandle(name, identity);
          selectedOldPair = await recovered.file.isSameEntry(source.file);
          console.log("freshness phase: admit recovery");
          const recoveredKernel = await open(recovered, true);
          try {
            await api.promoteFixedPersistenceRecovery(name, identity, recovered);
            restored = new TextDecoder().decode(await recoveredKernel.readFileFromVfs("/state"));
          }
          finally { await recoveredKernel.destroy(); }
        } catch (error) {
          const typed = (error as { recovery?: string }).recovery;
          if (typed === "unproven-image-freshness" || typed === "no-valid-overlay-generation") refusal = typed;
          else if (damage === "base" && String(error).includes("image is damaged")) refusal = "damaged-active-base";
          else throw error;
        }
        const older = damage === "journal" ? await api.loadPreviousFixedPersistenceImageHandle(name, identity, current) : null;
        await repair?.();
        console.log("freshness phase: verify retained target");
        const durableKernel = await open(current, true);
        let durable;
        try { durable = new TextDecoder().decode(await durableKernel.readFileFromVfs("/state")); }
        finally { await durableKernel.destroy(); }
        return { exitCode, acknowledged, restored, selectedOldPair, refusal, durable, olderAvailable: older !== null };
      }, { persistenceUrl: new URL(`/@fs/${modulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, imageUrl, kernelUrl, damage });
      await testInfo.attach("post-checkpoint-freshness", { body: JSON.stringify(result), contentType: "application/json" });
      expect(result.exitCode).toBe(0);
      if (damage === "released-source" || damage === "released-target") {
        expect(result).toMatchObject({ refusal: "unproven-image-freshness", selectedSource: true, durable: "XYcdefgh" });
        return;
      }
      expect(result.acknowledged).toBe("XYcdefgh");
      expect(result.durable).toBe("XYcdefgh");
      expect(result.selectedOldPair).toBe(false);
      expect(result.olderAvailable).toBe(false);
      if (damage === "both" || damage === "base" || damage === "journal") {
        expect(result.refusal).toBeTruthy();
        expect(result.restored).toBeUndefined();
      } else {
        expect(result.refusal).toBeUndefined();
        expect(result.restored).toBe("XYcdefgh");
      }
    } finally { await context.close(); }
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

}
test("experimental computer keeps exact payload bytes and rejects damaged images", async ({ playwright, browserName, baseURL }, testInfo) => {
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
      await routeCurrentImageModules(context);
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async (url) => {
        const imageSource = (chunks: Iterable<Uint8Array>, payloadLength = Array.isArray(chunks) ? chunks.reduce((total, chunk) => total + chunk.byteLength, 0) : 0) => ({ chunks, payloadLength, integrityPolicy: "crc32c" as const });
        const { loadFixedPersistenceImageHandle, saveFixedPersistenceImageStream } = await import(url);
        const name = `image-${crypto.randomUUID()}`;
        const identity = "source A, profile A";
        const proposed = new Uint8Array([1, 2, 3, 4]);
        const lazyAssets = {
          deploymentBase: `${location.origin}/`,
          directoryUrl: `${location.origin}/assets/`,
          manifestUrl: `${location.origin}/assets/manifest.json`,
        };
        const before = await loadFixedPersistenceImageHandle(name, identity);
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
        const saved = await saveFixedPersistenceImageStream(name, identity, imageSource([proposed]), lazyAssets, composition);
        const restored = await loadFixedPersistenceImageHandle(name, identity);
        const imageHandle = await loadFixedPersistenceImageHandle(name, identity);
        let wrongIdentity = false;
        try {
          await loadFixedPersistenceImageHandle(name, "source B, profile A");
        } catch {
          wrongIdentity = true;
        }
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        await directory.removeEntry(name + ".active.base.json");
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
          await loadFixedPersistenceImageHandle(name, identity);
        } catch {
          damagedMetadata = true;
        }
        const damagedChunksManifest = JSON.parse(manifestText);
        damagedChunksManifest.chunkSha256 = ["0".repeat(64)];
        await writeManifest(JSON.stringify(damagedChunksManifest));
        let damagedChunks = false;
        try {
          await loadFixedPersistenceImageHandle(name, identity);
        } catch {
          damagedChunks = true;
        }
        const incompleteManifest = JSON.parse(manifestText);
        delete incompleteManifest.composition;
        delete incompleteManifest.compositionSha256;
        await writeManifest(JSON.stringify(incompleteManifest));
        let missingMetadataRejected = false;
        try { await loadFixedPersistenceImageHandle(name, identity); }
        catch { missingMetadataRejected = true; }
        await writeManifest(manifestText);
        const savedBytes = Array.from(new Uint8Array(await (await saved.file.getFile()).slice(128, 128 + saved.payloadLength).arrayBuffer()));
        const restoredBytes = Array.from(new Uint8Array(await (await restored!.file.getFile()).slice(128, 128 + restored!.payloadLength).arrayBuffer()));
        const baseFile = saved.file;
        const writer = await baseFile.createWritable();
        await writer.write(new Uint8Array([9, 2, 3, 4]));
        await writer.close();
        let damaged = false;
        try {
          await loadFixedPersistenceImageHandle(name, identity);
        } catch {
          damaged = true;
        }
        return {
          before,
          saved: savedBytes,
          restored: restoredBytes,
          lazyAssets: restored?.lazyAssets,
          handleLength: imageHandle?.payloadLength,
          handleProfile: imageHandle?.composition.profileId,
          missingMetadataRejected,
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
        handleLength: 4,
        handleProfile: "probe",
        missingMetadataRejected: true,
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
      await routeCurrentImageModules(context);
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ url, workerUrl }) => {
        const imageSource = (chunks: Iterable<Uint8Array>, payloadLength = Array.isArray(chunks) ? chunks.reduce((total, chunk) => total + chunk.byteLength, 0) : 0) => ({ chunks, payloadLength, integrityPolicy: "crc32c" as const });
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
        let orphanRefused = false;
        try { await saveFixedPersistenceImageStream(name, identity, imageSource([first]), undefined, composition); }
        catch (error) { orphanRefused = (error as { recovery?: string }).recovery === "unproven-image-freshness"; }
        const orphanRetained = (await (await orphan.getFile()).arrayBuffer()).byteLength === 1;
        await directory.removeEntry(orphanName);
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
        const rawSnapshot = await directory.getFileHandle(name + ".test-snapshot.vfs", { create: true });
        const rawBytes = new Uint8Array(first.length + 3);
        rawBytes.set(first);
        rawBytes.set([1, 2, 3], first.length);
        const rawWriter = await rawSnapshot.createWritable();
        await rawWriter.write(rawBytes);
        await rawWriter.close();
        const integrity = { length: rawBytes.length, chunkBytes: 1024 * 1024,
          imageSha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBytes)),
            byte => byte.toString(16).padStart(2, "0")).join("") };
        await publishFixedPersistenceSnapshot(
          cloneName, identity, rawSnapshot, integrity, restored!.lazyAssets, restored!.composition, restored!.integrityPolicy,
        );
        const clone = await loadFixedPersistenceImageHandle(cloneName, identity);
        const manifestFile = await directory.getFileHandle(`${name}.base.json`);
        const manifestText = await (await manifestFile.getFile()).text();
        const changedManifest = JSON.parse(manifestText);
        await directory.removeEntry(name + ".active.base.json");
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
        const incompleteManifest = JSON.parse(manifestText);
        delete incompleteManifest.journalName;
        delete incompleteManifest.journalNameSha256;
        const legacyWriter = await manifestFile.createWritable();
        await legacyWriter.write(JSON.stringify(incompleteManifest));
        await legacyWriter.close();
        let missingJournalRejected = false;
        try {
          await loadFixedPersistenceImageHandle(name, identity);
        } catch {
          missingJournalRejected = true;
        }
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
          readWorker.postMessage({ file: restored!.file, length: restored!.length,
            imageIdentitySha256: restored!.imageIdentitySha256, integrityPolicy: restored!.integrityPolicy });
        }).finally(() => readWorker.terminate());
        const file = await restored?.file.getFile();
        const last = file === undefined
          ? []
          : [...new Uint8Array(await file.slice(128 + restored!.payloadLength - 3, 128 + restored!.payloadLength).arrayBuffer())];
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
            lostAckName, identity, imageSource([first]), undefined, composition,
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
            rejectedCloseName, identity, imageSource([first]), undefined, composition,
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
        let uncertainRetryRefused = false;
        try { await saveFixedPersistenceImageStream(rejectedCloseName, identity, imageSource([first]), undefined, composition); }
        catch (error) { uncertainRetryRefused = (error as { recovery?: string }).recovery === "unproven-image-freshness"; }
        let uncertainImagesRetained = abandonedImages.length === 1;
        for (const entryName of abandonedImages) {
          try { await directory.getFileHandle(entryName); }
          catch { uncertainImagesRetained = false; }
        }
        for (const entryName of abandonedImages) await directory.removeEntry(entryName);
        const retriedInstall = await saveFixedPersistenceImageStream(
          rejectedCloseName, identity, imageSource([first]), undefined, composition,
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
        const damagedRawWriter = await rawSnapshot.createWritable();
        await damagedRawWriter.write(damagedFirst);
        await damagedRawWriter.write(Uint8Array.of(1, 2, 3));
        await damagedRawWriter.close();
        const failedName = `snapshot-${crypto.randomUUID()}`;
        let damagedSnapshotRejected = false;
        try {
          await publishFixedPersistenceSnapshot(
            failedName, identity, rawSnapshot, integrity, restored!.lazyAssets, restored!.composition, restored!.integrityPolicy,
          );
        } catch {
          damagedSnapshotRejected = true;
        }
        const failedSnapshot = await loadFixedPersistenceImageHandle(failedName, identity);
        const cloneFile = await clone!.file.getFile();
        const cloneTail = [...new Uint8Array(await cloneFile.slice(128 + clone!.payloadLength - 3, 128 + clone!.payloadLength).arrayBuffer())];
        let corruptionRejected = false;
        try { await loadFixedPersistenceImageHandle(name, identity); }
        catch (error) { corruptionRejected = (error as { recovery?: string }).recovery === "unproven-image-freshness"; }
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
            imageSource(interrupted(), first.length + 3),
            undefined,
            composition,
          );
        } catch {
          interruptedRejected = true;
        }
        const incomplete = await loadFixedPersistenceImageHandle(interruptedName, identity);
        return {
          savedLength: restored!.payloadLength,
          clonedFileLength: restored!.length > restored!.payloadLength,
          restoredLength: restored?.payloadLength,
          name,
          journalName,
          restoredJournalName: restored?.journalName,
          digestCount: restored?.imageIdentitySha256 === undefined ? 0 : 1,
          journalBindingRejected,
          prematureInitializationRejected,
          stillPending,
          foreignJournalRejected,
          missingJournalRejected,
          orphanRemoved,
          orphanRefused,
          orphanRetained,
          uncertainRetryRefused,
          uncertainImagesRetained,
          lostAckInjected,
          lostAckCommitted,
          rejectedCloseFailed,
          rejectedCloseUnpublished,
          abandonedRemoved,
          last,
          positionedRead,
          corruptionRejected,
          cloneName,
          cloneLength: clone?.payloadLength,
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
      const { cloneName, journalName, restoredJournalName, name, ...observed } = result;
      expect(restoredJournalName).toBe(journalName);
      expect(observed).toEqual({
        savedLength: 1024 * 1024 + 3,
        clonedFileLength: true,
        restoredLength: 1024 * 1024 + 3,
        digestCount: 1,
        journalBindingRejected: true,
        prematureInitializationRejected: true,
        stillPending: true,
        foreignJournalRejected: true,
        missingJournalRejected: true,
          orphanRemoved: true,
          orphanRefused: true,
          orphanRetained: true,
          uncertainRetryRefused: true,
          uncertainImagesRetained: true,
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
          length: clone.payloadLength,
          tail: [...new Uint8Array(await file.slice(128 + clone.payloadLength - 3, 128 + clone.payloadLength).arrayBuffer())],
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

for (const cut of ["before-prepared", "after-prepared", "before", "after", "before-active", "after-active"] as const) {
test(`abrupt termination ${cut} replacement manifest commit selects the right generation`, async ({ playwright, browserName, baseURL }, testInfo) => {
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
    let recoveryContext: typeof context | null = null;
    let browserCrashed = false;
    try {
      await context.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await context.route(previousImageUrl, (route) => route.fulfill({ body: Buffer.from(previousImage) }));
      await context.route(replacementImageUrl, (route) => route.fulfill({ body: Buffer.from(replacementImage) }));
      await routeCurrentImageModules(context);
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const primaryClosed = page.waitForEvent("console", {
        predicate: (message) => message.text() === `replacement primary manifest ${cut} close`,
        timeout: 30_000,
      });
      const { name, identity, stagedJournalName, previousJournalName } = await page.evaluate(async ({
        url, browserKernelUrl, kernelUrl, previousImageUrl, replacementImageUrl, cut,
      }) => {
        const imageSource = (chunks: Iterable<Uint8Array>, payloadLength = Array.isArray(chunks) ? chunks.reduce((total, chunk) => total + chunk.byteLength, 0) : 0) => ({ chunks, payloadLength, integrityPolicy: "crc32c" as const });
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
          name, identity, imageSource([previousImage]), undefined, composition,
        );
        const first = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await first.initFromOpfsImage({
            kernelWasm,
            vfsImageFile: previous.file,
            persistentImageBinding: previous.persistentImageBinding,
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
          name, identity, imageSource([replacementImage]), undefined, composition,
        );
        const stagedKernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await stagedKernel.initFromOpfsImage({
            kernelWasm,
            vfsImageFile: staged.file,
            persistentImageBinding: staged.persistentImageBinding,
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
        let bindingWrites = 0;
        filePrototype.createWritable = async function (this: FileSystemFileHandle, options) {
          const writer = await originalCreateWritable.call(this, options);
          if (this.name === `${name}.active.base.json`) bindingWrites++;
          const boundary = cut.endsWith("prepared") ? this.name === `${name}.active.base.json` && bindingWrites === 1
            : cut.endsWith("active") ? this.name === `${name}.active.base.json` && bindingWrites === 2
              : this.name === `${name}.base.json`;
          if (!boundary) return writer;
          return {
            write: (...args: Parameters<typeof writer.write>) => writer.write(...args),
            close: async () => {
              if (cut.startsWith("after")) await writer.close();
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
      if (browserName === "chromium") {
        const session = await context.newCDPSession(page);
        const closed = context.waitForEvent("close", { timeout: 15_000 });
        void session.send("Browser.crash").catch(() => {});
        await closed;
        browserCrashed = true;
        recoveryContext = await playwright[browserName].launchPersistentContext(userDataDir, {
          channel: projectUse.channel,
          proxy: projectUse.proxy as never,
          extraHTTPHeaders: projectUse.extraHTTPHeaders,
          ...(projectUse.launchOptions ?? {}),
        });
        await recoveryContext.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
        await routeCurrentImageModules(recoveryContext);
      } else {
        await page.close();
      }
      const reopened = await (recoveryContext ?? context).newPage();
      try {
        await reopened.goto(new URL("/trap-signal-test.html", baseURL).href);
        const recovered = await reopened.evaluate(async ({ url, browserKernelUrl, kernelUrl, name, identity }) => {
          const { loadFixedPersistenceImageHandle, loadPreviousFixedPersistenceImageHandle, promoteFixedPersistenceRecovery } = await import(url);
          const { BrowserKernel } = await import(browserKernelUrl);
          const current = await loadFixedPersistenceImageHandle(name, identity);
          if (current === null) throw new Error("committed replacement disappeared after tab close");
          const previous = await loadPreviousFixedPersistenceImageHandle(name, identity, current);
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
              vfsImageFile: current.file,
              persistentImageBinding: current.persistentImageBinding,
              experimentalFixedPersistenceName: current.journalName,
              persistentComputerName: name,
              requireExistingRootfsPersistence: true,
            });
            const state = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
            await promoteFixedPersistenceRecovery(name, identity, current);
            const repaired = await loadFixedPersistenceImageHandle(name, identity);
            return { current: current.journalName, previous: previous?.journalName ?? null, state,
              repaired: repaired !== null && repaired.recovery === undefined,
              staleFallbackRefused: repaired !== null && await loadPreviousFixedPersistenceImageHandle(name, identity, repaired) === null };
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
        expect(recovered).toEqual(["after", "before-active", "after-active"].includes(cut)
          ? { current: stagedJournalName, previous: cut === "after-active" ? null : previousJournalName,
            state: "replacement", repaired: true, staleFallbackRefused: true }
          : { current: previousJournalName, previous: null, state: "XYcdefgh", repaired: true, staleFallbackRefused: true });
      } finally {
        await reopened.close();
      }
    } finally {
      await recoveryContext?.close();
      if (!browserCrashed) await context.close();
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
      await routeCurrentImageModules(context);
      const page = context.pages()[0] ?? await context.newPage();
      const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
      filesystem.setImageCapacity(8 * 1024 * 1024);
      const imageConfig = {
        version: 1 as const,
        defaultProfile: "probe",
        profiles: { probe: { init: { target: "boot" } }, other: {} },
      };
      const terminalSession = {
        kind: "kandelo-experimental-terminal-session" as const,
        version: 1 as const,
        initial: { path: "/bin/persistence-overwrite", argv: ["persistence-overwrite"], uid: 0, gid: 0 },
      };
      filesystem.mkdir("/bin", 0o755);
      filesystem.mkdir("/etc", 0o755);
      filesystem.mkdir("/etc/kandelo", 0o755);
      filesystem.mkdir("/etc/dinit.d", 0o755);
      filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
      filesystem.writeFile("/etc/kandelo/demo.json", new TextEncoder().encode(JSON.stringify(imageConfig)), 0o644);
      filesystem.writeFile("/etc/kandelo/experimental-terminal-session.json", new TextEncoder().encode(JSON.stringify(terminalSession)), 0o644);
      filesystem.writeFile("/etc/dinit.d/boot", new TextEncoder().encode("type = internal\ndepends-on = alpha\n"), 0o644);
      filesystem.writeFile("/etc/dinit.d/alpha", new TextEncoder().encode("type = internal\n"), 0o644);
      filesystem.writeFile("/etc/dinit.d/bravo", new TextEncoder().encode("type = internal\n"), 0o644);
      filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
      const image = await filesystem.saveImage();
      const kernelUrl = new URL("/snapshot-replacement-kernel.wasm", baseURL).href;
      const imageUrl = new URL("/snapshot-replacement-base.vfs", baseURL).href;
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const staged = await page.evaluate(async ({ moduleUrl, checkpointUrl, browserKernelUrl, journalLeaseUrl, kernelUrl, imageUrl, imageConfig, terminalSession }) => {
        const imageSource = (chunks: Iterable<Uint8Array>, payloadLength = Array.isArray(chunks) ? chunks.reduce((total, chunk) => total + chunk.byteLength, 0) : 0) => ({ chunks, payloadLength, integrityPolicy: "crc32c" as const });
        const {
          acquireFixedPersistenceRuntimeLease,
          loadFixedPersistenceImageHandle,
          markFixedPersistenceJournalInitialized,
          saveFixedPersistenceImageStream,
        } = await import(moduleUrl);
        const { checkpointPersistentImage } = await import(checkpointUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const { browserPersistenceJournalLockName } = await import(journalLeaseUrl);
        const name = `snapshot-replacement-${crypto.randomUUID()}`;
        const identity = "snapshot replacement";
        const composition = {
          imageConfig,
          profileId: "probe",
          terminalSession,
          requiredServices: ["boot", "alpha"],
        };
        const previous = await saveFixedPersistenceImageStream(
          name, identity, imageSource([new Uint8Array(await (await fetch(imageUrl)).arrayBuffer())]), undefined, composition,
        );
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const first = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await first.initFromOpfsImage({
            kernelWasm,
            vfsImageFile: previous.file,
            persistentImageBinding: previous.persistentImageBinding,
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
        const persistenceComputerLease = await acquireFixedPersistenceRuntimeLease(name);
        let stagedState = "";
        const filePrototype = Object.getPrototypeOf(ready.file) as FileSystemFileHandle;
        const originalCreateWritable = filePrototype.createWritable;
        let lostCloseAcknowledgement = false;
        let publicationLeaseHeld = false;
        let sourceJournalHeldAtPublish = false;
        let targetJournalHeldAtPublish = false;
        let stagedJournalName: string | null = null;
        filePrototype.createWritable = async function (this: FileSystemFileHandle, options) {
          const writer = await originalCreateWritable.call(this, options);
          if (this.name !== `${name}.base.json`) return writer;
          return {
            write: (...args: Parameters<typeof writer.write>) => writer.write(...args),
            close: async () => {
              sourceJournalHeldAtPublish = !(await navigator.locks.request(
                browserPersistenceJournalLockName(ready.journalName),
                { mode: "exclusive", ifAvailable: true }, (lock) => lock !== null,
              ));
              if (stagedJournalName !== null) {
                targetJournalHeldAtPublish = !(await navigator.locks.request(
                  browserPersistenceJournalLockName(stagedJournalName),
                  { mode: "exclusive", ifAvailable: true }, (lock) => lock !== null,
                ));
              }
              try {
                const competing = await acquireFixedPersistenceRuntimeLease(name);
                await competing();
              } catch (error) {
                publicationLeaseHeld = String(error).includes("already running in another tab");
              }
              await writer.close();
              lostCloseAcknowledgement = true;
              throw new Error("injected lost checkpoint manifest close acknowledgement");
            },
            abort: () => writer.abort(),
          } as FileSystemWritableFileStream;
        };
        const { previous: checkpointSource, staged } = await (async () => {
          try {
            return await checkpointPersistentImage({
              name,
              identity,
              journalName: ready.journalName,
              kernelWasm,
              createKernel: () => new BrowserKernel({ kernelOwnedFs: true }),
              closeKernel: (kernel) => kernel.destroy(),
              lazyUrlMapForImage: (assets) => {
                if (assets) throw new Error("fixture unexpectedly has lazy assets");
                return {};
              },
              persistenceComputerLease,
              releaseLease: persistenceComputerLease,
              validateCandidate: async (kernel, candidateStage) => {
                stagedJournalName = candidateStage.journalName;
                stagedState = new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
              },
            });
          } finally {
            filePrototype.createWritable = originalCreateWritable;
            await persistenceComputerLease();
          }
        })();
        return { name, identity, previousJournal: checkpointSource.journalName, stagedJournal: staged.journalName, stagedState, lostCloseAcknowledgement, publicationLeaseHeld, sourceJournalHeldAtPublish, targetJournalHeldAtPublish };
      }, {
        moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href,
        checkpointUrl: new URL(`/@fs/${checkpointModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        journalLeaseUrl: new URL(`/@fs/${resolve(repoRoot, "host/src/browser-persistence-journal-lease.ts")}`, baseURL).href,
        kernelUrl,
        imageUrl,
        imageConfig,
        terminalSession,
      });
      expect(staged.stagedState).toBe("XYcdefgh");
      expect(staged.lostCloseAcknowledgement).toBe(true);
      expect(staged.publicationLeaseHeld).toBe(true);
      expect(staged.sourceJournalHeldAtPublish).toBe(true);
      expect(staged.targetJournalHeldAtPublish).toBe(true);
      expect(staged.stagedJournal).not.toBe(staged.previousJournal);
      await page.reload();
      const reopened = await page.evaluate(async ({ moduleUrl, browserKernelUrl, kernelUrl, name, identity }) => {
        const {
          discardFixedPersistenceStagedReplacement,
          loadFixedPersistenceImageHandle,
          loadPreviousFixedPersistenceImageHandle,
        } = await import(moduleUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const current = await loadFixedPersistenceImageHandle(name, identity);
        if (current === null) throw new Error("replacement disappeared after reload");
        const discardedPublished = await discardFixedPersistenceStagedReplacement(name, identity, current);
        const previous = await loadPreviousFixedPersistenceImageHandle(name, identity, current);
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({
            kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
            vfsImageFile: current.file,
            persistentImageBinding: current.persistentImageBinding,
            experimentalFixedPersistenceName: current.journalName,
            persistentComputerName: name,
            requireExistingRootfsPersistence: true,
          });
          return {
            currentJournal: current.journalName,
            previousJournal: previous?.journalName ?? null,
            state: new TextDecoder().decode(await kernel.readFileFromVfs("/state")),
            discardedPublished,
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
        previousJournal: null,
        state: "XYcdefgh",
        discardedPublished: false,
      });
      const changedMetadata = await page.evaluate(async ({ moduleUrl, checkpointUrl, browserKernelUrl, kernelUrl, name, identity }) => {
        const { loadFixedPersistenceImageHandle } = await import(moduleUrl);
        const { checkpointPersistentImage } = await import(checkpointUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const current = await loadFixedPersistenceImageHandle(name, identity);
        if (current === null) throw new Error("replacement disappeared before config edit");
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const listEntries = async () => {
          const entries: string[] = [];
          for await (const [entry] of (directory as FileSystemDirectoryHandle & {
            entries(): AsyncIterable<[string, FileSystemHandle]>;
          }).entries()) entries.push(entry);
          return entries.sort();
        };
        const rejectedStages: Array<{ imageFileName?: string; journalName: string }> = [];
        let rejectedCandidate = false;
        try {
          await checkpointPersistentImage({
            name,
            identity,
            journalName: current.journalName,
            kernelWasm,
            createKernel: () => new BrowserKernel({ kernelOwnedFs: true }),
            closeKernel: (instance) => instance.destroy(),
            lazyUrlMapForImage: () => ({}),
            releaseLease: async () => {},
            validateCandidate: async (_kernel, candidateStage) => {
              rejectedStages.push(candidateStage);
              for (const slot of ["g2", "g3", "g4"]) {
                for (const suffix of ["journal", "index", "seal"]) {
                  await directory.getFileHandle(`${candidateStage.journalName}.${slot}.${suffix}`, { create: true });
                }
              }
              throw new Error("injected candidate validation failure");
            },
          });
        } catch (error) {
          rejectedCandidate = error instanceof Error && error.message === "injected candidate validation failure";
        }
        const rejectedStage = rejectedStages[0];
        if (rejectedStage?.imageFileName === undefined) throw new Error("candidate stage was not captured");
        const discardedStage = !(await listEntries()).some((entry) =>
          entry === rejectedStage.imageFileName || entry.startsWith(`${rejectedStage.journalName}.`) ||
          entry.startsWith(`${name}.snapshot-`));
        const runGuestEdits = async (modes: string[]) => {
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({
              kernelWasm,
              vfsImageFile: current.file,
              persistentImageBinding: current.persistentImageBinding,
              experimentalFixedPersistenceName: current.journalName,
              persistentComputerName: name,
              requireExistingRootfsPersistence: true,
            });
            for (const mode of modes) {
              const { exit } = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", mode]);
              if (await exit !== 0) throw new Error(`guest ${mode} failed`);
            }
          } finally {
            await kernel.destroy();
          }
        };
        const checkpointError = async () => {
          try {
            await checkpointPersistentImage({
              name,
              identity,
              journalName: current.journalName,
              kernelWasm,
              createKernel: () => new BrowserKernel({ kernelOwnedFs: true }),
              closeKernel: (instance) => instance.destroy(),
              lazyUrlMapForImage: () => ({}),
              releaseLease: async () => {},
            });
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        };
        await runGuestEdits(["change-boot-config"]);
        const configError = await checkpointError();
        await runGuestEdits(["restore-boot-config", "change-terminal-session"]);
        const sessionError = await checkpointError();
        await runGuestEdits(["restore-terminal-session", "change-dinit-closure"]);
        const serviceError = await checkpointError();
        const selected = await loadFixedPersistenceImageHandle(name, identity);
        return {
          configRejected: configError?.includes("boot configuration changed after composition"),
          sessionRejected: sessionError?.includes("terminal session changed after composition"),
          serviceRejected: serviceError?.includes("dinit service closure changed after composition"),
          journalUnchanged: selected?.journalName === current.journalName,
          rejectedCandidate,
          discardedStage,
        };
      }, {
        moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href,
        checkpointUrl: new URL(`/@fs/${checkpointModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        kernelUrl,
        name: staged.name,
        identity: staged.identity,
      });
      expect(changedMetadata).toEqual({
        configRejected: true,
        sessionRejected: true,
        serviceRejected: true,
        journalUnchanged: true,
        rejectedCandidate: true,
        discardedStage: true,
      });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("resizable computer checkpoints a guest-created directory tree", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(imageModulePath === null || kernelPath === null || guestProgramPath === null,
    "kernel, image writer, and guest artifacts are required");
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.setImageCapacity(8 * 1024 * 1024);
  filesystem.mkdir("/bin", 0o755);
  filesystem.mkdir("/etc", 0o755);
  filesystem.mkdir("/etc/kandelo", 0o755);
  filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
  const imageConfig = {
    version: 1 as const,
    defaultProfile: "probe",
    profiles: { probe: { identity: { title: "Persistence probe", summary: "Resizable checkpoint", accent: "#123456", glyph: "sh" } } },
  };
  const terminalSession = {
    kind: "kandelo-experimental-terminal-session" as const,
    version: 1 as const,
    initial: { path: "/bin/persistence-overwrite", argv: ["persistence-overwrite"], uid: 0, gid: 0 },
  };
  filesystem.writeFile("/etc/kandelo/demo.json", new TextEncoder().encode(JSON.stringify(imageConfig)), 0o644);
  filesystem.writeFile("/etc/kandelo/experimental-terminal-session.json", new TextEncoder().encode(JSON.stringify(terminalSession)), 0o644);
  const image = await filesystem.saveImage();
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-resizable-checkpoint-"));
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, string>;
    extraHTTPHeaders?: Record<string, string>;
  };
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      await routeCurrentImageModules(context);
      const page = context.pages()[0] ?? await context.newPage();
      const imageUrl = new URL("/resizable-checkpoint.vfs", baseURL).href;
      const kernelUrl = new URL("/resizable-checkpoint-kernel.wasm", baseURL).href;
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ imageUrl, kernelUrl, moduleUrl, checkpointUrl, browserKernelUrl, imageConfig, terminalSession }) => {
        const imageSource = (chunks: Iterable<Uint8Array>, payloadLength = Array.isArray(chunks) ? chunks.reduce((total, chunk) => total + chunk.byteLength, 0) : 0) => ({ chunks, payloadLength, integrityPolicy: "crc32c" as const });
        const { saveFixedPersistenceImageStream, loadFixedPersistenceImageHandle, markFixedPersistenceJournalInitialized } = await import(moduleUrl);
        const { checkpointPersistentImage } = await import(checkpointUrl);
        const { BrowserKernel } = await import(browserKernelUrl);
        const name = `resizable-checkpoint-${crypto.randomUUID()}`;
        const identity = JSON.stringify({ imageUrl, persistenceMode: "resizable" });
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const saved = await saveFixedPersistenceImageStream(name, identity,
          imageSource([new Uint8Array(await (await fetch(imageUrl)).arrayBuffer())]), undefined,
          { imageConfig, profileId: "probe", terminalSession, requiredServices: [] });
        let fixedModeRejected = false;
        try {
          await loadFixedPersistenceImageHandle(name, JSON.stringify({ imageUrl }));
        } catch {
          fixedModeRejected = true;
        }
        if (!fixedModeRejected) throw new Error("resizable image reopened under fixed-mode identity");
        const first = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await first.initFromOpfsImage({
            kernelWasm, vfsImageFile: saved.file,
            persistentImageBinding: saved.persistentImageBinding,
            experimentalResizablePersistenceName: saved.journalName, persistentComputerName: name,
          });
          await markFixedPersistenceJournalInitialized(name, identity, saved);
          const { exit } = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "create-tree"]);
          if (await exit !== 0) throw new Error("guest could not create directory tree");
        } finally {
          await first.destroy();
        }
        const ready = await loadFixedPersistenceImageHandle(name, identity);
        if (ready === null) throw new Error("created computer disappeared");
        const { staged } = await checkpointPersistentImage({
          name, mode: "resizable", identity, journalName: ready.journalName, kernelWasm,
          createKernel: () => new BrowserKernel({ kernelOwnedFs: true }),
          closeKernel: (kernel) => kernel.destroy(),
          lazyUrlMapForImage: () => ({}),
          releaseLease: async () => {},
          validateCandidate: async (kernel) => {
            const content = await kernel.readFileFromVfs("/persist-tree/nested/file");
            if (new TextDecoder().decode(content ?? new Uint8Array()) !== "TREE") {
              throw new Error("staged snapshot lost the guest-created file");
            }
          },
        });
        const reopened = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await reopened.initFromOpfsImage({
            kernelWasm, vfsImageFile: staged.file,
            persistentImageBinding: staged.persistentImageBinding,
            experimentalResizablePersistenceName: staged.journalName, persistentComputerName: name,
            requireExistingRootfsPersistence: true,
          });
          const content = await reopened.readFileFromVfs("/persist-tree/nested/file");
          return { content: new TextDecoder().decode(content ?? new Uint8Array()), changedJournal: staged.journalName !== ready.journalName };
        } finally {
          await reopened.destroy();
        }
      }, {
        imageUrl, kernelUrl,
        moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href,
        checkpointUrl: new URL(`/@fs/${checkpointModulePath}`, baseURL).href,
        browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
        imageConfig, terminalSession,
      });
      expect(result).toEqual({ content: "TREE", changedJournal: true });
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
      await routeCurrentImageModules(context);
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
