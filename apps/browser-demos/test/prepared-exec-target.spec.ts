import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const browserKernelModulePath = resolve(
  here,
  "../../../host/src/browser-kernel-host.ts",
);
// The Rust image writer. Its wasm arrives as bytes from Node, the shape the
// program fixtures already use; the bridge no longer imports node builtins,
// so a page can transform it like any other module.
const imageFsModulePath = resolve(
  here,
  "../../../images/vfs/lib/kandelo-image-fs.ts",
);
const imageModuleWasmPath = resolve(
  here,
  "../../../local-binaries/kandelo_image_module32.wasm",
);
const lifecycleProgramPath = resolve(
  here,
  "../../../local-binaries/programs/wasm32/vfork-lifecycle.wasm",
);
const execChildPath = resolve(
  here,
  "../../../local-binaries/programs/wasm32/exec-child.wasm",
);

function bytes(path: string): number[] {
  return Array.from(readFileSync(path));
}

test("a replacement Worker failure after exact-target commit is fatal", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  const asViteUrl = (path: string) => new URL(`/@fs/${path}`, baseURL).href;
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(async ({
    browserKernelModuleUrl,
    imageFsModuleUrl,
    imageModuleBytes,
    lifecycleBytes,
    childBytes,
  }) => {
    const { BrowserKernel } = await import(
      /* @vite-ignore */ browserKernelModuleUrl
    );
    const { KandeloImageFs } = await import(
      /* @vite-ignore */ imageFsModuleUrl
    );
    const decoder = new TextDecoder();
    let stdout = "";
    const diagnostics: Array<{
      status?: number;
      source: string;
      message: string;
    }> = [];
    const image = KandeloImageFs.create(new Uint8Array(imageModuleBytes));
    image.mkdir("/bin", 0o755);
    image.mkdir("/tmp", 0o755);
    image.createFileWithOwner(
      "/bin/vfork-exec-child",
      0o755,
      0,
      0,
      new Uint8Array(childBytes),
    );
    const kernel = new BrowserKernel({
      maxWorkers: 4,
      env: ["KANDELO_TEST_EXEC_WORKER_CONSTRUCTION_FAILURE=once"],
      onStdout: (data: Uint8Array) => {
        stdout += decoder.decode(data);
      },
      onHostDiagnostic: (diagnostic: {
        status?: number;
        source: string;
        message: string;
      }) => diagnostics.push(diagnostic),
    });
    await kernel.initFromImage({ vfsImage: await image.saveImage() });
    try {
      const exitCode = await kernel.spawn(
        new Uint8Array(lifecycleBytes).buffer,
        ["prepared-exec-postcommit-failure"],
      );
      return { exitCode, stdout, diagnostics };
    } finally {
      await kernel.destroy();
    }
  }, {
    browserKernelModuleUrl: asViteUrl(browserKernelModulePath),
    imageFsModuleUrl: asViteUrl(imageFsModulePath),
    imageModuleBytes: Array.from(readFileSync(imageModuleWasmPath)),
    lifecycleBytes: bytes(lifecycleProgramPath),
    childBytes: bytes(execChildPath),
  });

  expect(result.stdout).toContain("PARENT_AFTER_EXEC_COMMIT");
  expect(result.stdout).not.toContain("argc=2");
  expect(result.stdout).not.toContain("PARENT_REAPED_EXEC_CHILD");
  expect(result.stdout).not.toContain("PASS: VFORK_LIFECYCLE");
  // The parent resumes, observes the child's fatal SIGSEGV status instead of
  // the fixture's ordinary status 42, and truthfully fails that cycle.
  expect(result.exitCode).toBe(5);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      status: 139,
      source: "exec post-commit transition",
      message: expect.stringContaining("injected exec Worker construction failure"),
    }),
  ]);
});
