import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { persistentBaseFixture, persistentColdPayloadRange, persistentReplacementBaseFixture } from "../../../host/test/fixtures/persistent-base-image";
import { opfsTest as test } from "./support/opfs-page";

const repository = resolve(import.meta.dirname, "../../..");

for (const policy of ["crc32c", "sha256"] as const) {
  for (const budget of [768 * 1024, 896 * 1024]) {
    test(`replaced ${policy} OPFS namespace reopens at its ${budget} byte metadata allowance`, async ({ page, baseURL }, testInfo) => {
      test.setTimeout(180_000);
      const temporary = mkdtempSync(join(tmpdir(), "kandelo-browser-recovery-slots-"));
      try {
        const fixture = await persistentReplacementBaseFixture(temporary, policy);
        const imageUrl = new URL("/recovery-slots.img", baseURL).href;
        const kernelUrl = new URL("/recovery-slots-kernel.wasm", baseURL).href;
        await page.route(imageUrl, route => route.fulfill({ body: readFileSync(fixture.path) }));
        await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolve(repository, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm")) }));
        await page.goto(new URL("/trap-signal-test.html", baseURL).href);
        const result = await page.evaluate(async parameters => {
          const { BrowserKernel } = await import(parameters.browserKernelUrl) as typeof import("../../../host/src/browser-kernel-host");
          const root = await navigator.storage.getDirectory();
          const name = `recovery-slots-${crypto.randomUUID()}`;
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
            const counts: number[] = [];
            const pages: number[] = [];
            for (const phase of ["replace", "recover", "verify"]) {
              active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024,
                rootfsMetadataBytes: parameters.budget, maxMemoryPages: 1024, memoryProfile: "constrained" });
              await active.initFromOpfsImage({ kernelWasm, vfsImageFile: base, persistentImageBinding: parameters.binding,
                experimentalResizablePersistenceName: name, persistentComputerName: name });
              if (phase === "replace") {
                for (let index = 0; index < parameters.count; index++) {
                  const suffix = String(index).padStart(4, "0");
                  if (!await active.unlinkFileFromVfs(`/base-${suffix}`)) throw new Error(`base unlink failed: ${suffix}`);
                  await active.writeFileToVfs(`/next-${suffix}`, new Uint8Array());
                }
              }
              const entries = await active.readDirFromVfs("/");
              const count = entries?.filter(entry => entry.name.startsWith("next-")).length;
              if (count !== parameters.count || entries?.some(entry => entry.name.startsWith("base-"))) {
                throw new Error("recovered replacement namespace differs");
              }
              counts.push(count);
              if (phase === "recover") await active.writeFileToVfs("/next-0000", new TextEncoder().encode("after recovery"));
              const text = new TextDecoder().decode((await active.readFileFromVfs("/next-0000")) ?? new Uint8Array());
              if (text !== (phase === "replace" ? "" : "after recovery")) throw new Error("recovered file content differs");
              pages.push(await active.getKernelMemoryPages());
              await active.destroy();
              clean = !active.hasUnconfirmedKernelQuiescence() && active.getPersistenceShutdownFailure() === null;
              if (!clean) throw new Error("persistent storage did not close");
              active = undefined;
            }
            return { counts, pages };
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
        }, { imageUrl, kernelUrl, binding: fixture.binding, count: fixture.count, budget,
          browserKernelUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href });
        await testInfo.attach("same-budget-recovery", { body: JSON.stringify({ policy, budget, ...result }), contentType: "application/json" });
        expect(result.counts).toEqual([fixture.count, fixture.count, fixture.count]);
        expect(Math.max(...result.pages)).toBeLessThanOrEqual(1024);
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    });
  }
}

