// Trusted mechanism prototype: mappings change only between stopped guest calls.
// Metadata and physical memory are deliberately visible to this test harness.
export const PAGE = 65536;
export const LIMIT = 64 * 1024 * 1024;
export const READ = 1, WRITE = 2, SHARED = 4;

export class Group {
  constructor(modules) {
    this.modules = modules;
    this.memory = new WebAssembly.Memory({ initial: 1024, maximum: 2048, shared: true });
    this.next = 1024 * 1024;
    this.nextRoot = 4096;
  }
  alloc(pages = 1) {
    const p = this.next;
    this.next += pages * PAGE;
    if (this.next > this.memory.buffer.byteLength) throw Error('prototype physical capacity');
    return p;
  }
  context() {
    const root = this.nextRoot;
    this.nextRoot += 4096;
    if (this.nextRoot > 1024 * 1024) throw Error('prototype table capacity');
    const scratch = this.alloc();
    const table = new Uint32Array(this.memory.buffer, root, LIMIT / PAGE);
    const env = { memory: this.memory, root, scratch };
    const inline = new WebAssembly.Instance(this.modules.inline, { env });
    const native = new WebAssembly.Instance(this.modules.native, { env });
    const helper = new WebAssembly.Instance(this.modules.helper, { env, ops: inline.exports });
    return { root, scratch, table, env, inline: inline.exports, native: native.exports, helper: helper.exports };
  }
  map(ctx, va, physical, pages = 1, rights = READ | WRITE, shared = false) {
    if (va % PAGE || physical % PAGE || va < 0 || va + pages * PAGE > LIMIT ||
        physical < 1024 * 1024 || physical + pages * PAGE > this.next) throw Error('invalid mapping');
    for (let i = 0; i < pages; i++) ctx.table[va / PAGE + i] = physical + i * PAGE | rights | (shared ? SHARED : 0);
  }
  fork(parent, mutation = '') {
    const child = this.context(), copies = new Map();
    for (let i = 0; i < parent.table.length; i++) {
      const entry = parent.table[i];
      if (!entry) continue;
      const physical = entry & -PAGE;
      if ((entry & SHARED) || mutation === 'share-private') child.table[i] = entry;
      else {
        let copy = copies.get(physical);
        if (copy === undefined) {
          copy = this.alloc();
          new Uint8Array(this.memory.buffer, copy, PAGE).set(new Uint8Array(this.memory.buffer, physical, PAGE));
          copies.set(physical, copy);
        }
        child.table[i] = copy | entry & (PAGE - 1);
      }
    }
    return child;
  }
  physical(ctx, va) {
    const entry = ctx.table[va >>> 16];
    if (!(entry & READ)) throw Error('unreadable fixture address');
    return (entry & -PAGE) + (va & (PAGE - 1));
  }
  bytes(ctx, va, length) {
    // Harness-only contiguous view; deliberately refuse a scattered mapping.
    const p = this.physical(ctx, va);
    for (let i = PAGE - (va & (PAGE - 1)); i < length; i += PAGE) {
      if (this.physical(ctx, va + i) !== p + i) throw Error('noncontiguous fixture view');
    }
    return new Uint8Array(this.memory.buffer, p, length);
  }
}

export function instantiateRemote({ modules, memory, root, scratch }) {
  return new WebAssembly.Instance(modules.inline, { env: { memory, root, scratch } }).exports;
}
