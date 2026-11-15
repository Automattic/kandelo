export const PAGE = 65536, READ = 1, WRITE = 2, SHARED = 4;

export class ProgramGroup {
  constructor({ initialPages = 256, maximumPages = 4096, scratchBytes = 1024 * 1024 } = {}) {
    this.memory = new WebAssembly.Memory({ initial: initialPages, maximum: maximumPages, shared: true });
    this.maximumPages = maximumPages;
    this.scratchBytes = Math.ceil(scratchBytes / PAGE) * PAGE;
    const header = new Uint32Array(this.memory.buffer, 4096, 3);
    header.set([0, 1, maximumPages]);
  }
  alloc(pages) {
    if (!Number.isSafeInteger(pages) || pages < 1) throw Error('invalid physical allocation');
    const header = new Int32Array(this.memory.buffer, 4096, 3);
    if (Atomics.compareExchange(header, 0, 0, 1)) throw Error('group allocation is busy');
    try {
      const next = header[1], end = next + pages;
      if (end > this.maximumPages) throw Error('group physical capacity');
      const current = this.memory.buffer.byteLength / PAGE;
      if (end > current) this.memory.grow(end - current);
      header[1] = end;
      return next * PAGE;
    } finally { Atomics.store(header, 0, 0); }
  }
  metadata(module) {
    const sections = WebAssembly.Module.customSections(module, 'kandelo.common-memory.prototype');
    if (sections.length !== 1) throw Error('missing or duplicate common-memory contract');
    const metadata = JSON.parse(new TextDecoder().decode(sections[0]));
    if (metadata.format !== 1 || metadata.maximumPages > 65536) throw Error('unsupported common-memory contract');
    return metadata;
  }
  create(module, parent, extraEnv = {}) {
    const metadata = this.metadata(module);
    if (parent && parent.module !== module) throw Error('fork requires the exact parent module');
    const root = this.alloc(Math.ceil((64 + metadata.maximumPages * 4) / PAGE));
    const scratch = this.alloc(this.scratchBytes / PAGE);
    const count = parent ? this.pages(parent) : metadata.initialPages;
    new Uint32Array(this.memory.buffer, root, 5).set([count, metadata.maximumPages, this.scratchBytes, 0, 1]);
    const ctx = { module, metadata, root, scratch, instance: null, exports: null };
    if (parent) {
      const copies = new Map();
      for (let i = 0; i < count; i++) {
        const entry = this.table(parent)[i];
        if (!entry) continue;
        const physical = (entry & -PAGE) >>> 0;
        if (entry & SHARED) this.table(ctx)[i] = entry;
        else {
          let copy = copies.get(physical);
          if (copy === undefined) {
            copy = this.alloc(1);
            new Uint8Array(this.memory.buffer, copy, PAGE).set(new Uint8Array(this.memory.buffer, physical, PAGE));
            copies.set(physical, copy);
          }
          this.table(ctx)[i] = copy | (entry & 65535);
        }
      }
    } else if (count) {
      const base = this.alloc(count);
      for (let i = 0; i < count; i++) this.table(ctx)[i] = base + i * PAGE | READ | WRITE;
    }
    ctx.instance = new WebAssembly.Instance(module, { env: { ...extraEnv, memory: this.memory } });
    ctx.exports = ctx.instance.exports;
    ctx.exports.__vm_root.value = root;
    ctx.exports.__vm_scratch.value = scratch;
    ctx.exports.__vm_initialize(parent ? 0 : 1);
    return ctx;
  }
  pages(ctx) { return new Uint32Array(this.memory.buffer, ctx.root, 1)[0]; }
  table(ctx) { return new Uint32Array(this.memory.buffer, ctx.root + 64, ctx.metadata.maximumPages); }
  invalidateMappings(ctx) {
    const epoch = new Uint32Array(this.memory.buffer, ctx.root + 16, 1);
    if (epoch[0]) epoch[0] = (epoch[0] + 1) >>> 0;
  }
  map(ctx, va, physical, { shared = false, rights = READ | WRITE } = {}) {
    if (va % PAGE || physical % PAGE || va < 0 || va / PAGE >= this.pages(ctx) || physical < PAGE || physical + PAGE > this.memory.buffer.byteLength)
      throw Error('invalid prototype mapping');
    this.invalidateMappings(ctx);
    this.table(ctx)[va / PAGE] = physical | rights | (shared ? SHARED : 0);
  }
  physical(ctx, va, rights) {
    if (!Number.isSafeInteger(va) || va < 0 || va >= this.pages(ctx) * PAGE) throw Error('virtual bounds');
    const entry = this.table(ctx)[Math.floor(va / PAGE)];
    if ((entry & rights) !== rights || !(entry & -PAGE)) throw Error('mapping permissions');
    return ((entry & -PAGE) >>> 0) + va % PAGE;
  }
  read(ctx, va, size) {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = new Uint8Array(this.memory.buffer)[this.physical(ctx, va + i, READ)];
    return out;
  }
  write(ctx, va, bytes) {
    const destinations = Array.from(bytes, (_, i) => this.physical(ctx, va + i, WRITE));
    destinations.forEach((p, i) => { new Uint8Array(this.memory.buffer)[p] = bytes[i]; });
  }
}
