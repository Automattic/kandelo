import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

test("absolute futex deadlines expire in production browser workers", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { programPath, cleanup } = compileSdkFixture(
    new URL("../../../host/test/fixtures/futex-deadlines.c", import.meta.url),
  );
  try {
    // Compose on Node; the page must not own a VFS SharedArrayBuffer.
    const image = KandeloImageFs.create();
    image.mkdir("/bin", 0o755);
    image.writeFile("/bin/probe", readFileSync(programPath), 0o755);
    const imageBytes = Array.from(await image.saveImage());
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/trap-signal-test.html");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const result = await page.evaluate(async ({ moduleUrl, imageBytes }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
      let stdout = "", stderr = "";
      const diagnostics: unknown[] = [];
      const kernel = new BrowserKernel({
        onStdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); },
        onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
        onHostDiagnostic: (value: unknown) => diagnostics.push(value),
      });
      let cancelWatchdog: (() => void) | undefined;
      try {
        await kernel.initFromImage({ vfsImage: new Uint8Array(imageBytes) });
        const child = await kernel.spawnFromVfs("/bin/probe", ["futex-deadlines"]);
        const exitCode = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("futex deadline did not expire")), 15_000);
          cancelWatchdog = () => clearTimeout(timer);
          child.exit.then(resolve, reject);
        });
        return { exitCode, stdout, stderr, diagnostics };
      } finally { cancelWatchdog?.(); await kernel.destroy(); }
    }, { moduleUrl: new URL(`/@fs/${resolve(root, "host/src/browser-kernel-host.ts")}`, baseURL).href,
      imageBytes });
    expect(result).toEqual({ exitCode: 0, stdout: "FUTEX_DEADLINES_PASS\n", stderr: "", diagnostics: [] });
    expect(errors).toEqual([]);
  } finally { cleanup(); }
});
