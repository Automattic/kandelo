/**
 * The lua interpreter runs a chunk and reaches the shell through liblua's
 * POSIX build: io.popen reads a command's output and reports its exit
 * status, and os.execute reports a command's exit status. pcall recovers
 * from a raised error through the POSIX build's _setjmp and _longjmp.
 *
 * Requires the normal lua-cli and dash package artifacts. A missing artifact
 * is a provisioning failure, not passing or skipped coverage.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { resolveBinary } from "../../../../host/src/binary-resolver";

const lua = resolveBinary("programs/lua.wasm");
const dash = resolveBinary("programs/dash.wasm");

const CHUNK = [
  'local pipe = io.popen("echo piped")',
  'print(pipe:read("*l"))',
  "print(pipe:close())",
  'print(os.execute("exit 3"))',
  'print(pcall(error, "boom", 0))',
].join("\n");

describe("lua-cli — the lua interpreter on the Kandelo kernel", () => {
  it(
    "runs a chunk that reads a command through io.popen, runs one with os.execute and recovers from an error",
    async () => {
      const result = await runCentralizedProgram({
        programPath: lua,
        argv: ["lua", "-e", CHUNK],
        env: ["PATH=/bin", "HOME=/tmp"],
        execPrograms: new Map([["/bin/sh", dash]]),
        timeout: 30_000,
      });
      const output = `stdout=${result.stdout}\nstderr=${result.stderr}`;

      expect(result.exitCode, output).toBe(0);
      expect(result.stdout, output).toBe([
        "piped",
        "true\texit\t0",
        "nil\texit\t3",
        "false\tboom",
        "",
      ].join("\n"));
    },
    60_000,
  );
});
