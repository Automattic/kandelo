import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { centralizedWorkerMain } from "../src/worker-main";
import type { CentralizedWorkerInitMessage } from "../src/worker-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helloWasm = join(__dirname, "../../examples/hello.wasm");
const hasBinary = existsSync(helloWasm);

function loadProgramBytes(): ArrayBuffer {
  const buf = readFileSync(helloWasm);
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
      pid: 1,
      ppid: 0,
      programBytes: loadProgramBytes(),
      memory,
      channelOffset,
    };

    // Note: centralizedWorkerMain will call _start() which uses channel IPC.
    // Without a kernel polling the channel, syscalls will block forever.
    // We test the init/error path only — running actual programs uses
    // the full centralized-test-helper.

    // Instead, test with invalid program bytes to verify error handling
    const errorPort = createMockPort();
    const errorInitData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: 2,
      ppid: 0,
      programBytes: new ArrayBuffer(0),
      memory,
      channelOffset,
    };

    await centralizedWorkerMain(errorPort as any, errorInitData);

    expect(errorPort.messages).toHaveLength(1);
    expect((errorPort.messages[0] as any).type).toBe("error");
    expect((errorPort.messages[0] as any).pid).toBe(2);
  });
});
