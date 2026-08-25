import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const browserKernelModulePath = resolve(
  here,
  "../../../host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(
  here,
  "../../../host/src/vfs/memory-fs.ts",
);
const probePath = resolve(
  here,
  "../../../local-binaries/programs/wasm32/secure-exec-probe.wasm",
);
const SECURE_STDOUT_SENTINEL = "secure-stdout-sentinel\n";
const SECURE_STDERR_SENTINEL = "secure-stderr-sentinel\n";

test("ordinary startup receives the kernel-owned non-secure marker", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });
  await page.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const asViteUrl = (path: string) => new URL(`/@fs${path}`, baseURL).href;
  const result = await page.evaluate(async ({
    browserKernelModuleUrl,
    memoryFsModuleUrl,
    probeBytes,
  }) => {
    const { BrowserKernel } = await import(
      /* @vite-ignore */ browserKernelModuleUrl
    );
    const { MemoryFileSystem } = await import(
      /* @vite-ignore */ memoryFsModuleUrl
    );
    const image = MemoryFileSystem.create(
      new SharedArrayBuffer(2 * 1024 * 1024),
    );
    let stdout = "";
    let stderr = "";
    const hostDiagnostics: unknown[] = [];
    const kernel = new BrowserKernel({
      maxWorkers: 2,
      onStdout: (data: Uint8Array) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (data: Uint8Array) => {
        stderr += new TextDecoder().decode(data);
      },
      onHostDiagnostic: (diagnostic: unknown) => {
        hostDiagnostics.push(diagnostic);
      },
    });
    await kernel.initFromImage({ vfsImage: await image.saveImage() });
    try {
      const exitCode = await kernel.spawn(
        new Uint8Array(probeBytes).buffer,
        ["secure-exec-probe", "startup-target", "0", "0"],
        { env: ["KANDELO_UNTRUSTED=ordinary-browser-startup"] },
      );
      return { exitCode, stdout, stderr, hostDiagnostics };
    } finally {
      await kernel.destroy();
    }
  }, {
    browserKernelModuleUrl: asViteUrl(browserKernelModulePath),
    memoryFsModuleUrl: asViteUrl(memoryFsModulePath),
    probeBytes: Array.from(readFileSync(probePath)),
  });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe(
    "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1\n",
  );
  expect(result.stderr).toBe("");
  expect(result.hostDiagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("browser worker preserves postcommit secure-exec state", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });
  await page.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const asViteUrl = (path: string) => new URL(`/@fs${path}`, baseURL).href;
  const result = await page.evaluate(async ({
    browserKernelModuleUrl,
    memoryFsModuleUrl,
    probeBytes,
  }) => {
    const { BrowserKernel } = await import(
      /* @vite-ignore */ browserKernelModuleUrl
    );
    const { MemoryFileSystem } = await import(
      /* @vite-ignore */ memoryFsModuleUrl
    );
    const probe = Uint8Array.from(probeBytes);
    const imageFs = MemoryFileSystem.create(
      new SharedArrayBuffer(Math.max(4 * 1024 * 1024, probe.byteLength * 2)),
    );
    imageFs.mkdir("/bin", 0o755);
    imageFs.mkdir("/usr", 0o755);
    imageFs.mkdir("/usr/bin", 0o755);
    imageFs.createFileWithOwner(
      "/bin/secure-parent",
      0o4755,
      0,
      0,
      probe,
    );
    imageFs.createFileWithOwner(
      "/bin/secure-child",
      0o755,
      0,
      0,
      probe,
    );
    imageFs.createFileWithOwner("/usr/bin/login", 0o4755, 0, 0, probe);
    const image = await imageFs.saveImage();

    const run = async (
      vfsImage: Uint8Array,
      argv: string[],
      nosuid = false,
    ) => {
      let stdout = "";
      let stderr = "";
      const hostDiagnostics: unknown[] = [];
      const kernel = new BrowserKernel({
        maxWorkers: 4,
        onStdout: (data: Uint8Array) => {
          stdout += new TextDecoder().decode(data);
        },
        onStderr: (data: Uint8Array) => {
          stderr += new TextDecoder().decode(data);
        },
        onHostDiagnostic: (diagnostic: unknown) => {
          hostDiagnostics.push(diagnostic);
        },
      });
      await kernel.initFromImage({
        vfsImage,
        ...(nosuid
          ? {
              rootfsMountSpec: [{
                path: "/",
                source: "image" as const,
                readonly: false,
                nosuid: true,
              }],
            }
          : {}),
      });
      try {
        const exitCode = await kernel.spawn(
          probe.buffer,
          argv,
          { uid: 1000, gid: 1000 },
        );
        return { exitCode, stdout, stderr, hostDiagnostics };
      } finally {
        await kernel.destroy();
      }
    };

    return {
      writableImage: await run(image, [
        "secure-exec-probe", "launch", "/usr/bin/login",
        "startup-target", "1", "0",
      ]),
      nosuid: await run(image, [
        "secure-exec-probe", "launch", "/bin/secure-parent",
        "startup-target", "0", "0",
      ], true),
      spawnPreserve: await run(image, [
        "secure-exec-probe", "launch", "/usr/bin/login",
        "spawn-parent", "1", "0", "/bin/secure-child", "startup-target",
      ]),
      spawnReset: await run(image, [
        "secure-exec-probe", "launch", "/usr/bin/login",
        "spawn-parent", "1", "1", "/bin/secure-child", "startup-target",
      ]),
      stdioOpen: await run(image, [
        "secure-exec-probe", "launch", "/usr/bin/login",
        "stdio-target", "1", "0",
      ]),
      stdioClosed: await run(image, [
        "secure-exec-probe", "launch", "/usr/bin/login",
        "stdio-target", "1", "7",
      ]),
    };
  }, {
    browserKernelModuleUrl: asViteUrl(browserKernelModulePath),
    memoryFsModuleUrl: asViteUrl(memoryFsModulePath),
    probeBytes: Array.from(readFileSync(probePath)),
  });

  expect(result.writableImage.exitCode, result.writableImage.stderr).toBe(0);
  expect(result.writableImage.stdout).toBe(
    "secure=1 ctor_secure=1 untrusted_visible=0 ctor_visible=0\n",
  );
  expect(result.nosuid.exitCode, result.nosuid.stderr).toBe(0);
  expect(result.nosuid.stdout).toBe(
    "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1\n",
  );
  expect(result.spawnPreserve.exitCode, result.spawnPreserve.stderr).toBe(0);
  expect(result.spawnPreserve.stdout).toContain(
    "secure=1 ctor_secure=1 untrusted_visible=0 ctor_visible=0",
  );
  expect(result.spawnReset.exitCode, result.spawnReset.stderr).toBe(0);
  expect(result.spawnReset.stdout).toContain(
    "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1",
  );
  expect(result.stdioOpen.exitCode, result.stdioOpen.stderr).toBe(0);
  expect(result.stdioOpen.stdout).toContain(SECURE_STDOUT_SENTINEL);
  expect(result.stdioOpen.stderr).toContain(SECURE_STDERR_SENTINEL);
  expect(result.stdioClosed.exitCode, result.stdioClosed.stderr).toBe(0);
  expect(result.stdioClosed.stdout).not.toContain(SECURE_STDOUT_SENTINEL);
  expect(result.stdioClosed.stderr).not.toContain(SECURE_STDERR_SENTINEL);
  for (const acceptance of Object.values(result)) {
    expect(acceptance.hostDiagnostics).toEqual([]);
  }
  expect(runtimeErrors).toEqual([]);
});
