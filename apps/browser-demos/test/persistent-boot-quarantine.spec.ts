import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { LiveKernelHost } from "../../../web-libs/kandelo-session/src/kernel-host";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { opfsTest as test } from "./support/opfs-page";

interface QuarantineProbe {
  host?: LiveKernelHost;
  replacement?: Promise<void>;
  barrierName?: string;
  releaseBarrier?: () => void;
  bridgeClaims: number;
  kernelStarts: number;
  kernelStops: number;
}

type ProbeWindow = Window & typeof globalThis & { quarantineProbe: QuarantineProbe };

async function runtimeLeaseAvailable(page: Page, name: string): Promise<boolean> {
  return page.evaluate(computerName => navigator.locks.request(
    `kandelo-fixed-rootfs-runtime:${computerName}`, { mode: "exclusive", ifAvailable: true }, lock => lock !== null,
  ), name);
}

for (const outcome of ["reject", "native-barrier"] as const) {
  test(`superseded persistent boot ${outcome} preserves actual runtime ownership`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(540_000);
    const name = `boot-quarantine-${crypto.randomUUID()}`;
    const imageUrl = new URL(`/@fs/${resolveBinary("programs/wasm32/lamp.vfs.zst")}`, baseURL).href;
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const observer = await page.context().newPage();
    await observer.goto(new URL("/trap-signal-test.html", baseURL).href);
    try {
      await page.evaluate(async parameters => {
        window.confirm = () => true;
        const state: QuarantineProbe = { bridgeClaims: 0, kernelStarts: 0, kernelStops: 0 };
        (window as ProbeWindow).quarantineProbe = state;
        const { persistentWebRouteLock, persistentWebRouteName } = await import(parameters.routeModule) as typeof import("../lib/init/persistent-web-route");
        const routeLock = persistentWebRouteLock("/", await persistentWebRouteName("/", parameters.name));
        const nativeRequest = navigator.locks.request.bind(navigator.locks);
        let armed = true;
        navigator.locks.request = (async (...arguments_: Parameters<LockManager["request"]>) => {
          const lockName = arguments_[0];
          if (armed && lockName === routeLock) {
            armed = false;
            state.barrierName = lockName;
            await new Promise<void>((complete, reject) => {
              state.releaseBarrier = parameters.outcome === "reject"
                ? () => reject(new Error("injected route barrier refusal")) : complete;
            });
          }
          return nativeRequest(...arguments_);
        }) as LockManager["request"];
        const nativePost = ServiceWorker.prototype.postMessage;
        ServiceWorker.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
          if ((message as { type?: unknown } | null)?.type === "init-bridge") state.bridgeClaims++;
          return Reflect.apply(nativePost, this, [message, options]);
        };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          private readonly kernelWorker: boolean;
          private stopped = false;
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.kernelWorker = String(url).includes("browser-kernel-worker-entry");
            if (this.kernelWorker) state.kernelStarts++;
          }
          override terminate(): void {
            if (this.kernelWorker && !this.stopped) {
              this.stopped = true;
              state.kernelStops++;
            }
            super.terminate();
          }
        };
        const { createLiveHost } = await import(parameters.liveModule) as typeof import("../pages/kandelo/kernel-host/live-setup");
        state.host = await createLiveHost({ vfsUrl: parameters.imageUrl, profile: "wordpress-mariadb",
          experimentalPersistenceName: parameters.name, experimentalPersistenceMode: "resizable" });
      }, { name, imageUrl, outcome, liveModule: `/@fs/${resolve(import.meta.dirname, "../pages/kandelo/kernel-host/live-setup.ts")}`,
        routeModule: `/@fs/${resolve(import.meta.dirname, "../lib/init/persistent-web-route.ts")}` });
      await page.waitForFunction(() => {
        const state = (window as ProbeWindow).quarantineProbe;
        return state.barrierName !== undefined || state.host?.getStatus() === "error";
      }, undefined, { timeout: 360_000, polling: 100 });
      const barrierName = await page.evaluate(() => (window as ProbeWindow).quarantineProbe.barrierName!);
      expect(barrierName).toBeTruthy();
      expect(await runtimeLeaseAvailable(observer, name)).toBe(false);
      if (outcome === "native-barrier") {
        await observer.evaluate(async lockName => {
          const state = window as Window & { heldRoute?: Promise<unknown>; releaseRoute?: () => void };
          let acquired!: () => void;
          const ready = new Promise<void>(resolve => { acquired = resolve; });
          let release!: () => void;
          const released = new Promise<void>(resolve => { release = resolve; });
          state.heldRoute = navigator.locks.request(lockName, { mode: "exclusive", ifAvailable: true }, async lock => {
            if (!lock) throw new Error("route barrier fixture could not acquire its native lock");
            state.releaseRoute = release;
            acquired();
            await released;
          });
          await Promise.race([ready, state.heldRoute]);
        }, barrierName);
      }
      await page.evaluate(() => {
        const state = (window as ProbeWindow).quarantineProbe;
        state.replacement = state.host!.applyBootDescriptor(state.host!.getBootDescriptor());
        state.releaseBarrier!();
      });
      if (outcome === "native-barrier") {
        await expect.poll(() => observer.evaluate(async lockName => {
          const snapshot = await navigator.locks.query();
          return snapshot.pending?.filter(lock => lock.name === lockName).length ?? 0;
        }, barrierName)).toBeGreaterThan(0);
        expect(await page.evaluate(() => (window as ProbeWindow).quarantineProbe.bridgeClaims)).toBe(1);
        expect(await page.evaluate(() => (window as ProbeWindow).quarantineProbe.kernelStarts)).toBe(1);
        expect(await page.evaluate(() => (window as ProbeWindow).quarantineProbe.kernelStops)).toBe(0);
        expect(await runtimeLeaseAvailable(observer, name)).toBe(false);
        await observer.evaluate(async () => {
          const state = window as Window & { heldRoute?: Promise<unknown>; releaseRoute?: () => void };
          state.releaseRoute!();
          await state.heldRoute;
        });
      }
      await page.evaluate(() => (window as ProbeWindow).quarantineProbe.replacement);
      if (outcome === "reject") {
        expect(await page.evaluate(() => (window as ProbeWindow).quarantineProbe.host!.getStatus())).toBe("error");
        expect(await page.evaluate(() => JSON.stringify((window as ProbeWindow).quarantineProbe.host!.dmesgHistory())))
          .toContain("persistent HTTP bridge ownership is uncertain");
        expect(await runtimeLeaseAvailable(observer, name)).toBe(false);
        await page.evaluate(() => (window as ProbeWindow).quarantineProbe.host!.reboot());
        await expect(page.evaluate(() => (window as ProbeWindow).quarantineProbe.host!.checkpointPersistentImage()))
          .rejects.toThrow("persistent HTTP bridge ownership is uncertain");
        expect(await runtimeLeaseAvailable(observer, name)).toBe(false);
      } else {
        await expect.poll(() => page.evaluate(() => (window as ProbeWindow).quarantineProbe.host!.getStatus()), { timeout: 180_000 }).toBe("running");
      }
      const evidence = await page.evaluate(() => {
        const state = (window as ProbeWindow).quarantineProbe;
        return { bridgeClaims: state.bridgeClaims, kernelStarts: state.kernelStarts, kernelStops: state.kernelStops,
          status: state.host!.getStatus(), logs: state.host!.dmesgHistory() };
      });
      expect(evidence.bridgeClaims).toBe(outcome === "reject" ? 1 : 2);
      expect(evidence.kernelStarts).toBe(outcome === "reject" ? 1 : 2);
      expect(evidence.kernelStops).toBeGreaterThanOrEqual(1);
      await testInfo.attach("persistent-boot-owner", { contentType: "application/json", body: JSON.stringify({ outcome, ...evidence }) });
      await page.close();
      await expect.poll(() => runtimeLeaseAvailable(observer, name)).toBe(true);
    } catch (error) {
      if (!page.isClosed()) {
        try {
          const evidence = await page.evaluate(() => {
            const state = (window as ProbeWindow).quarantineProbe;
            return state === undefined ? null : { barrierName: state.barrierName, bridgeClaims: state.bridgeClaims,
              kernelStarts: state.kernelStarts, kernelStops: state.kernelStops,
              status: state.host?.getStatus(), logs: state.host?.dmesgHistory() };
          });
          await testInfo.attach("persistent-boot-owner-failure", { contentType: "application/json", body: JSON.stringify(evidence) });
        } catch (diagnosticError) { console.error("Persistent boot ownership diagnostic failed", diagnosticError); }
      }
      throw error;
    } finally {
      if (!page.isClosed()) await page.close();
      await observer.close();
    }
  });
}
