import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { bufferValidationSource } from "./fixtures/node-buffer-validation";
import { nodeAssertionCommand } from "./fixtures/node-assertion-semantics";
import { nodeFileSyncCommand } from "./fixtures/node-file-sync";
import { nodeProcessExitCommand, nodeProcessExitExpected } from "./fixtures/node-process-exit";
import { nodeSpawnPathCommand, nodeSpawnPathExpected } from "./fixtures/node-spawn-path";
import { nodeStdinDecodingCommand } from "./fixtures/node-stdin-decoding";
import { nodeStdinCommand } from "./fixtures/node-stdin";
import { nodeUrlCommand } from "./fixtures/node-url";
import { nodeWebStreamsCommand } from "./fixtures/node-web-streams";

async function runShell(command: string) {
  let stdout = "", stderr = "";
  const base = "https://kandelo.invalid/";
  const assets = ([
    ["assets/programs/wasm32/node.zip", "programs/wasm32/node.zip"],
    ["assets/programs/wasm32/coreutils.wasm", "programs/coreutils.wasm"],
  ] as const).map(([url, path]) => {
    const bytes = new Uint8Array(readFileSync(resolveBinary(path)));
    return { url: base + url, bytes, size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const host = new NodeKernelHost({
    rootfsImage: new Uint8Array(readFileSync(resolveBinary("programs/wasm32/shell.vfs.zst"))),
    rootfsLazyUrlBase: base, rootfsLazyAssets: assets, rootfsLazyAssetDirectory: base,
    onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
    onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
  });
  try {
    await host.init();
    const { exit } = await host.spawnFromVfs("/usr/bin/bash", ["bash", "-lc", command], {
      cwd: "/home/maker", uid: 1000, gid: 1000,
      env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/maker", "USER=maker", "TMPDIR=/tmp"],
      stdin: new Uint8Array(),
    });
    return { exitCode: await exit, stdout, stderr };
  } finally { await host.destroy(); }
}

const cases: Array<[string, string, readonly string[]]> = [
  ["assertion matchers and deep comparisons", nodeAssertionCommand, ["node-assertion-semantics-ok"]],
  ["buffer byte validation", `set -eu\ncat > /tmp/buffer-core.cjs <<'JS'\nconst {isUtf8,isAscii}=require('buffer');\n${bufferValidationSource}\nJS\nnode /tmp/buffer-core.cjs`, ["buffer-validation-ok"]],
  ["descriptor synchronization and filesystem failures", nodeFileSyncCommand, ["node-file-sync-ok", "node-file-io-errors-ok"]],
  ["exit-code absence and exit listeners", nodeProcessExitCommand, nodeProcessExitExpected],
  ["stdin bytes, EOF and reader lifetime", nodeStdinCommand, ["stdin-eof:[]", "stdin-eof:[68656c6c6f]", "stdin-pipe:[hello]", "stdin-pause-exit-ok", "stdin-unref-exit-ok", "stdin-resume-exit-ok", "stdin-ref-exit-ok"]],
  ["child PATH, working directories and chmod", nodeSpawnPathCommand, nodeSpawnPathExpected],
  ["streaming stdin decoding and EOF", nodeStdinDecodingCommand, ["node-stdin-decoding-ok"]],
  ["WHATWG URL validation and mutation", nodeUrlCommand, ["node-url-ok"]],
  ["pull-based Web Streams and cancellation", nodeWebStreamsCommand, ["node-web-streams-ok"]],
];

describe("base shell Node core compatibility", () => {
  it.each(cases)("implements %s", async (_name, command, expected) => {
    const result = await runShell(command);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const marker of expected) expect(result.stdout).toContain(marker);
  }, 120_000);
});
