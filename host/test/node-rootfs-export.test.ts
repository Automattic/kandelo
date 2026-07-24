import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const kernelPath = tryResolveBinary("kernel.wasm");
const blockForeverPath = join(repoRoot, "examples/block-forever.wasm");
const haveKernel = kernelPath !== null;
const haveBlockForever = existsSync(blockForeverPath);

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function writeFile(
  fs: MemoryFileSystem,
  path: string,
  bytes: Uint8Array,
  mode = 0o644,
): void {
  const fd = fs.open(path, 0o1101 /* O_WRONLY|O_CREAT|O_TRUNC */, mode);
  try {
    expect(fs.write(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
  } finally {
    fs.close(fd);
  }
}

function readFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
  } finally {
    fs.close(fd);
  }
  return bytes;
}

async function createRootfs(): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  fs.mkdir("/var", 0o755);
  fs.mkdir("/var/lib", 0o755);
  writeFile(
    fs,
    "/var/lib/persisted-state",
    new TextEncoder().encode("survives reboot\n"),
    0o640,
  );
  fs.registerLazyFile(
    "/opt/lazy-tool",
    "https://packages.example.test/lazy-tool.wasm",
    123_456,
    0o755,
  );
  return fs.saveImage();
}

describe("NodeKernelHost rootfs export contract", () => {
  it("rejects export before initialization without starting a worker", async () => {
    const host = new NodeKernelHost({ rootfsImage: new Uint8Array() });
    await expect(host.exportRootfsImage()).rejects.toThrow(
      "rootfs export requires an initialized kernel",
    );
    await expect(host.destroy()).resolves.toBeUndefined();
  });

  it.skipIf(!haveKernel)(
    "rejects a host-filesystem kernel because it has no VFS image",
    async () => {
      const host = new NodeKernelHost();
      try {
        await host.init(asArrayBuffer(new Uint8Array(readFileSync(kernelPath!))));
        await expect(host.exportRootfsImage()).rejects.toThrow(
          "rootfs export requires a VFS-backed kernel",
        );
      } finally {
        await host.destroy();
      }
    },
  );

  it.skipIf(!haveKernel)(
    "transfers exact bytes, preserves lazy descriptors, and reboots from the export",
    async () => {
      const kernel = new Uint8Array(readFileSync(kernelPath!));
      const initialImage = await createRootfs();
      const first = new NodeKernelHost({ rootfsImage: initialImage });
      let exported: Uint8Array;
      try {
        await first.init(asArrayBuffer(kernel));
        exported = await first.exportRootfsImage();
      } finally {
        await first.destroy();
      }

      expect(exported).toBeInstanceOf(Uint8Array);
      const restored = MemoryFileSystem.fromImage(exported);
      expect(new TextDecoder().decode(
        readFile(restored, "/var/lib/persisted-state"),
      )).toBe("survives reboot\n");
      expect(restored.stat("/var/lib/persisted-state").mode & 0o7777).toBe(0o640);
      expect(restored.exportLazyEntries()).toEqual([expect.objectContaining({
        path: "/opt/lazy-tool",
        url: "https://packages.example.test/lazy-tool.wasm",
        size: 123_456,
      })]);

      const rebooted = new NodeKernelHost({ rootfsImage: exported });
      try {
        await rebooted.init(asArrayBuffer(kernel));
        const afterReboot = await rebooted.exportRootfsImage();
        const afterRebootFs = MemoryFileSystem.fromImage(afterReboot);
        expect(new TextDecoder().decode(
          readFile(afterRebootFs, "/var/lib/persisted-state"),
        )).toBe("survives reboot\n");
        expect(afterRebootFs.exportLazyEntries()).toEqual([
          expect.objectContaining({
            path: "/opt/lazy-tool",
            url: "https://packages.example.test/lazy-tool.wasm",
            size: 123_456,
          }),
        ]);
      } finally {
        await rebooted.destroy();
      }
    },
  );

  it.skipIf(!haveKernel || !haveBlockForever)(
    "rejects live and tearing-down processes without racing a snapshot",
    async () => {
      const kernel = new Uint8Array(readFileSync(kernelPath!));
      const program = new Uint8Array(readFileSync(blockForeverPath));
      const host = new NodeKernelHost({ rootfsImage: await createRootfs() });
      try {
        await host.init(asArrayBuffer(kernel));
        let startedPid = -1;
        const exit = host.spawn(asArrayBuffer(program), ["block-forever"], {
          onStarted: (pid) => {
            startedPid = pid;
          },
        });
        for (let tries = 0; startedPid < 0 && tries < 100; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(startedPid).toBeGreaterThan(0);

        await expect(host.exportRootfsImage()).rejects.toThrow(
          "no live or tearing-down processes",
        );

        const terminating = host.terminateProcess(startedPid, 143);
        await expect(host.exportRootfsImage()).rejects.toThrow(
          "no live or tearing-down processes",
        );
        await terminating;
        await expect(exit).resolves.toBe(143);
        await expect(host.exportRootfsImage()).resolves.toBeInstanceOf(Uint8Array);
      } finally {
        await host.destroy();
      }
    },
  );
});
