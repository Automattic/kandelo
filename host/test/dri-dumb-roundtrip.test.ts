/**
 * End-to-end test for the DRI buffer-sharing milestone (A)
 * (docs/plans/2026-05-25-dri-buffer-sharing-plan.md §C5).
 *
 * Runs `dumb_roundtrip.wasm` (programs/dumb_roundtrip.c) under the
 * centralized kernel and asserts that the parent exits 0 with the
 * milestone-(A) sentinel on stdout. Parent's exit 0 implies the
 * child exited 0 (the parent's only success path is WIFEXITED +
 * status==0), which in turn implies:
 *
 *   parent: gbm_create_device → gbm_bo_create (CREATE_DUMB ioctl)
 *           → gbm_bo_map (MAP_DUMB + mmap) → write gradient
 *           → gbm_bo_get_fd (PRIME_HANDLE_TO_FD)
 *   fork(): prime fd inherited via fd table
 *   child:  gbm_create_device → gbm_bo_import (PRIME_FD_TO_HANDLE)
 *           → gbm_bo_map (MAP_DUMB + mmap on the imported handle)
 *           → verify the gradient byte-for-byte at every (x,y).
 *
 * The byte-verify exercises the host's SAB-backed bo store + the
 * bind/unbind sync that primes the importing pid's wasm Memory from
 * the canonical bo SAB (plan §B2). If `GbmBoRegistry`'s sync ever
 * regresses, the child reads zeros and FAIL: pixel lines hit stderr.
 *
 * Worker-thread mode (default for runCentralizedProgram). Fork support
 * is sketchy in main-thread mode (see fork-from-thread.test.ts header),
 * so we don't pass `io:` — we want NodeKernelHost's full fork path.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const dumbRoundtripBinary = tryResolveBinary("programs/dumb_roundtrip.wasm");
const hasBinary = !!dumbRoundtripBinary;

describe("dri dumb-buffer round-trip", () => {
  it.skipIf(!hasBinary)(
    "parent's gradient survives fork → PRIME export → child PRIME import → child mmap (byte-for-byte verify)",
    async () => {
      const result = await runCentralizedProgram({
        programPath: dumbRoundtripBinary!,
        argv: ["dumb_roundtrip"],
        timeout: 15_000,
      });

      expect(
        result.exitCode,
        `parent exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("milestone (A) PASS");

      // No FAIL lines should leak — every error-path branch in the
      // demo writes a "FAIL: …" line to stderr and exits non-zero,
      // including the per-pixel mismatch path that catches a broken
      // SAB sync. Belt-and-braces vs. the exit-code check above.
      expect(result.stderr).not.toContain("FAIL:");
    },
  );
});
