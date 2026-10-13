import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDirectory, "../../..");
const directKernelPath = resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm");
const publishedKernelPath = resolve(repoRoot, "local-binaries/kernel.wasm");
const kernelPath = [directKernelPath, publishedKernelPath].find(existsSync) ?? null;
const directImageModulePath = resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_image_module.wasm");
const publishedImageModulePath = resolve(repoRoot, "local-binaries/kandelo_image_module32.wasm");
const imageModulePath = [publishedImageModulePath, directImageModulePath].find((path) => {
  if (!existsSync(path)) return false;
  return WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(path))).length === 0;
}) ?? null;
const browserKernelPath = resolve(repoRoot, "host/src/browser-kernel-host.ts");
const guestProgramPath = tryResolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm");

test.skip(kernelPath === null || imageModulePath === null, "kernel and standalone image module artifacts are required");
test.skip(guestProgramPath === null, "persistence guest fixture is required");

test("browser kernel mounts a named OPFS journal and reopens it after destroy", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
  const cacheProbe = Uint8Array.from({ length: 5 * 1024 * 1024 }, (_, index) => index % 251);
  filesystem.writeFile("/cache-probe", cacheProbe, 0o644);
  const image = await filesystem.saveImage();
  const kernelUrl = new URL("/fixed-rootfs-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/fixed-rootfs-image.vfs", baseURL).href;
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-browser-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);

      const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const imageBytes = new Uint8Array(await (await fetch(imageUrl)).arrayBuffer());
        const name = `fixed-rootfs-${crypto.randomUUID()}`;
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
        const imageWriter = await imageFile.createWritable();
        await imageWriter.write(imageBytes);
        await imageWriter.close();
        const control = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await control.initFromImage({ kernelWasm: kernelBytes, vfsImage: imageBytes });
        } catch (error) {
          throw new Error(`control boot: ${error}`);
        } finally {
          await control.destroy();
        }
        const open = async (phase: string) => {
          const kernel = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await kernel.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
          } catch (error) {
            throw new Error(`${phase}: ${error}`);
          }
          return kernel;
        };
        const first = await open("first boot");
        let initial: string;
        let written: string;
        let cacheProbeMatches: boolean;
        let rejected = false;
        let locked = false;
        try {
          initial = new TextDecoder().decode(await first.readFileFromVfs("/state"));
          const cacheProbe = await first.readFileFromVfs("/cache-probe");
          cacheProbeMatches = cacheProbe?.byteLength === 5 * 1024 * 1024
            && cacheProbe[0] === 0
            && cacheProbe[64 * 1024 + 1] === (64 * 1024 + 1) % 251
            && cacheProbe[cacheProbe.byteLength - 1] === (cacheProbe.byteLength - 1) % 251;
          const competing = new BrowserKernel({ kernelOwnedFs: true });
          try {
            await competing.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
          } catch {
            locked = true;
          } finally {
            await competing.destroy();
          }
          try {
            await first.writeFileToVfs("/state", new TextEncoder().encode("changed"));
          } catch {
            rejected = true;
          }
          const { exit } = await first.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "unsynced"]);
          if (await exit !== 0) throw new Error("guest overwrite failed");
          written = new TextDecoder().decode(await first.readFileFromVfs("/state"));
        } finally {
          await first.destroy();
        }
        const second = await open("second boot");
        try {
          return {
            initial,
            written,
            locked,
            rejected,
            cacheProbeMatches,
            recovered: new TextDecoder().decode(await second.readFileFromVfs("/state")),
          };
        } finally {
          await second.destroy();
        }
      }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, imageUrl });
      expect(result).toEqual({ initial: "abcdefgh", written: "XYcdefgh", locked: true, rejected: true, cacheProbeMatches: true, recovered: "XYcdefgh" });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("browser termination loses unsynced writes without damaging the last durable image", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"), 0o644);
  const image = await filesystem.saveImage();
  const kernelUrl = new URL("/fixed-crash-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/fixed-crash-image.vfs", baseURL).href;
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-fixed-crash-browser-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(kernelPath!) }));
      await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const before = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const imageBytes = new Uint8Array(await (await fetch(imageUrl)).arrayBuffer());
        const name = `fixed-crash-${crypto.randomUUID()}`;
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
        const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
        const writer = await imageFile.createWritable();
        await writer.write(imageBytes);
        await writer.close();
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        await kernel.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
        const { exit } = await kernel.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", "unsynced"]);
        if (await exit !== 0) throw new Error("guest overwrite failed");
        (window as unknown as { crashKernel: unknown }).crashKernel = kernel;
        return { name, visible: new TextDecoder().decode(await kernel.readFileFromVfs("/state")) };
      }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, imageUrl });
      expect(before.visible).toBe("XYcdefgh");
      await page.reload();
      const recovered = await page.evaluate(async ({ moduleUrl, kernelUrl, name }) => {
        const { BrowserKernel } = await import(moduleUrl);
        const kernelBytes = await (await fetch(kernelUrl)).arrayBuffer();
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
        const imageFile = await directory.getFileHandle(`${name}.base`);
        const kernel = new BrowserKernel({ kernelOwnedFs: true });
        try {
          await kernel.initFromOpfsImage({ kernelWasm: kernelBytes, vfsImageFile: imageFile, experimentalFixedPersistenceName: name });
          return new TextDecoder().decode(await kernel.readFileFromVfs("/state"));
        } finally {
          await kernel.destroy();
        }
      }, { moduleUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href, kernelUrl, name: before.name });
      expect(recovered).toBe("abcdefgh");
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
