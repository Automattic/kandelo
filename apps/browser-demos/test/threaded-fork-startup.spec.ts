import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./support/streamed-artifacts";
import { buildProgramsFixture, requireBuiltFixtures } from "./support/program-fixtures";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const cases = [
  { name: "nested fork from a pthread", file: "programs/wasm32/fork-from-thread.wasm",
    marker: "GRANDCHILD_THREAD: ok" },
  { name: "concurrent forks from pthreads", file: "programs/wasm32/fork-from-concurrent-threads.wasm",
    marker: "PASS: 16 concurrent fork pairs" },
];
const repoRoot = resolve(import.meta.dirname, "../../..");

for (const probe of cases) {
  test(`${probe.name} preserves metadata after worker startup`, async ({ page, baseURL, serveArtifacts }) => {
    test.setTimeout(120_000);
    const path = buildProgramsFixture(probe.file);
    requireBuiltFixtures([path]);
    const urls = await serveArtifacts({
      program: { path, contentType: "application/wasm" },
      kernel: { path: resolveBinary("kernel.wasm"), contentType: "application/wasm" },
      image: { bytes: await KandeloImageFs.create().saveImage(), contentType: "application/octet-stream" },
    });
    await page.goto(new URL("/trap-signal-test.html", baseURL!).href);
    const result = await page.evaluate(async ({ urls, hostUrl }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ hostUrl);
      const [program, kernelWasm, image] = await Promise.all(
        [urls.program, urls.kernel, urls.image].map(async url => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`fixture HTTP ${response.status}`);
          return response.arrayBuffer();
        }),
      );
      const decoder = new TextDecoder();
      let stdout = "", stderr = "";
      const diagnostics: unknown[] = [];
      const kernel = new BrowserKernel({ kernelOwnedFs: true,
        onStdout: (bytes: Uint8Array) => { stdout += decoder.decode(bytes); },
        onStderr: (bytes: Uint8Array) => { stderr += decoder.decode(bytes); },
        onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
      });
      try {
        await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(image) });
        const exitCode = await kernel.spawn(program, ["threaded-fork"]);
        return { exitCode, stdout, stderr, diagnostics, processes: await kernel.enumProcs() };
      } finally { await kernel.destroy(); }
    }, { urls, hostUrl: new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL!).href });
    await test.info().attach("threaded-fork-result", {
      body: JSON.stringify(result), contentType: "application/json",
    });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain(probe.marker);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
    expect(result.processes.map((process: { pid: number }) => process.pid)).toEqual([1]);
  });
}
