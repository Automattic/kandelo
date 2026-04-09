/**
 * Tests for Git 2.47.1 running on the wasm-posix-kernel.
 *
 * Git is built with asyncify-onlylist for fork() support so that
 * subprocesses (git gc --auto, hooks, pager) work correctly.
 *
 * Each runCentralizedProgram call creates a fresh kernel instance,
 * but the host filesystem persists, so we use unique temp dirs.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const gitBinary = join(repoRoot, "examples/libs/git/bin/git.wasm");

const hasGit = existsSync(gitBinary);

// Git config via environment
const gitEnv = [
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_COUNT=4",
  "GIT_CONFIG_KEY_0=gc.auto",
  "GIT_CONFIG_VALUE_0=0",
  "GIT_CONFIG_KEY_1=user.name",
  "GIT_CONFIG_VALUE_1=Test",
  "GIT_CONFIG_KEY_2=user.email",
  "GIT_CONFIG_VALUE_2=test@wasm.local",
  "GIT_CONFIG_KEY_3=init.defaultBranch",
  "GIT_CONFIG_VALUE_3=main",
];

describe.skipIf(!hasGit)("Git", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: gitBinary,
      argv: ["git", "--version"],
      env: gitEnv,
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("git version 2.");
  });

  it("initializes a repository", async () => {
    const dir = `/tmp/git-test-init-${Date.now()}`;
    const result = await runCentralizedProgram({
      programPath: gitBinary,
      argv: ["git", "init", dir],
      env: gitEnv,
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("nitialized");
  });

  it("creates a commit without spurious help output (asyncify fork)", { timeout: 30_000 }, async () => {
    // git commit triggers fork+exec for `git gc --auto`. Without asyncify,
    // the fork child restarts from _start() with empty argv and prints help.
    const dir = `/tmp/git-commit-test-${Date.now()}`;
    // Init repo on host filesystem first
    const initResult = await runCentralizedProgram({
      programPath: gitBinary,
      argv: ["git", "init", dir],
      env: gitEnv,
      timeout: 15_000,
    });
    expect(initResult.exitCode).toBe(0);
    // Commit with fork
    const result = await runCentralizedProgram({
      programPath: gitBinary,
      argv: ["git", "-C", dir, "commit", "--allow-empty", "-m", "test commit"],
      env: gitEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("test commit");
    expect(output).not.toContain("usage: git");
  });
});
