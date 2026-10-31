import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";
import { httpRetirementImage } from "../../../host/test/fixtures/http-retirement-image";
import { resolveBinary } from "../../../host/src/binary-resolver";

test("persistent OPFS HTTP timeout waves release unaccepted ownership and preserve accepted peers", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120000);
  const directory = mkdtempSync(join(tmpdir(), "kandelo-opfs-http-retirement-"));
  let retainFixture = false;
  try {
    const image = await httpRetirementImage(directory);
    const kernelUrl = new URL("/http-retirement-kernel.wasm", baseURL).href;
    const imageUrl = new URL("/http-retirement-base.img", baseURL).href;
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
    await page.route(imageUrl, route => route.fulfill({ body: readFileSync(image.path) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async parameters => {
      const { BrowserKernel } = await import(parameters.kernelModule) as typeof import("../../../host/src/browser-kernel-host");
      const { exerciseHttpRetirement, HttpRetirementTranscript } = await import(parameters.workloadModule) as typeof import("../../../host/test/fixtures/http-retirement-workload");
      const transcript = new HttpRetirementTranscript();
      const root = await navigator.storage.getDirectory();
      const name = `http-retirement-${crypto.randomUUID()}`;
      const storage = await root.getDirectoryHandle(name, { create: true });
      const base = await storage.getFileHandle("base.img", { create: true });
      const response = await fetch(parameters.imageUrl);
      if (!response.ok || response.body === null) throw new Error("HTTP retirement base download failed");
      await response.body.pipeTo(await base.createWritable());
      const kernel = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024,
        maxWorkers: 1, memoryProfile: "constrained", onStdout: bytes => transcript.append(bytes),
        onStderr: bytes => transcript.append(bytes) });
      let clean = false;
      try {
        const kernelWasm = await (await fetch(parameters.kernelUrl)).arrayBuffer();
        await kernel.initFromOpfsImage({ kernelWasm, vfsImageFile: base, persistentImageBinding: parameters.binding,
          experimentalResizablePersistenceName: name, persistentComputerName: name });
        const bytes = await kernel.readFileFromVfs("/bin/http-retirement");
        if (bytes === null) throw new Error("HTTP retirement guest missing from mounted image");
        let started!: (pid: number) => void;
        const ready = new Promise<number>(resolve => { started = resolve; });
        const exited = kernel.spawn(bytes.buffer as ArrayBuffer, ["http-retirement", "8097"], { onStarted: started });
        const pid = await Promise.race([ready, exited.then(code => { throw new Error(`HTTP retirement guest exited before admission (${code})`); })]);
        const result = await exerciseHttpRetirement(kernel, pid, transcript, 8097);
        const code = await exited;
        if (code !== 0) throw new Error(`HTTP retirement guest failed (${code}): ${transcript.text}`);
        return { ...result, pages: await kernel.getKernelMemoryPages(), transcript: transcript.text };
      } finally {
        await kernel.destroy();
        clean = !kernel.hasUnconfirmedKernelQuiescence() && kernel.getPersistenceShutdownFailure() === null;
        if (clean) await root.removeEntry(name, { recursive: true });
        else throw new Error(`Retained HTTP retirement storage after uncertain close: ${name}`);
      }
    }, { kernelUrl, imageUrl, binding: image.binding,
      kernelModule: `/@fs/${resolve(import.meta.dirname, "../../../host/src/browser-kernel-host.ts")}`,
      workloadModule: `/@fs/${resolve(import.meta.dirname, "../../../host/test/fixtures/http-retirement-workload.ts")}` });
    expect(result.waves).toBe(12);
    expect(result.pages).toBeLessThanOrEqual(1024);
    await testInfo.attach("http-retirement-memory", { contentType: "application/json", body: JSON.stringify(result) });
  } catch (error) {
    retainFixture = error !== null && typeof error === "object" && (error as { retainTarget?: boolean }).retainTarget === true;
    throw error;
  } finally {
    if (!retainFixture) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained HTTP retirement fixture after uncertain close: ${directory}`);
  }
});
