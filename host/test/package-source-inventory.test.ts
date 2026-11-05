import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

const moduleBytes = new Uint8Array(readFileSync(resolve(import.meta.dirname, "../../local-binaries/kandelo_image_module32.wasm")));
const directory = `https://example.test/vfs-groups/${"a".repeat(64)}/`;

function fixture() {
  const filesystem = KandeloImageFs.create(moduleBytes);
  filesystem.writeFile("/program", Uint8Array.of(1, 2, 3), 0o755);
  const inventory = filesystem.buildPackageInventory({ name: "core", version: "1", programAbi: 55,
    programDigest: "07".repeat(32), paths: ["/program"] });
  return { filesystem, inventory };
}

describe("native image-module source pinning", () => {
  it("returns independent canonical inventories and releases ready state after each call", () => {
    const { filesystem, inventory } = fixture();
    const pinned = filesystem.pinPackageInventorySources(inventory, directory);
    expect(pinned).toEqual(inventory);
    expect(pinned.buffer).not.toBe(inventory.buffer);
    expect(filesystem.pinPackageInventorySources(pinned, directory)).toEqual(pinned);
    expect(() => filesystem.pinPackageInventorySources(inventory, "https://example.test/latest/"))
      .toThrow("pin package sources");
    expect(filesystem.pinPackageInventorySources(inventory, directory)).toEqual(inventory);
  });

  it("refuses oversized, shared and module-backed ingress before any native allocation", () => {
    const { filesystem, inventory } = fixture();
    const owner = filesystem as unknown as { exports: { memory: WebAssembly.Memory; sm_alloc(length: number): number } };
    const memory = owner.exports.memory;
    let allocations = 0;
    Object.defineProperty(filesystem, "exports", { value: { ...owner.exports,
      sm_alloc: () => { allocations++; throw new Error("native allocation must not start"); },
    } });
    expect(() => filesystem.pinPackageInventorySources(new Uint8Array(memory.buffer, 0, 1), directory)).toThrow("must not alias");
    expect(() => filesystem.pinPackageInventorySources(new Uint8Array(new SharedArrayBuffer(1)), directory)).toThrow("independently owned");
    expect(() => filesystem.pinPackageInventorySources(new Uint8Array(8 * 1024 * 1024 + 1), directory)).toThrow("inventory exceeds");
    expect(() => filesystem.pinPackageInventorySources(inventory, "x".repeat(4097))).toThrow("directory exceeds");
    expect(() => filesystem.pinPackageInventorySources(inventory, "é".repeat(3000))).toThrow("directory exceeds");
    expect(allocations).toBe(0);
  });

  it("frees the original allocation length when growing module memory detaches borrowed input", () => {
    const { filesystem } = fixture();
    const owner = filesystem as unknown as { exports: { memory: WebAssembly.Memory }; withBytes(bytes: Uint8Array, use: () => void): void };
    const memory = owner.exports.memory;
    const borrowed = new Uint8Array(memory.buffer, 0, 16);
    const freed: number[][] = [];
    Object.defineProperty(filesystem, "exports", { value: { ...owner.exports,
      sm_alloc: () => { memory.grow(1); return 64; },
      sm_free: (pointer: number, length: number) => { freed.push([pointer, length]); },
    } });
    expect(() => owner.withBytes(borrowed, () => { throw new Error("detached copy must not complete"); })).toThrow();
    expect(freed).toEqual([[64, 16]]);
  });
});
