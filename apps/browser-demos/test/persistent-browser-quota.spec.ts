import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "../playwright-test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { persistentBaseFixture } from "../../../host/test/fixtures/persistent-base-image";
import { opfsTest as test } from "./support/opfs-page";

const repository = resolve(import.meta.dirname, "../../..");

for (const policy of ["crc32c", "sha256"] as const) {
  test(`browser-enforced ${policy} OPFS quota preserves durable data and allows a source-free retry`, async ({ page, browserName, baseURL }, testInfo) => {
    test.skip(browserName !== "chromium", "Browser-managed quota override requires Chromium's DevTools protocol; other engines retain injected quota coverage");
    test.setTimeout(180_000);
    const temporary = mkdtempSync(join(tmpdir(), "kandelo-browser-managed-quota-"));
    const session = await page.context().newCDPSession(page);
    const origin = new URL(baseURL!).origin;
    try {
      const fixture = await persistentBaseFixture(temporary, policy, undefined, undefined, 64 * 1024 * 1024);
      const pressureBytes = 16 * 1024 * 1024;
      const imageUrl = new URL("/browser-quota.img", baseURL).href;
      const kernelUrl = new URL("/browser-quota-kernel.wasm", baseURL).href;
      await page.route(imageUrl, route => route.fulfill({ body: readFileSync(fixture.path) }));
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(process.env.KANDELO_KIFS_BENCH_KERNEL ?? resolveBinary("kernel.wasm")) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      let sourceRequests = 0;
      await page.exposeFunction("blockImportedSource", async () => {
        await page.route(imageUrl, route => { sourceRequests++; return route.abort("failed"); });
      });
      const quotas: Array<{ usage: number; quota: number; overrideActive: boolean }> = [];
      await page.exposeFunction("setManagedQuota", async (limited: boolean) => {
        if (limited) {
          const before = await session.send("Storage.getUsageAndQuota", { origin });
          await session.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: before.usage + 2 * 1024 * 1024 });
        } else {
          await session.send("Storage.overrideQuotaForOrigin", { origin });
        }
        const observed = await session.send("Storage.getUsageAndQuota", { origin });
        quotas.push({ usage: observed.usage, quota: observed.quota, overrideActive: observed.overrideActive });
        if (observed.overrideActive !== limited) throw new Error("Browser quota override did not reach the requested state");
      });
      const result = await page.evaluate(async parameters => {
        const { BrowserKernel } = await import(parameters.moduleUrl) as typeof import("../../../host/src/browser-kernel-host");
        const setQuota = (window as unknown as { setManagedQuota(limited: boolean): Promise<void> }).setManagedQuota;
        const blockSource = (window as unknown as { blockImportedSource(): Promise<void> }).blockImportedSource;
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const name = `managed-quota-${crypto.randomUUID()}`;
        const base = await directory.getFileHandle(`${name}.base`, { create: true });
        const response = await fetch(parameters.imageUrl);
        if (!response.ok || response.body === null) throw new Error("Quota fixture source is unavailable");
        await response.body.pipeTo(await base.createWritable());
        const kernelWasm = await (await fetch(parameters.kernelUrl)).arrayBuffer();
        const NativeWorker = window.Worker;
        const nativeFailures: Array<{ name: string; operation: string; exception: string }> = [];
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            const targeted = String(url).includes("browser-kernel-worker-entry");
            super(targeted ? parameters.observerUrl : url, options);
            if (targeted) this.addEventListener("message", event => {
              if (event.data?.type !== "kandelo-test-managed-quota") return;
              event.stopImmediatePropagation();
              if (nativeFailures.length < 16) nativeFailures.push(event.data);
            }, true);
          }
        };
        const storageDiagnostics: string[] = [];
        let active: InstanceType<typeof BrowserKernel> | undefined;
        let closed = true;
        let verified = false;
        const boot = async (existing: boolean) => {
          active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained",
            onHostDiagnostic: diagnostic => { if (diagnostic.source === "storage-capacity") storageDiagnostics.push(diagnostic.message); } });
          closed = false;
          await active.initFromOpfsImage({ kifsUpgradeProfile: "custom", kernelWasm, vfsImageFile: base, persistentImageBinding: parameters.binding,
            experimentalResizablePersistenceName: name, persistentComputerName: name, requireExistingRootfsPersistence: existing });
          return active;
        };
        const close = async () => {
          if (active === undefined) return null;
          const current = active;
          await current.destroy();
          closed = !current.hasUnconfirmedKernelQuiescence();
          if (!closed) throw new Error("Quota test could not prove kernel shutdown");
          active = undefined;
          return current.getPersistenceShutdownFailure();
        };
        const readState = async (kernel: InstanceType<typeof BrowserKernel>) =>
          new TextDecoder().decode((await kernel.readFileFromVfs("/state")) ?? new Uint8Array());
        const writePressure = (kernel: InstanceType<typeof BrowserKernel>) =>
          kernel.writeFileToVfs("/pressure", new Uint8Array(parameters.pressureBytes).fill(53));
        try {
          const first = await boot(false);
          await first.writeFileToVfs("/state", new TextEncoder().encode("durable before browser quota"));
          if (await close() !== null) throw new Error("Protected data did not reach a clean shutdown");
          await setQuota(true);
          const limited = await boot(true);
          let failure: string | undefined;
          try { await writePressure(limited); }
          catch (error) { failure = String(error); }
          if (failure === undefined) throw new Error("Browser quota failed to refuse a write beyond its available space");
          const live = await readState(limited);
          const shutdownFailure = await close();
          await setQuota(false);
          await blockSource();
          const recovered = await boot(true);
          const restored = await readState(recovered);
          const memoryPages = await recovered.getKernelMemoryPages();
          await writePressure(recovered);
          const recoveryShutdownFailure = await close();
          const reopened = await boot(true);
          const originalAfterRetry = await readState(reopened);
          const retried = await reopened.readFileFromVfs("/pressure");
          const retryBytes = retried?.byteLength ?? 0;
          const retryContentsIntact = retried?.every(byte => byte === 53) ?? false;
          const retryShutdownFailure = await close();
          verified = live === "durable before browser quota" && restored === live && originalAfterRetry === live
            && retryBytes === parameters.pressureBytes && retryContentsIntact
            && recoveryShutdownFailure === null && retryShutdownFailure === null;
          return { failure, live, restored, originalAfterRetry, retryBytes, retryContentsIntact, shutdownFailure,
            recoveryShutdownFailure, retryShutdownFailure, memoryPages, nativeFailures, storageDiagnostics };
        } finally {
          await setQuota(false);
          await close();
          window.Worker = NativeWorker;
          if (closed && verified) {
            for await (const filename of directory.keys()) {
              if (filename.startsWith(name + ".")) await directory.removeEntry(filename);
            }
          }
        }
      }, { moduleUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
        observerUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/test/fixtures/opfs-managed-quota-observer-worker.ts")}?worker_file&type=module`, baseURL).href,
        imageUrl, kernelUrl, binding: fixture.binding, pressureBytes });
      await testInfo.attach("browser-managed-quota", { contentType: "application/json", body: JSON.stringify({
        policy, result, quotas, sourceRequests, mechanism: "Chromium quota-manager override, not a JavaScript OPFS exception shim or physical-device disk exhaustion",
        reference: "https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-overrideQuotaForOrigin",
      }) });
      expect(result.failure).toContain("rootfs write failed");
      expect(result.failure).toContain("errno 28");
      expect(result.nativeFailures.length).toBeGreaterThan(0);
      expect(result.nativeFailures.every(failure => failure.exception === "QuotaExceededError" && failure.name.endsWith(".volume"))).toBe(true);
      expect(result.storageDiagnostics.some(message => message.includes("Host storage refused"))).toBe(true);
      expect(result.live).toBe("durable before browser quota");
      expect(result.restored).toBe(result.live);
      expect(result.originalAfterRetry).toBe(result.live);
      expect(result.retryBytes).toBe(pressureBytes);
      expect(result.retryContentsIntact).toBe(true);
      expect(result.recoveryShutdownFailure).toBeNull();
      expect(result.retryShutdownFailure).toBeNull();
      expect(sourceRequests).toBe(0);
      expect(result.memoryPages).toBeLessThanOrEqual(1024);
      expect(quotas.some(quota => quota.overrideActive)).toBe(true);
    } finally {
      await session.send("Storage.overrideQuotaForOrigin", { origin });
      await session.detach();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
