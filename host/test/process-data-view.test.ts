import { describe, expect, it } from "vitest";

import {
  GROUP_HEADER_BYTES,
  PAGE_TABLE_BYTES,
  ProcessAddressSpace,
} from "../src/process-address-space";
import { processDataView } from "../src/process-data-view";

const PAGE = 65536;

function mapped() {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024, shared: true });
  const groupBase = 4 * PAGE;
  const space = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
  const words = new Int32Array(memory.buffer);
  const table = space.location!.table / 4;
  words[table + 1] = 2 * PAGE;
  words[table + PAGE_TABLE_BYTES / 4 + 1] = 2 * PAGE;
  return { memory, space };
}

describe("processDataView", () => {
  it("is a plain DataView for the identity mapping", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = processDataView(new ProcessAddressSpace(memory, null));

    view.setUint32(8, 0x01020304, true);

    expect(view).toBeInstanceOf(DataView);
    expect(new DataView(memory.buffer).getUint32(8, true)).toBe(0x01020304);
  });

  it("translates an access inside one page", () => {
    const { memory, space } = mapped();
    const view = processDataView(space);

    view.setUint32(PAGE + 8, 0x01020304, true);
    view.setBigUint64(PAGE + 16, 0x0102030405060708n, true);
    view.setUint8(PAGE + 3, 9);

    const physical = new DataView(memory.buffer);
    expect(physical.getUint32(3 * PAGE + 8, true)).toBe(0x01020304);
    expect(physical.getUint32(PAGE + 8, true)).toBe(0);
    expect(view.getUint32(PAGE + 8, true)).toBe(0x01020304);
    expect(view.getBigUint64(PAGE + 16, true)).toBe(0x0102030405060708n);
    expect(view.getUint8(PAGE + 3)).toBe(9);
  });

  it("round-trips every signed and 16-bit accessor through the tables", () => {
    const { memory, space } = mapped();
    const view = processDataView(space);

    view.setUint16(PAGE + 32, 0xfffe, true);
    view.setInt32(PAGE + 36, -2, true);
    view.setBigInt64(PAGE + 40, -3n, true);

    expect(new DataView(memory.buffer).getUint16(3 * PAGE + 32, true)).toBe(0xfffe);
    expect(view.getUint16(PAGE + 32, true)).toBe(0xfffe);
    expect(view.getInt16(PAGE + 32, true)).toBe(-2);
    expect(view.getInt32(PAGE + 36, true)).toBe(-2);
    expect(view.getBigInt64(PAGE + 40, true)).toBe(-3n);
  });

  it("splits an access that crosses into a page with another mapping", () => {
    const { memory, space } = mapped();
    const view = processDataView(space);

    view.setUint32(PAGE - 2, 0x0a0b0c0d, true);
    view.setBigUint64(PAGE - 4, 0x0102030405060708n, false);
    view.setUint32(PAGE - 2, 0x0a0b0c0d, true);

    const bytes = new Uint8Array(memory.buffer);
    expect([...bytes.subarray(PAGE - 2, PAGE)]).toEqual([0x0d, 0x0c]);
    expect([...bytes.subarray(3 * PAGE, 3 * PAGE + 2)]).toEqual([0x0b, 0x0a]);
    expect(view.getUint32(PAGE - 2, true)).toBe(0x0a0b0c0d);
    expect(view.getInt16(PAGE - 1, true)).toBe(0x0b0c);
  });

  it("reaches a page that a copy-on-write added after the view was made", () => {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 1024, shared: true });
    const groupBase = 4 * PAGE;
    const parent = new ProcessAddressSpace(memory, { table: groupBase + GROUP_HEADER_BYTES, group: groupBase });
    const child = parent.fork([{ page: 2, count: 1 }]);
    const view = processDataView(child);

    view.setUint32(100, 7, true);

    expect(child.readable(100)).toBe(25 * PAGE + 100);
    expect(view.getUint32(100, true)).toBe(7);
    expect(processDataView(parent).getUint32(100, true)).toBe(0);
  });
});