for (const policy of ["crc32c", "sha256"] as const) {
  test(`normal ${policy} OPFS double-indirect file reads stay within the positioned I/O bound`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const temporary = mkdtempSync(join(tmpdir(), "kandelo-browser-file-read-io-"));
    try {
      const fixture = await persistentBaseFixture(temporary, policy, 8 * 1024 * 1024 + 17);
      const imageUrl = new URL("/file-read-io.img", baseURL).href;
      const kernelUrl = new URL("/file-read-io-kernel.wasm", baseURL).href;
      await page.route(imageUrl, route => route.fulfill({ body: readFileSync(fixture.path) }));
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolve(repository, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm")) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const measurement = await page.evaluate(async parameters => {
        const NativeWorker = globalThis.Worker;
        let worker: Worker | undefined;
        globalThis.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            const kernel = String(url).includes("browser-kernel-worker-entry");
            super(kernel ? parameters.measuredWorkerUrl : url, options);
            if (kernel) worker = this;
          }
        };
        const statistics = async () => {
          if (worker === undefined) throw new Error("kernel worker was not instrumented");
          const channel = new MessageChannel();
          const values = await new Promise<Array<[string, { bytes: number; calls: number; maxRequest: number }]>>((resolve, reject) => {
            const timer = setTimeout(() => { channel.port1.close(); reject(new Error("storage probe did not respond")); }, 10_000);
            channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
            worker!.postMessage({ type: "kandelo-test-storage-stats" }, [channel.port2]);
          });
          const base = new Map(values).get("base");
          if (base === undefined) throw new Error("base reads were not observed");
          return base;
        };
        const { BrowserKernel } = await import(parameters.browserKernelUrl) as typeof import("../../../host/src/browser-kernel-host");
        const root = await navigator.storage.getDirectory();
        const name = `file-read-io-${crypto.randomUUID()}`;
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
          active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained" });
          await active.initFromOpfsImage({ kernelWasm, vfsImageFile: base,
            persistentImageBinding: { ...parameters.binding, dataCachePages: 2, indexCachePages: 2 },
            experimentalResizablePersistenceName: name, persistentComputerName: name });
          const before = await statistics();
          const offset = 5 * 1024 * 1024 + 37;
          const length = 1024 * 1024 - 257;
          const actual = await active.readFileRangeFromVfs("/large", offset, length);
          if (actual?.length !== length || actual.some((byte, index) => byte !== (offset + index) % 251)) throw new Error("positioned file bytes changed");
          const after = await statistics();
          return { offset, length, bytes: after.bytes - before.bytes, calls: after.calls - before.calls,
            maxRequest: after.maxRequest, pages: await active.getKernelMemoryPages() };
        } finally {
          globalThis.Worker = NativeWorker;
          if (active !== undefined) {
            await active.destroy();
            clean = !active.hasUnconfirmedKernelQuiescence() && active.getPersistenceShutdownFailure() === null;
            if (!clean) throw new Error("positioned read kernel shutdown is unproven");
          }
          if (clean && inputClosed) {
            const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
            for await (const filename of overlay.keys()) {
              if (filename.startsWith(name + ".")) await overlay.removeEntry(filename, { recursive: true });
            }
            await root.removeEntry(name, { recursive: true });
          }
        }
      }, { imageUrl, kernelUrl, binding: fixture.binding,
        browserKernelUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
        measuredWorkerUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/test/fixtures/persistent-io-kernel-worker.ts")}?worker_file&type=module`, baseURL).href });
      await testInfo.attach("persistent-file-physical-reads", { body: JSON.stringify({ policy, ...measurement }), contentType: "application/json" });
      expect(measurement.bytes).toBeGreaterThan(0);
      expect(measurement.bytes).toBeLessThan(measurement.length * 5);
      expect(measurement.maxRequest).toBeLessThanOrEqual(65536);
      expect(measurement.pages).toBeLessThanOrEqual(1024);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  test(`normal ${policy} OPFS reopen reads metadata rather than untouched image payload`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(240_000);
    const temporary = mkdtempSync(join(tmpdir(), "kandelo-browser-boot-io-"));
    const sizes = [512 * 1024, 32 * 1024 * 1024];
    try {
      const fixtures = [];
      for (const contentBytes of sizes) {
        const directory = join(temporary, String(contentBytes));
        mkdirSync(directory);
        const fixture = await persistentBaseFixture(directory, policy, contentBytes);
        const url = new URL(`/boot-io-${contentBytes}.img`, baseURL).href;
        await page.route(url, route => route.fulfill({ body: readFileSync(fixture.path) }));
        fixtures.push({ url, binding: fixture.binding, contentBytes, guard: persistentColdPayloadRange(fixture.path, fixture.content) });
      }
      const kernelUrl = new URL("/boot-io-kernel.wasm", baseURL).href;
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolve(repository, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm")) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const measurements = await page.evaluate(async ({ browserKernelUrl, measuredWorkerUrl, kernelUrl, fixtures }) => {
        const NativeWorker = globalThis.Worker;
        const workers: Worker[] = [];
        globalThis.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            const kernel = String(url).includes("browser-kernel-worker-entry");
            super(kernel ? measuredWorkerUrl : url, options);
            if (kernel) {
              workers.push(this);
              this.postMessage({ type: "kandelo-test-storage-guards", guards: fixtures.map(fixture => [`${fixture.contentBytes}.base`, fixture.guard]) });
            }
          }
        };
        const { BrowserKernel } = await import(browserKernelUrl) as typeof import("../../../host/src/browser-kernel-host");
        const root = await navigator.storage.getDirectory();
        const name = `boot-io-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        const journals: string[] = [];
        let active: InstanceType<typeof BrowserKernel> | undefined;
        const measurements: Array<{ contentBytes: number; physicalBytes: number; bytes: number; calls: number; maxRequest: number; touchedPayload: boolean }> = [];
        try {
          const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
          for (const fixture of fixtures) {
            const filename = `${fixture.contentBytes}.base`;
            const file = await directory.getFileHandle(filename, { create: true });
            const writer = await file.createWritable();
            await writer.write(await (await fetch(fixture.url)).arrayBuffer());
            await writer.close();
            const journalName = `${name}-${fixture.contentBytes}`;
            journals.push(journalName);
            const boot = async (existing: boolean) => {
              active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained" });
              await active.initFromOpfsImage({ kernelWasm, vfsImageFile: file, persistentImageBinding: fixture.binding,
                experimentalResizablePersistenceName: journalName, persistentComputerName: journalName,
                requireExistingRootfsPersistence: existing });
              return active;
            };
            const first = await boot(false);
            await first.writeFileToVfs("/state", new TextEncoder().encode("persisted"), 0o640);
            await first.destroy();
            active = undefined;
            const second = await boot(true);
            if (new TextDecoder().decode((await second.readFileFromVfs("/state"))!) !== "persisted") throw new Error("journal recovery lost data");
            const worker = workers.at(-1);
            if (worker === undefined) throw new Error("kernel worker was not instrumented");
            const channel = new MessageChannel();
            const statistics = await new Promise<Array<[string, { bytes: number; calls: number; maxRequest: number; touchedPayload: boolean }]>>((resolve, reject) => {
              const timer = setTimeout(() => { channel.port1.close(); reject(new Error("storage probe did not respond")); }, 10_000);
              channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
              worker.postMessage({ type: "kandelo-test-storage-stats" }, [channel.port2]);
            });
            const recorded = new Map(statistics).get(filename);
            if (recorded === undefined) throw new Error("no physical base reads were observed");
            measurements.push({ contentBytes: fixture.contentBytes, physicalBytes: (await file.getFile()).size, ...recorded });
            await second.destroy();
            active = undefined;
          }
          return measurements;
        } finally {
          globalThis.Worker = NativeWorker;
          try { await active?.destroy(); }
          finally {
            const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
            for await (const filename of overlay.keys()) {
              if (journals.some(journal => filename.startsWith(journal + "."))) await overlay.removeEntry(filename, { recursive: true });
            }
            await root.removeEntry(name, { recursive: true });
          }
        }
      }, {
        browserKernelUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
        measuredWorkerUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/test/fixtures/persistent-io-kernel-worker.ts")}?worker_file&type=module`, baseURL).href,
        kernelUrl, fixtures,
      });
      const [small, large] = measurements;
      expect(small.bytes).toBeGreaterThan(0);
      expect(large.bytes).toBeGreaterThan(0);
      expect(large.bytes).toBeLessThan(large.physicalBytes / 4);
      expect(small.touchedPayload).toBe(false);
      expect(large.touchedPayload).toBe(false);
      expect(large.maxRequest).toBeLessThanOrEqual(65536);
      await testInfo.attach("persistent-boot-physical-reads", { body: JSON.stringify({ policy, measurements }), contentType: "application/json" });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}
