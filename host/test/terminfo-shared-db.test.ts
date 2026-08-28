import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const sourceOnly = join(repoRoot, "local-binaries/source-only-v1");
const shellImage = join(sourceOnly, "programs/wasm32/shell.vfs.zst");
const kernel = join(sourceOnly, "kernel.wasm");
const available = [shellImage, kernel].every(existsSync);

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

// Proves the shared /usr/share/terminfo database works for terminals that are
// NOT among ncurses's four compiled-in fallbacks (xterm-256color/xterm/vt100/
// dumb). screen-256color and tmux-256color only resolve if the db is really
// staged in the image and ncurses reads it — the whole point of the general
// (per-system, not per-package) fix.
describe.skipIf(!available)("shared /usr/share/terminfo database", () => {
  it("resolves non-fallback terminals (screen-256color, tmux-256color)", async () => {
    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      rootfsImage: new Uint8Array(readFileSync(shellImage)),
      onStdout: (_pid, b) => { stdout += new TextDecoder().decode(b); },
      onStderr: (_pid, b) => { stderr += new TextDecoder().decode(b); },
    });

    const cmd = [
      'echo "===DIR==="',
      "ls /usr/share/terminfo 2>&1",
      'echo "===SCREEN_FILE==="',
      "ls /usr/share/terminfo/73/screen-256color 2>&1",
      'echo "===INFOCMP==="',
      "infocmp -1 screen-256color 2>&1 | head -3",
      'echo "===TPUT_SCREEN==="',
      "TERM=screen-256color tput colors 2>&1",
      'echo "===TPUT_TMUX==="',
      "TERM=tmux-256color tput colors 2>&1",
      'echo "===TPUT_XTERM==="',
      "TERM=xterm-256color tput colors 2>&1",
      'echo "===END==="',
    ].join("\n");

    try {
      await host.init(arrayBuffer(new Uint8Array(readFileSync(kernel))));
      const { exit } = await host.spawnFromVfs(
        "/bin/bash",
        ["bash", "-c", cmd],
        { env: ["PATH=/usr/bin:/bin", "HOME=/root"], uid: 0, gid: 0 },
      );
      const code = await exit;
      expect(code, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
    } finally {
      await host.destroy().catch(() => {});
    }

    // The db tree is present and contains the non-fallback entry.
    expect(stdout).toMatch(/screen-256color/);
    // infocmp read the entry out of the db (not the compiled-in fallback).
    expect(stdout).toMatch(/===INFOCMP===[\s\S]*screen[-|]256color/);
    // tput ran ncurses setupterm() against the db for non-fallback terminals.
    const screen = stdout.match(/===TPUT_SCREEN===\s*(\d+)/)?.[1];
    const tmux = stdout.match(/===TPUT_TMUX===\s*(\d+)/)?.[1];
    expect(screen, `full output:\n${stdout}`).toBe("256");
    expect(tmux, `full output:\n${stdout}`).toBe("256");
  });
});
