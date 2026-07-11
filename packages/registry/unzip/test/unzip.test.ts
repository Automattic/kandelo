import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const unzipBinary = tryResolveBinary("programs/unzip/unzip.wasm");
const funzipBinary = tryResolveBinary("programs/unzip/funzip.wasm");

const singleFileZip = Uint8Array.from(Buffer.from(
  "UEsDBAoAAAAAAAAAIQBh0FkBDQAAAA0AAAALAAAAcGF5bG9hZC50eHRmdW56aXAgd29ya3MKUEsBAh4DCgAAAAAAAAAhAGHQWQENAAAADQAAAAsAAAAAAAAAAAAAAKSBAAAAAHBheWxvYWQudHh0UEsFBgAAAAABAAEAOQAAADYAAAAAAA==",
  "base64",
));

describe.skipIf(!unzipBinary)("unzip", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: unzipBinary!,
      argv: ["unzip", "--version"],
      timeout: 10_000,
    });
    expect(result.stdout + result.stderr).toContain("UnZip");
  });
});

describe.skipIf(!funzipBinary)("funzip", () => {
  it("extracts a ZIP archive from stdin", async () => {
    const result = await runCentralizedProgram({
      programPath: funzipBinary!,
      argv: ["funzip"],
      stdinBytes: singleFileZip,
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("funzip works\n");
    expect(result.stderr).toBe("");
  });
});
