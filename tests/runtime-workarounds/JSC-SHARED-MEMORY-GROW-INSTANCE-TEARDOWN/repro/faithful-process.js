// A process main thread: one instance bound to the process memory that keeps
// allocating, growing memory from Wasm (as malloc/sbrk does) and asking the
// kernel for brk/mmap growth, which the kernel performs from JavaScript.
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
  const { memory, wasmGrows } = data;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(WASM_BYTES), { env: { memory } });
  const { grow } = instance.exports;
  const pace = new Int32Array(new SharedArrayBuffer(4));
  let step = 0;
  const tick = () => {
    for (let i = 0; i < 4; i++) {
      step++;
      if (!wasmGrows) continue;
      if (step % 2 === 0) {
        if (grow(1 + (step % 8)) < 0) { postMessage({ type: 'exit' }); return; }
        postMessage({ type: 'wasm_grow' });
      } else {
        postMessage({ type: 'brk', pages: 1 + (step % 4) });
      }
      Atomics.wait(pace, 0, 0, 0.2);
    }
    setTimeout(tick, 0);
  };
  tick();
};
