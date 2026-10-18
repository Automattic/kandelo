/**
 * TyrQuake fits the address space the host gives it.
 *
 * The engine allocates its whole heap in one malloc at startup, and upstream's
 * default for that heap is 256 MiB — exactly the per-process address space
 * Kandelo declares under the constrained memory profile (4096 Wasm pages),
 * which browsers select on small-reservation-pool devices such as iOS. The
 * request therefore could not fit alongside the program, its stack, and the
 * host's control pages, and the Quake demo died with
 * "Allocation of 268435456 byte heap failed" before drawing a frame, on iOS
 * only. The engine now sizes that heap from RLIMIT_AS
 * (packages/registry/tyrquake/patches/0002-*.patch).
 *
 * Both runs stop at the missing game data: this harness boots a bare rootfs
 * with no pak0.pak. Reaching that point is the assertion — it means the engine
 * started.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const quake = tryResolveBinary("programs/quake.wasm");

/** The two per-process ceilings the shipped memory profiles declare. */
const CEILINGS = [
  ["desktop", 16384, "256.0 megabyte heap"],
  ["constrained", 4096, "128.0 megabyte heap"],
] as const;

describe("TyrQuake heap sizing", () => {
  it.skipIf(!quake).each(CEILINGS)(
    "starts under the %s budget",
    async (_profile, maxPages, expectedHeapLine) => {
      const result = await runCentralizedProgram({
        programPath: quake!,
        argv: ["quake", "-basedir", "/usr/share/quake"],
        maxPages,
        timeout: 60_000,
      });

      expect(result.stderr).not.toContain("heap failed");
      // The engine prints the heap it got, so the budget stays inspectable.
      expect(result.stdout).toContain(expectedHeapLine);
      expect(result.stdout).toContain("Quake -- TyrQuake Version");
    },
  );
});
