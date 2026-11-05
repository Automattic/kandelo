import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { hostFileReadImage } from "../../../host/test/fixtures/host-file-read-image";
import { opfsTest as test } from "./support/opfs-page";

const repository = resolve(import.meta.dirname, "../../..");

for (const policy of ["crc32c", "sha256"] as const) {
  test(`${policy} OPFS whole-file read admission preserves ranges, symlinks, exec and recovery`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const directory = mkdtempSync(join(tmpdir(), "kandelo-browser-read-budget-"));
    try {
      const fixture = await hostFileReadImage(directory, policy);
      const imageUrl = new URL("/read-budget.img", baseURL).href;
      const kernelUrl = new URL("/read-budget-kernel.wasm", baseURL).href;
      await page.route(imageUrl, route => route.fulfill({ body: readFileSync(fixture.path) }));
      await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(join(repository,
        "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm")) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ imageUrl, kernelUrl, binding, kernelModule }) => {
        const { BrowserKernel } = await import(kernelModule) as typeof import("../../../host/src/browser-kernel-host");
        const root = await navigator.storage.getDirectory();
        const name = `read-budget-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        const file = await directory.getFileHandle("base", { create: true });
        const writer = await file.createWritable();
        await writer.write(await (await fetch(imageUrl)).arrayBuffer());
        await writer.close();
        const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
        let active: InstanceType<typeof BrowserKernel> | undefined;
        const boot = async (existing: boolean) => {
          active = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024,
            maxMemoryPages: 1024, maxWorkers: 1, memoryProfile: "constrained", maxVfsFileReadBytes: 1024 });
          await active.initFromOpfsImage({ kernelWasm, vfsImageFile: file, persistentImageBinding: binding,
            experimentalResizablePersistenceName: name, persistentComputerName: name,
            requireExistingRootfsPersistence: existing });
          return active;
        };
        const failures: string[] = [];
        const refused = async (kernel: InstanceType<typeof BrowserKernel>, path: string) => {
          try { await kernel.readFileFromVfs(path); failures.push("unexpected success"); }
          catch (error) { failures.push(String(error)); }
        };
        try {
          const first = await boot(false);
          const link = [...(await first.readFileFromVfs("/a"))!];
          const empty = (await first.readFileFromVfs("/empty"))!.length;
          const missing = await first.readFileFromVfs("/absent");
          const directoryResult = await first.readFileFromVfs("/bin");
          await refused(first, "/blocked");
          const range = [...(await first.readFileRangeFromVfs("/blocked", 0, 2051))!];
          await refused(first, "/bin/probe");
          const process = await first.spawnFromVfs("/bin/probe", ["persistence-overwrite"]);
          const code = await process.exit;
          const written = new TextDecoder().decode((await first.readFileFromVfs("/state"))!);
          await first.destroy();
          active = undefined;
          const second = await boot(true);
          const recovered = new TextDecoder().decode((await second.readFileFromVfs("/state"))!);
          const recoveredLink = [...(await second.readFileFromVfs("/a"))!];
          return { link, empty, missing, directoryResult, range, failures, code, written, recovered, recoveredLink };
        } finally {
          await active?.destroy();
          await root.removeEntry(name, { recursive: true });
          const overlay = await root.getDirectoryHandle("kandelo-persistent-overlay");
          for await (const filename of overlay.keys()) {
            if (filename.startsWith(`${name}.`)) await overlay.removeEntry(filename, { recursive: true });
          }
        }
      }, { imageUrl, kernelUrl, binding: fixture.binding,
        kernelModule: new URL(`/@fs/${join(repository, "host/src/browser-kernel-host.ts")}`, baseURL).href });
      expect(result.link).toEqual([...fixture.value]);
      expect(result.recoveredLink).toEqual([...fixture.value]);
      expect(result.range).toEqual([...fixture.large]);
      expect(result.empty).toBe(0);
      expect(result.missing).toBeNull();
      expect(result.directoryResult).toBeNull();
      expect(result.failures).toHaveLength(2);
      for (const failure of result.failures) {
        expect(failure).toContain("rootfs read failed:");
        expect(failure).toContain("errno 12");
        expect(failure).toContain("1024-byte memory allowance");
      }
      expect(result.code).toBe(0);
      expect(result.written).toBe("XYcdefgh");
      expect(result.recovered).toBe("XYcdefgh");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
