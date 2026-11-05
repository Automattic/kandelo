import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecureRandomBytes } from '../src/secure-random';
import { createWasmPosixKernelTestHarness } from '../src/kernel';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('shared host entropy owner', () => {
  it('chunks arbitrary reads within Web Crypto quota using owned host buffers', () => {
    const chunks: number[] = [];
    const provider = { getRandomValues(bytes: Uint8Array) {
      expect(this).toBe(provider); expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
      expect(bytes.byteLength).toBeLessThanOrEqual(65536);
      chunks.push(bytes.byteLength); bytes.fill(chunks.length); return bytes;
    } };
    const result = createSecureRandomBytes(131079, provider);
    expect(chunks).toEqual([65536, 65536, 7]);
    expect([...new Set(result.subarray(0, 65536))]).toEqual([1]);
    expect([...new Set(result.subarray(65536, 131072))]).toEqual([2]);
    expect([...result.subarray(131072)]).toEqual(Array(7).fill(3));
  });

  it('fails when the secure source is absent and preserves real provider errors', () => {
    vi.stubGlobal('crypto', undefined);
    const weak = vi.spyOn(Math, 'random');
    expect(() => createSecureRandomBytes(1)).toThrow('No cryptographically secure');
    expect(createSecureRandomBytes(0)).toHaveLength(0); expect(weak).not.toHaveBeenCalled();
    const error = Error('entropy unavailable');
    expect(() => createSecureRandomBytes(1, { getRandomValues() { throw error; } })).toThrow(error);
  });

  it('delegates a large request to the actual Node Web Crypto provider', () => {
    const provider = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const bytes = createSecureRandomBytes(131073);
    expect(bytes.byteLength).toBe(131073); expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(provider.mock.calls.map(([value]) => value!.byteLength)).toEqual([65536, 65536, 1]);
  });

  it.each([4, 8] as const)('writes real import destinations without lending shared memory, pointer width %i', (pointerWidth) => {
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const kernel = createWasmPosixKernelTestHarness({ memory, pointerWidth });
    const imports = kernel.testAuthority.buildImportObject(memory);
    const getrandom = (imports.env as any).host_getrandom as (pointer: number | bigint, length: number) => number;
    const spans: Uint8Array[] = [];
    vi.stubGlobal('crypto', { getRandomValues(bytes: Uint8Array) {
      expect(bytes.buffer).not.toBe(memory.buffer); expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
      expect(bytes.byteLength).toBeLessThanOrEqual(65536); spans.push(bytes); bytes.fill(0x37); return bytes;
    } });
    const pointer = pointerWidth === 8 ? 1024n : 1024;
    expect(getrandom(pointer, 131073)).toBe(131073);
    expect(spans.map(x => x.byteLength)).toEqual([65536, 65536, 1]);
    const bytes = new Uint8Array(memory.buffer);
    expect(bytes[1023]).toBe(0); expect(bytes[132097]).toBe(0);
    expect(bytes.subarray(1024, 132097).every(x => x === 0x37)).toBe(true);
    spans[0].fill(0); expect(bytes[1024]).toBe(0x37);
  });

  it('keeps import failure atomic, rejects bad ranges and propagates missing-provider errno', () => {
    const memory = new WebAssembly.Memory({ initial: 3, maximum: 3 });
    const kernel = createWasmPosixKernelTestHarness({ memory, pointerWidth: 4 });
    const getrandom = (kernel.testAuthority.buildImportObject(memory).env as any).host_getrandom;
    const bytes = new Uint8Array(memory.buffer); bytes.fill(0x79);
    let calls = 0;
    vi.stubGlobal('crypto', { getRandomValues(bytes: Uint8Array) {
      if (++calls === 2) throw Error('native entropy failure'); bytes.fill(0x31); return bytes;
    } });
    expect(getrandom(1024, 65537)).toBe(-5);
    expect(bytes.every(x => x === 0x79)).toBe(true);
    expect(getrandom(200000, 1)).toBe(-14); expect(calls).toBe(2);
    vi.stubGlobal('crypto', undefined);
    expect(getrandom(1024, 1)).toBe(-38); expect(getrandom(1024, 0)).toBe(0);
  });
});
