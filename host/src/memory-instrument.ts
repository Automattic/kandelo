/**
 * Rewrites a side module so its loads and stores go through the page tables
 * of the process that loads it.
 *
 * WHY: a process with page tables shares its Memory with its fork group. A
 * side module that `dlopen` loads runs in that Memory, and the build path
 * does not rewrite it, so the host rewrites it at load time. `instrumenter`
 * is the compiled `kandelo_memory_instrument32.wasm`
 * (`crates/memory-instrument/build-wasm.sh`).
 */
export function instrumentSideModule(instrumenter: WebAssembly.Module, bytes: Uint8Array): Uint8Array {
  const exports = new WebAssembly.Instance(instrumenter).exports as {
    memory: WebAssembly.Memory;
    mi_begin(length: number): number;
    mi_instrument_side_module(): number;
    mi_result(): number;
  };
  const input = exports.mi_begin(bytes.byteLength);
  new Uint8Array(exports.memory.buffer).set(bytes, input);
  const length = exports.mi_instrument_side_module();
  const result = exports.mi_result();
  const output = new Uint8Array(exports.memory.buffer).slice(result, result + Math.abs(length));
  if (length < 0) throw new Error(`memory instrumentation failed: ${new TextDecoder().decode(output)}`);
  return output;
}
