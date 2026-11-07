/**
 * Regression: the in-kernel rootfs overlay must NOT claim paths that belong to
 * a sibling filesystem still mounted under `/`.
 *
 * The overlay is the sole `/` authority. `rootfs::owns_path` once treated
 * *any* non-tmpfs absolute path as overlay-owned,
 * so it shadowed host-backed sibling mounts such as the `/var/lib/kandelo-tests/runner`
 * session-seed tree the isolated-fixture harness uses to stage test programs.
 * The concrete symptom was `spawnFromVfs("/var/lib/kandelo-tests/runner/...") -> ENOENT`,
 * which broke the entire POSIX + sortix conformance runners (they exec every
 * test program from that seeded tree).
 *
 * This boots the real Node kernel worker (the path that wires the overlay) and
 * spawns a program that lives ONLY under the `/var/lib/kandelo-tests/runner` host mount. It
 * must run and exit 0 — the sibling mount stays visible even though the overlay
 * owns `/`. The kernel-side predicate itself is covered by
 * `rootfs::tests::owns_path_excludes_registered_foreign_mounts`.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { DEFAULT_MOUNT_SPEC } from "../src/vfs/default-mounts";
import { tryResolveBinary } from "../src/binary-resolver";
import { tryResolveRootfsArtifact } from "./support/rootfs-artifact";

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
// The default rootfs as the resolver finds it -- the same image the host
// boots for `rootfsImage: "default"`, not a path of this file's own.
const rootfsImagePath = tryResolveRootfsArtifact()?.selectedPath;
const helloWasmPath = join(repoRoot, "examples/hello.wasm");

const kernelPath = tryResolveBinary("kernel.wasm");
const havePrereqs = rootfsImagePath !== undefined &&
  existsSync(helloWasmPath) && kernelPath !== null;

describe.runIf(havePrereqs)(
  "rootfs overlay foreign sibling mounts",
  () => {
    it(
      "spawns a program that lives only under the /var/lib/kandelo-tests/runner host mount",
      async () => {
        // Stage the guest program in a host directory and seed it under
        // `/var/lib/kandelo-tests/runner` — a host-backed scratch mount, exactly like the
        // isolated conformance fixture harness (`resolveRunExampleFilesystem`).
        const seedRoot = mkdtempSync(join(tmpdir(), "kandelo-foreign-seed-"));
        cpSync(helloWasmPath, join(seedRoot, "prog.wasm"));

        let stdout = "";
        const host = new NodeKernelHost({
          rootfsImage: new Uint8Array(readFileSync(rootfsImagePath!)),
          rootfsMountSpec: [
            ...DEFAULT_MOUNT_SPEC,
            { path: "/var/lib/kandelo-tests", source: "scratch", mode: 0o755, nosuid: true },
          ],
          sessionSeedTrees: [
            { destinationPath: "/var/lib/kandelo-tests/runner", sourcePath: seedRoot },
          ],
          onStdout: (_pid, bytes) => {
            stdout += new TextDecoder().decode(bytes);
          },
        });

        try {
          await host.init(
            asArrayBuffer(new Uint8Array(readFileSync(kernelPath!))),
          );
          const { exit } = await host.spawnFromVfs(
            "/var/lib/kandelo-tests/runner/prog.wasm",
            ["prog"],
          );
          const exitCode = await exit;
          expect(exitCode).toBe(0);
          // hello.wasm prints its greeting; proves it actually ran, not just
          // resolved.
          expect(stdout.toLowerCase()).toContain("hello");
        } finally {
          await host.destroy().catch(() => {});
          rmSync(seedRoot, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);
