import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

import {
  GROUP_HEADER_BYTES,
  GROUP_SHARERS_OFFSET,
  PAGE_TABLE_BYTES,
  ProcessAddressSpace,
} from "../src/process-address-space";

const PAGE = 65536;

function group(pages: number) {
  const memory = new WebAssembly.Memory({ initial: pages, maximum: 1024, shared: true });
  const words = new Int32Array(memory.buffer);
  const groupBase = 4 * PAGE;
  const parentTable = groupBase + GROUP_HEADER_BYTES;
  const childTable = parentTable + 2 * PAGE_TABLE_BYTES;
  words[groupBase / 4] = childTable / PAGE + 2 * PAGE_TABLE_BYTES / PAGE;
  return {
    memory,
    words,
    groupBase,
    parent: new ProcessAddressSpace(memory, { table: parentTable, group: groupBase }),
    child: new ProcessAddressSpace(memory, { table: childTable, group: groupBase }),
    share(page: number) {
      for (const table of [parentTable, childTable]) {
        words[(table + PAGE_TABLE_BYTES) / 4 + page] |= 1;
      }
      words[(groupBase + GROUP_SHARERS_OFFSET) / 4 + page] += 1;
    },
  };
}

describe("ProcessAddressSpace", () => {
  it("is the identity mapping without a page table", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const space = new ProcessAddressSpace(memory, null);

    space.write(100, new Uint8Array([1, 2, 3]));

    expect(space.readable(100)).toBe(100);
    expect(space.writable(100)).toBe(100);
    expect([...new Uint8Array(memory.buffer, 100, 3)]).toEqual([1, 2, 3]);
    expect([...space.read(100, 3)]).toEqual([1, 2, 3]);
  });

  it("splits a range that crosses into a page with another mapping", () => {
    const { memory, words, parent } = group(32);
    const table = parent.location!.table / 4;
    words[table + 1] = 2 * PAGE;
    words[table + PAGE_TABLE_BYTES / 4 + 1] = 2 * PAGE;

    parent.write(PAGE - 2, new Uint8Array([7, 8, 9, 10]));

    const bytes = new Uint8Array(memory.buffer);
    expect([...bytes.subarray(PAGE - 2, PAGE)]).toEqual([7, 8]);
    expect([...bytes.subarray(3 * PAGE, 3 * PAGE + 2)]).toEqual([9, 10]);
    expect(bytes[PAGE]).toBe(0);
    expect([...parent.read(PAGE - 2, 4)]).toEqual([7, 8, 9, 10]);
  });

  it("finds one physical run only when every page has the same mapping", () => {
    const { words, parent } = group(32);
    const table = parent.location!.table / 4;
    for (const page of [1, 2]) words[table + page] = 8 * PAGE;

    expect(parent.readableRun(PAGE + 5, PAGE)).toBe(9 * PAGE + 5);
    expect(parent.readableRun(PAGE - 2, 4)).toBe(-1);
    expect(parent.readableRun(2 * PAGE + 5, PAGE)).toBe(-1);
    expect(parent.readableRun(0, 0)).toBe(0);
    expect(new ProcessAddressSpace(new WebAssembly.Memory({ initial: 1 }), null).readableRun(7, 9)).toBe(7);
  });

  it("copies a shared page before a write and leaves the other sharer unchanged", () => {
    const { memory, words, groupBase, parent, child, share } = group(32);
    new Uint8Array(memory.buffer).fill(5, 0, PAGE);
    share(0);
    const fresh = words[groupBase / 4];

    child.write(10, new Uint8Array([42]));

    expect(child.readable(10)).toBe(fresh * PAGE + 10);
    expect(child.read(0, 11)[0]).toBe(5);
    expect(child.read(10, 1)[0]).toBe(42);
    expect(parent.read(10, 1)[0]).toBe(5);
    expect(words[groupBase / 4]).toBe(fresh + 1);
    expect(words[(groupBase + GROUP_SHARERS_OFFSET) / 4]).toBe(0);
    expect(words[(child.location!.table + PAGE_TABLE_BYTES) / 4] & 3).toBe(0);
  });

  it("writes in place when the writer is the last sharer", () => {
    const { words, groupBase, parent, child, share } = group(32);
    share(0);
    child.write(10, new Uint8Array([1]));
    const next = words[groupBase / 4];

    parent.write(10, new Uint8Array([2]));

    expect(parent.writable(10)).toBe(10);
    expect(words[groupBase / 4]).toBe(next);
    expect(child.read(10, 1)[0]).toBe(1);
  });

  it("grows the memory when the copy needs a page past its end", () => {
    const { memory, words, groupBase, child, share } = group(32);
    words[groupBase / 4] = 32;
    share(0);

    child.write(0, new Uint8Array([1]));

    expect(memory.buffer.byteLength).toBe(33 * PAGE);
    expect(child.readable(0)).toBe(32 * PAGE);
  });

  it("waits while another thread holds the copy lock", async () => {
    const { memory, words, child, share } = group(32);
    share(0);
    const slot = (child.location!.table + PAGE_TABLE_BYTES) / 4;
    words[slot] = 3;
    const worker = new Worker(
      `const { workerData } = require("node:worker_threads");
       const words = new Int32Array(workerData.buffer);
       Atomics.wait(words, 0, 0, 50);
       Atomics.store(words, workerData.slot, 0);`,
      { eval: true, workerData: { buffer: memory.buffer, slot } },
    );
    await new Promise((resolve) => worker.once("online", resolve));

    expect(child.writable(0)).toBe(0);
    await worker.terminate();
  });

  it("grows the memory itself without a page table", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 8 });
    const space = new ProcessAddressSpace(memory, null);

    space.grow(2 * PAGE + 1);

    expect(memory.buffer.byteLength).toBe(3 * PAGE);
    expect(space.byteLength).toBe(3 * PAGE);
  });

  it("keeps the identity mapping when a process that has not forked grows", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const space = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    const words = new Int32Array(memory.buffer);
    expect(words[groupBase / 4]).toBe(16);

    space.grow(18 * PAGE);

    expect(memory.buffer.byteLength).toBe(18 * PAGE);
    expect(space.byteLength).toBe(18 * PAGE);
    expect(space.readable(17 * PAGE + 3)).toBe(17 * PAGE + 3);
    expect(space.writable(17 * PAGE + 3)).toBe(17 * PAGE + 3);
    expect(new Int32Array(memory.buffer)[groupBase / 4]).toBe(18);
  });

  it("maps new pages to a fresh physical run after another process took pages", () => {
    const { words, groupBase, parent, child, share } = group(32);
    share(0);
    child.write(0, new Uint8Array([1]));
    const fresh = words[groupBase / 4];

    parent.grow(34 * PAGE);
    parent.write(33 * PAGE - 1, new Uint8Array([8, 9]));

    expect(parent.byteLength).toBe(34 * PAGE);
    expect(child.byteLength).toBe(32 * PAGE);
    expect(parent.readable(32 * PAGE)).toBe(fresh * PAGE);
    expect(parent.readableRun(32 * PAGE, 2 * PAGE)).toBe(fresh * PAGE);
    expect(words[groupBase / 4]).toBe(fresh + 2);
    expect([...parent.read(33 * PAGE - 1, 2)]).toEqual([8, 9]);
  });

  it("leaves the allocator unchanged when the memory cannot grow", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 17, shared: true });
    const groupBase = 4 * PAGE;
    const space = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });

    expect(() => space.grow(18 * PAGE)).toThrow(RangeError);

    expect(new Int32Array(memory.buffer)[groupBase / 4]).toBe(16);
    expect(space.byteLength).toBe(16 * PAGE);
  });

  it("zeroes and copies ranges that cross into a page with another mapping", () => {
    const { memory, words, parent } = group(32);
    const table = parent.location!.table / 4;
    words[table + 1] = 2 * PAGE;
    words[table + PAGE_TABLE_BYTES / 4 + 1] = 2 * PAGE;
    const bytes = new Uint8Array(memory.buffer);
    bytes.fill(6, PAGE - 2, PAGE);
    bytes.fill(7, 3 * PAGE, 3 * PAGE + 2);

    parent.copy(20 * PAGE + 1, PAGE - 2, 4);
    parent.zero(PAGE - 1, 2);

    expect([...bytes.subarray(20 * PAGE + 1, 20 * PAGE + 5)]).toEqual([6, 6, 7, 7]);
    expect([...parent.read(PAGE - 2, 4)]).toEqual([6, 0, 0, 7]);
    expect(bytes[PAGE]).toBe(0);
  });

  it("gives a view of one physical run and a copy of a range that crosses runs", () => {
    const { memory, words, parent } = group(32);
    const table = parent.location!.table / 4;
    words[table + 1] = 2 * PAGE;
    const bytes = new Uint8Array(memory.buffer);
    bytes.fill(6, PAGE - 2, PAGE);
    bytes.fill(7, 3 * PAGE, 3 * PAGE + 2);

    const view = parent.readableBytes(PAGE, 2);
    const copy = parent.readableBytes(PAGE - 2, 4);

    expect(view.buffer).toBe(memory.buffer);
    expect(view.byteOffset).toBe(3 * PAGE);
    expect([...copy]).toEqual([6, 6, 7, 7]);
    expect(copy.buffer).not.toBe(memory.buffer);
  });

  it("finds a zero byte in a range that crosses into a page with another mapping", () => {
    const { memory, words, parent } = group(32);
    const table = parent.location!.table / 4;
    words[table + 1] = 2 * PAGE;
    const bytes = new Uint8Array(memory.buffer);
    bytes.fill(6, PAGE - 2, PAGE + 2);
    bytes.fill(7, 3 * PAGE, 3 * PAGE + 3);

    expect(parent.indexOfZero(PAGE - 2, 8)).toBe(5);
    expect(parent.indexOfZero(PAGE - 2, 5)).toBe(-1);
    expect(parent.indexOfZero(PAGE - 2, 0)).toBe(-1);
    expect(new ProcessAddressSpace(memory, null).indexOfZero(PAGE - 2, 8)).toBe(4);
  });

  it("forks into the same memory with shared pages and private control pages", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    parent.write(100, new Uint8Array([1]));
    parent.write(2 * PAGE + 100, new Uint8Array([2]));

    const child = parent.fork([{ page: 2, count: 2 }]);

    const words = new Int32Array(memory.buffer);
    const sharers = (groupBase + GROUP_SHARERS_OFFSET) / 4;
    expect(child.location).toEqual({ table: 16 * PAGE, group: groupBase });
    expect(words[groupBase / 4]).toBe(16 + 8 + 2);
    expect(child.byteLength).toBe(16 * PAGE);
    expect(child.readable(100)).toBe(100);
    expect(child.readable(2 * PAGE + 100)).toBe(24 * PAGE + 100);
    expect(child.readable(3 * PAGE)).toBe(25 * PAGE);
    expect(child.read(2 * PAGE + 100, 1)[0]).toBe(2);
    expect(parent.writable(2 * PAGE + 100)).toBe(2 * PAGE + 100);
    expect(words[sharers + 2]).toBe(0);
    expect(words[sharers]).toBe(1);

    child.write(100, new Uint8Array([9]));
    child.write(2 * PAGE + 100, new Uint8Array([8]));
    parent.write(100, new Uint8Array([7]));

    expect(child.readable(100)).toBe(26 * PAGE + 100);
    expect(parent.readable(100)).toBe(100);
    expect([child.read(100, 1)[0], parent.read(100, 1)[0]]).toEqual([9, 7]);
    expect([child.read(2 * PAGE + 100, 1)[0], parent.read(2 * PAGE + 100, 1)[0]]).toEqual([8, 2]);
    expect(new Int32Array(memory.buffer)[sharers]).toBe(0);
  });

  it("keeps every private run unshared in the parent and copies each one for the child", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    parent.write(2 * PAGE, new Uint8Array([2]));
    parent.write(9 * PAGE, new Uint8Array([9]));

    const child = parent.fork([{ page: 2, count: 1 }, { page: 8, count: 2 }]);

    const words = new Int32Array(memory.buffer);
    const sharers = (groupBase + GROUP_SHARERS_OFFSET) / 4;
    expect(words[groupBase / 4]).toBe(16 + 8 + 3);
    expect(child.readable(2 * PAGE)).toBe(24 * PAGE);
    expect(child.readable(8 * PAGE)).toBe(25 * PAGE);
    expect(child.readable(9 * PAGE)).toBe(26 * PAGE);
    expect(child.writable(9 * PAGE)).toBe(26 * PAGE);
    expect([child.read(2 * PAGE, 1)[0], child.read(9 * PAGE, 1)[0]]).toEqual([2, 9]);
    expect([2, 8, 9].map((page) => parent.writable(page * PAGE))).toEqual([2 * PAGE, 8 * PAGE, 9 * PAGE]);
    expect([2, 8, 9].map((page) => words[sharers + page])).toEqual([0, 0, 0]);
    expect(words[sharers + 3]).toBe(1);
  });

  it("locks every page but the private runs until writes resume", () => {
    const { parent, words, share } = group(32);
    share(5);
    const writeEntry = (page: number) => words[(parent.location!.table + PAGE_TABLE_BYTES) / 4 + page];

    parent.stopWrites([{ page: 2, count: 2 }]);

    expect([1, 2, 3, 5].map((page) => writeEntry(page) & 3)).toEqual([3, 0, 0, 3]);

    parent.resumeWrites();

    expect([1, 2, 3, 5].map((page) => writeEntry(page) & 3)).toEqual([0, 0, 0, 1]);
  });

  it("shares the locked pages with a fork child and removes the locks", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    parent.write(100, new Uint8Array([1]));
    parent.stopWrites([{ page: 2, count: 2 }]);

    const child = parent.fork([{ page: 2, count: 2 }]);

    const words = new Int32Array(memory.buffer);
    const writeEntry = (space: ProcessAddressSpace, page: number) =>
      words[(space.location!.table + PAGE_TABLE_BYTES) / 4 + page];
    expect([parent, child].map((space) => writeEntry(space, 0) & 3)).toEqual([1, 1]);
    expect([parent, child].map((space) => writeEntry(space, 2) & 3)).toEqual([0, 0]);
    child.write(100, new Uint8Array([9]));
    expect([child.read(100, 1)[0], parent.read(100, 1)[0]]).toEqual([9, 1]);
  });

  it("grows parent and child apart after a fork", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    const child = parent.fork([{ page: 2, count: 1 }]);

    parent.grow(17 * PAGE);
    child.grow(17 * PAGE);
    parent.write(16 * PAGE, new Uint8Array([1]));
    child.write(16 * PAGE, new Uint8Array([2]));

    expect(parent.readable(16 * PAGE)).toBe(25 * PAGE);
    expect(child.readable(16 * PAGE)).toBe(26 * PAGE);
    expect([parent.read(16 * PAGE, 1)[0], child.read(16 * PAGE, 1)[0]]).toEqual([1, 2]);
  });

  it("grows the memory for a private run without a page table", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 16, shared: true });
    const space = new ProcessAddressSpace(memory, null);

    expect(space.privateRun(4, 2)).toBe(4);
    expect(memory.buffer.byteLength).toBe(6 * PAGE);
  });

  it("grows a wasm64 memory by a bigint page count", () => {
    const memory = new WebAssembly.Memory({ initial: 1n, maximum: 16n, shared: true, address: "i64" } as any);
    const space = new ProcessAddressSpace(memory, null);

    space.grow(2 * PAGE + 1, 8);
    expect(memory.buffer.byteLength).toBe(3 * PAGE);

    expect(space.privateRun(4, 2, 8)).toBe(4);
    expect(memory.buffer.byteLength).toBe(6 * PAGE);
  });

  it("keeps pages that already form one unshared run", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const space = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    space.write(14 * PAGE, new Uint8Array([5]));

    expect(space.privateRun(14, 4)).toBe(14);
    expect(space.privateRun(14, 4)).toBe(14);
    expect(space.byteLength).toBe(18 * PAGE);
    expect(space.read(14 * PAGE, 1)[0]).toBe(5);
    expect(new Int32Array(memory.buffer)[groupBase / 4]).toBe(18);
  });

  it("moves shared pages to one new run and leaves the other sharer its pages", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    parent.write(12 * PAGE, new Uint8Array([3]));
    const child = parent.fork([{ page: 2, count: 1 }]);
    const sharers = (groupBase + GROUP_SHARERS_OFFSET) / 4;

    const run = child.privateRun(12, 2);

    expect(run).toBe(16 + 8 + 1);
    expect(child.readable(12 * PAGE)).toBe(run * PAGE);
    expect(child.writable(13 * PAGE + 8)).toBe((run + 1) * PAGE + 8);
    expect(child.read(12 * PAGE, 1)[0]).toBe(0);
    expect(parent.read(12 * PAGE, 1)[0]).toBe(3);
    const words = new Int32Array(memory.buffer);
    expect([words[sharers + 12], words[sharers + 13], words[sharers + 11]]).toEqual([0, 0, 1]);
    expect(child.privateRun(12, 2)).toBe(run);
    expect(parent.writable(12 * PAGE)).toBe(12 * PAGE);
  });
});
