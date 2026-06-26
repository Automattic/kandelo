import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const dashBinary = tryResolveBinary("programs/dash.wasm");
const bashBinary = tryResolveBinary("programs/bash.wasm");
const shellBinary = dashBinary ?? bashBinary;
const shellArgv0 = dashBinary ? "dash" : "bash";

describe.skipIf(!shellBinary)("non-PTY stdio", () => {
  it("reports captured stdio as pipes, not terminals", async () => {
    const result = await runCentralizedProgram({
      programPath: shellBinary!,
      argv: [
        shellArgv0,
        "-c",
        'if [ -t 0 ] || [ -t 1 ] || [ -t 2 ]; then echo tty; else echo pipe; fi',
      ],
      timeout: 20_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("pipe");
  });

  it("reports EOF for captured stdin when no input is supplied", async () => {
    const result = await runCentralizedProgram({
      programPath: shellBinary!,
      argv: [
        shellArgv0,
        "-c",
        'if read line; then echo "data:$line"; else echo eof; fi',
      ],
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("eof");
  });
});
