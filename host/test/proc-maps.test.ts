/**
 * /proc/<pid>/maps reports the kernel's mapping tables in Linux's format:
 * s/p from MAP_SHARED/MAP_PRIVATE, the file offset, the mapped file's device
 * and inode as fstat() reports them, and its pathname -- `/memfd:<name>
 * (deleted)` for a memfd, the /dev/shm path for a POSIX shared-memory
 * object, nothing for anonymous memory. A forked child reports the same
 * files for the mappings it inherited. (`format_maps` in
 * crates/runtime-core/src/procfs.rs.) The memory64 build checks the wider
 * pathname column Linux uses for 64-bit pointers.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("/proc/self/maps", () => {
  it.each(["wasm32", "wasm64"] as const)(
    "reports each mapping's sharing, offset, device, inode and pathname (%s)",
    async (arch) => {
      const fixture = arch === "wasm64"
        ? compileSdkFixture(
          new URL("../../examples/proc_maps_test.c", import.meta.url),
          [],
          { arch, forkInstrument: true },
        )
        : {
          programPath: join(__dirname, "../../examples/proc_maps_test.wasm"),
          cleanup: () => {},
        };
      try {
        const result = await runCentralizedProgram({
          programPath: fixture.programPath,
          timeout: 20_000,
          useDefaultRootfs: false,
        });

        for (const check of [
          "file-shared",
          "file-private",
          "file-trimmed",
          "memfd",
          "dev-shm",
          "anonymous-private",
          "anonymous-shared",
          "fork-child-memfd",
          "fork-child-file",
        ]) {
          expect(result.stdout).toContain(`${check}: PASS`);
        }
        expect(result.stdout).toContain("PROC_MAPS_PASS");
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
      } finally {
        fixture.cleanup();
      }
    },
    90_000,
  );
});
