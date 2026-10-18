/**
 * PR3 gate: the wasm32 libwayland port (packages/registry/libwayland)
 * runs against the kernel's Unix primitives.
 *
 * Runs `wl_smoke.wasm` (programs/wl_smoke.c) under the centralized kernel.
 * The program hosts a libwayland server AND client in one process, wired
 * over a kernel AF_UNIX socketpair, and drives a real request round-trip.
 * Its exit-0 path asserts both PR3 integration risks
 * (docs/plans/2026-07-08-dri-wayland-compositor-plan.md §4, §8):
 *
 *   - wl_closure_invoke dispatches a decoded request through the PR1
 *     libffi shim: the server's create_surface + damage(7,11,100,200)
 *     implementations fire via ffi_call, and all four i32 args land in
 *     the right slots (DISPATCH_* markers).
 *   - wl_event_loop's epoll_wait genuinely parks (~60 ms with the socket
 *     drained) and wakes promptly on a readable client fd (PARK/WAKE
 *     markers).
 *
 * The binary is built + fork-instrumented by scripts/build-programs.sh
 * (which resolves libwayland + libffi and links their archives). Absent
 * the binary — e.g. a bare checkout where build-programs.sh hasn't run in
 * the dev shell — the test skips, matching the sdl2/dri program tests.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const wlSmokeBinary = tryResolveBinary("programs/wl_smoke.wasm");
const hasBinary = !!wlSmokeBinary;

describe("libwayland — client↔server round-trip on the kernel", () => {
  it.skipIf(!hasBinary)(
    "wl_closure_invoke dispatches through the ffi shim; wl_event_loop parks/wakes on epoll",
    async () => {
      const result = await runCentralizedProgram({
        programPath: wlSmokeBinary!,
        argv: ["wl_smoke"],
        timeout: 20_000,
      });

      expect(
        result.exitCode,
        `wl_smoke exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);

      // Both endpoints came up over the AF_UNIX socketpair.
      expect(result.stdout).toContain("SERVER_UP");
      expect(result.stdout).toContain("CLIENT_UP");
      expect(result.stdout).toContain("BOUND_COMPOSITOR");

      // Closure dispatch through the libffi shim: handlers fired AND the
      // four i32 damage args survived marshalling → invoke → demarshal.
      expect(result.stdout).toContain("DISPATCH_CREATE_SURFACE ok");
      expect(result.stdout).toContain(
        "DISPATCH_DAMAGE_ARGS ok x=7 y=11 w=100 h=200",
      );

      // Event loop actually parked on epoll_wait for the timeout, then
      // woke promptly on the readable client fd.
      expect(result.stdout).toMatch(/PARK dispatch_rc=\d+ elapsed_ms=(\d+)/);
      expect(result.stdout).toContain("WAKE");
      expect(result.stdout).toContain("WL_SMOKE_OK");

      // Parked at least ~40 ms (the program's own guard is 40; assert it
      // here too so a regression to a busy-spin epoll surfaces).
      const parkMs = Number(
        /PARK dispatch_rc=\d+ elapsed_ms=(\d+)/.exec(result.stdout)?.[1] ?? "0",
      );
      expect(parkMs).toBeGreaterThanOrEqual(40);
    },
    25_000,
  );
});
