import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";

const repository = resolve(import.meta.dirname, "../../..");

for (const policy of ["crc32c", "sha256"] as const) {
  test(`Rust writes and checks a ${policy} OPFS image before real kernel restart`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const imageModuleUrl = new URL("/persistent-image-writer.wasm", baseURL).href;
    const kernelUrl = new URL("/persistent-image-writer-kernel.wasm", baseURL).href;
    await page.route(imageModuleUrl, route => route.fulfill({ body: readFileSync(resolve(repository, "local-binaries/kandelo_image_module_positioned32.wasm")) }));
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolve(repository, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm")) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ workerUrl, kernelModuleUrl, imageModuleUrl, kernelUrl, policy }) => {
      const root = await navigator.storage.getDirectory();
      const name = `persistent-writer-${crypto.randomUUID()}`;
      const directory = await root.getDirectoryHandle(name, { create: true });
      const file = await directory.getFileHandle("base", { create: true });
      const cancelFile = await directory.getFileHandle("cancelled", { create: true });
      const worker = new Worker(workerUrl, { type: "module" });
      const { BrowserKernel } = await import(kernelModuleUrl);
      let active: InstanceType<typeof BrowserKernel> | undefined;
      try {
        const moduleBytes = await (await fetch(imageModuleUrl)).arrayBuffer();
        const written = await new Promise<{
          error?: string; stack?: string;
          result: { payloadLength: number; physicalLength: number };
          binding: { identitySha256: string; dataCachePages: number; indexCachePages: number };
          phases: string[]; written: number; verified: number; value: string; mountedRead: number;
          progressCancelled: boolean; producerCancelled: boolean;
        }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Persistent image writer worker did not complete")), 90_000);
          worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.postMessage({ moduleBytes, file, cancelFile, policy }, [moduleBytes]);
        });
        if (written.error !== undefined) throw new Error(`${written.error}\n${written.stack}`);
        worker.terminate();
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const boot = async (requireExisting = false) => {
          active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained" });
          await active.initFromOpfsImage({ kernelWasm, vfsImageFile: file, persistentImageBinding: written.binding,
            experimentalResizablePersistenceName: name, persistentComputerName: name,
            requireExistingRootfsPersistence: requireExisting });
          return active;
        };
        const first = await boot();
        const initial = new TextDecoder().decode((await first.readFileFromVfs("/link"))!);
        await first.writeFileToVfs("/state", new TextEncoder().encode("persisted"), 0o640);
        await first.destroy();
        active = undefined;
        const second = await boot(true);
        const recovered = new TextDecoder().decode((await second.readFileFromVfs("/link"))!);
        await second.destroy();
        active = undefined;
        return { ...written, initial, recovered };
      } finally {
        worker.terminate();
        await active?.destroy();
        const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        for await (const filename of overlay.keys()) {
          if (filename.startsWith(`${name}.`)) await overlay.removeEntry(filename, { recursive: true });
        }
        await root.removeEntry(name, { recursive: true });
      }
    }, {
      workerUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/test/fixtures/persistent-image-writer-worker.ts")}`, baseURL).href,
      kernelModuleUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
      imageModuleUrl, kernelUrl, policy,
    });
    expect(result.phases).toEqual(["write", "verify"]);
    expect(result.progressCancelled).toBe(true);
    expect(result.producerCancelled).toBe(true);
    expect(result.written).toBe(result.result.payloadLength);
    expect(result.verified).toBe(result.result.payloadLength);
    expect(result.mountedRead).toBeLessThan(result.result.physicalLength / 2);
    expect(result.value).toBe("original");
    expect(result.initial).toBe("original");
    expect(result.recovered).toBe("persisted");
  });
}
