import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { routeCurrentImageModules } from "./support/current-image-module";
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

for (const scenario of ["admission"] as const) {
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
              for (const control of ["primary", "target"]) {
                const unsupported = JSON.parse(control === "primary" ? original : originalActive);
                const manifest = control === "primary" ? unsupported : unsupported.target;
                manifest.imageFormat = "kandelo-checked-image-v2";
                const contents = JSON.stringify(unsupported);
                const file = control === "primary" ? primary : active;
                await write(file, contents);
                try { await api.loadFixedPersistenceImageHandle(name, identity); }
                catch (error) {
                  if (String(error).includes("Unsupported persistent checked-image format")
                    && await (await primary.getFile()).text() === (control === "primary" ? contents : original)
                    && await (await active.getFile()).text() === (control === "target" ? contents : originalActive)) refusals++;
                }
                await write(file, control === "primary" ? original : originalActive);
              }
              unknownRefused = refusals === 14;
            } finally {
              if (descriptor === undefined) delete prototype.text;
              else Object.defineProperty(prototype, "text", descriptor);
            }
            const retried = await api.loadFixedPersistenceImageHandle(name, identity);
            return { codes, lengths, oversizedReads, unknownRefused, retryLength: retried?.payloadLength,
              digest: retried?.imageIdentitySha256, expectedDigest: installed.imageIdentitySha256 };
          }
        }, { url: new URL(`/@fs/${modulePath}`, baseURL).href, scenario });
        await testInfo.attach("manifest-v6-ownership", { body: JSON.stringify(result), contentType: "application/json" });
        if (scenario === "admission") {
          expect(result).toMatchObject({ codes: ["ENOMEM", "ENOMEM"], lengths: [8 * 1024 * 1024 + 1, 8 * 1024 * 1024 + 1],
            oversizedReads: 0, unknownRefused: true, retryLength: 20 });
          expect(result.digest).toBe(result.expectedDigest);
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
