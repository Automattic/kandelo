import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORK_RESUME_CATALOG_EXPORT,
  FORK_RESUME_CATALOG_HEADER_SIZE,
  FORK_RESUME_CATALOG_SECTION,
  FORK_RESUME_CATALOG_VERSION,
  forkResumeTargetsFromInstance,
  readForkResumeCatalog,
} from "../src/fork-resume-catalog";

function uleb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function appendCustomSection(
  wasm: Uint8Array,
  name: string,
  payload: Uint8Array,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const contents = new Uint8Array(
    uleb128(nameBytes.byteLength).length
      + nameBytes.byteLength
      + payload.byteLength,
  );
  const encodedNameLength = uleb128(nameBytes.byteLength);
  contents.set(encodedNameLength, 0);
  contents.set(nameBytes, encodedNameLength.length);
  contents.set(payload, encodedNameLength.length + nameBytes.byteLength);
  const encodedSectionLength = uleb128(contents.byteLength);
  const result = new Uint8Array(
    wasm.byteLength + 1 + encodedSectionLength.length + contents.byteLength,
  );
  result.set(wasm, 0);
  result[wasm.byteLength] = 0;
  result.set(encodedSectionLength, wasm.byteLength + 1);
  result.set(contents, wasm.byteLength + 1 + encodedSectionLength.length);
  return result;
}

function descriptor(
  records: readonly {
    functionOrdinal: number;
    localCatalogSlot: number;
  }[],
): Uint8Array {
  const bytes = new Uint8Array(
    FORK_RESUME_CATALOG_HEADER_SIZE + records.length * 8,
  );
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("KFRC"), 0);
  view.setUint16(4, FORK_RESUME_CATALOG_VERSION, true);
  view.setUint16(6, FORK_RESUME_CATALOG_HEADER_SIZE, true);
  view.setUint32(8, records.length, true);
  records.forEach((record, index) => {
    const offset = FORK_RESUME_CATALOG_HEADER_SIZE + index * 8;
    view.setUint32(offset, record.functionOrdinal, true);
    view.setUint32(offset + 4, record.localCatalogSlot, true);
  });
  return bytes;
}

function baseCatalogBytes(tableSize = 2): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-resume-catalog-"));
  const wat = join(directory, "catalog.wat");
  const wasm = join(directory, "catalog.wasm");
  const elements = tableSize === 0 ? "" : `(elem (i32.const 0) ${[
    "$first",
    "$second",
  ].slice(0, tableSize).join(" ")})`;
  writeFileSync(wat, `(module
    (table $catalog (export "${FORK_RESUME_CATALOG_EXPORT}") ${tableSize} ${tableSize} funcref)
    (func $first (result i32) i32.const 17)
    (func $second (result i32) i32.const 29)
    ${elements}
  )`);
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  return readFileSync(wasm);
}

function moduleWithDescriptor(
  records: readonly {
    functionOrdinal: number;
    localCatalogSlot: number;
  }[],
  tableSize = 2,
): WebAssembly.Module {
  return new WebAssembly.Module(
    appendCustomSection(
      baseCatalogBytes(tableSize),
      FORK_RESUME_CATALOG_SECTION,
      descriptor(records),
    ),
  );
}

describe("fork resume catalog", () => {
  it("pairs deterministic ordinals with fresh-instance thunk objects", () => {
    const module = moduleWithDescriptor([
      { functionOrdinal: 3, localCatalogSlot: 0 },
      { functionOrdinal: 9, localCatalogSlot: 1 },
    ]);
    const first = new WebAssembly.Instance(module);
    const second = new WebAssembly.Instance(module);
    const firstTargets = forkResumeTargetsFromInstance(module, first);
    const secondTargets = forkResumeTargetsFromInstance(module, second);

    expect(firstTargets.map(({ functionOrdinal, localCatalogSlot }) => ({
      functionOrdinal,
      localCatalogSlot,
    }))).toEqual([
      { functionOrdinal: 3, localCatalogSlot: 0 },
      { functionOrdinal: 9, localCatalogSlot: 1 },
    ]);
    expect(firstTargets[0]!.thunk).not.toBe(secondTargets[0]!.thunk);
    expect((firstTargets[0]!.thunk as () => number)()).toBe(17);
    expect((secondTargets[1]!.thunk as () => number)()).toBe(29);
  });

  it("rejects malformed or ambiguous KFRC metadata", () => {
    const base = baseCatalogBytes();
    expect(() => readForkResumeCatalog(new WebAssembly.Module(base)))
      .toThrow(`expected one ${FORK_RESUME_CATALOG_SECTION}`);

    const valid = descriptor([
      { functionOrdinal: 3, localCatalogSlot: 0 },
      { functionOrdinal: 9, localCatalogSlot: 1 },
    ]);
    const duplicate = appendCustomSection(
      appendCustomSection(base, FORK_RESUME_CATALOG_SECTION, valid),
      FORK_RESUME_CATALOG_SECTION,
      valid,
    );
    expect(() => readForkResumeCatalog(new WebAssembly.Module(duplicate)))
      .toThrow("found 2");

    const badMagic = valid.slice();
    badMagic[0] = 0;
    expect(() => readForkResumeCatalog(new WebAssembly.Module(
      appendCustomSection(base, FORK_RESUME_CATALOG_SECTION, badMagic),
    ))).toThrow("invalid magic");

    const truncated = valid.slice(0, valid.byteLength - 1);
    expect(() => readForkResumeCatalog(new WebAssembly.Module(
      appendCustomSection(base, FORK_RESUME_CATALOG_SECTION, truncated),
    ))).toThrow("invalid size");

    expect(() => readForkResumeCatalog(moduleWithDescriptor([
      { functionOrdinal: 9, localCatalogSlot: 0 },
      { functionOrdinal: 3, localCatalogSlot: 1 },
    ]))).toThrow("not strictly ordered");

    expect(() => readForkResumeCatalog(moduleWithDescriptor([
      { functionOrdinal: 3, localCatalogSlot: 0 },
      { functionOrdinal: 9, localCatalogSlot: 0 },
    ]))).toThrow("repeats local slot");
  });

  it("rejects metadata that cannot resolve against the instance table", () => {
    const wrongLength = moduleWithDescriptor([
      { functionOrdinal: 3, localCatalogSlot: 0 },
    ]);
    expect(() => forkResumeTargetsFromInstance(
      wrongLength,
      new WebAssembly.Instance(wrongLength),
    )).toThrow("length 2, expected 1");

    const outOfBounds = moduleWithDescriptor([
      { functionOrdinal: 3, localCatalogSlot: 0 },
      { functionOrdinal: 9, localCatalogSlot: 2 },
    ]);
    expect(() => forkResumeTargetsFromInstance(
      outOfBounds,
      new WebAssembly.Instance(outOfBounds),
    )).toThrow("out of bounds");

    const nullModule = moduleWithDescriptor([], 0);
    expect(forkResumeTargetsFromInstance(
      nullModule,
      new WebAssembly.Instance(nullModule),
    )).toEqual([]);
  });
});
