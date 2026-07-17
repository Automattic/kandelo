import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const curlBinaryPath =
  tryResolveBinary("programs/curl.wasm") ??
  join(__dirname, "../bin/curl.wasm");
const READY = existsSync(curlBinaryPath);
const scratchDirs: string[] = [];

afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe.skipIf(!READY)("curl CLI package", () => {
  it("reports the packaged libcurl, OpenSSL, and zlib versions", async () => {
    const { stdout, stderr, exitCode } = await runCentralizedProgram({
      programPath: curlBinaryPath,
      argv: ["curl", "--version"],
      io: new NodePlatformIO(),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "curl 8.11.1 (wasm32-unknown-linux-musl) libcurl/8.11.1 OpenSSL/3.3.2 zlib/1.3.1",
    );
    expect(stdout).toContain("Protocols: file ftp ftps http https");
  }, 60_000);

  it("transfers file URL bytes through libcurl", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kandelo-curl-cli-"));
    scratchDirs.push(scratch);
    const fixture = join(scratch, "fixture.txt");
    writeFileSync(fixture, "kandelo-curl-file-ok\n");

    const { stdout, stderr, exitCode } = await runCentralizedProgram({
      programPath: curlBinaryPath,
      argv: [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        pathToFileURL(fixture).href,
      ],
      io: new NodePlatformIO(),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("kandelo-curl-file-ok\n");
  }, 60_000);
});
