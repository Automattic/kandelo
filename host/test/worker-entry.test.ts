import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { centralizedWorkerMain } from "../src/worker-main";
import { tryResolveBinary } from "../src/binary-resolver";
import { extractHeapBase } from "../src/constants";
import { ForkExternrefProcessOwner } from "../src/fork-externref-process-owner";
import { ForkHostImportOwnerRuntime } from "../src/fork-host-import-runtime";
import { computeProcessMemoryLayout, createProcessMemory } from "../src/process-memory";
import type { CentralizedWorkerInitMessage } from "../src/worker-protocol";

const helloWasm = tryResolveBinary("programs/wasm64/hello64.wasm");
const hasBinary = !!helloWasm;

function loadProgramBytes(): ArrayBuffer {
  const buf = readFileSync(helloWasm!);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createMockPort() {
  const messages: unknown[] = [];
  return {
    postMessage(msg: unknown) {
      messages.push(msg);
    },
    on(_event: string, _handler: Function) {},
    messages,
  };
}

describe.skipIf(!hasBinary)("centralizedWorkerMain", () => {
  it("should initialize program and send ready then exit", async () => {
    const port = createMockPort();

    // Create shared memory with channel region
    const MAX_PAGES = 256; // smaller for tests
    const memory = new WebAssembly.Memory({
      initial: 17,
      maximum: MAX_PAGES,
      shared: true,
    });
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, 72 + 65536).fill(0);

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: 100,
      programBytes: loadProgramBytes(),
      memory,
      channelOffset,
      secureExec: false,
    };

    // Note: centralizedWorkerMain will call _start() which uses channel IPC.
    // Without a kernel polling the channel, syscalls will block forever.
    // We test the init/error path only — running actual programs uses
    // the full centralized-test-helper.

    // Instead, test with invalid program bytes to verify error handling
    const errorPort = createMockPort();
    const errorInitData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: 101,
      programBytes: new ArrayBuffer(0),
      memory,
      channelOffset,
      secureExec: false,
    };

    await centralizedWorkerMain(errorPort as any, errorInitData);

    expect(errorPort.messages).toHaveLength(1);
    expect((errorPort.messages[0] as any).type).toBe("error");
    expect((errorPort.messages[0] as any).pid).toBe(101);
  });
});

describe("centralizedWorkerMain program bytes", () => {
  it.each([
    ["an SDK module", new URL("../../examples/hello.wasm", import.meta.url)],
    [
      "a fork-instrumented SDK module",
      new URL("../../examples/wait_lifecycle_test.wasm", import.meta.url),
    ],
  ])("detaches the program bytes of %s before it reports ready", async (_kind, path) => {
    const pid = 102;
    const buf = readFileSync(path);
    const programBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const layout = computeProcessMemoryLayout({
      ptrWidth: 4,
      programBytes,
      heapBase: extractHeapBase(programBytes),
    });
    const externrefOwner = new ForkExternrefProcessOwner();
    const generation = externrefOwner.startGeneration(pid);
    const hostImports = new ForkHostImportOwnerRuntime(externrefOwner).createWorker({
      pid,
      generationId: generation.id,
      authorizeSender: () => {},
    });
    let detachedAtReady: boolean | undefined;
    const port = {
      postMessage(msg: { type: string }) {
        if (msg.type !== "ready") return;
        detachedAtReady = programBytes.detached;
        throw new Error("stop before _start: no kernel serves its syscalls");
      },
      on(_event: string, _handler: Function) {},
    };

    try {
      await centralizedWorkerMain(port as any, {
        type: "centralized_init",
        pid,
        programBytes,
        memory: createProcessMemory(4, layout),
        channelOffset: layout.channelOffset,
        secureExec: false,
        ptrWidth: 4,
        externrefGenerationId: generation.id,
        forkHostImports: hostImports.init,
      });
    } finally {
      hostImports.close();
      externrefOwner.releaseGeneration(generation);
    }

    expect(detachedAtReady).toBe(true);
  });
});
