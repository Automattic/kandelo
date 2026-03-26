/**
 * Quick sanity check that PHP still works after the channel fix.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");
const phpBinaryPath = join(repoRoot, "examples/libs/php/php-src/sapi/cli/php");

const PHP_AVAILABLE = existsSync(phpBinaryPath);

describe.skipIf(!PHP_AVAILABLE)("PHP sanity", () => {
  it("echo hello", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-r", "echo 'HELLO';"],
      timeout: 10_000,
    });
    console.log("STDOUT:", stdout);
    expect(stdout).toContain("HELLO");
  }, 15_000);

  it("echo with env var", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-r", "echo 'HELLO'; echo getenv('HOME');"],
      env: ["HOME=/tmp"],
      timeout: 10_000,
    });
    console.log("STDOUT:", stdout);
    expect(stdout).toContain("HELLO");
  }, 15_000);
});
