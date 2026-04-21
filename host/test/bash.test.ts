/**
 * Tests for bash running on the wasm-posix-kernel.
 *
 * Focuses on bash-specific features (bashisms) that dash does not implement,
 * to guard against bash-in-wasm regressions. POSIX-generic shell coverage
 * lives in dash.test.ts.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bashBinary = join(
  __dirname,
  "../../examples/libs/bash/bin/bash.wasm",
);

const hasBash = existsSync(bashBinary);

const bashEnv = [
  "HOME=/tmp",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "TMPDIR=/tmp",
  "TERM=dumb",
];

describe.skipIf(!hasBash)("bash shell", () => {
  it("runs echo via -c", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: ["bash", "-c", "echo hello world"],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("supports [[ ... ]] extended test", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: ["bash", "-c", "if [[ 5 -gt 3 && foo == foo ]]; then echo yes; fi"],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("yes");
  });

  it("supports =~ regex match", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: [
        "bash",
        "-c",
        's="abc123"; if [[ $s =~ ^[a-z]+([0-9]+)$ ]]; then echo ${BASH_REMATCH[1]}; fi',
      ],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("123");
  });

  it("supports indexed arrays", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: [
        "bash",
        "-c",
        "arr=(one two three); echo ${arr[1]} ${#arr[@]}",
      ],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("two 3");
  });

  it("supports associative arrays", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: [
        "bash",
        "-c",
        'declare -A h=([a]=1 [b]=2 [c]=3); echo ${h[b]}',
      ],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("2");
  });

  it("supports brace expansion (numeric range)", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: ["bash", "-c", "echo {1..5}"],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1 2 3 4 5");
  });

  it("supports brace expansion (comma list)", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: ["bash", "-c", "echo pre-{a,b,c}-post"],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("pre-a-post pre-b-post pre-c-post");
  });

  it("supports case-modification parameter expansion", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: ["bash", "-c", "s=hello; echo ${s^^} ${s^}"],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("HELLO Hello");
  });

  it("supports substring expansion", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: ["bash", "-c", "s=abcdefgh; echo ${s:2:3}"],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("cde");
  });

  it("supports C-style for loop", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: [
        "bash",
        "-c",
        "for ((i=0; i<3; i++)); do echo $i; done",
      ],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("0\n1\n2");
  });

  it("supports $'...' ANSI-C quoting", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: ["bash", "-c", "printf '%s' $'a\\tb\\nc'"],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\tb\nc");
  });

  it("exposes history and bind builtins", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: [
        "bash",
        "-c",
        "type history >/dev/null && type bind >/dev/null && echo y",
      ],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("y");
  });

  it("exits with the correct status", async () => {
    const result = await runCentralizedProgram({
      programPath: bashBinary,
      argv: ["bash", "-c", "exit 11"],
      env: bashEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(11);
  });
});
