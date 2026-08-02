type AddressedMemory = {
  grow(delta: number | bigint): number | bigint;
};

/**
 * Synchronize a received shared Wasm memory with its backing store.
 *
 * A Kandelo pthread receives the process's shared `WebAssembly.Memory` from
 * another JavaScript isolate. The process can grow that memory while the
 * pthread starts. Node/V8 can then give the pthread an older fixed-length
 * view of the live shared backing. Asking to grow by zero pages adds no memory
 * but makes the receiving isolate refresh its view of the current length.
 *
 * Call this before creating any views or Wasm instances from a received
 * memory.
 *
 * @internal
 */
export function synchronizeReceivedSharedWasmMemory(
  memory: WebAssembly.Memory,
  ptrWidth: 4 | 8,
): void {
  // WHY: memory32's JavaScript API accepts a number page delta, while
  // memory64 requires a BigInt even when the zero delta only refreshes this
  // isolate's view. The process pointer width is already authoritative and
  // works across engines that do not expose WebAssembly.Memory.type().
  const zeroPages = ptrWidth === 8 ? 0n : 0;
  (memory as unknown as AddressedMemory).grow(zeroPages);
}
