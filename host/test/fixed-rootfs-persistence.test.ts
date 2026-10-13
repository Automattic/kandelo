import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";

const directKernelPath = join(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/kandelo_kernel.wasm");
const directImageModulePath = join(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/kandelo_image_module.wasm");
const publishedImageModulePath = join(import.meta.dirname, "../../local-binaries/kandelo_image_module32.wasm");
const kernelPath = existsSync(directKernelPath) ? directKernelPath : tryResolveBinary("kernel.wasm");
const imageModulePath = [publishedImageModulePath, directImageModulePath].find((path) => {
  if (!existsSync(path)) return false;
  return WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(path))).length === 0;
}) ?? null;
const guestProgramPath = tryResolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm");
const guestProgramName = "/bin/persistence-overwrite";
const encoder = new TextEncoder();

async function makeImage(state: string): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  if (guestProgramPath !== null) {
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile(guestProgramName, new Uint8Array(readFileSync(guestProgramPath)), 0o755);
  }
  filesystem.writeFile("/state", encoder.encode(state), 0o644);
  return filesystem.saveImage();
}

async function boot(image: Uint8Array, path: string): Promise<NodeKernelHost> {
  const host = new NodeKernelHost({
    rootfsImage: image,
    experimentalFixedPersistencePath: path,
  });
  const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
  try {
    await host.init(kernelBytes.buffer.slice(
      kernelBytes.byteOffset,
      kernelBytes.byteOffset + kernelBytes.byteLength,
    ) as ArrayBuffer);
    return host;
  } catch (error) {
    await host.destroy();
    throw error;
  }
}

describe.skipIf(kernelPath === null || imageModulePath === null)("fixed rootfs persistence", () => {
  it("boots read-only, rejects incompatible images and concurrent writers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      const host = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await host.readFileFromVfs("/state"))!)).toBe("abcdefgh");
        await expect(host.writeFileToVfs("/state", encoder.encode("new"))).rejects.toThrow();
        await expect(host.writeFileToVfs("/new", encoder.encode("new"))).rejects.toThrow();
        await expect(boot(image, path)).rejects.toThrow();
      } finally {
        await host.destroy();
      }
      const recovered = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("abcdefgh");
      } finally {
        await recovered.destroy();
      }
      await expect(boot(await makeImage("different"), path)).rejects.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("replays a guest overwrite after a worker restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      const host = await boot(image, path);
      try {
        const { exit } = await host.spawnFromVfs(guestProgramName, ["persistence-overwrite"]);
        expect(await exit).toBe(0);
        expect(new TextDecoder().decode((await host.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await host.destroy();
      }
      const recovered = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await recovered.destroy();
      }
      const committed = readFileSync(path);
      appendFileSync(path, Buffer.from("KTXN"));
      const afterTail = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await afterTail.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await afterTail.destroy();
      }
      expect(readFileSync(path)).toEqual(committed);
      const damaged = readFileSync(path);
      damaged[damaged.length - 37] ^= 1;
      writeFileSync(path, damaged);
      await expect(boot(image, path)).rejects.toThrow(/errno 5/);
      expect(readFileSync(path)).toEqual(damaged);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
