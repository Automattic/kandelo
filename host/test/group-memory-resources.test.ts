import { describe, expect, it, vi } from 'vitest';
import { GroupMemoryResources, GroupMemoryResourceError } from '../src/group-memory-resources';
import { ERRNO } from '../src/generated/abi';
import { tryPublishMemoryGroupNotification } from '../src/memory-group-notification';

const PAGE = 65536;
describe('kernel-issued foreign memory resources', () => {
  it('prepares native queue release before publishing foreign memory', () => {
    const resources = new GroupMemoryResources(); resources.create(1n, 1, 1);
    const memory = resources.memory(1n);
    const store = vi.spyOn(Atomics, 'store');
    try {
      expect(tryPublishMemoryGroupNotification(memory, PAGE - 4, 1, () => {})).toBe(0);
      expect(store).not.toHaveBeenCalled();
    } finally { store.mockRestore(); }
  });
  it('constructs native group memory even if a host callback replaces the global constructor', () => {
    const resources = new GroupMemoryResources();
    const replacement = vi.spyOn(WebAssembly, 'Memory').mockImplementation(() => { throw Error('replaced constructor'); });
    try { resources.create(1n, 1, 1); expect(resources.pages(1n)).toBe(1); expect(replacement).not.toHaveBeenCalled(); }
    finally { replacement.mockRestore(); }
  });
  it('performs exact raw byte operations and refreshes access after growth', () => {
    const resources = new GroupMemoryResources();
    resources.create(9n, 1, 3);
    expect(resources.grow(9n, 1)).toBe(1);
    resources.write(9n, PAGE - 2, Uint8Array.of(1, 2, 3, 4));
    resources.copy(9n, PAGE - 1, PAGE - 2, 4);
    const output = new Uint8Array(5);
    resources.read(9n, PAGE - 2, output);
    expect([...output]).toEqual([1, 1, 2, 3, 4]);
    resources.fill(9n, PAGE, 2, 7);
    resources.read(9n, PAGE - 2, output);
    expect([...output]).toEqual([1, 1, 7, 7, 4]);
    expect(resources.pages(9n)).toBe(2);
  });

  it('keeps status separate from all 32 atomic bits', () => {
    const resources = new GroupMemoryResources(); resources.create(1n, 1, 1);
    resources.store(1n, 0, 0xffffffff);
    expect(resources.load(1n, 0)).toBe(0xffffffff);
    expect(resources.compareExchange(1n, 0, 0xffffffff, 0x80000000)).toBe(0xffffffff);
    expect(resources.load(1n, 0)).toBe(0x80000000);
    expect(resources.notify(1n, 0, 0xffffffff)).toBe(0);
  });

  it('copies a fragmented Rust BO descriptor and preflights every span before writes', () => {
    const resources = new GroupMemoryResources(); resources.create(1n, 4, 4);
    const pages = Object.freeze([3, 1]);
    expect(resources.writePages(1n, pages, PAGE - 2, Uint8Array.of(1, 2, 3, 4))).toBe(4);
    const bytes = new Uint8Array(4);
    resources.readPages(1n, pages, PAGE - 2, bytes);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    expect(resources.load(1n, PAGE)).toBe(0x0403);
    expect(() => resources.writePages(1n, [3, 4], PAGE - 2, Uint8Array.of(9, 9, 9, 9))).toThrow();
    resources.readPages(1n, pages, PAGE - 2, bytes);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    expect(() => resources.readPages(1n, pages, PAGE * 2 - 1, bytes)).toThrow();
  });

  it('refuses out-of-range copies before any destination changes', () => {
    const resources = new GroupMemoryResources(); resources.create(1n, 1, 1);
    resources.write(1n, 0, Uint8Array.of(42));
    expect(() => resources.copy(1n, 0, PAGE - 1, 2)).toThrow(GroupMemoryResourceError);
    expect(resources.load(1n, 0)).toBe(42);
    for (const address of [-1, 1.5, NaN, 0x100000000]) {
      expect(() => resources.write(1n, address, Uint8Array.of(9))).toThrow();
    }
    expect(() => resources.load(1n, 1)).toThrow();
    expect(() => resources.grow(1n, 1)).toThrow(expect.objectContaining({ errno: ERRNO.ENOMEM }));
    expect(resources.pages(1n)).toBe(1);
  });

  it('never aliases kernel resource identities or silently recreates dropped resources', () => {
    const resources = new GroupMemoryResources(); resources.create(1n, 1, 1); resources.create(2n, 1, 1);
    resources.store(1n, 0, 99); expect(resources.load(2n, 0)).toBe(0);
    expect(() => resources.create(1n, 1, 2)).toThrow(expect.objectContaining({ errno: ERRNO.EEXIST }));
    resources.drop(1n);
    expect(() => resources.memory(1n)).toThrow(expect.objectContaining({ errno: ERRNO.ENOENT }));
    expect(() => resources.drop(1n)).toThrow();
    expect(resources.load(2n, 0)).toBe(0);
  });
});
