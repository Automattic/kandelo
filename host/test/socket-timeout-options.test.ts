import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("socket timeout option guest ABI", () => {
  it.each([".wasm", ".wasm64.wasm"])(
    "sets and gets distinct receive and send timeouts (%s)",
    async (suffix) => {
      const result = await runCentralizedProgram({
        programPath: join(
          __dirname,
          `../../examples/socket_timeout_options_test${suffix}`,
        ),
        argv: ["socket-timeout-options-test"],
        timeout: 15_000,
        useDefaultRootfs: false,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("SOCKET_TIMEOUT_OPTIONS_PASS");
      expect(result.stderr).toBe("");
    },
  );
});
