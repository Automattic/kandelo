import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { ERRNO } from "../../../host/src/generated/abi";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { opfsTest as test } from "./support/opfs-page";

const repository = resolve(import.meta.dirname, "../../..");
const source = KandeloImageFs.create(new Uint8Array(readFileSync(resolve(repository, "local-binaries/kandelo_image_module32.wasm"))));
source.writeFile("/state", new TextEncoder().encode("original"), 0o640);
source.writeFile("/large", new Uint8Array(512 * 1024 + 17).fill(73), 0o600);
const rawImage = source.exportImage();
source.reset();

test("browser image binding selection uses bounded Rust policy without a filesystem image", async ({ page, baseURL }) => {
  const codecWasmUrl = new URL("/binding-policy-module.wasm", baseURL).href;
  await page.route(codecWasmUrl, route => route.fulfill({ body: readFileSync(resolve(repository, "local-binaries/kandelo_image_module_positioned32.wasm")) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ codecUrl, bindingUrl, codecWasmUrl }) => {
    const { runPersistentImageControl } = await import(codecUrl) as typeof import("../pages/kandelo/kernel-host/persistent-image-codec");
    const { selectImageBinding, validateImageBindingState, UnprovenImageFreshnessError } = await import(bindingUrl) as typeof import("../../../host/src/vfs/image-binding-state");
    const moduleBytes = new Uint8Array(await (await fetch(codecWasmUrl)).arrayBuffer());
    let requests = 0;
    const call = async (operation: 19 | 20, input: Uint8Array) => {
      if (input.length !== 64) throw new Error("Unbounded image binding evidence");
      requests++;
      return runPersistentImageControl(moduleBytes, operation, input);
    };
    const source = { version: 6, generation: 3, initialized: true, digest: "source", content: "source" };
    const target = { ...source, generation: 4, digest: "target", content: "target" };
    const prepared = { phase: "prepared" as const, source, target };
    const active = { phase: "active" as const, target };
    const selections = [
      await selectImageBinding(call, source, prepared),
      await selectImageBinding(call, null, prepared),
      await selectImageBinding(call, target, prepared),
      await selectImageBinding(call, source, active),
      await selectImageBinding(call, target, active),
      await selectImageBinding(call, { ...target, generation: 5 }, prepared),
      await selectImageBinding(call, null, null),
    ];
    await validateImageBindingState(call, prepared);
    const refused: boolean[] = [];
    for (const binding of [
      { ...active, target: { ...target, version: 5 } },
      { ...active, target: { ...target, generation: Number.MAX_SAFE_INTEGER + 1 } },
      { ...prepared, target: { ...target, generation: 5 } },
    ]) {
      try { await selectImageBinding(call, source, binding); refused.push(false); }
      catch (error) { refused.push(error instanceof UnprovenImageFreshnessError); }
    }
    return { selections, refused, requests, moduleLength: moduleBytes.length };
  }, {
    codecUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec.ts")}`, baseURL).href,
    bindingUrl: new URL(`/@fs/${resolve(repository, "host/src/vfs/image-binding-state.ts")}`, baseURL).href,
    codecWasmUrl,
  });
  expect(result.selections).toEqual([
    { choice: "source", repair: true }, { choice: "source", repair: true },
    { choice: "target", repair: true }, { choice: "target", repair: true },
    { choice: "target", repair: false }, { choice: "primary", repair: true },
    { choice: "empty", repair: false },
  ]);
  expect(result.refused).toEqual([true, true, true]);
  expect(result.requests).toBe(11);
  expect(result.moduleLength).toBeGreaterThan(0);
});

