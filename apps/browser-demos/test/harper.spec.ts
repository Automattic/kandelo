import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { registerDeclaredShellLazyArchive, SHELL_LAZY_ARCHIVE_SPECS } from "../../../images/vfs/scripts/shell-lazy-archives";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { ensureDirRecursive } from "../../../host/src/vfs/image-helpers";

// An isolated guest image exercises the packaged executables and canonical
// lazy paths without rebuilding the full shell product or its other packages.
test("Harper shares one lazy archive for CLI linting and LSP diagnostics and corrections in a browser", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const fs = KandeloImageFs.create();
  fs.setImageCapacity(192 * 1024 * 1024);
  fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
  for (const path of ["/usr/bin", "/home/maker", "/tmp"]) ensureDirRecursive(fs, path);
  fs.chown("/home/maker", 1000, 1000);
  fs.writeFile("/home/maker/probe.md", new TextEncoder().encode("This is an test.\n"));
  fs.writeFile("/home/maker/code.c", new TextEncoder().encode("// This is an test.\nint main(void) { return 0; }\n"));
  const archiveUrl = new URL("/harper-probe.zip", baseURL).href;
  const spec = SHELL_LAZY_ARCHIVE_SPECS.find(spec => spec.id === "harper")!;
  const archive = registerDeclaredShellLazyArchive(fs, { ...spec, archiveUrl },
    resolverPath => resolveBinary(resolverPath));
  let archiveRequests = 0;
  await page.route(archiveUrl, route => {
    archiveRequests++;
    return route.fulfill({ body: Buffer.from(archive.bytes), contentType: "application/zip" });
  });
  const imageUrl = new URL("/harper-probe.vfs", baseURL).href;
  const kernelUrl = new URL("/harper-probe-kernel.wasm", baseURL).href;
  const image = Buffer.from(await fs.saveImage());
  await page.route(imageUrl, route => route.fulfill({ body: image }));
  await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  const blankUrl = new URL("/harper-probe", baseURL).href;
  await page.route(blankUrl, route => route.fulfill({
    body: "<!doctype html><title>Harper package probe</title>", contentType: "text/html",
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
  }));
  await page.goto(blankUrl);
  const moduleUrl = (relative: string) => new URL(
    `/@fs/${fileURLToPath(new URL(relative, import.meta.url))}`, baseURL).href;
  const results = await page.evaluate(async ({ kernelModule, probeModule, kernelUrl, imageUrl }) => {
    const { BrowserKernel } = await import(kernelModule);
    const { HarperLspProbe, exerciseHarperLsp } = await import(probeModule);
    let stdout = "";
    let stderr = "";
    let peer: any;
    const downloads: any[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); peer?.accept(bytes); },
      onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
    });
    kernel.subscribeLazyDownloads((event: any) => downloads.push(event));
    const env = ["HOME=/home/maker", "PATH=/usr/bin:/bin", "LANG=C.UTF-8"];
    try {
      await kernel.initFromImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
      });
      const downloadsAtBoot = downloads.length;
      const run = async (text: string, file?: string) => {
        stdout = ""; stderr = "";
        const { exit } = await kernel.spawnFromVfs("/usr/bin/harper-cli", ["harper-cli", "lint", "--format", "json", ...(file ? [file] : [])], {
          env, uid: 1000, gid: 1000, stdin: new TextEncoder().encode(text),
        });
        return { code: await exit, stdout, stderr };
      };
      const bad = await run("This is an test.\n");
      const clean = await run("This is a test.\n");
      const comments = await run("", "/home/maker/code.c");
      const downloadsAfterCli = downloads.filter(event => event.status === "complete").map(event => event.url);
      let pid = -1;
      peer = new HarperLspProbe((bytes: Uint8Array, eof: boolean) => eof ? kernel.setStdinData(pid, bytes) : kernel.appendStdinData(pid, bytes));
      const started = await kernel.spawnFromVfs("/usr/bin/harper-ls", ["harper-ls", "--stdio"], {
        env, uid: 1000, gid: 1000,
      });
      pid = started.pid;
      const lsp = await exerciseHarperLsp(peer);
      return {
        bad, clean, comments, lsp, lspExit: await started.exit, stderr, downloadsAtBoot, downloadsAfterCli,
        completedDownloads: downloads.filter(event => event.status === "complete").map(event => event.url),
      };
    } catch (error) {
      throw new Error(`${String(error)}\nstdout: ${stdout}\nstderr: ${stderr}`);
    } finally {
      await kernel.destroy();
    }
  }, {
    kernelModule: moduleUrl("../../../host/src/browser-kernel-host.ts"),
    probeModule: moduleUrl("../../../host/test/support/harper-lsp-probe.ts"),
    kernelUrl, imageUrl,
  });
  expect(results.bad.code, results.bad.stderr).toBe(1);
  expect(JSON.parse(results.bad.stdout)[0].lints.some((lint: any) => lint.rule === "AnA" && lint.suggestions.includes("Replace with: “a”"))).toBe(true);
  expect(results.clean.code, results.clean.stderr).toBe(0);
  expect(JSON.parse(results.clean.stdout)[0].lint_count).toBe(0);
  expect(results.comments.code, results.comments.stderr).toBe(1);
  expect(JSON.parse(results.comments.stdout)[0].lints.map((lint: any) => lint.matched_text)).toEqual(["an"]);
  expect(results.lsp.initialization.serverInfo.name).toBe("harper-ls");
  expect(results.lsp.actions.some((action: any) => action.edit?.changes?.["file:///home/maker/probe.md"]?.some((edit: any) => edit.newText === "a"))).toBe(true);
  expect(results.lsp.corrected).toEqual([]);
  expect(results.lspExit, results.stderr).toBe(0);
  expect(results.downloadsAtBoot).toBe(0);
  expect(results.downloadsAfterCli).toEqual([archiveUrl]);
  expect(results.completedDownloads).toEqual([archiveUrl]);
  expect(archiveRequests).toBe(1);
});
