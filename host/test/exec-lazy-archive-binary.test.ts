import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { parseZipCentralDirectory } from "../src/vfs/zip";

// Phase 5 Increment 3b-wiring.4 (exec-target EAGAIN retry, see
// docs/superpowers/plans/2026-08-31-phase5-3b-inc-w4-exec-target-eagain.md):
// durable end-to-end proof that a binary living ONLY inside a lazy VFS
// archive can be `exec`'d through the in-kernel rootfs overlay (the
// unconditional sole `/` authority). Reads of a lazy member already worked (w3,
// `node-lazy-archive-runtime.test.ts`'s "materializes a lazy base file..."
// test); this pins the exec path specifically, which needed the host
// exec-target reader (`host/src/exec-target.ts`) to retry on the kernel's
// transient EAGAIN instead of throwing and cancelling the prepared-exec
// token on the very first read attempt.
//
// This MUST use `registerLazyArchive` (the zip-archive-group format that feeds
// the overlay's deferred provider), NOT `registerLazyTree` (fully materialized
// ahead of time by `io.preparePath` before `readPreparedExecTarget` ever runs,
// which would make this a false positive that never exercises the EAGAIN path).
//
// The image is built by `KandeloImageFs`, which writes the `SDEF` section, and the
// format is load-bearing here rather than incidental. Under URI addressing the
// kernel fetches a deferred resource by the address ITS OWN image recorded, and
// `SDEF` has a typed field for that address. The `KLZY` section this fixture
// used to be built with has no such field: an archive described that way
// carries no address at all, so the kernel refuses the read with EIO rather
// than asking a host table where the bytes went. That refusal is the truthful
// outcome of removing the host's id->URL table, not a gap — but it does mean a
// `KLZY` fixture can no longer prove anything about exec, which is why this
// test moved to the format production actually ships.
//
// Stale-kernel guard: a `local-binaries/kernel.wasm` built before the Rust
// `KIND_LAZY_FILE`/materialization support landed can silently no-op the
// overlay for this path (the archive provider is never consulted and exec
// either fails outright or "succeeds" without ever touching the lazy
// archive). To make that failure mode loud rather than a false green, the
// archive is served from a real local HTTP server and the test counts
// requests to it. The overlay's archive provider (`rootfs-lazy-archives.ts`)
// is the ONLY code path that ever fetches this URL — a live kernel worker
// runs in a separate `node:worker_threads` isolate, so there is no shared
// JS reference to spy on directly; counting genuine inbound HTTP requests
// against the archive's one real transport is the seam that actually
// crosses that thread boundary. A stale kernel that never calls the
// provider will leave this counter at 0, failing the test truthfully
// instead of masking the gap.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const kernelPath = tryResolveBinary("kernel.wasm");
const environmentProgramPath = join(
  repoRoot,
  "examples/environment_lifecycle_test.wasm",
);

const haveKernel = kernelPath !== null;
const haveEnvironmentProgram = existsSync(environmentProgramPath);
const available = haveKernel && haveEnvironmentProgram;

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function integrity(bytes: Uint8Array): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

describe.skipIf(!available)(
  "exec a binary that lives in a lazy VFS archive (Phase 5 3b-wiring.4)",
  () => {
    it(
      "execs /bin/environment-lifecycle through the overlay's lazy-archive provider",
      async () => {
        const execBytes = new Uint8Array(readFileSync(environmentProgramPath));
        // fflate's zipSync does not stamp a Unix creator OS, so
        // `parseZipCentralDirectory` falls back to its `bin/`-prefix
        // heuristic (host/src/vfs/zip.ts) and assigns mode 0o755 — exactly
        // the executable bit this exec needs, with no manual chmod bookkeeping.
        const dataArchive = zipSync({
          "bin/environment-lifecycle": execBytes,
        });

        let requestCount = 0;
        const server: Server = createServer((_request, response) => {
          requestCount += 1;
          response.writeHead(200, {
            "content-length": String(dataArchive.byteLength),
          });
          response.end(dataArchive);
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("lazy archive fixture server lacks a TCP address");
        }
        const archiveUrl = `http://127.0.0.1:${address.port}/archive.zip`;

        const fs = KandeloImageFs.create();
        fs.registerLazyArchive({
          url: archiveUrl,
          entries: parseZipCentralDirectory(dataArchive),
          mountPrefix: "/",
          integrity: integrity(dataArchive),
        });
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
          await host.init(arrayBuffer(new Uint8Array(readFileSync(kernelPath!))));

          // /bin/environment-lifecycle exists ONLY as a lazy-archive member —
          // it is absent from the (empty) base rootfs image. A successful
          // exec proves the overlay resolved and read it through the
          // archive provider, not some other mount or fallback.
          const { exit } = await host.spawnFromVfs(
            "/bin/environment-lifecycle",
            ["environment-lifecycle"],
            { env: ["INITIAL=parent", "REMOVE=before-fork"] },
          );
          const exitCode = await exit;

          expect(stderr).toBe("");
          expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
          // The binary forks then re-execs itself twice more (still at the
          // same lazy-archive path) with a replaced and then an empty
          // environment; all three stages must pass for a clean exit 0.
          expect(stdout).toContain("FORK_ENV_PASS");
          expect(stdout).toContain("EXEC_ENV_PASS");
          expect(stdout).toContain("EMPTY_ENV_PASS");

          // The stale-kernel guard: the archive's one real HTTP transport
          // must have been hit at least once. If a kernel silently no-ops the
          // overlay for this path, the deferred provider
          // (rootfs-lazy-archives.ts) is never invoked, no fetch runs, and this
          // stays at 0 — this assertion is what turns that into a truthful
          // failure instead of a false green. It also now proves the ADDRESS
          // survived the round trip through the image: the kernel could only
          // have named this URL by reading it back out of the `SDEF` record.
          expect(requestCount).toBeGreaterThan(0);
        } finally {
          await host.destroy().catch(() => {});
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      60_000,
    );
  },
);
