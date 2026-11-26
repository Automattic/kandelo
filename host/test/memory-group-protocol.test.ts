import { describe, expect, it } from 'vitest';
import { encodeGroupMemoryLayout,
  encodeMemoryGroupReceipt, decodeMemoryGroupReceipt, MemoryGroupProtocolFault } from '../src/memory-group-protocol';
import { MEMORY_GROUP_PROTOCOL as P } from '../src/generated/abi';

// Copied wire records only. Allocation and lifecycle authority remain in Rust.
const GENERATION = 0x8000000100000003n, SERIAL = 0xfffffffffffffff1n;
const groupedOptions = { brkBase: 3 * 65536, brkLimit: 16 * 65536, mmapBase: 4 * 65536, controlBase: 0, controlEnd: 3 * 65536, maxAddr: 16 * 65536 };

describe('copied task receipts', () => {
  const receipt = { group: 23, pid: 100, tid: 100, generation: GENERATION + 1n, serial: SERIAL };
  it('preserves unsigned serial and generation above the safe integer range', () => {
    const bytes = encodeMemoryGroupReceipt(receipt), result = decodeMemoryGroupReceipt(bytes, receipt);
    bytes.fill(0);
    expect(result).toEqual(receipt);
  });
  it('refuses another group, process, task or image generation', () => {
    for (const wrong of [{ ...receipt, group: 24 }, { ...receipt, pid: 101 },
      { ...receipt, tid: 101 }, { ...receipt, generation: GENERATION }]) {
      expect(() => decodeMemoryGroupReceipt(encodeMemoryGroupReceipt(receipt), wrong)).toThrow(MemoryGroupProtocolFault);
    }
  });
  it('refuses truncated receipts and out-of-range serials', () => {
    expect(() => decodeMemoryGroupReceipt(encodeMemoryGroupReceipt(receipt).subarray(0, 31), receipt)).toThrow(MemoryGroupProtocolFault);
    expect(() => encodeMemoryGroupReceipt({ ...receipt, serial: 1n << 64n })).toThrow(MemoryGroupProtocolFault);
  });
});

describe('grouped image layout transport', () => {
  const receipt = { group: 23, pid: 100, tid: 100, serial: SERIAL, generation: GENERATION };
  it('copies exact identities, admitted bounds and control ranges into one owned record', () => {
    const input = { mode: 'fresh' as const, initialPages: 4, maximumPages: 16, channel: 65536, ...groupedOptions };
    const bytes = encodeGroupMemoryLayout(receipt, input), view = new DataView(bytes.buffer), f = P.layout.fields;
    input.controlEnd = 0;
    expect(bytes.length).toBe(P.layout.bytes); expect(view.getBigUint64(P.receipt_fields.serial, true)).toBe(SERIAL);
    expect(view.getBigUint64(P.receipt_fields.generation, true)).toBe(GENERATION);
    expect(view.getBigUint64(f.controlEnd, true)).toBe(3n * 65536n); expect(view.getBigUint64(f.channel, true)).toBe(65536n);
    expect(view.getUint32(f.maximumPages, true)).toBe(16); expect(view.getUint32(f.reserved, true)).toBe(0);
  });
  it('keeps inherited layout values absent and refuses hidden resets or malformed bounds', () => {
    const input = { mode: 'inherited' as const, initialPages: 4, maximumPages: 16, channel: 65536 };
    const bytes = encodeGroupMemoryLayout(receipt, input), view = new DataView(bytes.buffer);
    expect(view.getUint32(P.layout.fields.mode, true)).toBe(P.layout.modes.inherited);
    expect([...bytes.subarray(40, 80)].every(byte => byte === 0)).toBe(true);
    expect(() => encodeGroupMemoryLayout(receipt, { ...input, brkBase: 65536 })).toThrow();
    expect(() => encodeGroupMemoryLayout(receipt, { ...input, initialPages: 17 })).toThrow();
    expect(() => encodeGroupMemoryLayout(receipt, { ...input, mode: 'fresh' })).toThrow();
    expect(() => encodeGroupMemoryLayout({ ...receipt, serial: 0n }, input)).toThrow();
  });
});
