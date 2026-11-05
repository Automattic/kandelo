import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PackageImageSource } from "../../images/vfs/lib/package-image-source";
import type { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { softwareImage } from "./fixtures/package-upgrade-image";

const moduleBytes = new Uint8Array(readFileSync(new URL("../../local-binaries/kandelo_image_module_positioned32.wasm", import.meta.url)));
const directory = `https://example.test/vfs-groups/${"a".repeat(64)}/`;

async function fixture() {
  const image = await softwareImage(2, undefined, { pinDirectory: directory });
  let peak = 0;
  const input = { length: image.bytes.length, sha256: createHash("sha256").update(image.bytes).digest("hex"), directory,
    readAt: (offset: number, destination: Uint8Array) => {
      peak = Math.max(peak, destination.length);
      const bytes = image.bytes.subarray(offset, offset + destination.length);
      destination.set(bytes);
      return bytes.length;
    } };
  return { image, input, peak: () => peak };
}

describe("positioned native package source", () => {
  it("verifies the target, binds its producer inventory and reads staging bytes in bounded independent chunks", async () => {
    const { image, input, peak } = await fixture();
    const source = new PackageImageSource(moduleBytes, input);
    const inventory = new Uint8Array(source.inventoryBytes);
    for (let offset = 0; offset < inventory.length; offset += 65536) {
      const chunk = source.readInventory(offset, Math.min(65536, inventory.length - offset));
      expect(chunk.buffer.byteLength).toBe(chunk.length);
      inventory.set(chunk, offset);
    }
    expect(inventory).toEqual(image.inventory);
    const actual = new Uint8Array(image.bodies.get("/software/tool")!.length);
    for (let offset = 0; offset < actual.length; offset += 65536) {
      const chunk = source.readFile("/software/tool", offset, Math.min(65536, actual.length - offset));
      expect(chunk.buffer.byteLength).toBe(chunk.length);
      actual.set(chunk, offset);
    }
    expect(actual).toEqual(image.bodies.get("/software/tool"));
    expect(peak()).toBeLessThanOrEqual(65536);
    inventory.fill(0);
    expect(source.readInventory(0, 4)).toEqual(image.inventory.slice(0, 4));
  });

  it("refuses the wrong source digest before exposing an inventory", async () => {
    const { input } = await fixture();
    expect(() => new PackageImageSource(moduleBytes, { ...input, sha256: "0".repeat(64) })).toThrow("verifyPositionedSource");
  });

  it("releases native path and output allocations on repeated successful and failed chunk reads", async () => {
    const { input } = await fixture();
    const source = new PackageImageSource(moduleBytes, input);
    const filesystem = Reflect.get(source, "filesystem") as KandeloImageFs;
    const native = Reflect.get(filesystem, "exports") as {
      sm_alloc(length: number): number; sm_free(pointer: number, length: number): void;
      sm_read_file(...args: unknown[]): number;
    };
    const live = new Map<number, number>();
    let refuse = false;
    Reflect.set(filesystem, "exports", { ...native,
      sm_alloc: (length: number) => {
        const pointer = native.sm_alloc(length);
        if (pointer !== 0) live.set(pointer, length);
        return pointer;
      },
      sm_free: (pointer: number, length: number) => {
        expect(live.get(pointer)).toBe(length);
        live.delete(pointer);
        native.sm_free(pointer, length);
      },
      sm_read_file: (...args: unknown[]) => refuse ? -5 : native.sm_read_file(...args),
    });
    for (let index = 0; index < 32; index++) {
      expect(source.readFile("/software/tool", 0, 65536)).toHaveLength(65536);
      expect(live.size).toBe(0);
    }
    refuse = true;
    expect(() => source.readFile("/software/tool", 0, 65536)).toThrow();
    expect(live.size).toBe(0);
  });

  it("refuses unbounded ranges and never materializes deferred providers as raw staging bytes", async () => {
    const { input } = await fixture();
    const source = new PackageImageSource(moduleBytes, input);
    for (const [offset, length] of [[-1, 1], [0, 65537], [0, 0], [Number.MAX_SAFE_INTEGER, 1]]) {
      expect(() => source.readInventory(offset, length)).toThrow("valid range");
      expect(() => source.readFile("/software/tool", offset, length)).toThrow("valid range");
    }
    expect(() => source.readInventory(source.inventoryBytes + 1, 1)).toThrow("out of range");
    expect(() => source.readFile("/software/lazy", 0, 1)).toThrow("resident regular");
    expect(() => source.readFile("/software", 0, 1)).toThrow("resident regular");
    expect(() => source.readFile("relative", 0, 1)).toThrow("path is invalid");
    expect(() => source.readFile("/" + "é".repeat(2500), 0, 1)).toThrow("path is invalid");
    expect(source.readFile("/software/tool", 84000, 1)).toHaveLength(0);
    expect(() => source.readFile("/software/tool", 84001, 1)).toThrow("out of range");
  });
});
