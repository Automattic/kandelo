// A concurrent reader of the kernel's shared memory, to make the memory
// genuinely multi-threaded-shared while the kernel call runs.
let sab = null;
self.onmessage = (e) => {
  sab = e.data;
  const view = new Uint8Array(sab);
  let acc = 0;
  setInterval(() => { for (let i = 0; i < 4096; i += 64) acc += view[i]; }, 0);
};
