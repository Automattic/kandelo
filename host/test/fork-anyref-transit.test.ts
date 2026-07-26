import { describe, expect, it } from "vitest";
import {
  FORK_ANYREF_TRANSIT_IMPORT,
  ForkAnyrefTransitTable,
  forkAnyrefTransitProviderBytes,
} from "../src/fork-anyref-transit";

describe("ForkAnyrefTransitTable", () => {
  it("uses a closed audited Wasm provider with the exact table type", () => {
    const bytes = forkAnyrefTransitProviderBytes();
    const module = new WebAssembly.Module(bytes as BufferSource);

    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(WebAssembly.Module.exports(module)).toEqual([
      {
        name: FORK_ANYREF_TRANSIT_IMPORT,
        kind: "table",
      },
      {
        name: `${FORK_ANYREF_TRANSIT_IMPORT}_clear`,
        kind: "function",
      },
    ]);
  });

  it("clears every grown slot and isolates workers", () => {
    const first = new ForkAnyrefTransitTable();
    const second = new ForkAnyrefTransitTable();

    expect(first.table).not.toBe(second.table);
    expect(first.table.length).toBe(1);
    first.table.grow(3);
    expect(first.table.length).toBe(4);

    first.clear();
    expect(
      Array.from(
        { length: first.table.length },
        (_, index) => first.table.get(index),
      ),
    ).toEqual([null, null, null, null]);
    expect(second.table.length).toBe(1);
  });

  it("does not expose mutable provider bytes", () => {
    const first = forkAnyrefTransitProviderBytes();
    first[0] = 0xff;
    expect(forkAnyrefTransitProviderBytes()[0]).toBe(0x00);
  });
});
