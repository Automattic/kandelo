// One pthread: a fresh Worker per thread, never reused. Mirrors Kandelo's
// thread worker: receive the process memory, refresh this isolate's view with
// a zero-page grow, bind ONE instance to the memory, run briefly, report that
// it no longer touches memory, and return. The kernel then terminates it.
// (module (import "env" "memory" (memory 1 65536 shared))
//   (func (export "grow") (param i32) (result i32)
//     (memory.grow (local.get 0))))
const WASM_BYTES = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f,
  2, 0x12, 1, 3, 0x65, 0x6e, 0x76, 6, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 2, 3, 1, 0x80, 0x80, 4,
  3, 2, 1, 0,
  7, 8, 1, 4, 0x67, 0x72, 0x6f, 0x77, 0, 0,
  0x0a, 8, 1, 6, 0, 0x20, 0, 0x40, 0, 0x0b]);
onmessage = ({ data }) => {
  const { memory, slotOffset, retain } = data;
  memory.grow(0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(WASM_BYTES), { env: { memory } });
  const view = new Int32Array(memory.buffer, slotOffset, 1024);
  for (let i = 0; i < view.length; i++) view[i] = i;
  // retain=1: keep the instance reachable for the life of this worker.
  if (retain) self.keep = instance;
  void instance;
  postMessage({ type: 'memory_quiescent' });
};
