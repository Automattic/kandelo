import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSourceOnlyBinarySnapshotSession, tryResolveBinaries } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import type { LazyDownloadEvent } from "../../../../host/src/vfs/lazy-download-event";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";

const names = ["kernel.wasm", "programs/wasm32/shell.vfs.zst"];
const sourceOnly = process.env.WASM_POSIX_RESOLUTION_POLICY === "source-only-v1";
const artifacts = sourceOnly
  ? createSourceOnlyBinarySnapshotSession().snapshots(names, 128 * 1024 * 1024)
    .map((snapshot) => snapshot?.bytes ?? null)
  : tryResolveBinaries(names).map((path) => path === null ? null : new Uint8Array(readFileSync(path)));
const available = artifacts.every((bytes) => bytes !== null);
if (!available && sourceOnly) throw new Error("Build browser-main-shell before Composer acceptance");

describe.skipIf(!available)("Composer in the Node-host shell", () => {
  it("submits a character-by-character choice with carriage return", async () => {
    const [kernel, shell] = artifacts as Uint8Array[];
    let output = "";
    const host = new NodeKernelHost({
      rootfsImage: shell!,
      onPtyOutput: (_pid, bytes) => { output += new TextDecoder().decode(bytes); },
    });
    try {
      await host.init(kernel!.buffer.slice(kernel!.byteOffset, kernel!.byteOffset + kernel!.byteLength) as ArrayBuffer);
      const { pid, exit } = await host.spawnFromVfs("/bin/bash", ["bash", "-lc", `composer --version >/dev/null && php -d extension=/usr/lib/composer/phar.so -r 'require "phar:///usr/share/composer/composer.phar/vendor/autoload.php"; $helper = new Symfony\\Component\\Console\\Helper\\QuestionHelper; $question = new Symfony\\Component\\Console\\Question\\ChoiceQuestion("Pick a fixture:", ["first", "second"]); $answer = $helper->ask(new Symfony\\Component\\Console\\Input\\ArgvInput, new Symfony\\Component\\Console\\Output\\ConsoleOutput, $question); echo "CHOICE=", $answer, PHP_EOL;'`], {
        env: ["HOME=/home/maker", "USER=maker", "PATH=/usr/bin:/bin", "TERM=xterm", "NO_COLOR=1"],
        cwd: "/home/maker", uid: 1000, gid: 1000, pty: true,
      });
      await expect.poll(() => output, { timeout: 120_000 }).toContain("[1] second");
      // Symfony prints the prompt before changing the terminal mode.
      await new Promise(resolve => setTimeout(resolve, 1000));
      host.ptyWrite(pid, new TextEncoder().encode("1"));
      await expect.poll(() => output).toContain("> 1");
      host.ptyWrite(pid, new Uint8Array([13]));
      await expect.poll(() => output, { timeout: 15_000 }).toContain("CHOICE=second");
      expect(await exit, output).toBe(0);
    } finally {
      await host.destroy();
    }
  }, 180_000);

  it("loads on first use, reuses its archive, and generates a working autoloader", async () => {
    const [kernel, shell] = artifacts as Uint8Array[];
    const image = KandeloImageFs.create();
    image.loadImage(shell!);
    expect(image.isPathDeferred("/usr/bin/php")).toBe(true);
    expect(image.isPathDeferred("/usr/bin/composer")).toBe(true);
    const downloads: LazyDownloadEvent[] = [];
    let output = "";
    const host = new NodeKernelHost({
      rootfsImage: shell!,
      onStdout: (_pid, bytes) => { output += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { output += new TextDecoder().decode(bytes); },
      onLazyDownload: (event) => { downloads.push(event); },
    });
    async function run(command: string) {
      output = "";
      const { exit } = await host.spawnFromVfs("/bin/bash", ["bash", "-lc", command], {
        env: ["HOME=/home/maker", "USER=maker", "LOGNAME=maker", "PATH=/usr/bin:/bin"],
        cwd: "/home/maker", uid: 1000, gid: 1000, stdin: new Uint8Array(),
      });
      expect(await exit, output).toBe(0);
      return output;
    }
    const composerDownloads = () => downloads.filter((event) =>
      event.url.endsWith("composer.zip") && event.status === "complete");
    try {
      await host.init(kernel!.buffer.slice(kernel!.byteOffset, kernel!.byteOffset + kernel!.byteLength) as ArrayBuffer);
      await run("printf 'ready\\n'");
      expect(composerDownloads()).toHaveLength(0);
      expect(await run("composer --version --no-ansi")).toContain("Composer version 2.10.3");
      expect(composerDownloads()).toHaveLength(1);
      expect(await run("/bin/composer --version --no-ansi")).toContain("Composer version 2.10.3");
      const result = await run(`set -eu
        mkdir -p "$HOME/composer smoke/src"
        cd "$HOME/composer smoke"
        printf '%s' '{"name":"kandelo/smoke","autoload":{"classmap":["src/"]}}' > composer.json
        printf '%s' '<?php class Smoke { public static function answer() { return 42; } }' > src/Smoke.php
        composer --working-dir "$HOME/composer smoke" dump-autoload --no-interaction --no-plugins --no-scripts
        php -r 'require "vendor/autoload.php"; echo "AUTOLOAD=", Smoke::answer(), PHP_EOL;'
      `);
      expect(result).toContain("AUTOLOAD=42");
      expect(composerDownloads()).toHaveLength(1);
      expect(downloads.filter((event) => event.status === "error")).toEqual([]);
    } finally {
      await host.destroy();
    }
  }, 180_000);
});
