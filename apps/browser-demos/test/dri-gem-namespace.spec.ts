/** Real C guests exercise DRM-file ownership on each browser host. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

test.use({ serviceWorkers: "block" });
let fixture: ReturnType<typeof compileSdkFixture>;
test.beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../../host/test/fixtures/dri-gem-namespace.c", import.meta.url), [], {
    forkInstrument: true,
  });
});
test.afterAll(() => fixture?.cleanup());

for (const mode of ["namespace", "prime"]) {
  test(`guest DRM file preserves ${mode} ownership`, async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    const image = KandeloImageFs.create();
    image.mkdir("/bin", 0o755);
    image.writeFile("/bin/probe", readFileSync(fixture.programPath), 0o755);
    const imageBytes = await image.saveImage();
    await page.route("**/__gem_kernel", route => route.fulfill({
      body: readFileSync(resolveBinary("kernel.wasm")),
    }));
    await page.route("**/__gem_image", route => route.fulfill({ body: Buffer.from(imageBytes) }));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
    const result = await page.evaluate(async ({ moduleUrl, mode }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
      const state = { stdout: "", stderr: "", diagnostics: [] as unknown[] };
      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        onStdout: (data: Uint8Array) => { state.stdout += new TextDecoder().decode(data); },
        onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
        onHostDiagnostic: (diagnostic: unknown) => state.diagnostics.push(diagnostic),
      });
      try {
        await kernel.initFromImage({
          kernelWasm: await (await fetch("/__gem_kernel")).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch("/__gem_image")).arrayBuffer()),
        });
        const child = await kernel.spawnFromVfs("/bin/probe", ["probe", mode], { uid: 1000, gid: 1000 });
        const exitCode = await child.exit;
        return { ...state, exitCode };
      } finally {
        await kernel.destroy();
      }
    }, { moduleUrl: new URL(`/@fs${modulePath}`, baseURL).href, mode });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain(mode === "prime" ? "prime namespace: ok" : "inherited namespace: ok");
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
    expect(errors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}
