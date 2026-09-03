/**
 * Stage-4 gate for the Quickshell port (packages/registry/quickshell):
 * the static QtQuick shell binary boots on the kernel.
 *
 * --version exercises the whole launcher path short of a Wayland
 * connection — CLI11 parses argv, QtCore initializes, and the build's
 * version metadata prints. The layer-shell window path is proven on
 * the desktop by the Omarchy wiring, not here.
 *
 * Skips if the binary isn't built (bare checkout).
 */
import { describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const quickshellBin = tryResolveBinary("programs/quickshell.wasm");

describe("quickshell — the QtQuick shell binary on the kernel", () => {
  it.skipIf(!quickshellBin)(
    "parses argv and reports its version",
    async () => {
      const result = await runCentralizedProgram({
        programPath: quickshellBin!,
        argv: ["quickshell", "--version"],
        timeout: 120_000,
      });

      const dump = `stdout=${result.stdout}\nstderr=${result.stderr}`;
      expect(result.exitCode, dump).toBe(0);
      expect(result.stdout, dump).toContain("Quickshell");
      expect(result.stdout, dump).toContain("0.3.1");
    },
    300_000,
  );
});
