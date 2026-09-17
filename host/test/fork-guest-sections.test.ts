import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  computeForkModuleTemplateId,
  readForkModuleStatePointerWidth,
  readForkModuleStateRoot,
} from "../src/fork-guest-sections";
import {
  WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
  WPK_FORK_MODULE_STATE_FORMAT_MAGIC,
  WPK_FORK_MODULE_STATE_FORMAT_VERSION,
} from "../src/generated/abi";

/** The smallest wasm module carrying one custom section. */
function moduleWithSection(name: string, payload: Uint8Array): WebAssembly.Module {
  const uleb = (value: number): number[] => {
    const out: number[] = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      out.push(byte);
    } while (value !== 0);
    return out;
  };
  const nameBytes = new TextEncoder().encode(name);
  const body = [...uleb(nameBytes.length), ...nameBytes, ...payload];
  return new WebAssembly.Module(
    new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x00, ...uleb(body.length), ...body,
    ]),
  );
}

function descriptor(overrides: Partial<{
  magic: readonly number[];
  version: number;
  size: number;
  ptrWidth: number;
}> = {}): Uint8Array {
  const bytes = new Uint8Array(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(overrides.magic ?? WPK_FORK_MODULE_STATE_FORMAT_MAGIC, 0);
  view.setUint16(4, overrides.version ?? WPK_FORK_MODULE_STATE_FORMAT_VERSION, true);
  view.setUint16(6, overrides.size ?? WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE, true);
  view.setUint8(8, overrides.ptrWidth ?? 4);
  view.setUint8(9, 8); // record alignment, which this reader does not police
  return bytes;
}

const SECTION = "kandelo.wpk_fork.module_state";

describe("fork module section readers", () => {
  it("reads the declared pointer width", () => {
    for (const width of [4, 8] as const) {
      expect(
        readForkModuleStatePointerWidth(
          moduleWithSection(SECTION, descriptor({ ptrWidth: width })),
        ),
      ).toBe(width);
    }
  });

  it("refuses a descriptor it cannot trust the width of", () => {
    // Every check here exists because a wrong pointer width read out of the
    // wrong bytes is a number that looks perfectly reasonable.
    expect(() =>
      readForkModuleStatePointerWidth(moduleWithSection("other", descriptor())),
    ).toThrow(/found 0/);
    expect(() =>
      readForkModuleStatePointerWidth(
        moduleWithSection(SECTION, descriptor({ magic: [1, 2, 3, 4] })),
      ),
    ).toThrow(/invalid magic/);
    expect(() =>
      readForkModuleStatePointerWidth(
        moduleWithSection(SECTION, descriptor({ version: 99 })),
      ),
    ).toThrow(/version 99/);
    expect(() =>
      readForkModuleStatePointerWidth(
        moduleWithSection(SECTION, descriptor({ size: 8 })),
      ),
    ).toThrow(/invalid size/);
    expect(() =>
      readForkModuleStatePointerWidth(
        moduleWithSection(SECTION, descriptor({ ptrWidth: 2 })),
      ),
    ).toThrow(/pointer width 2/);
    expect(() =>
      readForkModuleStatePointerWidth(
        moduleWithSection(SECTION, descriptor().subarray(0, 8)),
      ),
    ).toThrow(/8 bytes/);
  });

  it("reads the arena root out of a module buffer's prefix", () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const view = new DataView(memory.buffer);
    const buffer = 1024;
    view.setUint32(buffer + 4, 3 * 65_536, true); // word offset 1, ptrWidth 4
    expect(readForkModuleStateRoot(memory, buffer, 4)).toBe(3 * 65_536);
    view.setUint32(buffer + 4, 0, true);
    expect(readForkModuleStateRoot(memory, buffer, 4), "0 means none").toBe(0);
  });

  it("refuses a root that cannot be an arena", () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const view = new DataView(memory.buffer);
    view.setUint32(1024 + 4, 65_536 + 1, true);
    expect(() => readForkModuleStateRoot(memory, 1024, 4)).toThrow(
      /not page-aligned/,
    );
    expect(() => readForkModuleStateRoot(memory, 0, 4)).toThrow(
      /invalid module-state module buffer/,
    );
  });

  it("hashes module bytes the way SHA-256 does", () => {
    // Against node's own SHA-256, not against a recorded digest: a recorded one
    // would agree with this implementation's bugs. The lengths bracket the
    // block boundary, where the padding and the length word interact.
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
      expect(
        Buffer.from(computeForkModuleTemplateId(bytes)).toString("hex"),
        `length ${length}`,
      ).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("hashes a view without hashing its neighbours", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const middle = backing.subarray(2, 6);
    expect(Buffer.from(computeForkModuleTemplateId(middle)).toString("hex")).toBe(
      createHash("sha256").update(Buffer.from([3, 4, 5, 6])).digest("hex"),
    );
  });
});
