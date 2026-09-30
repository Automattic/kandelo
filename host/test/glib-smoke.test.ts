/*
 * PR21 gate: the glib port (packages/registry/glib/) — GMainLoop
 * dispatch, GObject signals through the libffi-backed generic
 * marshaller (PR20), GObject properties, and GSpawn sync + async —
 * driven by programs/glib_smoke_test.c under the kernel.
 *
 * The program re-execs itself for the spawn legs, so the binary is
 * staged at /bin/glib_smoke_test via execPrograms. Skips when the
 * binary is missing, matching the other program smoke tests.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const wasmBinary = tryResolveBinary("programs/glib_smoke_test.wasm");

describe("glib port — mainloop, gobject signals, gspawn", () => {
  it.skipIf(!wasmBinary)(
    "passes the smoke matrix on wasm32 under the kernel",
    async () => {
      const result = await runCentralizedProgram({
        programPath: wasmBinary!,
        argv: ["glib_smoke_test"],
        env: [],
        timeout: 60_000,
        execPrograms: new Map([["/bin/glib_smoke_test", wasmBinary!]]),
      });

      expect(
        result.exitCode,
        `glib_smoke_test exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("GLIB_SMOKE_OK");
    },
    90_000,
  );
});
