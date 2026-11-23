import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "../../../apps/browser-demos/playwright-test";
import type { HostDiagnostic } from "../../../host/src/host-diagnostic";
import { NodeKernelHost } from "../../../host/src/node-kernel-host";

const image = process.env.KANDELO_ZIG_GUEST_IMAGE;
if (!image) throw new Error("Set KANDELO_ZIG_GUEST_IMAGE to the prepared guest Zig smoke image");
const kernel = resolve(import.meta.dirname, "../../../target/wasm32-unknown-unknown/release/kandelo_kernel.wasm");
const shell = "/bin/bash";
const cwd = "/guest-zig-smoke";
const env = ["PATH=/zig-tools/bin:/usr/bin:/bin", "HOME=/tmp"];
const argv = [shell, "-ec", [
  "zig version",
  "bash check-cache.sh",
  "zig build-exe main.zig -femit-bin=main.wasm",
  "./main.wasm",
  "zig build -j1",
  "./zig-out/bin/guest-zig-smoke.wasm",
].join("\n")];

async function check(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: HostDiagnostic[];
}) {
  const output = result.stdout + result.stderr;
  await test.info().attach("guest output", { body: output, contentType: "text/plain" });
  await test.info().attach("host diagnostics", {
    body: JSON.stringify(result.diagnostics),
    contentType: "application/json",
  });
  expect(result.exitCode, output).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([
    "0.17.1",
    "SDK identity invalidated cached Zig objects and archives",
    "zig build inside Kandelo passed",
    "zig build inside Kandelo passed",
  ]);
}

test("Node compiles and runs Zig inside Kandelo", async () => {
  test.setTimeout(900_000);
  let stdout = "";
  let stderr = "";
  const diagnostics: HostDiagnostic[] = [];
  const host = new NodeKernelHost({
    rootfsImage: await readFile(image),
    onStdout: (_pid, data) => { stdout += Buffer.from(data).toString(); },
    onStderr: (_pid, data) => { stderr += Buffer.from(data).toString(); },
    onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  try {
    const bytes = await readFile(kernel);
    await host.init(new Uint8Array(bytes).buffer);
    const { exit } = await host.spawnFromVfs(shell, argv, { cwd, env });
    await check({ exitCode: await exit, stdout, stderr, diagnostics });
  } finally {
    await host.destroy();
  }
});

test("browser compiles and runs Zig inside Kandelo", async ({ page }) => {
  test.setTimeout(900_000);
  await page.route("**/__guest-zig-smoke", route => route.fulfill({
    contentType: "text/html",
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
    body: "<!doctype html><title>Kandelo Zig guest compiler smoke test</title>",
  }));
  await page.goto("/__guest-zig-smoke");
  const result = await page.evaluate(async ({ cwd, env, argv, runtimeUrl, imageUrl, kernelUrl }) => {
    const { BrowserKernel } = await import(runtimeUrl) as typeof import("../../../host/src/browser-kernel-host");
    const decoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    const diagnostics: HostDiagnostic[] = [];
    const host = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: data => { stdout += decoder.decode(data); },
      onStderr: data => { stderr += decoder.decode(data); },
      onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
    });
    async function fetchFixture(url: string) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.arrayBuffer();
    }
    try {
      const [kernelWasm, fileSystem] = await Promise.all([fetchFixture(kernelUrl), fetchFixture(imageUrl)]);
      await host.initFromImage({ kernelWasm, vfsImage: new Uint8Array(fileSystem) });
      const { exit } = await host.spawnFromVfs(argv[0], argv, { cwd, env });
      return { exitCode: await exit, stdout, stderr, diagnostics };
    } finally {
      await host.destroy();
    }
  }, {
    cwd, env, argv,
    runtimeUrl: `/@fs${resolve(import.meta.dirname, "../../../host/src/browser-kernel-host.ts")}`,
    imageUrl: `/@fs${resolve(image)}`,
    kernelUrl: `/@fs${kernel}`,
  });
  await check(result);
});
