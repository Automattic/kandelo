import { describe, expect, it } from "vitest";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { ABI_SYSCALLS } from "../src/generated/abi";
import {
  ForkShareAddressSpace,
  GROUP_HEADER_BYTES,
  PAGE_TABLE_BYTES,
} from "../src/fork-share-address-space";

const PAGE = 65536;

interface TraceChannel {
  pid: number;
  channelOffset: number;
  memory: WebAssembly.Memory;
  source: ForkShareAddressSpace;
}

interface TraceWorker {
  formatSyscallEntry(
    channel: TraceChannel,
    syscallNr: number,
    args: number[],
  ): string;
}

function format(source: ForkShareAddressSpace, syscallNr: number, args: number[]) {
  const worker = createCentralizedKernelWorkerTestDouble() as unknown as TraceWorker;
  return worker.formatSyscallEntry(
    { pid: 100, channelOffset: 0, memory: source.memory, source },
    syscallNr,
    args,
  );
}

/** Guest page 1 reads from physical page 3. */
function remapped() {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 32, shared: true });
  const group = 4 * PAGE;
  const table = group + GROUP_HEADER_BYTES;
  const space = new ForkShareAddressSpace(memory, { table, group });
  const words = new Int32Array(memory.buffer);
  words[table / 4 + 1] = 2 * PAGE;
  words[(table + PAGE_TABLE_BYTES) / 4 + 1] = 2 * PAGE;
  return { bytes: new Uint8Array(memory.buffer), space };
}

function encode(text: string) {
  return new TextEncoder().encode(text);
}

describe("CentralizedKernelWorker syscall trace", () => {
  it("reads a path at its guest address", () => {
    const { bytes, space } = remapped();
    bytes.set(encode("/foo\0"), PAGE + 16);
    bytes.set(encode("/bar\0"), 3 * PAGE + 16);

    expect(format(space, ABI_SYSCALLS.Open, [PAGE + 16, 0, 0]))
      .toBe('[100] open("/bar", 0x0, 0o0)');
  });

  it("reads a path that crosses into a page with another mapping", () => {
    const { bytes, space } = remapped();
    bytes.set(encode("/fo"), PAGE - 3);
    bytes.set(encode("o\0"), 3 * PAGE);

    expect(format(space, ABI_SYSCALLS.Chdir, [PAGE - 3]))
      .toBe('[100] chdir("/foo")');
  });

  it("reads write bytes at their guest address", () => {
    const { bytes, space } = remapped();
    bytes.set(encode("foo"), PAGE + 16);
    bytes.set(encode("bar"), 3 * PAGE + 16);

    expect(format(space, ABI_SYSCALLS.Write, [1, PAGE + 16, 3]))
      .toBe('[100] write(1, 3, "bar")');
  });

  it("reads pollfd entries at their guest address", () => {
    const { bytes, space } = remapped();
    const view = new DataView(bytes.buffer);
    view.setInt32(PAGE + 16, 5, true);
    view.setInt32(3 * PAGE + 16, 7, true);
    view.setInt16(3 * PAGE + 20, 0x1, true);
    view.setInt16(3 * PAGE + 22, 0x10, true);

    expect(format(space, ABI_SYSCALLS.Poll, [PAGE + 16, 1, -1]))
      .toBe("[100] poll(1, -1, [{fd:7,events:0x1,revents:0x10}])");
  });
});
