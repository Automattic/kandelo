import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../../host/src/constants";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const programPath = process.env.KANDELO_CADDY_WASM;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("Caddy serves a VFS file over HTTP", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  test.skip(!programPath, "Build the caddy package and set KANDELO_CADDY_WASM");
  expect(baseURL).toBeTruthy();

  const programBytes = readFileSync(programPath!);
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  expect(readWasmCustomSectionPayload(
    Uint8Array.from(programBytes).buffer, ABI_CONTRACT_SECTION,
  )).toEqual(readWasmCustomSectionPayload(
    Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
  ));

  const image = KandeloImageFs.create();
  image.setImageCapacity(2 * 1024 * 1024);
  for (const directory of ["/tmp", "/var", "/var/www", "/var/www/html"]) {
    image.mkdir(directory, 0o755);
  }
  image.createFileWithOwner("/var/www/html/index.html", 0o644, 0, 0,
    new TextEncoder().encode("Kandelo Caddy static response\n"));

  const programUrl = new URL(`/@fs/${programPath}`, baseURL!).href;
  const kernelUrl = new URL("/__caddy_kernel__.wasm", baseURL!).href;
  const browserKernelUrl = new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL!).href;
  await page.route(kernelUrl, (route) => route.fulfill({
    status: 200, contentType: "application/wasm", body: kernelBytes,
  }));
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

  const result = await page.evaluate(async ({ programUrl, kernelUrl, browserKernelUrl, imageBytes }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
    const [programResponse, kernelResponse] = await Promise.all([fetch(programUrl), fetch(kernelUrl)]);
    if (!programResponse.ok || !kernelResponse.ok) throw new Error("Caddy artifacts failed to load");
    const [program, kernelWasm] = await Promise.all([
      programResponse.arrayBuffer(), kernelResponse.arrayBuffer(),
    ]);
    const decoder = new TextDecoder();
    let stderr = "";
    const diagnostics: unknown[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStderr: (data: Uint8Array) => { stderr += decoder.decode(data); },
      onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
    });
    let serverPid = 0;
    try {
      await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(imageBytes) });
      const exit = kernel.spawn(program, [
        "caddy", "file-server", "--root", "/var/www/html", "--listen", ":8080", "--no-compress",
      ], { env: ["HOME=/tmp", "TMPDIR=/tmp"], onStarted: (pid: number) => { serverPid = pid; } });
      let serverExit: number | undefined;
      exit.then((code: number) => { serverExit = code; }).catch(() => {});
      let response: Awaited<ReturnType<typeof kernel.fetchInKernel>> | undefined;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (serverExit !== undefined) throw new Error(`Caddy exited before readiness: ${serverExit}\n${stderr}\n${JSON.stringify(diagnostics).slice(0, 2000)}`);
        try {
          response = await kernel.fetchInKernel(8080, {
            method: "GET", url: "/", headers: { Host: "localhost:8080" }, body: null,
          }, { timeoutMs: 10_000 });
          break;
        } catch (error) {
          if (!String(error).includes("No in-kernel listener")) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        }
      }
      if (!response) throw new Error(`Caddy did not listen on 8080\n${stderr}`);
      return { status: response.status, body: decoder.decode(response.body), stderr, diagnostics };
    } finally {
      if (serverPid !== 0) await kernel.signalProcess(serverPid, 15).catch(() => {});
      await kernel.destroy();
    }
  }, { programUrl, kernelUrl, browserKernelUrl, imageBytes: Array.from(await image.saveImage()) });

  expect(result.status, JSON.stringify(result)).toBe(200);
  expect(result.body).toBe("Kandelo Caddy static response\n");
  expect(result.stderr).not.toContain("panic");
  expect(result.diagnostics).toEqual([]);
});
