import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const continuationModulePath = resolve(
  __dirname,
  "../../../host/src/fork-continuation.ts",
);
const moduleStateModulePath = resolve(
  __dirname,
  "../../../host/src/fork-module-state.ts",
);
const runtimeHarnessPath = resolve(
  __dirname,
  "../../../host/test/fork-instrument-runtime-harness.ts",
);
const dylinkModulePath = resolve(
  __dirname,
  "../../../host/src/dylink.ts",
);
const childWorkerPath = resolve(
  __dirname,
  "fixtures/borrowed-fork-replay-browser-worker.ts",
);
const childDylinkWorkerPath = resolve(
  __dirname,
  "fixtures/borrowed-dylink-replay-browser-worker.ts",
);
const processRuntimePath = resolve(
  __dirname,
  "fixtures/borrowed-process-runtime.ts",
);
const childActiveSideWorkerPath = resolve(
  __dirname,
  "fixtures/borrowed-active-side-replay-browser-worker.ts",
);

function buildBorrowedReplayFixture(): { bytes: number[]; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-browser-fork-borrow-"));
  try {
    const rawPath = join(dir, "borrow.wasm");
    const instrumentedPath = join(dir, "borrow.instrumented.wasm");
    const watPath = join(dir, "borrow.wat");
    writeFileSync(watPath, `(module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (import "env" "memory" (memory 16 16 shared))
      (func $leaf (result i32) call $fork)
      (func (export "run") (result i32) (local $saved i32)
        i32.const 7
        local.set $saved
        call $leaf
        local.get $saved
        i32.add))`);
    execFileSync("wat2wasm", [
      "--enable-threads",
      watPath,
      "-o",
      rawPath,
    ]);
    execFileSync(fileURLToPath(new URL(
      "../../../tools/bin/wasm-fork-instrument",
      import.meta.url,
    )), [
      rawPath,
      "-o",
      instrumentedPath,
    ]);
    return {
      bytes: [...readFileSync(instrumentedPath)],
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function buildBorrowedDylinkFixture(): { bytes: number[]; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-browser-dylink-borrow-"));
  try {
    const sourcePath = join(dir, "borrowed-side.c");
    const modulePath = join(dir, "borrowed-side.so");
    writeFileSync(sourcePath, `
      static int counter = 41;
      int get_counter(void) { return counter; }
      void inc_counter(void) { counter++; }
    `);
    execFileSync("wasm32posix-cc", [
      "-shared",
      "-fPIC",
      "-O2",
      sourcePath,
      "-o",
      modulePath,
    ]);
    return {
      bytes: [...readFileSync(modulePath)],
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function buildBorrowedActiveSideFixture(): {
  mainBytes: number[];
  sideBytes: number[];
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-browser-active-side-borrow-"));
  try {
    const build = (name: string, wat: string, side: boolean): number[] => {
      const watPath = join(dir, `${name}.wat`);
      const rawPath = join(dir, `${name}.wasm`);
      const instrumentedPath = join(dir, `${name}.instrumented.wasm`);
      writeFileSync(watPath, wat);
      execFileSync("wat2wasm", [
        "--enable-threads",
        watPath,
        "-o",
        rawPath,
      ]);
      execFileSync(fileURLToPath(new URL(
        "../../../tools/bin/wasm-fork-instrument",
        import.meta.url,
      )), [
        ...(side ? ["--entry", "env.fork"] : []),
        rawPath,
        "-o",
        instrumentedPath,
      ]);
      return [...readFileSync(instrumentedPath)];
    };
    return {
      mainBytes: build("borrowed-main", `(module
        (import "kernel" "kernel_fork" (func $fork (result i32)))
        (import "env" "memory" (memory 16 16 shared))
        (func (export "main_fork") (result i32) call $fork))`, false),
      sideBytes: build("borrowed-side", `(module
        (import "env" "memory" (memory 16 16 shared))
        (import "env" "fork" (func $fork (result i32)))
        (func $leaf (result i32) call $fork)
        (func (export "run") (result i32) (local $saved i32)
          i32.const 7
          local.set $saved
          call $leaf
          local.get $saved
          i32.add))`, true),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test("separate browser Worker borrows ABI 43 replay without consuming its parent", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBeTruthy();
  const fixture = buildBorrowedReplayFixture();
  try {
    await page.goto(new URL("/trap-signal-test.html", baseURL!).href);
    const asViteFsUrl = (path: string) =>
      new URL(`/@fs/${path}`, baseURL!).href;
    const result = await page.evaluate(
      async ({
        bytes,
        continuationModuleUrl,
        moduleStateModuleUrl,
        runtimeHarnessUrl,
        childWorkerUrl,
      }) => {
        const {
          LinkedForkContinuation,
          readLinkedFrameFormat,
        } = await import(/* @vite-ignore */ continuationModuleUrl);
        const {
          ForkModuleStateArena,
          readForkModuleStateRoot,
        } = await import(/* @vite-ignore */ moduleStateModuleUrl);
        const { SingleActivationForkRuntime } = await import(
          /* @vite-ignore */ runtimeHarnessUrl
        );
        const moduleBytes = new Uint8Array(bytes);
        const module = await WebAssembly.compile(moduleBytes);
        const linkedFormat = readLinkedFrameFormat(module);
        const memory = new WebAssembly.Memory({
          initial: 16,
          maximum: 16,
          shared: true,
        });
        const allocations: Array<{ addr: number; size: number }> = [];
        const releases: Array<{ addr: number; size: number }> = [];
        const arenaReleases: Array<{ addr: number; size: number }> = [];
        let nextAddress = 65_536;
        let nextArenaAddress = 12 * 65_536;
        const parentContinuation = new LinkedForkContinuation(
          memory,
          linkedFormat,
          (size: number) => {
            const addr = nextAddress;
            nextAddress += size;
            allocations.push({ addr, size });
            return addr;
          },
          (addr: number, size: number) => releases.push({ addr, size }),
          "borrow-parent-browser-e2e",
        );
        const parentRuntime = new SingleActivationForkRuntime({
          module,
          moduleBytes,
          memory,
          continuation: parentContinuation,
          newArena: () => new ForkModuleStateArena(
            memory,
            linkedFormat.ptrWidth,
            (size: number) => {
              const address = nextArenaAddress;
              nextArenaAddress += size;
              return address;
            },
            (addr: number, size: number) => {
              arenaReleases.push({ addr, size });
            },
            "borrow-parent-browser module state",
          ),
          label: "borrow-parent-browser-e2e",
        });
        let parentInstance: WebAssembly.Instance;
        let parentForkResult = 0;
        parentInstance = new WebAssembly.Instance(module, {
          env: {
            memory,
            ...parentRuntime.envImports,
          },
          kernel: {
            kernel_fork: () => {
              if (parentRuntime.coordinator.phaseName() === "parent-replay") {
                parentRuntime.coordinator.finishReplay();
                return parentForkResult;
              }
              parentRuntime.beginCapture();
              return 0;
            },
          },
        });
        parentRuntime.register(parentInstance);
        const parentRun = parentInstance.exports.run as () => number;

        parentRuntime.expectCaptureTransport(parentRun);
        parentRuntime.coordinator.sealCapture();
        const moduleBuffer = parentRuntime.coordinator.rootFor(0);
        const moduleStateRoot = readForkModuleStateRoot(
          memory,
          moduleBuffer,
          linkedFormat.ptrWidth,
        );
        const savedChunks = allocations.map(({ addr, size }) => ({
          addr,
          bytes: new Uint8Array(memory.buffer, addr, size).slice(),
        }));
        const savedArena = new Uint8Array(
          memory.buffer,
          moduleStateRoot,
          65_536,
        ).slice();

        const privateModuleBuffer = 15 * 65_536;
        const childWorker = new Worker(childWorkerUrl, { type: "module" });
        let childResult: {
          result: number;
          active: boolean;
          arenaActive: boolean;
        };
        try {
          childResult = await new Promise((resolve, reject) => {
            childWorker.onmessage = (event) => {
              if (event.data?.error) {
                reject(new Error(event.data.error));
                return;
              }
              resolve(event.data);
            };
            childWorker.onerror = (event) => {
              reject(new Error(event.message));
            };
            childWorker.postMessage({
              module,
              moduleBytes,
              memory,
              linkedFormat,
              moduleBuffer,
              moduleStateRoot,
              privateModuleBuffer,
            });
          });
        } finally {
          childWorker.terminate();
        }

        const chunksUnchanged = savedChunks.every(({ addr, bytes }) => {
          const current = new Uint8Array(memory.buffer, addr, bytes.length);
          return bytes.every((value, index) => current[index] === value);
        });
        const arenaUnchanged = savedArena.every((value, index) =>
          new Uint8Array(memory.buffer, moduleStateRoot, 65_536)[index] === value
        );
        const childReleases = releases.length;
        const childArenaReleases = arenaReleases.length;

        parentRuntime.coordinator.beginParentReplay();
        parentForkResult = 123;
        const finalParentResult = parentRun();

        return {
          childResult,
          childReleases,
          childArenaReleases,
          chunksUnchanged,
          arenaUnchanged,
          finalParentResult,
          parentActive: parentContinuation.hasActiveContinuation(),
          releasedInReverseOrder:
            JSON.stringify(releases)
            === JSON.stringify([...allocations].reverse()),
          arenaReleased: arenaReleases.length === 1,
        };
      },
      {
        bytes: fixture.bytes,
        continuationModuleUrl: asViteFsUrl(continuationModulePath),
        moduleStateModuleUrl: asViteFsUrl(moduleStateModulePath),
        runtimeHarnessUrl: asViteFsUrl(runtimeHarnessPath),
        childWorkerUrl: asViteFsUrl(childWorkerPath),
      },
    );

    expect(result, browserName).toEqual({
      childResult: { result: 7, active: false, arenaActive: false },
      childReleases: 0,
      childArenaReleases: 0,
      chunksUnchanged: true,
      arenaUnchanged: true,
      finalParentResult: 130,
      parentActive: false,
      releasedInReverseOrder: true,
      arenaReleased: true,
    });
  } finally {
    fixture.cleanup();
  }
});

test("borrowed side-module reconstruction does not write parent memory", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBeTruthy();
  const fixture = buildBorrowedDylinkFixture();
  try {
    await page.goto(new URL("/trap-signal-test.html", baseURL!).href);
    const asViteFsUrl = (path: string) =>
      new URL(`/@fs/${path}`, baseURL!).href;
    const result = await page.evaluate(
      async ({ bytes, dylinkModuleUrl, childWorkerUrl }) => {
        const { loadSharedLibrarySync } = await import(
          /* @vite-ignore */ dylinkModuleUrl
        );
        const memory = new WebAssembly.Memory({
          initial: 4,
          maximum: 100,
          shared: true,
        });
        const parent = loadSharedLibrarySync(
          "libborrowed-browser-side.so",
          new Uint8Array(bytes),
          {
            memory,
            table: new WebAssembly.Table({ initial: 1, element: "anyfunc" }),
            stackPointer: new WebAssembly.Global(
              { value: "i32", mutable: true },
              65_536,
            ),
            heapPointer: { value: 4_096 },
            globalSymbols: new Map(),
            got: new Map(),
            loadedLibraries: new Map(),
          },
        );
        (parent.exports.inc_counter as () => void)();
        const parentBefore = (parent.exports.get_counter as () => number)();
        const savedData = new Uint8Array(
          memory.buffer,
          parent.memoryBase,
          parent.metadata.memorySize,
        ).slice();

        const childWorker = new Worker(childWorkerUrl, { type: "module" });
        let childResult: { value?: number; error?: string };
        try {
          childResult = await new Promise((resolve, reject) => {
            childWorker.onmessage = (event) => resolve(event.data);
            childWorker.onerror = (event) => reject(new Error(event.message));
            childWorker.postMessage({
              bytes,
              memory,
              memoryBase: parent.memoryBase,
              tableBase: parent.tableBase,
              tlsBase: parent.tlsBase,
            });
          });
        } finally {
          childWorker.terminate();
        }
        if (childResult.error) throw new Error(childResult.error);

        const dataUnchanged = savedData.every((value, index) =>
          new Uint8Array(
            memory.buffer,
            parent.memoryBase,
            parent.metadata.memorySize,
          )[index] === value
        );
        return {
          parentBefore,
          childValue: childResult.value,
          dataUnchanged,
          parentAfter: (parent.exports.get_counter as () => number)(),
        };
      },
      {
        bytes: fixture.bytes,
        dylinkModuleUrl: asViteFsUrl(dylinkModulePath),
        childWorkerUrl: asViteFsUrl(childDylinkWorkerPath),
      },
    );

    expect(result, browserName).toEqual({
      parentBefore: 42,
      childValue: 42,
      dataUnchanged: true,
      parentAfter: 42,
    });
  } finally {
    fixture.cleanup();
  }
});

test("active side activation remains owned by the browser parent", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.setTimeout(120_000);
  expect(baseURL).toBeTruthy();
  const fixture = buildBorrowedActiveSideFixture();
  try {
    await page.goto(new URL("/trap-signal-test.html", baseURL!).href);
    const asViteFsUrl = (path: string) =>
      new URL(`/@fs/${path}`, baseURL!).href;
    const result = await page.evaluate(
      async ({
        mainBytes,
        sideBytes,
        continuationModuleUrl,
        moduleStateModuleUrl,
        processRuntimeUrl,
        childWorkerUrl,
      }) => {
        const {
          LinkedForkContinuation,
          readLinkedFrameFormat,
        } = await import(/* @vite-ignore */ continuationModuleUrl);
        const {
          ForkModuleStateArena,
          readForkModuleStateRoot,
        } = await import(/* @vite-ignore */ moduleStateModuleUrl);
        const { BorrowedProcessTestRuntime } = await import(
          /* @vite-ignore */ processRuntimeUrl
        );
        const mainModuleBytes = new Uint8Array(mainBytes);
        const sideModuleBytes = new Uint8Array(sideBytes);
        const mainModule = await WebAssembly.compile(mainModuleBytes);
        const sideModule = await WebAssembly.compile(sideModuleBytes);
        const memory = new WebAssembly.Memory({
          initial: 16,
          maximum: 16,
          shared: true,
        });
        const allocations: Array<{
          activationId: number;
          addr: number;
          size: number;
        }> = [];
        const releases: Array<{ addr: number; size: number }> = [];
        const arenaReleases: Array<{ addr: number; size: number }> = [];
        let nextContinuation = 65_536;
        let nextArena = 12 * 65_536;
        const newContinuation = (
          activationId: number,
          module: WebAssembly.Module,
        ) => new LinkedForkContinuation(
          memory,
          readLinkedFrameFormat(module),
          (size: number) => {
            const addr = nextContinuation;
            nextContinuation += size;
            allocations.push({ activationId, addr, size });
            return addr;
          },
          (addr: number, size: number) => releases.push({ addr, size }),
          `borrowed browser parent activation ${activationId}`,
        );
        const runtime = new BorrowedProcessTestRuntime(
          memory,
          "borrowed active-side browser parent",
        );
        const mainContinuation = newContinuation(0, mainModule);
        const sideContinuation = newContinuation(1, sideModule);
        let parentForkResult = 0;
        let parentArena: InstanceType<typeof ForkModuleStateArena> | null = null;
        const processFork = (): number => {
          if (runtime.coordinator.phaseName() === "parent-replay") {
            runtime.coordinator.finishReplay();
            return parentForkResult;
          }
          parentArena = new ForkModuleStateArena(
            memory,
            readLinkedFrameFormat(mainModule).ptrWidth,
            (size: number) => {
              const address = nextArena;
              nextArena += size;
              return address;
            },
            (addr: number, size: number) => {
              arenaReleases.push({ addr, size });
            },
            "borrowed active-side browser parent arena",
          );
          parentArena.begin();
          runtime.coordinator.beginCapture(parentArena);
          return 0;
        };
        const mainEnv = runtime.prepareActivation({
          activationId: 0,
          module: mainModule,
          moduleBytes: mainModuleBytes,
          continuation: mainContinuation,
        });
        const sideEnv = runtime.prepareActivation({
          activationId: 1,
          module: sideModule,
          moduleBytes: sideModuleBytes,
          continuation: sideContinuation,
          invokeFork: processFork,
        });
        const mainInstance = new WebAssembly.Instance(mainModule, {
          env: { memory, ...mainEnv },
          kernel: { kernel_fork: processFork },
        });
        const sideInstance = new WebAssembly.Instance(sideModule, {
          env: { memory, ...sideEnv },
        });
        runtime.registerActivation(0, mainInstance, true);
        runtime.registerActivation(1, sideInstance, true);
        const sideRun = sideInstance.exports.run as () => number;

        runtime.expectCaptureTransport(sideRun);
        runtime.coordinator.sealCapture();
        if (!parentArena) throw new Error("active-side capture lost its arena");
        const processLaunchRoot = runtime.coordinator.rootFor(1);
        if (runtime.coordinator.rootFor(0) !== 0) {
          throw new Error("inactive main activation retained a continuation");
        }
        const moduleStateRoot = readForkModuleStateRoot(
          memory,
          processLaunchRoot,
          readLinkedFrameFormat(sideModule).ptrWidth,
        );
        const sideChunkAddress = processLaunchRoot
          - readLinkedFrameFormat(sideModule).chunkHeaderSize;
        const savedSideChunk = new Uint8Array(
          memory.buffer,
          sideChunkAddress,
          65_536,
        ).slice();
        const savedArena = new Uint8Array(
          memory.buffer,
          moduleStateRoot,
          65_536,
        ).slice();
        const releasesBeforeChild = releases.length;

        const childWorker = new Worker(childWorkerUrl, { type: "module" });
        let childResult: {
          result: number;
          prefixActivations: number[];
          mainActive: boolean;
          sideActive: boolean;
          arenaActive: boolean;
        };
        try {
          childResult = await new Promise((resolve, reject) => {
            childWorker.onmessage = (event) => {
              if (event.data?.error) {
                reject(new Error(event.data.error));
                return;
              }
              resolve(event.data);
            };
            childWorker.onerror = (event) => reject(new Error(event.message));
            childWorker.postMessage({
              mainModule,
              mainBytes: mainModuleBytes,
              sideModule,
              sideBytes: sideModuleBytes,
              memory,
              processLaunchRoot,
              moduleStateRoot,
              privatePrefix: 15 * 65_536,
            });
          });
        } finally {
          childWorker.terminate();
        }

        const sideChunkUnchanged = savedSideChunk.every((value, index) =>
          new Uint8Array(memory.buffer, sideChunkAddress, 65_536)[index] === value
        );
        const arenaUnchanged = savedArena.every((value, index) =>
          new Uint8Array(memory.buffer, moduleStateRoot, 65_536)[index] === value
        );
        const releasesAfterChild = releases.length;
        parentForkResult = 123;
        runtime.coordinator.beginParentReplay();
        const parentResult = sideRun();
        const releasedAddresses = [...releases]
          .map(({ addr }) => addr)
          .sort((left, right) => left - right);
        const allocatedAddresses = allocations
          .map(({ addr }) => addr)
          .sort((left, right) => left - right);

        return {
          childResult,
          sideChunkUnchanged,
          arenaUnchanged,
          releasesBeforeChild,
          releasesAfterChild,
          parentResult,
          parentMainActive: mainContinuation.hasActiveContinuation(),
          parentSideActive: sideContinuation.hasActiveContinuation(),
          releasedEveryAllocation:
            JSON.stringify(releasedAddresses)
            === JSON.stringify(allocatedAddresses),
          arenaReleased: arenaReleases.length === 1,
        };
      },
      {
        mainBytes: fixture.mainBytes,
        sideBytes: fixture.sideBytes,
        continuationModuleUrl: asViteFsUrl(continuationModulePath),
        moduleStateModuleUrl: asViteFsUrl(moduleStateModulePath),
        processRuntimeUrl: asViteFsUrl(processRuntimePath),
        childWorkerUrl: asViteFsUrl(childActiveSideWorkerPath),
      },
    );

    expect(result, browserName).toEqual({
      childResult: {
        result: 7,
        prefixActivations: [1],
        mainActive: false,
        sideActive: false,
        arenaActive: false,
      },
      sideChunkUnchanged: true,
      arenaUnchanged: true,
      releasesBeforeChild: 1,
      releasesAfterChild: 1,
      parentResult: 130,
      parentMainActive: false,
      parentSideActive: false,
      releasedEveryAllocation: true,
      arenaReleased: true,
    });
  } finally {
    fixture.cleanup();
  }
});
