import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const browserKernelPath = resolve(repoRoot, "host/src/browser-kernel-host.ts");
const memoryFsPath = resolve(repoRoot, "host/src/vfs/memory-fs.ts");
const fixturePaths = {
  wasm32: resolve(repoRoot, "examples/select_signal_test.wasm"),
  wasm64: resolve(repoRoot, "examples/select_signal_test.wasm64.wasm"),
};

test("BrowserKernel runs the ppoll/pselect signal matrix and wait4 rejection", async ({
  browserName,
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(
    async ({ browserKernelUrl, memoryFsUrl, wasm32Bytes, wasm64Bytes }) => {
      const { BrowserKernel } = await import(
        /* @vite-ignore */ browserKernelUrl
      );
      const { MemoryFileSystem } = await import(
        /* @vite-ignore */ memoryFsUrl
      );
      const decoder = new TextDecoder();
      const pendingMarker = "TASK16_GATE=";
      const restartMarker = "TASK16_RESTART_GATE=";
      const timeoutMarker = "TASK16_TIMEOUT_GATE=";
      const blockedMarker = "TASK16_BLOCK\n";
      const sigalrm = 14;
      const sigterm = 15;

      const run = async (bytes: number[], arch: string) => {
        let stdout = "";
        let stderr = "";
        let markerBuffer = "";
        let pid: number | undefined;
        let resolvePid!: () => void;
        const pidReady = new Promise<void>((resolve) => { resolvePid = resolve; });
        let pendingSignals = 0;
        let blockedSignals = 0;
        let restartSignals = 0;
        let timeoutGates = 0;
        let injectionFailure: string | undefined;
        let injectionChain = Promise.resolve();

        const signal = (signum: number, kind: string) => {
          injectionChain = injectionChain.then(async () => {
            await pidReady;
            if (pid === undefined) {
              throw new Error(`${kind} arrived before BrowserKernel exposed pid`);
            }
            if (!(await kernel.signalProcess(pid, signum))) {
              throw new Error(`BrowserKernel rejected ${kind}`);
            }
          }).catch((error) => {
            injectionFailure =
              error instanceof Error ? error.message : String(error);
          });
        };

        const releaseGate = (
          rawAddress: string,
          signum: number | undefined,
          kind: string,
          delayMs = 0,
        ) => {
          injectionChain = injectionChain.then(async () => {
            await pidReady;
            if (pid === undefined) {
              throw new Error(`${kind} arrived before BrowserKernel exposed pid`);
            }
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            const address = Number.parseInt(rawAddress, 10);
            const memory = kernel.getProcessMemory(pid);
            if (
              !Number.isSafeInteger(address) ||
              address < 0 ||
              address % Int32Array.BYTES_PER_ELEMENT !== 0 ||
              memory === undefined ||
              address + Int32Array.BYTES_PER_ELEMENT > memory.buffer.byteLength
            ) {
              throw new Error(`invalid BrowserKernel ${kind} gate ${rawAddress}`);
            }
            if (
              signum !== undefined &&
              !(await kernel.signalProcess(pid, signum))
            ) {
              throw new Error(`BrowserKernel rejected ${kind}`);
            }
            Atomics.store(
              new Int32Array(memory.buffer),
              address / Int32Array.BYTES_PER_ELEMENT,
              1,
            );
          }).catch((error) => {
            injectionFailure =
              error instanceof Error ? error.message : String(error);
          });
        };

        const parseMarkers = () => {
          for (;;) {
            const pendingAt = markerBuffer.indexOf(pendingMarker);
            const restartAt = markerBuffer.indexOf(restartMarker);
            const timeoutAt = markerBuffer.indexOf(timeoutMarker);
            const blockedAt = markerBuffer.indexOf(blockedMarker);
            const candidates = [
              [pendingAt, "pending"] as const,
              [restartAt, "restart"] as const,
              [timeoutAt, "timeout"] as const,
              [blockedAt, "blocked"] as const,
            ].filter(([at]) => at >= 0).sort(([left], [right]) => left - right);
            const next = candidates[0];
            if (!next) return;
            const [at, kind] = next;
            if (kind === "blocked") {
              markerBuffer = markerBuffer.slice(at + blockedMarker.length);
              blockedSignals += 1;
              setTimeout(() => signal(sigalrm, "blocked SIGALRM"), 50);
              continue;
            }
            const marker = kind === "restart"
              ? restartMarker
              : kind === "timeout"
                ? timeoutMarker
                : pendingMarker;
            const lineEnd = markerBuffer.indexOf("\n", at);
            if (lineEnd < 0) return;
            const rawAddress = markerBuffer.slice(at + marker.length, lineEnd);
            markerBuffer = markerBuffer.slice(lineEnd + 1);
            if (kind === "restart") {
              restartSignals += 1;
              releaseGate(
                rawAddress,
                sigterm,
                "restart-window SIGTERM",
                250,
              );
            } else if (kind === "timeout") {
              timeoutGates += 1;
              releaseGate(rawAddress, undefined, "timeout release", 250);
            } else {
              pendingSignals += 1;
              releaseGate(rawAddress, sigalrm, "pending SIGALRM");
            }
          }
        };

        const kernel = new BrowserKernel({
          maxWorkers: 4,
          onStdout: (data: Uint8Array) => {
            const text = decoder.decode(data, { stream: true });
            stdout += text;
            markerBuffer += text;
            parseMarkers();
          },
          onStderr: (data: Uint8Array) => {
            stderr += decoder.decode(data, { stream: true });
          },
        });
        try {
          const image = MemoryFileSystem.create(
            new SharedArrayBuffer(256 * 1024),
          );
          await kernel.initFromImage({ vfsImage: await image.saveImage() });
          const exitCode = await kernel.spawn(
            new Uint8Array(bytes).buffer,
            ["select_signal_test", "--browser-gate"],
            { onStarted: (startedPid: number) => {
              pid = startedPid;
              resolvePid();
            } },
          );
          await injectionChain;
          stdout += decoder.decode();
          stderr += decoder.decode();
          return {
            arch,
            exitCode,
            stdout,
            stderr,
            pendingSignals,
            blockedSignals,
            restartSignals,
            timeoutGates,
            injectionFailure,
          };
        } finally {
          await kernel.destroy();
        }
      };

      const wasm32 = await run(wasm32Bytes, "wasm32");
      const memory64Supported = WebAssembly.validate(
        new Uint8Array(wasm64Bytes),
      );
      const wasm64 = memory64Supported
        ? await run(wasm64Bytes, "wasm64")
        : null;
      return { wasm32, wasm64, memory64Supported };
    },
    {
      browserKernelUrl: new URL(`/@fs/${browserKernelPath}`, baseURL).href,
      memoryFsUrl: new URL(`/@fs/${memoryFsPath}`, baseURL).href,
      wasm32Bytes: Array.from(readFileSync(fixturePaths.wasm32)),
      wasm64Bytes: Array.from(readFileSync(fixturePaths.wasm64)),
    },
  );

  const assertMatrix = (matrix: typeof result.wasm32) => {
    expect(matrix.injectionFailure).toBeUndefined();
    expect(matrix.exitCode, matrix.stderr).toBe(0);
    expect(matrix.pendingSignals).toBe(8);
    expect(matrix.blockedSignals).toBe(14);
    expect(matrix.restartSignals).toBe(1);
    expect(matrix.timeoutGates).toBe(2);
    expect(matrix.stdout).toContain(
      "PASS ppoll/pselect signal mask interruption matrix",
    );
    expect(matrix.stderr).toBe("");
  };

  assertMatrix(result.wasm32);
  if (browserName === "webkit") {
    expect(result.memory64Supported).toBe(false);
    expect(result.wasm64).toBeNull();
  } else {
    expect(result.memory64Supported).toBe(true);
    expect(result.wasm64).not.toBeNull();
    assertMatrix(result.wasm64!);
  }
});
