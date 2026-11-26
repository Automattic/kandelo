import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

import {
  ForkShareAddressSpace,
  GROUP_HEADER_BYTES,
  GROUP_SHARERS_OFFSET,
  PAGE_TABLE_BYTES,
  bindPageTable,
} from "../src/fork-share-address-space";
import { ProcessAddressFault } from "../src/process-address-space";

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
    parent: new ForkShareAddressSpace(memory, { table: parentTable, group: groupBase }),
    child: new ForkShareAddressSpace(memory, { table: childTable, group: groupBase }),
    share(page: number) {
      for (const table of [parentTable, childTable]) {
        words[(table + PAGE_TABLE_BYTES) / 4 + page] |= 1;
      }
      words[(groupBase + GROUP_SHARERS_OFFSET) / 4 + page] += 1;
    },
  };
}

describe("ForkShareAddressSpace", () => {
  it("splits a range that crosses into a page with another mapping", () => {
    const { memory, words, parent } = group(32);
    const table = parent.location.table / 4;
    words[table + 1] = 2 * PAGE;
    words[table + PAGE_TABLE_BYTES / 4 + 1] = 2 * PAGE;

    parent.writeBytes(PAGE - 2, new Uint8Array([7, 8, 9, 10]));

    const bytes = new Uint8Array(memory.buffer);
    expect([...bytes.subarray(PAGE - 2, PAGE)]).toEqual([7, 8]);
    expect([...bytes.subarray(3 * PAGE, 3 * PAGE + 2)]).toEqual([9, 10]);
    expect(bytes[PAGE]).toBe(0);
    expect([...parent.readBytes(PAGE - 2, 4)]).toEqual([7, 8, 9, 10]);
  });

  it("finds one physical run only when every page has the same mapping", () => {
    const { words, parent } = group(32);
    const table = parent.location.table / 4;
    for (const page of [1, 2]) words[table + page] = 8 * PAGE;

    expect(parent.readableRun(PAGE + 5, PAGE)).toBe(9 * PAGE + 5);
    expect(parent.readableRun(PAGE - 2, 4)).toBe(-1);
    expect(parent.readableRun(2 * PAGE + 5, PAGE)).toBe(-1);
    expect(parent.readableRun(0, 0)).toBe(0);
  });

  it("copies a shared page before a write and leaves the other sharer unchanged", () => {
    const { memory, words, groupBase, parent, child, share } = group(32);
    new Uint8Array(memory.buffer).fill(5, 0, PAGE);
    share(0);
    const fresh = words[groupBase / 4];

    child.writeBytes(10, new Uint8Array([42]));

    expect(child.readable(10)).toBe(fresh * PAGE + 10);
    expect(child.readBytes(0, 11)[0]).toBe(5);
    expect(child.readBytes(10, 1)[0]).toBe(42);
    expect(parent.readBytes(10, 1)[0]).toBe(5);
    expect(words[groupBase / 4]).toBe(fresh + 1);
    expect(words[(groupBase + GROUP_SHARERS_OFFSET) / 4]).toBe(0);
    expect(words[(child.location.table + PAGE_TABLE_BYTES) / 4] & 3).toBe(0);
  });

  it("writes in place when the writer is the last sharer", () => {
    const { words, groupBase, parent, child, share } = group(32);
    share(0);
    child.writeBytes(10, new Uint8Array([1]));
    const next = words[groupBase / 4];

    parent.writeBytes(10, new Uint8Array([2]));

    expect(parent.writable(10)).toBe(10);
    expect(words[groupBase / 4]).toBe(next);
    expect(child.readBytes(10, 1)[0]).toBe(1);
  });

  it("grows the memory when the copy needs a page past its end", () => {
    const { memory, words, groupBase, child, share } = group(32);
    words[groupBase / 4] = 32;
    share(0);

    child.writeBytes(0, new Uint8Array([1]));

    expect(memory.buffer.byteLength).toBe(33 * PAGE);
    expect(child.readable(0)).toBe(32 * PAGE);
  });

  it("waits while another thread holds the copy lock", async () => {
    const { memory, words, child, share } = group(32);
    share(0);
    const slot = (child.location.table + PAGE_TABLE_BYTES) / 4;
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

  it("keeps the identity mapping when a process that has not forked grows", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const space = new ForkShareAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
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
    child.writeBytes(0, new Uint8Array([1]));
    const fresh = words[groupBase / 4];

    parent.grow(34 * PAGE);
    parent.writeBytes(33 * PAGE - 1, new Uint8Array([8, 9]));

    expect(parent.byteLength).toBe(34 * PAGE);
    expect(child.byteLength).toBe(32 * PAGE);
    expect(parent.readable(32 * PAGE)).toBe(fresh * PAGE);
    expect(parent.readableRun(32 * PAGE, 2 * PAGE)).toBe(fresh * PAGE);
    expect(words[groupBase / 4]).toBe(fresh + 2);
    expect([...parent.readBytes(33 * PAGE - 1, 2)]).toEqual([8, 9]);
  });

  it("leaves the allocator unchanged when the memory cannot grow", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 17, shared: true });
    const groupBase = 4 * PAGE;
    const space = new ForkShareAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });

    expect(() => space.grow(18 * PAGE)).toThrow(RangeError);

    expect(new Int32Array(memory.buffer)[groupBase / 4]).toBe(16);
    expect(space.byteLength).toBe(16 * PAGE);
  });

  it("fills a range that crosses into a page with another mapping", () => {
    const { memory, words, parent } = group(32);
    const table = parent.location.table / 4;
    words[table + 1] = 2 * PAGE;
    words[table + PAGE_TABLE_BYTES / 4 + 1] = 2 * PAGE;
    const bytes = new Uint8Array(memory.buffer);
    bytes.fill(6, PAGE - 2, PAGE);
    bytes.fill(7, 3 * PAGE, 3 * PAGE + 2);

    parent.fillBytes(PAGE - 1, 2, 0);

    expect([...parent.readBytes(PAGE - 2, 4)]).toEqual([6, 0, 0, 7]);
    expect(bytes[PAGE]).toBe(0);
  });

  it("forks into the same memory with shared pages and private control pages", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ForkShareAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    parent.writeBytes(100, new Uint8Array([1]));
    parent.writeBytes(2 * PAGE + 100, new Uint8Array([2]));

    const child = parent.fork([{ page: 2, count: 2 }]);

    const words = new Int32Array(memory.buffer);
    const sharers = (groupBase + GROUP_SHARERS_OFFSET) / 4;
    expect(child.location).toEqual({ table: 16 * PAGE, group: groupBase });
    expect(words[groupBase / 4]).toBe(16 + 8 + 2);
    expect(child.byteLength).toBe(16 * PAGE);
    expect(child.readable(100)).toBe(100);
    expect(child.readable(2 * PAGE + 100)).toBe(24 * PAGE + 100);
    expect(child.readable(3 * PAGE)).toBe(25 * PAGE);
    expect(child.readBytes(2 * PAGE + 100, 1)[0]).toBe(2);
    expect(parent.writable(2 * PAGE + 100)).toBe(2 * PAGE + 100);
    expect(words[sharers + 2]).toBe(0);
    expect(words[sharers]).toBe(1);

    child.writeBytes(100, new Uint8Array([9]));
    child.writeBytes(2 * PAGE + 100, new Uint8Array([8]));
    parent.writeBytes(100, new Uint8Array([7]));

    expect(child.readable(100)).toBe(26 * PAGE + 100);
    expect(parent.readable(100)).toBe(100);
    expect([child.readBytes(100, 1)[0], parent.readBytes(100, 1)[0]]).toEqual([9, 7]);
    expect([child.readBytes(2 * PAGE + 100, 1)[0], parent.readBytes(2 * PAGE + 100, 1)[0]]).toEqual([8, 2]);
    expect(new Int32Array(memory.buffer)[sharers]).toBe(0);
  });

  it("keeps every private run unshared in the parent and copies each one for the child", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ForkShareAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    parent.writeBytes(2 * PAGE, new Uint8Array([2]));
    parent.writeBytes(9 * PAGE, new Uint8Array([9]));

    const child = parent.fork([{ page: 2, count: 1 }, { page: 8, count: 2 }]);

    const words = new Int32Array(memory.buffer);
    const sharers = (groupBase + GROUP_SHARERS_OFFSET) / 4;
    expect(words[groupBase / 4]).toBe(16 + 8 + 3);
    expect(child.readable(2 * PAGE)).toBe(24 * PAGE);
    expect(child.readable(8 * PAGE)).toBe(25 * PAGE);
    expect(child.readable(9 * PAGE)).toBe(26 * PAGE);
    expect(child.writable(9 * PAGE)).toBe(26 * PAGE);
    expect([child.readBytes(2 * PAGE, 1)[0], child.readBytes(9 * PAGE, 1)[0]]).toEqual([2, 9]);
    expect([2, 8, 9].map((page) => parent.writable(page * PAGE))).toEqual([2 * PAGE, 8 * PAGE, 9 * PAGE]);
    expect([2, 8, 9].map((page) => words[sharers + page])).toEqual([0, 0, 0]);
    expect(words[sharers + 3]).toBe(1);
  });

  it("locks every page but the private runs until writes resume", () => {
    const { parent, words, share } = group(32);
    share(5);
    const writeEntry = (page: number) => words[(parent.location.table + PAGE_TABLE_BYTES) / 4 + page];

    parent.stopWrites([{ page: 2, count: 2 }]);

    expect([1, 2, 3, 5].map((page) => writeEntry(page) & 3)).toEqual([3, 0, 0, 3]);

    parent.resumeWrites();

    expect([1, 2, 3, 5].map((page) => writeEntry(page) & 3)).toEqual([0, 0, 0, 1]);
  });

  it("shares the locked pages with a fork child and removes the locks", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ForkShareAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    parent.writeBytes(100, new Uint8Array([1]));
    parent.stopWrites([{ page: 2, count: 2 }]);

    const child = parent.fork([{ page: 2, count: 2 }]);

    const words = new Int32Array(memory.buffer);
    const writeEntry = (space: ForkShareAddressSpace, page: number) =>
      words[(space.location.table + PAGE_TABLE_BYTES) / 4 + page];
    expect([parent, child].map((space) => writeEntry(space, 0) & 3)).toEqual([1, 1]);
    expect([parent, child].map((space) => writeEntry(space, 2) & 3)).toEqual([0, 0]);
    child.writeBytes(100, new Uint8Array([9]));
    expect([child.readBytes(100, 1)[0], parent.readBytes(100, 1)[0]]).toEqual([9, 1]);
  });

  it("grows parent and child apart after a fork", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ForkShareAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    const child = parent.fork([{ page: 2, count: 1 }]);

    parent.grow(17 * PAGE);
    child.grow(17 * PAGE);
    parent.writeBytes(16 * PAGE, new Uint8Array([1]));
    child.writeBytes(16 * PAGE, new Uint8Array([2]));

    expect(parent.readable(16 * PAGE)).toBe(25 * PAGE);
    expect(child.readable(16 * PAGE)).toBe(26 * PAGE);
    expect([parent.readBytes(16 * PAGE, 1)[0], child.readBytes(16 * PAGE, 1)[0]]).toEqual([1, 2]);
  });

  it("keeps pages that already form one unshared run", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const space = new ForkShareAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    space.writeBytes(14 * PAGE, new Uint8Array([5]));

    expect(space.privateRun(14, 4)).toBe(14);
    expect(space.privateRun(14, 4)).toBe(14);
    expect(space.byteLength).toBe(18 * PAGE);
    expect(space.readBytes(14 * PAGE, 1)[0]).toBe(5);
    expect(new Int32Array(memory.buffer)[groupBase / 4]).toBe(18);
  });

  it("moves shared pages to one new run and leaves the other sharer its pages", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ForkShareAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    parent.writeBytes(12 * PAGE, new Uint8Array([3]));
    const child = parent.fork([{ page: 2, count: 1 }]);
    const sharers = (groupBase + GROUP_SHARERS_OFFSET) / 4;

    const run = child.privateRun(12, 2);

    expect(run).toBe(16 + 8 + 1);
    expect(child.readable(12 * PAGE)).toBe(run * PAGE);
    expect(child.writable(13 * PAGE + 8)).toBe((run + 1) * PAGE + 8);
    expect(child.readBytes(12 * PAGE, 1)[0]).toBe(0);
    expect(parent.readBytes(12 * PAGE, 1)[0]).toBe(3);
    const words = new Int32Array(memory.buffer);
    expect([words[sharers + 12], words[sharers + 13], words[sharers + 11]]).toEqual([0, 0, 1]);
    expect(child.privateRun(12, 2)).toBe(run);
    expect(parent.writable(12 * PAGE)).toBe(12 * PAGE);
  });

  it("refuses a range that the process does not map", () => {
    const { parent } = group(32);

    expect(() => parent.readBytes(32 * PAGE - 1, 2)).toThrow(ProcessAddressFault);
    expect(() => parent.writeBytes(32 * PAGE, new Uint8Array(1))).toThrow(ProcessAddressFault);
    expect(() => parent.fillBytes(-1, 1, 0)).toThrow(ProcessAddressFault);
    expect(() => parent.checkAccessRange(31 * PAGE, PAGE + 1)).toThrow(ProcessAddressFault);
    expect(() => parent.readableRun(32 * PAGE, 1)).toThrow(ProcessAddressFault);
    expect(() => parent.checkAccessRange(31 * PAGE, PAGE)).not.toThrow();
    expect(parent.readBytes(32 * PAGE, 0).byteLength).toBe(0);
  });

  it("bounds a space of a process Worker by the size of the Memory", () => {
    const { memory, parent } = group(32);
    const worker = new ForkShareAddressSpace(memory, parent.location, "worker");

    memory.grow(2);

    expect(parent.byteLength).toBe(32 * PAGE);
    expect(worker.byteLength).toBe(34 * PAGE);
    expect(worker.readBytes(33 * PAGE, 1)[0]).toBe(0);
  });

  it("gives atomic words on a page that the process owns", () => {
    const { words, groupBase, parent, child, share } = group(32);
    share(0);
    const fresh = words[groupBase / 4];

    const word = child.atomicWord(8);
    Atomics.store(word, 0, 7);
    Atomics.store(child.atomicLong(16), 0, 9n);

    expect(word.byteOffset).toBe(fresh * PAGE + 8);
    expect(word.length).toBe(1);
    expect(new DataView(child.readBytes(8, 16).buffer).getInt32(0, true)).toBe(7);
    expect(new DataView(child.readBytes(8, 16).buffer).getBigUint64(8, true)).toBe(9n);
    expect(parent.readBytes(8, 1)[0]).toBe(0);
    expect(() => child.atomicWord(6)).toThrow(ProcessAddressFault);
    expect(() => child.atomicLong(12)).toThrow(ProcessAddressFault);
  });

  it("gives an atomic word on a copy that grows the Memory", () => {
    const { words, groupBase, child, share } = group(32);
    share(0);
    words[groupBase / 4] = 32;

    Atomics.store(child.atomicLong(16), 0, 9n);

    expect(child.atomicWord(16).byteOffset).toBe(32 * PAGE + 16);
    expect(Atomics.load(child.atomicLong(16), 0)).toBe(9n);
  });

  it("publishes bytes, then stores the signal word", () => {
    const { parent, child, share } = group(32);
    share(0);

    expect(child.publishBytes(32, new Uint8Array([4, 5]), 64, 2, 1)).toBe(0);

    expect([...child.readBytes(32, 2)]).toEqual([4, 5]);
    expect(Atomics.load(child.atomicWord(64), 0)).toBe(2);
    expect([...parent.readBytes(32, 2)]).toEqual([0, 0]);
    expect(() => child.publishBytes(32 * PAGE, new Uint8Array(1), 64, 3, 1)).toThrow(ProcessAddressFault);
    expect(Atomics.load(child.atomicWord(64), 0)).toBe(2);
  });

  it("stores the page table location in an instance", () => {
    const global = () => new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    const exports = {
      __memory_table_base: global(),
      __memory_group_base: global(),
      __memory_stop_base: global(),
    };

    bindPageTable({ exports } as unknown as WebAssembly.Instance, { table: 8 * PAGE, group: 4 * PAGE, stop: 3 * PAGE - 8 });

    expect([
      exports.__memory_table_base.value,
      exports.__memory_group_base.value,
      exports.__memory_stop_base.value,
    ]).toEqual([8 * PAGE, 4 * PAGE, 3 * PAGE - 8]);
  });
});
