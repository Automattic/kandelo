import { PAGE } from './runtime.mjs';

export const PROFILES = ['O2', 'O3', 'O3-lto', 'O3-lto-auto', 'O3-lto-post'];
export const MODES = ['generic', 'span', 'cache', 'aligned', 'vector', 'opaque', 'combined'];

export function instantiateC(module, memory, stackTop) {
  const instance = new WebAssembly.Instance(module, { env: { memory } });
  instance.exports.__stack_pointer.value = stackTop;
  return instance.exports;
}

export function cInstance(group, ctx, profile) {
  const stack = group.alloc();
  const exports = instantiateC(group.modules.profiles[profile], group.memory, stack + PAGE);
  return {
    exports,
    call(mode, op, n, base, mask) {
      return exports[`${mode}_${op}`](n, base, mask, ctx.root, ctx.scratch);
    },
    scalar(mode) {
      return { load: p => exports[`${mode}_load`](p, ctx.root),
        store: (p, v) => exports[`${mode}_store`](p, v, ctx.root) };
    },
  };
}
