import { loadSharedLibrarySync } from "../../../../host/src/dylink";

interface BorrowedDylinkReplayRequest {
  bytes: number[];
  memory: WebAssembly.Memory;
  memoryBase: number;
  tableBase: number;
  tlsBase?: number;
}

interface BorrowedDylinkReplayResult {
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
}

const workerScope = globalThis as unknown as {
  close(): void;
  onmessage:
    ((event: MessageEvent<BorrowedDylinkReplayRequest>) => void) | null;
  postMessage(message: BorrowedDylinkReplayResult): void;
};

workerScope.onmessage = (event) => {
  try {
    const { bytes, memory, memoryBase, tableBase, tlsBase } = event.data;
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      65_536,
    );
    const globalSymbols = new Map<string, number>();
    const got = new Map<string, WebAssembly.Global>();
    const loadedLibraries = new Map<string, unknown>();
    const library = loadSharedLibrarySync(
      "libborrowed-browser-side.so",
      new Uint8Array(bytes),
      {
        memory,
        table,
        stackPointer,
        allocateMemory: () => {
          throw new Error("borrowed browser side child must not allocate");
        },
        deallocateMemory: () => {
          throw new Error("borrowed browser side child must not release");
        },
        globalSymbols,
        got,
        loadedLibraries,
      },
      {
        memoryBase,
        tableBase,
        tlsBase,
        memoryOwnership: "borrowed",
      },
    );
    const tableLengthBeforeMutation = table.length;
    stackPointer.value = 77_777;
    table.grow(1);
    globalSymbols.set("__borrowed_child_only", 1);
    got.set(
      "__borrowed_child_only",
      new WebAssembly.Global({ value: "i32", mutable: true }, 2),
    );
    loadedLibraries.set("__borrowed_child_only", {});
    workerScope.postMessage({
      value: (library.exports.get_counter as () => number)(),
      privateLoaderState: {
        stackPointer: Number(stackPointer.value),
        tableLengthBeforeMutation,
        tableLengthAfterMutation: table.length,
        hasGlobalSymbol: globalSymbols.has("__borrowed_child_only"),
        hasGotEntry: got.has("__borrowed_child_only"),
        hasLoadedLibrary: loadedLibraries.has("__borrowed_child_only"),
      },
    });
  } catch (error) {
    workerScope.postMessage({
      error:
        error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error),
    });
  } finally {
    workerScope.close();
  }
};