for (const policy of ["crc32c", "sha256"] as const) {
  test(`browser codec publishes a closed ${policy} OPFS target before kernel reuse`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const rawUrl = new URL("/codec-source.vfs", baseURL).href;
    const codecWasmUrl = new URL("/codec-module.wasm", baseURL).href;
    const kernelUrl = new URL("/codec-kernel.wasm", baseURL).href;
    await page.route(rawUrl, route => route.fulfill({ body: Buffer.from(rawImage) }));
    await page.route(codecWasmUrl, route => route.fulfill({ body: readFileSync(resolve(repository, "local-binaries/kandelo_image_module_positioned32.wasm")) }));
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ codecModuleUrl, kernelModuleUrl, rawUrl, codecWasmUrl, kernelUrl, policy, payloadLength }) => {
      const codec = await import(codecModuleUrl);
      const { BrowserKernel } = await import(kernelModuleUrl);
      const moduleBytes = new Uint8Array(await (await fetch(codecWasmUrl)).arrayBuffer());
      const root = await navigator.storage.getDirectory();
      const name = `codec-${crypto.randomUUID()}`;
      const directory = await root.getDirectoryHandle(name, { create: true });
      const file = await directory.getFileHandle("base", { create: true });
      let active: InstanceType<typeof BrowserKernel> | undefined;
      try {
        const response = await fetch(rawUrl);
        const reader = response.body!.getReader();
        async function* chunks() {
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) return;
              for (let offset = 0; offset < next.value.length; offset += 65536) yield next.value.subarray(offset, offset + 65536);
            }
          } finally { await reader.cancel(); reader.releaseLock(); }
        }
        const progress: Array<{ phase: string; bytes: number; total: number }> = [];
        const written = await codec.writePersistentImageFile(file, moduleBytes, payloadLength, policy, chunks(), {
          onProgress: (update: { phase: string; bytes: number; total: number }) => { progress.push(update); },
        });
        const geometry = await codec.inspectPersistentImageFile(file, moduleBytes, written.physicalLength, written.identitySha256, policy);
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        const boot = async (requireExisting = false) => {
          active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024, memoryProfile: "constrained" });
          await active.initFromOpfsImage({ kernelWasm, vfsImageFile: file,
            persistentImageBinding: { identitySha256: written.identitySha256, dataCachePages: 1, indexCachePages: 1 },
            experimentalResizablePersistenceName: name, persistentComputerName: name,
            requireExistingRootfsPersistence: requireExisting });
          return active;
        };
        const first = await boot();
        const concurrentInspection = await codec.inspectPersistentImageFile(file, moduleBytes, written.physicalLength, written.identitySha256, policy);
        await first.writeFileToVfs("/state", new TextEncoder().encode("persisted"), 0o640);
        await first.destroy();
        active = undefined;
        const second = await boot(true);
        const recovered = new TextDecoder().decode((await second.readFileFromVfs("/state"))!);
        await second.destroy();
        active = undefined;
        let wrongPolicyErrno: number | undefined;
        try {
          await codec.inspectPersistentImageFile(file, moduleBytes, written.physicalLength, written.identitySha256,
            policy === "crc32c" ? "sha256" : "crc32c");
        } catch (error) { wrongPolicyErrno = (error as { errno?: number }).errno; }
        return { geometry, concurrentInspection, written, progress, recovered, wrongPolicyErrno, moduleLength: moduleBytes.length };
      } finally {
        await active?.destroy();
        const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        for await (const filename of overlay.keys()) {
          if (filename.startsWith(`${name}.`)) await overlay.removeEntry(filename, { recursive: true });
        }
        await root.removeEntry(name, { recursive: true });
      }
    }, {
      codecModuleUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec.ts")}`, baseURL).href,
      kernelModuleUrl: new URL(`/@fs/${resolve(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href,
      rawUrl, codecWasmUrl, kernelUrl, policy, payloadLength: rawImage.length,
    });
    expect(result.geometry.payloadLength).toBe(rawImage.length);
    expect(result.concurrentInspection).toEqual(result.geometry);
    expect(result.recovered).toBe("persisted");
    expect(result.wrongPolicyErrno).toBe(ERRNO.EINVAL);
    expect(result.moduleLength).toBeGreaterThan(0);
    expect(result.progress.filter(update => update.phase === "write").at(-1)?.bytes).toBe(rawImage.length);
    expect(result.progress.filter(update => update.phase === "verify").at(-1)?.bytes).toBe(rawImage.length);
    expect(result.progress.length).toBeLessThanOrEqual(2 * Math.ceil(rawImage.length / (1024 * 1024)) + 4);
  });
}

test("browser codec closes cancelled progress and input operations before retrying their OPFS target", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const codecWasmUrl = new URL("/codec-cancel-module.wasm", baseURL).href;
  await page.route(codecWasmUrl, route => route.fulfill({ body: readFileSync(resolve(repository, "local-binaries/kandelo_image_module_positioned32.wasm")) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ codecModuleUrl, codecWasmUrl }) => {
    const codec = await import(codecModuleUrl);
    const moduleBytes = new Uint8Array(await (await fetch(codecWasmUrl)).arrayBuffer());
    const root = await navigator.storage.getDirectory();
    const name = `codec-cancel-${crypto.randomUUID()}`;
    const directory = await root.getDirectoryHandle(name, { create: true });
    const file = await directory.getFileHandle("target", { create: true });
    try {
      let cancelled = 0;
      for (const phase of ["progress", "input"] as const) {
        const controller = new AbortController();
        const chunks = phase === "progress" ? [new Uint8Array(31)] : {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              setTimeout(() => controller.abort(), 0);
              return new Promise<IteratorResult<Uint8Array>>(() => {});
            },
            return: async () => ({ done: true as const, value: undefined }),
          }),
        };
        try {
          await codec.writePersistentImageFile(file, moduleBytes, 31, "sha256", chunks, {
            signal: controller.signal,
            ...(phase === "progress" ? { onProgress: () => {
              setTimeout(() => controller.abort(), 0);
              return new Promise<void>(() => {});
            } } : {}),
          });
        } catch (error) {
          if ((error as Error).name !== "AbortError") throw error;
          cancelled++;
        }
        const reset = await file.createWritable();
        await reset.truncate(0);
        await reset.close();
      }
      const written = await codec.writePersistentImageFile(file, moduleBytes, 31, "crc32c", [new Uint8Array(31)]);
      const inspected = await codec.inspectPersistentImageFile(file, moduleBytes, written.physicalLength, written.identitySha256, "crc32c");
      return { cancelled, inspected };
    } finally { await root.removeEntry(name, { recursive: true }); }
  }, { codecModuleUrl: new URL(`/@fs/${resolve(repository, "apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec.ts")}`, baseURL).href, codecWasmUrl });
  expect(result.cancelled).toBe(2);
  expect(result.inspected.payloadLength).toBe(31);
});
