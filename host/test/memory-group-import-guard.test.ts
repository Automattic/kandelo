import { describe, expect, it, vi } from 'vitest';
import { MemoryGroupImportGuard } from '../src/memory-group-import-guard';
import { trapProcessWorker } from '../src/fork-worker-import-exceptions';

const guest = new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0,1,9,2,96,1,127,0,96,0,1,127,2,13,1,4,104,
  111,115,116,4,101,120,105,116,0,0,3,2,1,1,7,7,1,3,114,117,110,0,
  1,10,23,1,21,0,2,64,31,64,1,2,0,65,137,1,16,0,11,65,0,15,11,65,1,11,
]));
const runWith = (imports: WebAssembly.Imports) => new WebAssembly.Instance(guest, imports).exports.run as () => number;
describe('group process-Worker import guard', () => {
  it('keeps native bindings and function aliases while guarding normal returns', () => {
    const guard = new MemoryGroupImportGuard(), checkpoint = vi.fn(); guard.bindCheckpoint(checkpoint);
    const fn = function(this: { base: number }, n: number) { return this.base + n; };
    const memory = new WebAssembly.Memory({ initial: 1 });
    const imports = guard.wrap({ a: { fn, memory }, b: { alias: fn } });
    expect(imports.a!.memory).toBe(memory); expect(imports.a!.fn).toBe(imports.b!.alias);
    expect((imports.a!.fn as Function).call({ base: 3 }, 4)).toBe(7);
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });
  it('preserves a live guest exception but prevents catch-and-continue after a stop', () => {
    const guard = new MemoryGroupImportGuard(); let stopping = false;
    guard.bindCheckpoint(() => { if (stopping) trapProcessWorker(); });
    const ordinary = runWith(guard.wrap({ host: { exit: () => { throw new Error('ordinary'); } } }));
    expect(ordinary()).toBe(1);
    const stopped = runWith(guard.wrap({ host: { exit: () => { stopping = true; throw new Error('interrupted host call'); } } }));
    expect(stopped).toThrow(WebAssembly.RuntimeError);
  });
  it('checks an already stopped owner before invoking the original import', () => {
    const guard = new MemoryGroupImportGuard(), target = vi.fn(); guard.bindCheckpoint(trapProcessWorker);
    expect(runWith(guard.wrap({ host: { exit: target } }))).toThrow(WebAssembly.RuntimeError);
    expect(target).not.toHaveBeenCalled();
  });
  it('retires retained wrappers and refuses checkpoint rebinding', () => {
    const guard = new MemoryGroupImportGuard(), fn = vi.fn();
    const imports = guard.wrap({ host: { exit: fn } });
    expect(imports.host!.exit).toThrow(); expect(fn).not.toHaveBeenCalled();
    guard.bindCheckpoint(() => {}); expect(runWith(imports)()).toBe(0);
    expect(() => guard.bindCheckpoint(() => {})).toThrow(); guard.detach();
    expect(runWith(imports)).toThrow(WebAssembly.RuntimeError);
    expect(imports.host!.exit).toThrow(); expect(() => guard.wrap({ host: { exit: fn } })).toThrow();
    expect(() => guard.bindCheckpoint(() => {})).toThrow();
  });
  it('rejects import getters without invoking them', () => {
    const guard = new MemoryGroupImportGuard(), get = vi.fn();
    expect(() => guard.wrap({ host: Object.defineProperty({}, 'exit', { get }) })).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
