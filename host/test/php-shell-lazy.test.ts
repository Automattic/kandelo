import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { LazyDownloadEvent } from "../src/vfs/lazy-download-event";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

describe("PHP CLI in the base shell", () => {
  it("defers PHP until first use and reuses it through PATH and /bin/php", async () => {
    const shell = new Uint8Array(readFileSync(resolveBinary("programs/wasm32/shell.vfs.zst")));
    const php = new Uint8Array(readFileSync(resolveBinary("programs/php/php.wasm")));
    const kernel = new Uint8Array(readFileSync(resolveBinary("kernel.wasm")));
    const image = KandeloImageFs.create();
    image.loadImage(shell);
    expect(image.isPathDeferred("/usr/bin/php")).toBe(true);
    expect(image.readlink("/bin/php")).toBe("/usr/bin/php");
    expect(image.stat("/usr/bin/php").size).toBe(php.byteLength);
    expect(image.stat("/usr/bin/php").mode & 0o777).toBe(0o755);

    const base = "https://kandelo.invalid/";
    const url = `${base}binaries/programs/wasm32/php/php.wasm`;
    const reference = "kandelo-lazy:programs/php/php.wasm";
    const downloads: LazyDownloadEvent[] = [];
    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      rootfsImage: shell,
      rootfsLazyUrlBase: base,
      rootfsLazyUrlMap: { [reference]: url },
      rootfsLazyAssets: [{
        url,
        sha256: createHash("sha256").update(php).digest("hex"),
        size: php.byteLength,
        bytes: php,
      }],
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      onLazyDownload: (event) => { downloads.push(event); },
    });
    const run = async (command: string) => {
      stdout = "";
      stderr = "";
      const { exit } = await host.spawnFromVfs("/usr/bin/bash", ["bash", "-lc", command], {
        env: ["PATH=/usr/bin:/bin", "HOME=/home/maker", "USER=maker", "TMPDIR=/tmp"],
        cwd: "/home/maker",
        uid: 1000,
        gid: 1000,
        stdin: new Uint8Array(),
      });
      return { exitCode: await exit, stdout, stderr };
    };
    try {
      await host.init(kernel.buffer);
      expect(await run("printf 'shell ready\\n'")).toEqual({
        exitCode: 0, stdout: "shell ready\n", stderr: "",
      });
      expect(downloads).toEqual([]);
      const first = await run("php -r 'echo 6 * 7, PHP_EOL;'");
      expect(first, JSON.stringify(downloads)).toEqual({
        exitCode: 0, stdout: "42\n", stderr: "",
      });
      expect(await run("/bin/php -r 'echo PHP_SAPI, PHP_EOL;'")).toEqual({
        exitCode: 0, stdout: "cli\n", stderr: "",
      });
      expect(downloads.filter(({ status }) => status === "started")).toHaveLength(1);
      expect(downloads.filter(({ status }) => status === "complete")).toHaveLength(1);
      expect(downloads.filter(({ status }) => status === "error")).toEqual([]);
      expect(downloads.every((event) => event.url === url)).toBe(true);
    } finally {
      await host.destroy();
    }
  }, 120_000);
});
