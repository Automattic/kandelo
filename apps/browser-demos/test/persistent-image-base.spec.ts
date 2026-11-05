import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { persistentBaseFixture, persistentNearlyFullBaseFixture, preparePersistentBaseFixtures,
  PERSISTENT_BOOTSTRAP_CERTIFICATE_URL } from "../../../host/test/fixtures/persistent-base-image";
import { BROWSER_MITM_CA_BUNDLE_PATH } from "../../../host/src/networking/browser-mitm-ca-env";
import { opfsTest as test } from "./support/opfs-page";

const repository = resolve(import.meta.dirname, "../../..");
const kernelPath = join(repository, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm");

test.beforeAll(() => preparePersistentBaseFixtures());

for (const policy of ["crc32c", "sha256"] as const) {
  test(`host-staged ${policy} quota failure rejects boot, releases storage and preserves guest data`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const temporary = mkdtempSync(join(tmpdir(), "kandelo-browser-bootstrap-quota-"));
    try {
      const fixture = await persistentBaseFixture(temporary, policy);
      const imageUrl = new URL("/bootstrap-quota.img", baseURL).href;
      const kernelUrl = new URL("/bootstrap-quota-kernel.wasm", baseURL).href;
      await page.route(imageUrl, route => route.fulfill({ body: readFileSync(fixture.path) }));
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async parameters => {
        const { BrowserKernel } = await import(parameters.moduleUrl) as typeof import("../../../host/src/browser-kernel-host");
        const root = await navigator.storage.getDirectory();
        const name = `bootstrap-quota-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        const NativeWorker = globalThis.Worker;
        let inject = false;
        const refusals: Array<{ exception: string; refusedFlushes: number }> = [];
        globalThis.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            const targeted = inject && String(url).includes("browser-kernel-worker-entry");
            super(targeted ? parameters.faultWorkerUrl : url, options);
            if (targeted) this.addEventListener("message", event => {
              if (event.data?.type !== "kandelo-test-bootstrap-quota") return;
              event.stopImmediatePropagation();
              refusals.push(event.data);
            }, true);
          }
        };
        let active: InstanceType<typeof BrowserKernel> | undefined;
        let clean = false;
        let inputClosed = false;
        try {
          const base = await directory.getFileHandle("base", { create: true });
          const response = await fetch(parameters.imageUrl);
          if (!response.ok || response.body === null) throw new Error("base download failed");
          await response.body.pipeTo(await base.createWritable());
          inputClosed = true;
          const kernelWasm = await (await fetch(parameters.kernelUrl)).arrayBuffer();
          const boot = async (existing: boolean) => {
            active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained" });
            await active.initFromOpfsImage({ kernelWasm, vfsImageFile: base, persistentImageBinding: parameters.binding,
              experimentalResizablePersistenceName: name, persistentComputerName: name, requireExistingRootfsPersistence: existing });
            return active;
          };
          const first = await boot(false);
          await first.writeFileToVfs("/state", new TextEncoder().encode("guest data survives"));
          await first.destroy();
          clean = !first.hasUnconfirmedKernelQuiescence() && first.getPersistenceShutdownFailure() === null;
          if (!clean) throw new Error("initial bootstrap storage did not close");
          active = undefined;
          inject = true;
          let failure: string | undefined;
          try { await boot(true); } catch (error) { failure = String(error); }
          inject = false;
          if (failure === undefined) throw new Error("bootstrap storage refusal did not reject initialization");
          if (active === undefined || active.hasUnconfirmedKernelQuiescence()) throw new Error("failed bootstrap retained unconfirmed storage");
          const shutdownFailure = active.getPersistenceShutdownFailure();
          active = undefined;
          const recovered = await boot(true);
          const content = new TextDecoder().decode((await recovered.readFileFromVfs("/state")) ?? new Uint8Array());
          const certificate = new TextDecoder().decode((await recovered.readFileFromVfs(parameters.caPath)) ?? new Uint8Array());
          await recovered.destroy();
          clean = !recovered.hasUnconfirmedKernelQuiescence() && recovered.getPersistenceShutdownFailure() === null;
          if (!clean) throw new Error("recovered bootstrap storage did not close");
          active = undefined;
          return { failure, shutdownFailure, refusals, content, hasCertificate: certificate.startsWith("-----BEGIN CERTIFICATE-----") };
        } finally {
          globalThis.Worker = NativeWorker;
          if (active !== undefined) {
            await active.destroy();
            clean = !active.hasUnconfirmedKernelQuiescence() && active.getPersistenceShutdownFailure() === null;
          }
          if (clean && inputClosed) {
            const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
            for await (const filename of overlay.keys()) {
              if (filename.startsWith(name + ".")) await overlay.removeEntry(filename, { recursive: true });
            }
            await root.removeEntry(name, { recursive: true });
          }
        }
      }, { moduleUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
        faultWorkerUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/test/fixtures/bootstrap-quota-kernel-worker.ts")}?worker_file&type=module`, baseURL).href,
        imageUrl, kernelUrl, binding: fixture.binding, caPath: BROWSER_MITM_CA_BUNDLE_PATH });
      expect(result.failure).toMatch(/rootfs (unlink|write) failed/);
      expect(result.shutdownFailure).not.toBeNull();
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0].exception).toBe("QuotaExceededError");
      expect(result.refusals[0].refusedFlushes).toBeGreaterThan(0);
      expect(result.content).toBe("guest data survives");
      expect(result.hasCertificate).toBe(true);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  test(`host-staged ${policy} certificate files remain writable and preserve journaled siblings across boot`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const temporary = mkdtempSync(join(tmpdir(), "kandelo-browser-bootstrap-files-"));
    try {
      const fixture = await persistentBaseFixture(temporary, policy, undefined, policy === "crc32c" ? "resident" : "deferred");
      let oldCertificateFetches = 0;
      await page.route(PERSISTENT_BOOTSTRAP_CERTIFICATE_URL, route => { oldCertificateFetches++; return route.abort(); });
      const imageUrl = new URL("/bootstrap-files.img", baseURL).href;
      const kernelUrl = new URL("/bootstrap-files-kernel.wasm", baseURL).href;
      await page.route(imageUrl, route => route.fulfill({ body: readFileSync(fixture.path) }));
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async parameters => {
        const { BrowserKernel } = await import(parameters.moduleUrl) as typeof import("../../../host/src/browser-kernel-host");
        const root = await navigator.storage.getDirectory();
        const name = `bootstrap-files-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        let active: InstanceType<typeof BrowserKernel> | undefined;
        let clean = false;
        let inputClosed = false;
        try {
          const base = await directory.getFileHandle("base", { create: true });
          const response = await fetch(parameters.imageUrl);
          if (!response.ok || response.body === null) throw new Error("base download failed");
          await response.body.pipeTo(await base.createWritable());
          inputClosed = true;
          const kernelWasm = await (await fetch(parameters.kernelUrl)).arrayBuffer();
          const lengths: number[] = [];
          const marker = "/etc/ssl/certs/guest-owned-marker";
          for (let phase = 0; phase < 3; phase++) {
            active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained" });
            await active.initFromOpfsImage({ kernelWasm, vfsImageFile: base, persistentImageBinding: parameters.binding,
              experimentalResizablePersistenceName: name, persistentComputerName: name,
              requireExistingRootfsPersistence: phase !== 0 });
            const certificate = new TextDecoder().decode((await active.readFileFromVfs(parameters.caPath)) ?? new Uint8Array());
            if (!certificate.startsWith("-----BEGIN CERTIFICATE-----")) throw new Error("boot certificate is missing");
            lengths.push(certificate.length);
            if (phase !== 0) {
              const content = new TextDecoder().decode((await active.readFileFromVfs(marker)) ?? new Uint8Array());
              if (content !== String(phase - 1)) throw new Error("guest sibling did not recover");
            }
            if (phase !== 2) {
              await active.writeFileToVfs(parameters.caPath, new TextEncoder().encode(certificate + "\n"));
              await active.writeFileToVfs(marker, new TextEncoder().encode(String(phase)));
            }
            await active.destroy();
            clean = !active.hasUnconfirmedKernelQuiescence() && active.getPersistenceShutdownFailure() === null;
            if (!clean) throw new Error("bootstrap file storage did not close");
            active = undefined;
          }
          return { lengths };
        } finally {
          if (active !== undefined) {
            await active.destroy();
            clean = !active.hasUnconfirmedKernelQuiescence() && active.getPersistenceShutdownFailure() === null;
          }
          if (clean && inputClosed) {
            const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
            for await (const filename of overlay.keys()) {
              if (filename.startsWith(name + ".")) await overlay.removeEntry(filename, { recursive: true });
            }
            await root.removeEntry(name, { recursive: true });
          }
        }
      }, { moduleUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
        imageUrl, kernelUrl, binding: fixture.binding, caPath: BROWSER_MITM_CA_BUNDLE_PATH });
      expect(result.lengths).toHaveLength(3);
      expect(result.lengths.every(length => length > 0 && length < 65536)).toBe(true);
      expect(oldCertificateFetches).toBe(0);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  test(`host-staged ${policy} TLS resource refusal does not strand a full logical filesystem`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const temporary = mkdtempSync(join(tmpdir(), "kandelo-browser-bootstrap-full-"));
    try {
      const fixture = await persistentNearlyFullBaseFixture(temporary, policy);
      const imageUrl = new URL("/bootstrap-full.img", baseURL).href;
      const kernelUrl = new URL("/bootstrap-full-kernel.wasm", baseURL).href;
      await page.route(imageUrl, route => route.fulfill({ body: readFileSync(fixture.path) }));
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async parameters => {
        const { BrowserKernel } = await import(parameters.moduleUrl) as typeof import("../../../host/src/browser-kernel-host");
        const root = await navigator.storage.getDirectory();
        const name = `bootstrap-full-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        const diagnostics: Array<{ source: string; message: string }> = [];
        let active: InstanceType<typeof BrowserKernel> | undefined;
        let clean = false;
        let inputClosed = false;
        try {
          const base = await directory.getFileHandle("base", { create: true });
          const response = await fetch(parameters.imageUrl);
          if (!response.ok || response.body === null) throw new Error("base download failed");
          await response.body.pipeTo(await base.createWritable());
          inputClosed = true;
          const kernelWasm = await (await fetch(parameters.kernelUrl)).arrayBuffer();
          for (let phase = 0; phase < 3; phase++) {
            active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained",
              onHostDiagnostic: diagnostic => diagnostics.push(diagnostic) });
            await active.initFromOpfsImage({ kernelWasm, vfsImageFile: base, persistentImageBinding: parameters.binding,
              experimentalResizablePersistenceName: name, persistentComputerName: name, requireExistingRootfsPersistence: phase !== 0 });
            if (phase === 0) {
              if (!await active.unlinkFileFromVfs(parameters.caPath)) throw new Error("bootstrap certificate was not installed");
              let refused = false;
              for (let index = 0; index < parameters.fillLimit; index++) {
                try { await active.writeFileToVfs(`/padding-${index}`, new Uint8Array(4096).fill(66)); }
                catch (error) {
                  if (!String(error).includes("rootfs write failed")) throw error;
                  refused = true;
                  break;
                }
              }
              if (!refused) throw new Error("logical filesystem did not run out of data blocks");
              if (await active.statVfsPath(parameters.caPath) !== null) throw new Error("bootstrap certificate was unexpectedly restored");
            } else if (phase === 1) {
              if (!diagnostics.some(diagnostic => diagnostic.source === "Browser TLS"
                && diagnostic.message.includes("clean persistence sync"))) throw new Error("full-disk boot did not report optional TLS refusal");
              const sample = await active.readFileRangeFromVfs("/full", 0, 16);
              if (sample?.length !== 16 || sample.some(byte => byte !== 65)) throw new Error("full-disk base data changed");
              await active.writeFileToVfs("/full", new Uint8Array(), 0o600);
              await active.writeFileToVfs("/after-reclaim", new TextEncoder().encode("usable"));
            } else {
              const marker = new TextDecoder().decode((await active.readFileFromVfs("/after-reclaim")) ?? new Uint8Array());
              if (marker !== "usable") throw new Error("reclaimed filesystem did not recover");
              const certificate = new TextDecoder().decode((await active.readFileFromVfs(parameters.caPath)) ?? new Uint8Array());
              if (!certificate.startsWith("-----BEGIN CERTIFICATE-----")) throw new Error("TLS bundle did not recover after space reclamation");
            }
            await active.destroy();
            clean = !active.hasUnconfirmedKernelQuiescence() && active.getPersistenceShutdownFailure() === null;
            if (!clean) throw new Error("full-disk bootstrap storage did not close");
            active = undefined;
          }
          return { diagnostics };
        } finally {
          if (active !== undefined) {
            await active.destroy();
            clean = !active.hasUnconfirmedKernelQuiescence() && active.getPersistenceShutdownFailure() === null;
          }
          if (clean && inputClosed) {
            const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
            for await (const filename of overlay.keys()) {
              if (filename.startsWith(name + ".")) await overlay.removeEntry(filename, { recursive: true });
            }
            await root.removeEntry(name, { recursive: true });
          }
        }
      }, { moduleUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
        imageUrl, kernelUrl, binding: fixture.binding, caPath: BROWSER_MITM_CA_BUNDLE_PATH, fillLimit: fixture.fillLimit });
      expect(result.diagnostics.some(diagnostic => diagnostic.source === "Browser TLS"
        && diagnostic.message.includes("clean persistence sync"))).toBe(true);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  test(`Rust-verified ${policy} base and journal survive real OPFS worker restart`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const temporary = mkdtempSync(join(tmpdir(), "kandelo-browser-base-"));
    try {
      const fixture = await persistentBaseFixture(temporary, policy);
      const imageUrl = new URL("/verified-persistent-image.img", baseURL).href;
      const kernelUrl = new URL("/verified-persistent-kernel.wasm", baseURL).href;
      await page.route(imageUrl, route => route.fulfill({ body: readFileSync(fixture.path) }));
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ moduleUrl, imageUrl, kernelUrl, binding }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const root = await navigator.storage.getDirectory();
        const name = `verified-base-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        const file = await directory.getFileHandle("base", { create: true });
        const writer = await file.createWritable();
        await writer.write(await (await fetch(imageUrl)).arrayBuffer());
        await writer.close();
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        let active: InstanceType<typeof BrowserKernel> | undefined;
        const boot = async (identity = binding, requireExisting = false) => {
          active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained" });
          await active.initFromOpfsImage({
            kernelWasm, vfsImageFile: file, persistentImageBinding: identity,
            experimentalResizablePersistenceName: name, persistentComputerName: name,
            requireExistingRootfsPersistence: requireExisting,
          });
          return active;
        };
        try {
          const first = await boot();
          const initial = new TextDecoder().decode((await first.readFileFromVfs("/link"))!);
          const sample = await first.readFileRangeFromVfs("/large", 196645, 71);
          await first.writeFileToVfs("/state", new TextEncoder().encode("persisted"), 0o640);
          const pages = await first.getKernelMemoryPages();
          await first.destroy();
          active = undefined;
          const second = await boot(binding, true);
          const recovered = new TextDecoder().decode((await second.readFileFromVfs("/link"))!);
          await second.destroy();
          active = undefined;
          const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay");
          const journal = await overlay.getFileHandle(`${name}.journal`);
          const before = new Uint8Array(await (await journal.getFile()).arrayBuffer());
          const wrong = { ...binding, identitySha256: (binding.identitySha256[0] === "0" ? "1" : "0") + binding.identitySha256.slice(1) };
          let refused = false;
          try { await boot(wrong, true); } catch { refused = true; }
          await active?.destroy();
          active = undefined;
          const after = new Uint8Array(await (await journal.getFile()).arrayBuffer());
          return { initial, recovered, sample: Array.from(sample!), pages, refused,
            journalUnchanged: before.length === after.length && before.every((byte, index) => byte === after[index]) };
        } finally {
          await active?.destroy();
          const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
          for await (const filename of overlay.keys()) {
            if (filename.startsWith(`${name}.`)) await overlay.removeEntry(filename, { recursive: true });
          }
          await root.removeEntry(name, { recursive: true });
        }
      }, { moduleUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
        imageUrl, kernelUrl, binding: fixture.binding });
      expect(result.initial).toBe("original");
      expect(result.recovered).toBe("persisted");
      expect(result.sample).toEqual(Array.from(fixture.content.subarray(196645, 196716)));
      expect(result.pages).toBeLessThanOrEqual(1024);
      expect(result.refused).toBe(true);
      expect(result.journalUnchanged).toBe(true);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}
