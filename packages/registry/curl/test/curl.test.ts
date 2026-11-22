import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const curlBinaryPath =
  tryResolveBinary("programs/curl/curl.wasm") ??
  join(__dirname, "../bin/curl.wasm");
const READY = existsSync(curlBinaryPath);
const scratchDirs: string[] = [];

// The guest's internet transfer can only be shown where the host itself
// reaches the public test URL.
const PUBLIC_URL = "https://example.com/";
const HOST_REACHES_PUBLIC_URL = READY && await fetch(PUBLIC_URL, {
  method: "HEAD",
  signal: AbortSignal.timeout(5_000),
}).then((response) => response.ok, () => false);

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
    const scratch = makeHostScratchTempRoot("kandelo-curl-cli-");
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

  it.skipIf(!HOST_REACHES_PUBLIC_URL)(
    "resolves and fetches http and https URLs over the Node host's TCP network",
    async () => {
      // Name resolution goes through the private getaddrinfo syscall to the
      // host's resolver; HTTPS verifies against the image's CA bundle.
      const { stdout, stderr, exitCode } = await runCentralizedProgram({
        programPath: curlBinaryPath,
        argv: [
          "curl",
          "--silent",
          "--show-error",
          "--head",
          "--write-out", "%{url} %{http_code}\\n",
          "--output", "/dev/null",
          PUBLIC_URL.replace("https:", "http:"),
          "--output", "/dev/null",
          PUBLIC_URL,
        ],
        enableTcpNetwork: true,
        timeout: 60_000,
      });
      expect(stderr).toBe("");
      expect(stdout).toBe("http://example.com/ 200\nhttps://example.com/ 200\n");
      expect(exitCode).toBe(0);
    },
    90_000,
  );
});
