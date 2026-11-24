import { expect, it } from "vitest";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

it.each(["tree", "loc", "hexdump"])("runs the packaged Zig %s executable", async (program) => {
  const result = await runCentralizedProgram({
    programPath: resolveBinary(`programs/zigcli/${program}.wasm`),
    argv: [program, "--version"],
    timeout: 10_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^Zigcli\s*\n - version: \d+\.\d+\.\d+/);
}, 15_000);
