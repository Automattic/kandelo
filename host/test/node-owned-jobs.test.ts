import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { OwnedJobRead } from "../src/owned-jobs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const kernelPath = tryResolveBinary("kernel.wasm");
const programs = {
  "/bin/spawn-smoke": join(repoRoot, "examples/spawn-smoke.wasm"),
  "/bin/echo": join(repoRoot, "examples/echo.wasm"),
  "/bin/block-forever": join(repoRoot, "examples/block-forever.wasm"),
};
const havePrograms = Object.values(programs).every((path) => existsSync(path));
const haveKernel = kernelPath !== null;

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function createRootfs(): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
  fs.mkdir("/bin", 0o755);
  fs.mkdir("/tmp", 0o777);
  for (const [path, hostPath] of Object.entries(programs)) {
    const bytes = new Uint8Array(readFileSync(hostPath));
    const fd = fs.open(path, 0o1101 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
    try {
      expect(fs.write(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
    } finally {
      fs.close(fd);
    }
  }
  return fs.saveImage();
}

async function bootedHost(): Promise<NodeKernelHost> {
  const host = new NodeKernelHost({ rootfsImage: await createRootfs() });
  await host.init(asArrayBuffer(new Uint8Array(readFileSync(kernelPath!))));
  return host;
}

/** Poll one job until every member of its family has been observed to exit. */
async function awaitTermination(
  host: NodeKernelHost,
  jobId: string,
  timeoutMs = 20_000,
): Promise<Extract<OwnedJobRead, { expired: false }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const read = await host.readOwnedJob(jobId, 0, 65536);
    if (read.expired) throw new Error(`job ${jobId} output expired`);
    if (read.terminationObserved) return read;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} did not terminate: status ${read.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function decode(read: Extract<OwnedJobRead, { expired: false }>, stream: "stdout" | "stderr"): string {
  const parts = read.chunks.filter((chunk) => chunk.stream === stream);
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.bytes.length, 0));
  let index = 0;
  for (const part of parts) {
    bytes.set(part.bytes, index);
    index += part.bytes.length;
  }
  return new TextDecoder().decode(bytes);
}

describe.skipIf(!haveKernel || !havePrograms)("NodeKernelHost owned jobs", () => {
  it("records the output and exit status of a whole command family", async () => {
    const host = await bootedHost();
    try {
      await host.spawnFromVfs("/bin/spawn-smoke", ["spawn-smoke"], {
        ownedJob: { id: "family", timeoutMs: 30_000 },
      });
      const read = await awaitTermination(host, "family");
      expect(read.status).toBe("completed");
      expect(read.exitCode).toBe(0);
      // The posix_spawn child is owned too, so its stdout joins the job's.
      expect(decode(read, "stdout")).toContain("spawned-ok");
      expect(decode(read, "stdout")).toContain("OK");
    } finally {
      await host.destroy();
    }
  }, 60_000);

  it("cancels a family whose child would otherwise block forever", async () => {
    const host = await bootedHost();
    try {
      await host.spawnFromVfs(
        "/bin/spawn-smoke",
        ["spawn-smoke", "/bin/block-forever"],
        { ownedJob: { id: "blocked", timeoutMs: 30_000 } },
      );
      const cancelled = await host.readOwnedJob("blocked", 0, 4096, true);
      expect(cancelled.expired).toBe(false);
      const read = await awaitTermination(host, "blocked");
      expect(read.status).toBe("cancelled");
    } finally {
      await host.destroy();
    }
  }, 60_000);

  it("enforces the timeout even when nothing reads the job", async () => {
    const host = await bootedHost();
    try {
      await host.spawnFromVfs("/bin/block-forever", ["block-forever"], {
        ownedJob: { id: "slow", timeoutMs: 500 },
      });
      const read = await awaitTermination(host, "slow");
      expect(read.status).toBe("timed_out");
    } finally {
      await host.destroy();
    }
  }, 60_000);

  it("reports an unknown job rather than an empty one", async () => {
    const host = await bootedHost();
    try {
      await expect(host.readOwnedJob("absent")).rejects.toThrow("UNKNOWN_JOB");
    } finally {
      await host.destroy();
    }
  }, 60_000);
});

describe.skipIf(!haveKernel || !havePrograms)("NodeKernelHost raw VFS surface", () => {
  it("lists a directory with the values the VFS holds", async () => {
    const host = await bootedHost();
    try {
      const entries = await host.readDirFromVfs("/bin");
      expect(entries).not.toBeNull();
      const echo = entries!.find((entry) => entry.name === "echo");
      expect(echo).toBeDefined();
      expect(echo!.mode & 0o777).toBe(0o755);
      expect(echo!.size).toBeGreaterThan(0);
      expect(await host.readDirFromVfs("/absent")).toBeNull();
    } finally {
      await host.destroy();
    }
  }, 60_000);

  it("refuses an exclusive write to a path that already exists", async () => {
    const host = await bootedHost();
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      await host.writeFileToVfs("/tmp/created", bytes, 0o644, true);
      expect(await host.readFileFromVfs("/tmp/created")).toEqual(bytes);
      await expect(
        host.writeFileToVfs("/tmp/created", bytes, 0o644, true),
      ).rejects.toThrow(/EEXIST|exists/i);
      await host.writeFileToVfs("/tmp/created", new Uint8Array([4]), 0o644);
      expect(await host.readFileFromVfs("/tmp/created")).toEqual(new Uint8Array([4]));
    } finally {
      await host.destroy();
    }
  }, 60_000);
});
