import { describe, expect, it } from "vitest";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { ABI_SYSCALLS } from "../src/generated/abi";
import {
  GROUP_HEADER_BYTES,
  PAGE_TABLE_BYTES,
  ProcessAddressSpace,
} from "../src/process-address-space";

const PAGE = 65536;

interface TraceChannel {
  pid: number;
  channelOffset: number;
  addressSpace: ProcessAddressSpace;
}

interface TraceWorker {
  formatSyscallEntry(
    channel: TraceChannel,
    syscallNr: number,
    args: number[],
  ): string;
}

function format(addressSpace: ProcessAddressSpace, syscallNr: number, args: number[]) {
  const worker = createCentralizedKernelWorkerTestDouble() as unknown as TraceWorker;
  return worker.formatSyscallEntry({ pid: 100, channelOffset: 0, addressSpace }, syscallNr, args);
}

function identity() {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  return { bytes: new Uint8Array(memory.buffer), space: new ProcessAddressSpace(memory, null) };
}

/** Guest page 1 reads from physical page 3. */
function remapped() {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 32, shared: true });
  const group = 4 * PAGE;
  const table = group + GROUP_HEADER_BYTES;
  const space = new ProcessAddressSpace(memory, { table, group });
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

  it("stops a path, a preview and a pollfd list at the end of memory", () => {
    const { bytes, space } = identity();
    bytes.set(encode("foo"), 2 * PAGE - 3);

    expect(format(space, ABI_SYSCALLS.Open, [2 * PAGE - 3, 0, 0]))
      .toBe('[100] open("foo", 0x0, 0o0)');
    expect(format(space, ABI_SYSCALLS.Open, [2 * PAGE, 0, 0]))
      .toBe('[100] open("", 0x0, 0o0)');
    expect(format(space, ABI_SYSCALLS.Open, [0, 0, 0]))
      .toBe('[100] open("(null)", 0x0, 0o0)');
    expect(format(space, ABI_SYSCALLS.Write, [1, 2 * PAGE - 3, 8]))
      .toBe('[100] write(1, 8, "foo")');
    expect(format(space, ABI_SYSCALLS.Write, [1, 2 * PAGE, 8]))
      .toBe('[100] write(1, 8, "")');
    expect(format(space, ABI_SYSCALLS.Poll, [2 * PAGE - 4, 1, 0]))
      .toBe("[100] poll(1, 0, [])");
  });

  it("caps a path, a preview and a pollfd list", () => {
    const { bytes, space } = identity();
    bytes.fill(0x61, 1024, 1024 + 512);

    expect(format(space, ABI_SYSCALLS.Open, [1024, 0, 0]))
      .toBe(`[100] open("${"a".repeat(256)}", 0x0, 0o0)`);
    expect(format(space, ABI_SYSCALLS.Write, [1, 1024, 512]))
      .toBe(`[100] write(1, 512, "${"a".repeat(160)}")`);
    expect(format(space, ABI_SYSCALLS.Poll, [2048, 9, 0]))
      .toBe(`[100] poll(9, 0, [${"{fd:0,events:0x0,revents:0x0},".repeat(8)}...])`);
  });
});
