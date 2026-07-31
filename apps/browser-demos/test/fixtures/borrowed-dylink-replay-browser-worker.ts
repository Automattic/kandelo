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
  error?: string;
}

const workerScope = globalThis as unknown as {
  close(): void;
  onmessage: ((event: MessageEvent<BorrowedDylinkReplayRequest>) => void) | null;
  postMessage(message: BorrowedDylinkReplayResult): void;
};

workerScope.onmessage = (event) => {
  try {
    const { bytes, memory, memoryBase, tableBase, tlsBase } = event.data;
    const library = loadSharedLibrarySync(
      "libborrowed-browser-side.so",
      new Uint8Array(bytes),
      {
        memory,
        table: new WebAssembly.Table({ initial: 1, element: "anyfunc" }),
        stackPointer: new WebAssembly.Global(
          { value: "i32", mutable: true },
          65_536,
        ),
        allocateMemory: () => {
          throw new Error("borrowed browser side child must not allocate");
        },
        deallocateMemory: () => {
          throw new Error("borrowed browser side child must not release");
        },
        globalSymbols: new Map(),
        got: new Map(),
        loadedLibraries: new Map(),
      },
      {
        memoryBase,
        tableBase,
        tlsBase,
        memoryOwnership: "borrowed",
      },
    );
    workerScope.postMessage({
      value: (library.exports.get_counter as () => number)(),
    });
  } catch (error) {
    workerScope.postMessage({
      error: error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : String(error),
    });
  } finally {
    workerScope.close();
  }
};
