import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

test.use({ serviceWorkers: "block" });

// This package contains the pinned, unchanged upstream assertion method.
// Run its ordinary SDK binary through the real worker/kernel/EGL path;
// source command replays and renderer doubles cannot satisfy this gate.
test("rebuilt upstream EGL surfaceless and context query subsets cover every advertised GLES2 config", async ({ page, baseURL, browserName, browser }) => {
  test.setTimeout(120_000);
  const program = readFileSync(resolveBinary("programs/graphics-cts-egl.wasm"));
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  const image = KandeloImageFs.create();
  image.setImageCapacity(16 * 1024 * 1024);
  image.mkdir("/bin", 0o755);
  image.writeFile("/bin/graphics-cts-egl", program, 0o755);
  const imageBytes = await image.saveImage();
  const kernelUrl = new URL("/__graphics_cts_kernel", baseURL).href;
  const imageUrl = new URL("/__graphics_cts_image", baseURL).href;
  await page.route(kernelUrl, route => route.fulfill({ body: kernelBytes }));
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(imageBytes) }));
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  try {
    await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
      const { BrowserKernel } = await import(moduleUrl);
      const state = { output: "", exit: null as number | null, diagnostics: [] as unknown[] };
      const scope = globalThis as any;
      scope.__graphicsCtsState = state;
      const kernel = new BrowserKernel({ kernelOwnedFs: true,
        onStdout: (data: Uint8Array) => { state.output += new TextDecoder().decode(data); },
        onStderr: (data: Uint8Array) => { state.output += new TextDecoder().decode(data); },
        onHostDiagnostic: (diagnostic: unknown) => state.diagnostics.push(diagnostic),
      });
      scope.__graphicsCtsKernel = kernel;
      await kernel.initFromImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
      });
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 16;
      document.body.replaceChildren(canvas);
      kernel.kmsSetDisplaySize(1, 16, 16);
      kernel.kmsAttachCanvas(1, canvas.transferControlToOffscreen(), new SharedArrayBuffer(32), {
        mode: "webgl2-scanout",
      });
      const child = await kernel.spawnFromVfs("/bin/graphics-cts-egl", ["graphics-cts-egl"], { uid: 1000, gid: 1000 });
      child.exit.then((code: number) => { state.exit = code; });
    }, { moduleUrl: new URL(`/@fs${modulePath}`, baseURL).href, kernelUrl, imageUrl });
    await expect.poll(() => page.evaluate(() => (globalThis as any).__graphicsCtsState), {
      timeout: 60_000,
    }).toMatchObject({ exit: expect.any(Number) });
    const { output, exit, diagnostics } = await page.evaluate(() => (globalThis as any).__graphicsCtsState);
    writeFileSync(new URL(`../../../.context/graphics-cts-guest-${browserName}.json`, import.meta.url), JSON.stringify({
      engine: browserName, version: browser.version(),
      programSha256: createHash("sha256").update(program).digest("hex"),
      kernelSha256: createHash("sha256").update(kernelBytes).digest("hex"), output, exit, diagnostics,
    }, null, 2) + "\n");
    expect(exit, output).toBe(0);
    expect(diagnostics, output).toEqual([]);
    const summary = /CTS-SUBSET PASS surfaceless_context configs=(\d+)/.exec(output);
    expect(summary, output).not.toBeNull();
    const configs = Number(summary![1]);
    expect(configs, output).toBeGreaterThan(0);
    expect(output.match(/Creating OpenGL ES 2 context with config ID /g), output).toHaveLength(configs);
    const querySummary = /CTS-SUBSET PASS query_context configs=(\d+) windows=(\d+) pbuffers=(\d+) contexts=(\d+) checks=(\d+)/.exec(output);
    expect(querySummary, output).not.toBeNull();
    const [,queryConfigs,windows,pbuffers,contexts,checks] = querySummary!.map(Number);
    expect(queryConfigs, output).toBe(configs);
    expect(windows, output).toBeGreaterThan(0);
    expect(pbuffers, output).toBeGreaterThan(0);
    expect(contexts, output).toBe(windows+pbuffers);
    expect(contexts, output).toBeGreaterThanOrEqual(configs);
    expect(checks, output).toBe(contexts*4);
    expect(output.match(/^  Pass$/gm), output).toHaveLength(configs+checks);
    expect(output, output).not.toMatch(/CTS-SUBSET FAIL|eglMakeCurrent\(\) failed|Failed to make context current/);
  } finally {
    await page.evaluate(() => (globalThis as any).__graphicsCtsKernel?.destroy());
  }
  expect(pageErrors).toEqual([]);
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});
