import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../src/constants";

/** New guest builds must carry the exact program contract of their kernel. */
export function assertRustProgramAbi(program: Uint8Array, kernel: ArrayBuffer): void {
  const expected = readWasmCustomSectionPayload(kernel, ABI_CONTRACT_SECTION);
  if (expected?.byteLength !== 32) throw new Error("Rust acceptance kernel lacks its ABI contract");
  const actual = readWasmCustomSectionPayload(Uint8Array.from(program).buffer, ABI_CONTRACT_SECTION);
  if (actual?.byteLength !== 32 || !actual.every((byte, index) => byte === expected[index])) {
    throw new Error("Newly compiled Rust program lacks the matching ABI contract stamp");
  }
}
