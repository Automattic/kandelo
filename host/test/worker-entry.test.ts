import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { workerMain } from "../src/worker-main";
import { NodePlatformIO } from "../src/platform/node";
import type { WorkerInitMessage } from "../src/worker-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWasmBytes(): ArrayBuffer {
  const wasmPath = join(__dirname, "../wasm/wasm_posix_kernel.wasm");
  const buf = readFileSync(wasmPath);
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

describe("workerMain", () => {
  it("should initialize kernel and send ready message", async () => {
    const port = createMockPort();
    const initData: WorkerInitMessage = {
      type: "init",
      pid: 1,
      ppid: 0,
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 1,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
    };

    await workerMain(port as any, initData, () => new NodePlatformIO());

    expect(port.messages).toHaveLength(1);
    expect(port.messages[0]).toEqual({ type: "ready", pid: 1 });
  });

  it("should send error message on invalid wasm bytes", async () => {
    const port = createMockPort();
    const initData: WorkerInitMessage = {
      type: "init",
      pid: 2,
      ppid: 0,
      wasmBytes: new ArrayBuffer(0),
      kernelConfig: {
        maxWorkers: 1,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
    };

    await workerMain(port as any, initData, () => new NodePlatformIO());

    expect(port.messages).toHaveLength(1);
    expect((port.messages[0] as any).type).toBe("error");
    expect((port.messages[0] as any).pid).toBe(2);
  });
});
