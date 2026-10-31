import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import { withSparseFileLength } from "../../../host/test/fixtures/sparse-composer-file-image";
import { parseKandeloDemoConfig } from "../../../web-libs/kandelo-session/src/demo-config";
import { parseExperimentalTerminalSession } from "../../../web-libs/kandelo-session/src/experimental-terminal-session";
import { opfsTest as test } from "./support/opfs-page";

const repoRoot = resolve(import.meta.dirname, "../../..");

for (const path of ["/etc/kandelo/demo.json", "/etc/kandelo/experimental-terminal-session.json", "/etc/dinit.d/boot"]) {
  test(`persistent boot validation bounds a sparse metadata file (${path})`, async ({ page, baseURL }) => {
    const kernelPath = tryResolveBinary("kernel.wasm");
    if (kernelPath === null) throw new Error("Kernel artifact is required");
    const composition = {
      imageConfig: parseKandeloDemoConfig(JSON.stringify({ version: 1, defaultProfile: "probe",
        profiles: { probe: { init: { target: "boot" } } } }))!,
      profileId: "probe",
      terminalSession: parseExperimentalTerminalSession(JSON.stringify({ kind: "kandelo-experimental-terminal-session", version: 1,
        initial: { path: "/bin/true", argv: ["true"], uid: 0, gid: 0 } })),
      requiredServices: ["boot"],
    };
    const filesystem = KandeloImageFs.create();
    filesystem.setImageCapacity(128 * 1024 * 1024);
    filesystem.mkdir("/etc", 0o755);
    filesystem.mkdir("/etc/kandelo", 0o755);
    filesystem.mkdir("/etc/dinit.d", 0o755);
    filesystem.writeFile("/etc/kandelo/demo.json", new TextEncoder().encode(JSON.stringify(composition.imageConfig)));
    filesystem.writeFile("/etc/kandelo/experimental-terminal-session.json", new TextEncoder().encode(JSON.stringify(composition.terminalSession)));
    filesystem.writeFile("/etc/dinit.d/boot", new TextEncoder().encode("type = process\ncommand = /bin/true\n"));
    const image = withSparseFileLength(filesystem.exportImage(), path, 8 * 1024 ** 3);
    const imageUrl = new URL("/sparse-boot-metadata.vfs", baseURL).href;
    const kernelUrl = new URL("/sparse-boot-metadata-kernel.wasm", baseURL).href;
    await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(kernelPath) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ imageUrl, kernelUrl, kernelModule, checkpointModule, composition }) => {
      const { BrowserKernel } = await import(kernelModule);
      const { assertPersistentImageBootMetadata } = await import(checkpointModule);
      const root = await navigator.storage.getDirectory();
      const name = `boot-metadata-${crypto.randomUUID()}`;
      const directory = await root.getDirectoryHandle(name, { create: true });
      const file = await directory.getFileHandle("source", { create: true });
      const writer = await file.createWritable();
      await writer.write(await (await fetch(imageUrl)).arrayBuffer());
      await writer.close();
      const kernel = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024 });
      try {
        await kernel.initFromOpfsImage({ kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
          vfsImageFile: file, experimentalResizablePersistenceName: name, persistentComputerName: name });
        const pagesBefore = await kernel.getKernelMemoryPages();
        kernel.readFileFromVfs = async () => { throw new Error("Unbounded metadata read"); };
        const ranges: number[] = [];
        const read = kernel.readFileRangeFromVfs.bind(kernel);
        kernel.readFileRangeFromVfs = async (...args: [string, number, number]) => {
          ranges.push(args[2]);
          return read(...args);
        };
        let failure = "";
        try { await assertPersistentImageBootMetadata(kernel, composition); }
        catch (error) { failure = String(error); }
        return { failure, ranges, pagesBefore, pagesAfter: await kernel.getKernelMemoryPages() };
      } finally {
        await kernel.destroy();
        await root.removeEntry(name, { recursive: true });
      }
    }, { imageUrl, kernelUrl, composition,
      kernelModule: new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL).href,
      checkpointModule: new URL(`/@fs/${resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/persistent-image-checkpoint.ts")}`, baseURL).href });
    expect(result.failure).toContain(path.endsWith("demo.json") ? "boot configuration changed" :
      path.endsWith("session.json") ? "terminal session changed" : "exceeds 65536 bytes");
    expect(Math.max(...result.ranges)).toBeLessThanOrEqual(256 * 1024 + 1);
    expect(result.pagesAfter).toBeLessThanOrEqual(1024);
    expect(result.pagesAfter - result.pagesBefore).toBeLessThanOrEqual(32);
  });
}
