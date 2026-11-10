import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

const fixtures = new Map<string, ReturnType<typeof compileSdkFixture>>();
const evidence = mkdtempSync(fileURLToPath(new URL("../../../.scratch/egl-fork-guests-", import.meta.url)));
test.use({ serviceWorkers: "block" });
test.beforeAll(() => {
  for (const arch of ["wasm32", "wasm64"] as const) {
    fixtures.set(arch, compileSdkFixture(new URL("../../../programs/egl_fork_reinitialize.c", import.meta.url), ["-pthread", "-lEGL", "-lGLESv2", "-lgbm", "-ldrm"], { arch, forkInstrument: true }));
  }
});
test.afterAll(() => { for (const fixture of fixtures.values()) fixture.cleanup(); });

for (const arch of ["wasm32", "wasm64"] as const) {
for (const scenario of [
  { mode: "pixels", label: "creates a child renderer and preserves inherited image storage",
    expected: "OK EGL child renderer and inherited storage", role: "target-renderer-and-storage" },
  { mode: "borrow-pixels", label: "retires vanished peer image borrows and preserves caller/storage ownership",
    expected: "OK target image borrow fork custody", role: "target-borrow-fork-lifetime-and-pixels" },
] as const) {
test(`normal ${arch} EGL guest ${scenario.label}`, async ({ page, baseURL, browser }) => {
  test.setTimeout(120_000);
  const program = readFileSync(fixtures.get(arch)!.programPath);
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  const image = KandeloImageFs.create();
  image.mkdir("/bin", 0o755);
  image.writeFile("/bin/probe", program, 0o755);
  const imageBytes = await image.saveImage();
  await page.route("**/__eglFork_kernel", route => route.fulfill({ body: kernelBytes }));
  await page.route("**/__eglFork_image", route => route.fulfill({ body: Buffer.from(imageBytes) }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const module = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  try {
    const result = await page.evaluate(async ({ url, mode }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ url);
      const state = { stdout: "", stderr: "", diagnostics: [] as unknown[] };
      const kernel = new BrowserKernel({ kernelOwnedFs: true,
        onStdout: (data: Uint8Array) => { state.stdout += new TextDecoder().decode(data); },
        onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
        onHostDiagnostic: (value: unknown) => state.diagnostics.push(value),
      });
      (globalThis as any).__eglForkProbe = { kernel, state };
      await kernel.initFromImage({
        kernelWasm: await (await fetch("/__eglFork_kernel")).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch("/__eglFork_image")).arrayBuffer()),
      });
      const child = await kernel.spawnFromVfs("/bin/probe", ["probe", mode], { uid: 1000, gid: 1000 });
      const status = await child.exit;
      await kernel.terminateProcess(child.pid, 0);
      return { ...state, status };
    }, { url: new URL(`/@fs${module}`, baseURL).href, mode: scenario.mode });
    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe(scenario.expected);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
    const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    writeFileSync(`${evidence}/${Date.now()}-${test.info().project.name}-${arch}-${scenario.mode}.json`, JSON.stringify({
      arch, mode: scenario.mode, evidenceRole: scenario.role,
      engine: test.info().project.name, version: browser.version(),
      kernelSha256: hash(kernelBytes), programSha256: hash(program), imageSha256: hash(imageBytes), ...result,
    }, null, 2) + "\n");
  } finally {
    await page.evaluate(async () => { await (globalThis as any).__eglForkProbe?.kernel.destroy(); });
  }
  expect(await page.evaluate(() => (globalThis as any).__eglForkProbe.state.diagnostics)).toEqual([]);
  expect(errors).toEqual([]);
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});
}
}
