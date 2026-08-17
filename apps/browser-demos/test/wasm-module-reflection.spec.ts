import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const reflectionModulePath = resolve(
  __dirname,
  "../../../host/src/wasm-module-reflection.ts",
);
const forkArtifactPath = resolve(
  __dirname,
  "../../../local-binaries/programs/wasm32/p_01_fork_main_thread.wasm",
);

test("ABI 43 import reflection is identical across browser engines", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

  const result = await page.evaluate(async ({ reflectionUrl, artifactUrl }) => {
    const response = await fetch(artifactUrl);
    if (!response.ok) {
      throw new Error(`artifact fetch failed: ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    let nativeImportError: string | null = null;
    try {
      WebAssembly.Module.imports(module);
    } catch (error) {
      nativeImportError = error instanceof Error ? error.message : String(error);
    }

    const reflection = await import(/* @vite-ignore */ reflectionUrl);
    reflection.registerWasmModuleReflection(module, bytes);
    const imports = reflection.wasmModuleImports(module);
    const exports = reflection.wasmModuleExports(module);
    return {
      nativeImportError,
      hasKernelFork: imports.some(
        (entry: { module: string; name: string; kind: string }) =>
          entry.module === "kernel"
          && entry.name === "kernel_fork"
          && entry.kind === "function",
      ),
      hasForkUnwindTag: imports.some(
        (entry: { module: string; name: string; kind: string }) =>
          entry.module === "env"
          && entry.name === "__wpk_fork_unwind"
          && entry.kind === "tag",
      ),
      hasForkResumeExport: exports.some(
        (entry: { name: string; kind: string }) =>
          entry.name === "wpk_fork_resume_start"
          && entry.kind === "function",
      ),
    };
  }, {
    reflectionUrl: new URL(`/@fs/${reflectionModulePath}`, baseURL!).href,
    artifactUrl: new URL(`/@fs/${forkArtifactPath}`, baseURL!).href,
  });

  expect(result.hasKernelFork).toBe(true);
  expect(result.hasForkUnwindTag).toBe(true);
  expect(result.hasForkResumeExport).toBe(true);
});
