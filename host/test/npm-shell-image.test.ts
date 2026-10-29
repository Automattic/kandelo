import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { nodeWebStreamsCommand } from "./fixtures/node-web-streams";
import { nodeUrlCommand } from "./fixtures/node-url";
import { npmLifecycleCommand } from "./fixtures/npm-lifecycle";
import { bunShellCommand } from "./fixtures/bun-shell";
import { nodeFileSyncCommand } from "./fixtures/node-file-sync";
import { nodeStdinCommand } from "./fixtures/node-stdin";
import { nodeProcessExitCommand, nodeProcessExitExpected } from "./fixtures/node-process-exit";
import { nodeSpawnPathCommand, nodeSpawnPathExpected } from "./fixtures/node-spawn-path";

async function runShell(command: string) {
  let stdout = "";
  let stderr = "";
  const lazyBase = "https://kandelo.invalid/";
  const assets = ([
    ["assets/programs/wasm32/node.zip", "programs/wasm32/node.zip"],
    ["assets/programs/wasm32/coreutils.wasm", "programs/coreutils.wasm"],
    ["assets/programs/wasm32/git/git.wasm", "programs/git/git.wasm"],
  ] as const).map(([url, path]) => {
    const bytes = new Uint8Array(readFileSync(resolveBinary(path)));
    return { url: lazyBase + url, bytes, size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const host = new NodeKernelHost({
    rootfsImage: new Uint8Array(readFileSync(resolveBinary("programs/wasm32/shell.vfs.zst"))),
    rootfsLazyUrlBase: lazyBase,
    rootfsLazyAssets: assets,
    rootfsLazyAssetDirectory: lazyBase,
    onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
    onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
  });
  try {
    await host.init();
    const { exit } = await host.spawnFromVfs("/usr/bin/bash", ["bash", "-lc", command], {
      cwd: "/home/maker",
      uid: 1000, gid: 1000,
      env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/maker", "USER=maker", "TMPDIR=/tmp"],
      stdin: new Uint8Array(),
    });
    return { exitCode: await exit, stdout, stderr };
  } finally {
    await host.destroy();
  }
}

describe("base shell Node subprocesses and npm lifecycle scripts", () => {
  it("delivers pull-based streams and propagates cancellation, errors, and piping", async () => {
    const result = await runShell(nodeWebStreamsCommand);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("node-web-streams-ok");
  }, 120_000);

  it("validates URLs and keeps query changes synchronized with serialization", async () => {
    const result = await runShell(nodeUrlCommand);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("node-url-ok");
  }, 120_000);

  it("preserves an unset exit code and reports numeric exit-event statuses", async () => {
    const result = await runShell(nodeProcessExitCommand);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const marker of nodeProcessExitExpected) expect(result.stdout).toContain(marker);
  }, 120_000);

  it("streams stdin bytes and EOF and releases paused or unreferenced readers", async () => {
    const result = await runShell(nodeStdinCommand);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const marker of ["stdin-eof:[]", "stdin-eof:[68656c6c6f]", "stdin-pipe:[hello]",
      "stdin-pause-exit-ok", "stdin-unref-exit-ok", "stdin-resume-exit-ok", "stdin-ref-exit-ok"])
      expect(result.stdout).toContain(marker);
  }, 120_000);

  it("loads image-owned lazy executables through the shared asset directory", async () => {
    const result = await runShell("exec git --version");
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("git version 2.47.1");
  }, 120_000);

  it("synchronizes open file descriptors and reports invalid descriptors", async () => {
    const result = await runShell(nodeFileSyncCommand);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("node-file-sync-ok");
    expect(result.stdout).toContain("node-file-io-errors-ok");
  }, 120_000);

  it("installs a Bun payload and runs it as maker through the shipped launcher", async () => {
    const result = await runShell(bunShellCommand);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('bun-shell-ok extracted-module wasm32 ["two words","--flag"]');
    expect(result.stdout).toContain("buffer-validation-ok");
    expect(result.stdout).toContain("bun-default-platform-rejected");
    expect(result.stdout).toContain("bun-wrong-target-rejected");
    expect(result.stdout).toContain('["concurrent-one"]');
    expect(result.stdout).toContain('["concurrent-two"]');
    expect(result.stdout).toContain("bun-exit-status 23");
    expect(result.stdout).toContain("bun-shell-complete");
    expect(result.stderr).toContain("cache hit");
    expect(result.stderr).toContain("cache must be a private directory");
  }, 120_000);

  it("spawn and execFile search the child's PATH and preserve lookup errors", async () => {
    const result = await runShell(nodeSpawnPathCommand);
    expect(result.exitCode, result.stderr).toBe(0);
    for (const expected of nodeSpawnPathExpected) expect(result.stdout, result.stderr).toContain(expected);
  }, 120_000);

  it("installs scoped packages, runs nested shell commands, and preserves lifecycle failures", async () => {
    const result = await runShell(npmLifecycleCommand);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("npm-lifecycle-success");
    expect(result.stdout).toContain("npm-lifecycle-failure-status 23");
    expect(result.stderr).toContain("npm-lifecycle-child-error");
    expect(result.stdout).toContain("npm-lifecycle-enospc-rejected");
    expect(result.stdout).toContain("npm-extraction-enospc-rejected");
  }, 240_000);
});
