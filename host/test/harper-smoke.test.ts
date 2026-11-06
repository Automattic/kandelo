import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerDeclaredShellLazyArchive, SHELL_LAZY_ARCHIVE_SPECS } from "../../images/vfs/scripts/shell-lazy-archives";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../src/binary-resolver";
import { ABI_VERSION } from "../src/generated/abi";
import { NodeKernelHost } from "../src/node-kernel-host";
import { ensureDirRecursive } from "../src/vfs/image-helpers";
import type { LazyDownloadEvent } from "../src/vfs/lazy-download-event";
import { exerciseHarperLsp, HarperLspProbe } from "./support/harper-lsp-probe";

describe("Harper package on Kandelo", () => {
  it("shares one lazy archive between the CLI and LS, lints files and stdin, and serves LSP diagnostics and fixes", async () => {
    const fs = KandeloImageFs.create();
    fs.setImageCapacity(192 * 1024 * 1024);
    fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
    for (const dir of ["/usr/bin", "/home/maker", "/tmp"]) ensureDirRecursive(fs, dir);
    fs.chown("/home/maker", 1000, 1000);
    fs.writeFile("/home/maker/probe.md", new TextEncoder().encode("This is an test.\n"));
    fs.writeFile("/home/maker/first.md", new TextEncoder().encode("This is an test.\n"));
    fs.writeFile("/home/maker/second.md", new TextEncoder().encode("This is a test.\n"));
    fs.writeFile("/home/maker/code.c", new TextEncoder().encode("// This is an test.\nint main(void) { return 0; }\n"));
    const spec = SHELL_LAZY_ARCHIVE_SPECS.find(spec => spec.id === "harper")!;
    const url = "https://kandelo.invalid/harper.zip";
    const archive = registerDeclaredShellLazyArchive(fs, { ...spec, archiveUrl: url },
      resolverPath => resolveBinary(resolverPath));
    const assets = [{ url, bytes: archive.bytes, size: archive.bytes.length,
      sha256: createHash("sha256").update(archive.bytes).digest("hex") }];
    let stdout = "";
    let stderr = "";
    let peer: HarperLspProbe | undefined;
    const host = new NodeKernelHost({
      rootfsImage: await fs.saveImage(), rootfsLazyAssets: assets,
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); peer?.accept(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    });
    const downloads: LazyDownloadEvent[] = [];
    host.subscribeLazyDownloads(event => downloads.push(event));
    const env = ["HOME=/home/maker", "PATH=/usr/bin:/bin", "LANG=C.UTF-8"];
    try {
      await host.init(new Uint8Array(readFileSync(resolveBinary("kernel.wasm"))).buffer);
      expect(downloads).toEqual([]);
      const runCli = async (args: string[], stdin = "") => {
        stdout = ""; stderr = "";
        const { exit } = await host.spawnFromVfs("/usr/bin/harper-cli", ["harper-cli", ...args], {
          stdin: new TextEncoder().encode(stdin), env, uid: 1000, gid: 1000,
        });
        return { code: await exit, stdout, stderr };
      };
      const bad = await runCli(["lint", "--format", "json"], "This is an test.\n");
      expect(bad.code, bad.stderr).toBe(1);
      expect(JSON.parse(bad.stdout)[0].lints.some((lint: any) => lint.rule === "AnA" && lint.suggestions.includes("Replace with: “a”"))).toBe(true);
      expect(downloads.filter(event => event.status === "complete").map(event => event.url)).toEqual([assets[0].url]);
      const clean = await runCli(["lint", "--format", "json"], "This is a test.\n");
      expect(clean.code, clean.stderr).toBe(0);
      expect(JSON.parse(clean.stdout)[0].lint_count).toBe(0);
      const batch = await runCli(["lint", "--format", "json", "/home/maker/first.md", "/home/maker/second.md"]);
      expect(batch.code, batch.stderr).toBe(1);
      expect(JSON.parse(batch.stdout).map((file: any) => file.lint_count)).toEqual([1, 0]);
      const comments = await runCli(["lint", "--format", "json", "/home/maker/code.c"]);
      expect(comments.code, comments.stderr).toBe(1);
      expect(JSON.parse(comments.stdout)[0].lints.map((lint: any) => lint.matched_text)).toEqual(["an"]);
      let pid = -1;
      peer = new HarperLspProbe((bytes, eof) => eof ? host.setStdinData(pid, bytes) : host.appendStdinData(pid, bytes));
      const started = await host.spawnFromVfs("/usr/bin/harper-ls", ["harper-ls", "--stdio"], {
        env, uid: 1000, gid: 1000, onStarted: value => { pid = value; },
      });
      const result = await exerciseHarperLsp(peer);
      expect(await started.exit, stderr).toBe(0);
      expect(result.initialization.serverInfo.name).toBe("harper-ls");
      expect(result.initialization.capabilities.codeActionProvider).toBe(true);
      expect(result.actions.some((action: any) => action.edit?.changes?.["file:///home/maker/probe.md"]?.some((edit: any) => edit.newText === "a"))).toBe(true);
      expect(result.corrected).toEqual([]);
      expect(downloads.filter(event => event.status === "complete").map(event => event.url)).toEqual(assets.map(asset => asset.url));
    } finally {
      await host.destroy();
    }
  }, 120_000);
});
