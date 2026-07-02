import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));

const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  join(__dirname, "../php-src/sapi/cli/php");
const curlSoPath = tryResolveBinary("programs/php/curl.so");

const READY = existsSync(phpBinaryPath) && curlSoPath != null;

// NodePlatformIO keeps these runs off the default rootfs.vfs image, which this
// package does not ship.
describe.skipIf(!READY)("PHP curl as a runtime-loadable side module", () => {
  it("base php.wasm does NOT include curl", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-m"],
      io: new NodePlatformIO(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).not.toContain("curl");
  }, 60_000);

  it("loads curl.so at runtime via extension=", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${curlSoPath}`, "-r",
        'echo extension_loaded("curl") ? "curl-loaded" : "curl-missing";'],
      io: new NodePlatformIO(),
    });
    expect(stdout).toContain("curl-loaded");
    expect(exitCode).toBe(0);
  }, 60_000);

  // A real libcurl call proves libcurl.a was absorbed and its php.wasm imports
  // resolved, not just that the module registered.
  it("curl_version() reports the linked libcurl", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${curlSoPath}`, "-r",
        'echo curl_version()["version"];'],
      io: new NodePlatformIO(),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^8\.\d+\.\d+/);
  }, 60_000);

  it("curl_init and CURLOPT_* constants are available", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${curlSoPath}`, "-r", `
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, "https://example.com/");
        echo (is_object($ch) || is_resource($ch)) ? "handle-ok" : "handle-bad";
        echo defined("CURLOPT_URL") ? ",const-ok" : ",const-missing";
        curl_close($ch);
      `],
      io: new NodePlatformIO(),
    });
    expect(stdout).toContain("handle-ok");
    expect(stdout).toContain("const-ok");
    expect(exitCode).toBe(0);
  }, 60_000);
});
