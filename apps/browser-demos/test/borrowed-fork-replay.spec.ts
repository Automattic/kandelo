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
const dylinkModulePath = resolve(
  __dirname,
  "../../../host/src/dylink.ts",
);
const childDylinkWorkerPath = resolve(
  __dirname,
  "fixtures/borrowed-dylink-replay-browser-worker.ts",
);

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
        const parentTable = new WebAssembly.Table({
          initial: 1,
          element: "anyfunc",
        });
        const parentStackPointer = new WebAssembly.Global(
          { value: "i32", mutable: true },
          65_536,
        );
        const parentGlobalSymbols = new Map<string, number>();
        const parentGot = new Map<string, WebAssembly.Global>();
        const parentLoadedLibraries = new Map<string, unknown>();
        const parent = loadSharedLibrarySync(
          "libborrowed-browser-side.so",
          new Uint8Array(bytes),
          {
            memory,
            table: parentTable,
            stackPointer: parentStackPointer,
            heapPointer: { value: 4_096 },
            globalSymbols: parentGlobalSymbols,
            got: parentGot,
            loadedLibraries: parentLoadedLibraries,
          },
        );
        (parent.exports.inc_counter as () => void)();
        const parentBefore = (parent.exports.get_counter as () => number)();
        const savedData = new Uint8Array(
          memory.buffer,
          parent.memoryBase,
          parent.metadata.memorySize,
        ).slice();
        const parentLoaderState = {
          stackPointer: Number(parentStackPointer.value),
          tableLength: parentTable.length,
          globalSymbols: parentGlobalSymbols.size,
          got: parentGot.size,
          loadedLibraries: parentLoadedLibraries.size,
        };

        const childWorker = new Worker(childWorkerUrl, { type: "module" });
        let childResult: {
          value?: number;
          privateLoaderState?: {
            stackPointer: number;
            tableLengthBeforeMutation: number;
            tableLengthAfterMutation: number;
            hasGlobalSymbol: boolean;
            hasGotEntry: boolean;
            hasLoadedLibrary: boolean;
          };
          error?: string;
        };
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
          childLoaderState: childResult.privateLoaderState,
          dataUnchanged,
          parentAfter: (parent.exports.get_counter as () => number)(),
          parentLoaderStateUnchanged:
            Number(parentStackPointer.value) === parentLoaderState.stackPointer
            && parentTable.length === parentLoaderState.tableLength
            && parentGlobalSymbols.size === parentLoaderState.globalSymbols
            && parentGot.size === parentLoaderState.got
            && parentLoadedLibraries.size === parentLoaderState.loadedLibraries
            && !parentGlobalSymbols.has("__borrowed_child_only")
            && !parentGot.has("__borrowed_child_only")
            && !parentLoadedLibraries.has("__borrowed_child_only"),
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
      childLoaderState: {
        stackPointer: 77_777,
        tableLengthBeforeMutation: 3,
        tableLengthAfterMutation: 4,
        hasGlobalSymbol: true,
        hasGotEntry: true,
        hasLoadedLibrary: true,
      },
      dataUnchanged: true,
      parentAfter: 42,
      parentLoaderStateUnchanged: true,
    });
  } finally {
    fixture.cleanup();
  }
});
