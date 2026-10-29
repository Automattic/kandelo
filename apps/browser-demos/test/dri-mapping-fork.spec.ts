import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

let fixture: ReturnType<typeof compileSdkFixture>;
for (const arch of ["wasm32","wasm64"] as const) {
test.describe(arch,()=>{
test.use({ serviceWorkers: "block" });
test.beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../../host/test/fixtures/dri-mapping-fork.c", import.meta.url), [], {arch,forkInstrument:true});
});
test.afterAll(() => fixture?.cleanup());

test("normal DRI mappings survive descriptor close and synchronize across fork", async ({ page, baseURL, browser }) => {
  test.setTimeout(90_000);
  const program = readFileSync(fixture.programPath);
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  const image = KandeloImageFs.create();
  image.mkdir("/bin", 0o755);
  image.writeFile("/bin/probe", program, 0o755);
  const imageBytes = await image.saveImage();
  await page.route("**/__gbm_kernel", route => route.fulfill({ body: kernelBytes }));
  await page.route("**/__gbm_image", route => route.fulfill({ body: Buffer.from(imageBytes) }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const module = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  try {
    const result = await page.evaluate(async url => {
      const { BrowserKernel } = await import(/* @vite-ignore */ url);
      const state = { stdout: "", stderr: "", diagnostics: [] as unknown[] };
      const kernel = new BrowserKernel({ kernelOwnedFs: true,
        onStdout: (data: Uint8Array) => { state.stdout += new TextDecoder().decode(data); },
        onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
        onHostDiagnostic: (value: unknown) => state.diagnostics.push(value),
      });
      (globalThis as any).__gbmProbe = { kernel, state };
      await kernel.initFromImage({
        kernelWasm: await (await fetch("/__gbm_kernel")).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch("/__gbm_image")).arrayBuffer()),
      });
      const child = await kernel.spawnFromVfs("/bin/probe", ["probe"], { uid: 1000, gid: 1000 });
      const status = await child.exit;
      await kernel.terminateProcess(child.pid, 0);
      return { ...state, status };
    }, new URL(`/@fs${module}`, baseURL).href);
    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "OK inherited DRI mapping survives descriptor and writer retirement",
      "OK middle-unmap fragments retain storage offsets across fork",
      "OK prefix and suffix unmaps preserve the surviving mapping across fork",
      "OK fixed anonymous replacement retires only the replaced DRI interval",
      "OK fixed file replacement retires only the replaced DRI interval",
    ]);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
    const evidence = fileURLToPath(new URL("../../../.context/dri-mapping-fork-guests/", import.meta.url));
    mkdirSync(evidence, { recursive: true });
    const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    writeFileSync(`${evidence}/${Date.now()}-${test.info().project.name}.json`, JSON.stringify({
      arch, engine: test.info().project.name, version: browser.version(),
      kernelSha256: hash(kernelBytes), programSha256: hash(program), imageSha256: hash(imageBytes), ...result,
    }, null, 2) + "\n");
  } finally {
    await page.evaluate(async () => { await (globalThis as any).__gbmProbe?.kernel.destroy(); });
  }
  expect(await page.evaluate(() => (globalThis as any).__gbmProbe.state.diagnostics)).toEqual([]);
  expect(errors).toEqual([]);
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});

});
}
