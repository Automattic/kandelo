import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const browserKernelModulePath = resolve(
  repoRoot,
  "host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(
  repoRoot,
  "host/src/vfs/memory-fs.ts",
);
const kernelWasmPath = resolve(
  repoRoot,
  "local-binaries/kernel.wasm",
);
const forkExecWasmPath = resolve(
  repoRoot,
  "local-binaries/programs/wasm32/fork-exec.wasm",
);
const execChildWasmPath = resolve(
  repoRoot,
  "local-binaries/programs/wasm32/exec-child.wasm",
);
const CHURN_ITERATIONS = 100;

test("browser retires exact-fenced process memory across repeated fork and exec", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error"
      && !message.text().startsWith("Failed to load resource:")
    ) {
      runtimeErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(
    async ({
      churnIterations,
      browserKernelUrl,
      memoryFsUrl,
      kernelBytes,
      forkExecBytes,
      execChildBytes,
    }) => {
      const { BrowserKernel } = await import(
        /* @vite-ignore */ browserKernelUrl
      );
      const { MemoryFileSystem } = await import(
        /* @vite-ignore */ memoryFsUrl
      );
      const decoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      const diagnostics: Array<{ source: string; message: string }> = [];
      const observedPids = new Set<number>();
      const kernel = new BrowserKernel({
        maxWorkers: 4,
        // The SDK's fallback brk base makes each fixture address space about
        // 17 MiB. This budget fits the legitimate concurrent parent,
        // pre-exec child, and replacement, but not twelve quarantined exec
        // generations. Passing proves that exact retirement releases host
        // allocation authority; it intentionally makes no GC/RSS claim.
        maxProcessMemoryBytes: 64 * 1024 * 1024,
        onStdout: (data: Uint8Array) => {
          stdout += decoder.decode(data);
        },
        onStderr: (data: Uint8Array) => {
          stderr += decoder.decode(data);
        },
        onHostDiagnostic: (diagnostic: {
          source: string;
          message: string;
        }) => diagnostics.push(diagnostic),
        onProcessEvent: (event: { pid: number }) => {
          observedPids.add(event.pid);
        },
      });

      try {
        const imageOwner = MemoryFileSystem.create(
          new SharedArrayBuffer(2 * 1024 * 1024),
        );
        imageOwner.mkdir("/bin", 0o755);
        imageOwner.createFileWithOwner(
          "/bin/exec-child",
          0o755,
          0,
          0,
          new Uint8Array(execChildBytes),
        );
        await kernel.initFromImage({
          kernelWasm: new Uint8Array(kernelBytes).buffer,
          vfsImage: await imageOwner.saveImage(),
        });

        const exitCodes: number[] = [];
        for (let iteration = 0; iteration < churnIterations; iteration += 1) {
          exitCodes.push(await kernel.spawn(
            new Uint8Array(forkExecBytes).buffer,
            ["fork-exec"],
          ));
          const deadline = Date.now() + 2_000;
          let remainingProcesses = await kernel.enumProcs();
          // WHY: PID 1 is the kernel's permanent init authority and has no
          // guest address space. Every spawned process generation must still
          // disappear before the next churn cycle starts.
          while (
            remainingProcesses.some(
              (process: { pid: number }) => process.pid !== 1,
            )
          ) {
            if (Date.now() >= deadline) {
              throw new Error(
                `process table stayed live after iteration ${iteration}: ${
                  JSON.stringify(remainingProcesses)
                }`,
              );
            }
            await new Promise<void>((resolvePoll) =>
              setTimeout(resolvePoll, 10)
            );
            remainingProcesses = await kernel.enumProcs();
          }
        }
        return {
          exitCodes,
          stdout,
          stderr,
          diagnostics,
          observedPidCount: observedPids.size,
          remainingProcesses: await kernel.enumProcs(),
        };
      } finally {
        await kernel.destroy();
      }
    },
    {
      churnIterations: CHURN_ITERATIONS,
      browserKernelUrl: new URL(
        `/@fs/${browserKernelModulePath}`,
        baseURL,
      ).href,
      memoryFsUrl: new URL(`/@fs/${memoryFsModulePath}`, baseURL).href,
      kernelBytes: Array.from(readFileSync(kernelWasmPath)),
      forkExecBytes: Array.from(readFileSync(forkExecWasmPath)),
      execChildBytes: Array.from(readFileSync(execChildWasmPath)),
    },
  );

  expect(result.exitCodes, runtimeErrors.join("\n")).toEqual(
    Array.from({ length: CHURN_ITERATIONS }, () => 0),
  );
  expect(result.stdout.match(/child exited with 42/g)).toHaveLength(
    CHURN_ITERATIONS,
  );
  expect(result.stderr).toBe("");
  expect(result.diagnostics).toEqual([]);
  expect(result.observedPidCount).toBeGreaterThan(CHURN_ITERATIONS);
  expect(result.remainingProcesses).toEqual([
    expect.objectContaining({ pid: 1, ppid: 0, comm: "init" }),
  ]);
  expect(runtimeErrors).toEqual([]);
});
