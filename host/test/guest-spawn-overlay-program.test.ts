/**
 * Regression: a GUEST-initiated spawn (posix_spawn / popen / system, and the
 * PHP popen/proc_open/shell_exec that build on them) must be able to launch a
 * program whose bytes live in the in-kernel rootfs (the sole `/` authority).
 *
 * What this pins: SYS_SPAWN of a program that exists only in the in-kernel
 * overlay. A host-side resolver that read the child's bytes through an
 * immediate kernel entry inside the spawn's protocol transaction once failed
 * with `KernelReentrantEntryError`, surfacing as `posix_spawn` -> EIO and
 * breaking PHP-FPM/nginx/WordPress worker spawning. The kernel now resolves
 * the target itself, inside `kernel_spawn_process`.
 *
 * This boots the real Node kernel worker (the path that wires the overlay) and
 * stages BOTH the spawner and its child as overlay-resident programs. The child
 * exists only in the overlay, so SYS_SPAWN can only find it there. It must run and exit 0.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const spawnSmokeWasmPath = join(repoRoot, "examples/spawn-smoke.wasm");
const helloWasmPath = join(repoRoot, "examples/hello.wasm");

const kernelPath = tryResolveBinary("kernel.wasm");
const havePrereqs = existsSync(spawnSmokeWasmPath) &&
  existsSync(helloWasmPath) && kernelPath !== null;

describe.runIf(havePrereqs)(
  "guest-initiated posix_spawn of an overlay-resident program",
  () => {
    it(
      "posix_spawns an overlay-resident child from a guest program",
      async () => {
        // Build a rootfs image where both the spawner and the child live only
        // in the overlay-owned `/` tree — the child is deliberately absent from
        // any host execPrograms map, so SYS_SPAWN must resolve it through the
        // overlay (kernelWorker.rootfsReadFile) to launch it.
        const fs = KandeloImageFs.create();
        ensureDirRecursive(fs, "/bin");
        writeVfsBinary(
          fs,
          "/bin/spawn-smoke",
          new Uint8Array(readFileSync(spawnSmokeWasmPath)),
        );
        writeVfsBinary(
          fs,
          "/bin/hello",
          new Uint8Array(readFileSync(helloWasmPath)),
        );
        const image = await fs.saveImage();

        let stdout = "";
        let stderr = "";
        const host = new NodeKernelHost({
          rootfsImage: image,
          onStdout: (_pid, bytes) => {
            stdout += new TextDecoder().decode(bytes);
          },
          onStderr: (_pid, bytes) => {
            stderr += new TextDecoder().decode(bytes);
          },
        });

        try {
          await host.init(
            asArrayBuffer(new Uint8Array(readFileSync(kernelPath!))),
          );
          // Host-initiated spawn of the spawner works today; the guest-initiated
          // posix_spawn it performs of /bin/hello is the path under test.
          const { exit } = await host.spawnFromVfs(
            "/bin/spawn-smoke",
            ["spawn-smoke", "/bin/hello"],
          );
          const exitCode = await exit;

          // spawn-smoke prints "OK" only after posix_spawn + waitpid of the
          // overlay-resident child succeed. Before the fix the guest posix_spawn
          // failed with EIO and spawn-smoke exited 1 with a strerror diagnostic.
          expect(
            exitCode,
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
          ).toBe(0);
          expect(stdout).toContain("OK");
          // The child actually ran through the overlay (hello.wasm greeting),
          // proving the spawn resolved real bytes rather than a stub.
          expect(stdout.toLowerCase()).toContain("hello");
        } finally {
          await host.destroy().catch(() => {});
        }
      },
      60_000,
    );
  },
);
