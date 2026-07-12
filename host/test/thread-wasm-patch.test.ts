import { describe, expect, it } from "vitest";
import { patchWasmForThread } from "../src/worker-main";

function uleb(value: number): number[] {
  const encoded: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    encoded.push(byte);
  } while (value !== 0);
  return encoded;
}

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

function name(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  return [...uleb(bytes.length), ...bytes];
}

function moduleBytes(options: {
  types: Array<{ params: number[]; results: number[] }>;
  functionTypes: number[];
  bodies: number[][];
  exports: Array<{ name: string; index: number }>;
  functionNames?: Array<{ name: string; index: number }>;
  start?: number;
}): ArrayBuffer {
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const typeContent = [...uleb(options.types.length)];
  for (const type of options.types) {
    typeContent.push(
      0x60,
      ...uleb(type.params.length),
      ...type.params,
      ...uleb(type.results.length),
      ...type.results,
    );
  }
  bytes.push(...section(1, typeContent));
  bytes.push(...section(3, [
    ...uleb(options.functionTypes.length),
    ...options.functionTypes.flatMap(uleb),
  ]));
  bytes.push(...section(7, [
    ...uleb(options.exports.length),
    ...options.exports.flatMap((entry) => [
      ...name(entry.name),
      0x00,
      ...uleb(entry.index),
    ]),
  ]));
  if (options.start !== undefined) {
    bytes.push(...section(8, uleb(options.start)));
  }
  const codeContent = [...uleb(options.bodies.length)];
  for (const instructions of options.bodies) {
    const body = [0x00, ...instructions, 0x0b];
    codeContent.push(...uleb(body.length), ...body);
  }
  bytes.push(...section(10, codeContent));
  if (options.functionNames) {
    const functionNameMap = [
      ...uleb(options.functionNames.length),
      ...options.functionNames.flatMap((entry) => [
        ...uleb(entry.index),
        ...name(entry.name),
      ]),
    ];
    bytes.push(...section(0, [
      ...name("name"),
      0x01,
      ...uleb(functionNameMap.length),
      ...functionNameMap,
    ]));
  }
  return new Uint8Array(bytes).buffer;
}

const VOID = { params: [], results: [] };
const I32_RESULT = { params: [], results: [0x7f] };

describe("patchWasmForThread", () => {
  it("does not rewrite an unrelated exported call target when no constructors exist", async () => {
    const original = moduleBytes({
      types: [VOID, I32_RESULT],
      functionTypes: [0, 1, 1, 1],
      bodies: [
        [],
        [0x41, 0x07],
        [0x10, 0x01],
        [0x41, 0x12],
      ],
      exports: [
        { name: "p10_errno_address", index: 2 },
        { name: "__abi_version", index: 3 },
      ],
      start: 0,
    });

    const patched = patchWasmForThread(original);
    expect(WebAssembly.validate(patched)).toBe(true);
    const { instance } = await WebAssembly.instantiate(patched);
    expect((instance.exports.p10_errno_address as () => number)()).toBe(7);
  });

  it("neuters the constructor identified by the ABI linker wrapper", async () => {
    const original = moduleBytes({
      types: [VOID, I32_RESULT],
      functionTypes: [0, 0, 1],
      bodies: [
        [],
        [0x00], // unreachable if the constructor is not neutralized
        [0x10, 0x01, 0x41, 0x12],
      ],
      exports: [{ name: "__abi_version", index: 2 }],
      start: 0,
    });

    const patched = patchWasmForThread(original);
    expect(WebAssembly.validate(patched)).toBe(true);
    const { instance } = await WebAssembly.instantiate(patched);
    expect((instance.exports.__abi_version as () => number)()).toBe(18);
  });

  it("does not rewrite a function identified only by spoofed name metadata", async () => {
    const original = moduleBytes({
      types: [VOID, I32_RESULT],
      functionTypes: [0, 0, 1],
      bodies: [
        [],
        [0x00],
        [0x10, 0x01, 0x41, 0x12],
      ],
      exports: [{ name: "invoke_spoof", index: 2 }],
      functionNames: [{ name: "__wasm_call_ctors", index: 1 }],
    });

    const patched = patchWasmForThread(original);
    expect(WebAssembly.validate(patched)).toBe(true);
    const { instance } = await WebAssembly.instantiate(patched);
    expect(() => (instance.exports.invoke_spoof as () => number)()).toThrow(/unreachable/);
  });

  it("rejects constructor evidence that does not point to a () -> () function", () => {
    const original = moduleBytes({
      types: [VOID, I32_RESULT],
      functionTypes: [0, 1],
      bodies: [[], [0x41, 0x01]],
      exports: [{ name: "__wasm_call_ctors", index: 1 }],
      start: 0,
    });

    expect(() => patchWasmForThread(original)).toThrow(
      /must have type \(\) -> \(\).*1 result/,
    );
  });
});
