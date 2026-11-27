type RewriteExport = "mi_instrument_program" | "mi_instrument_side_module";

/**
 * Runs one rewrite of `kandelo_memory_instrument32.wasm`
 * (`crates/memory-instrument/build-wasm.sh`). `instrumenter` is that module,
 * compiled.
 */
function rewrite(instrumenter: WebAssembly.Module, bytes: Uint8Array, rewriteExport: RewriteExport): Uint8Array {
  const exports = new WebAssembly.Instance(instrumenter).exports as {
    memory: WebAssembly.Memory;
    mi_begin(length: number): number;
    mi_result(): number;
  } & Record<RewriteExport, () => number>;
  const input = exports.mi_begin(bytes.byteLength);
  new Uint8Array(exports.memory.buffer).set(bytes, input);
  const length = exports[rewriteExport]();
  const result = exports.mi_result();
  const output = new Uint8Array(exports.memory.buffer).slice(result, result + Math.abs(length));
  if (length < 0) throw new Error(`memory instrumentation failed: ${new TextDecoder().decode(output)}`);
  return output;
}

/**
 * Rewrites a side module so its loads and stores go through the page tables
 * of the process that loads it.
 *
 * WHY: a process with page tables shares its Memory with its fork group. A
 * side module that `dlopen` loads runs in that Memory, and the build path
 * does not rewrite it, so the host rewrites it at load time.
 */
export function instrumentSideModule(instrumenter: WebAssembly.Module, bytes: Uint8Array): Uint8Array {
  return rewrite(instrumenter, bytes, "mi_instrument_side_module");
}

/**
 * Rewrites a program that carries the `kandelo.memory.rewrite_at_exec` mark,
 * so its loads and stores go through its page tables.
 *
 * WHY: an image holds the plain form of such a program. The host makes the
 * rewritten form when a process starts the program, so a fork child can
 * share the pages of its parent or run the plain form in a private Memory.
 */
export function instrumentProgram(instrumenter: WebAssembly.Module, bytes: Uint8Array): Uint8Array {
  return rewrite(instrumenter, bytes, "mi_instrument_program");
}
