import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

// This is the same compiled guest probe used by the dedicated Node worker.
// Exercise the browser's real exec path, not a mocked resource transition.
test.use({ serviceWorkers: "block" });

test("cursor buffers retain their pixels across browser guest exec", async ({ page, baseURL }) => {
  const image = KandeloImageFs.create();
  image.mkdir("/bin", 0o755);
  image.writeFile("/bin/kms-cursor", readFileSync(fileURLToPath(new URL(
    "../../../host/test/fixtures/kms-cursor.wasm", import.meta.url,
  ))), 0o755);
  const imageBytes = await image.saveImage();
  const kernelUrl = new URL("/__cursor_exec_kernel.wasm", baseURL).href;
  const imageUrl = new URL("/__cursor_exec_image.vfs", baseURL).href;
  await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(imageBytes) }));
  // Use an inert COI-served document: this probe supplies its own kernel
  // and image and must not activate the test runner's unrelated boot assets.
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
    const { BrowserKernel } = await import(moduleUrl);
    let stdout = "", stderr = "";
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
    });
    try {
      await kernel.initFromImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
      });
      const child = await kernel.spawnFromVfs("/bin/kms-cursor", ["kms-cursor", "exec"],
        { uid: 1000, gid: 1000 });
      return { exitCode: await child.exit, stdout, stderr };
    } finally { await kernel.destroy(); }
  }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, kernelUrl, imageUrl });
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain("kms-cursor-exec: ok");
});
