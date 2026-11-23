import { describe, expect, it } from 'vitest';
import { encodeGroupMemoryChangeRequest, decodeGroupMemoryChangeDescription, encodeGroupMemoryLayout,
  encodeMemoryGroupReceipt, decodeGroupExecPreparation, MemoryGroupProtocolFault } from '../src/memory-group-protocol';
import { MEMORY_GROUP_PROTOCOL as P } from '../src/generated/abi';

// Copied wire records only. Allocation and lifecycle authority remain in Rust.
const GENERATION = 0x8000000100000003n, SERIAL = 0xfffffffffffffff1n;
const groupedOptions = { brkBase: 3 * 65536, brkLimit: 16 * 65536, mmapBase: 4 * 65536, controlBase: 0, controlEnd: 3 * 65536, maxAddr: 16 * 65536 };

describe('copied future exec preparation records', () => {
  const expected = { group: 23, pid: 100, generation: GENERATION + 1n };
  function packet(initialPages = 149, maximumPages = 2048) {
    const bytes = new Uint8Array(P.exec_preparation.bytes);
    bytes.set(encodeMemoryGroupReceipt({ ...expected, tid: 100, serial: SERIAL }));
    const view = new DataView(bytes.buffer);
    view.setUint32(P.exec_preparation.fields.initialPages, initialPages, true);
    view.setUint32(P.exec_preparation.fields.maximumPages, maximumPages, true);
    return bytes;
  }
  it('preserves unsigned serial and future generation above the safe integer range', () => {
    const bytes = packet(), result = decodeGroupExecPreparation(bytes, expected);
    bytes.fill(0);
    expect(result).toEqual({ receipt: { ...expected, tid: 100, serial: SERIAL }, initialPages: 149, maximumPages: 2048 });
  });
  it('refuses a reservation for another group, process or image generation', () => {
    for (const wrong of [{ ...expected, group: 24 }, { ...expected, pid: 101 }, { ...expected, generation: GENERATION }]) {
      expect(() => decodeGroupExecPreparation(packet(), wrong)).toThrow(MemoryGroupProtocolFault);
    }
  });
  it('refuses truncated receipts and impossible virtual ceilings', () => {
    expect(() => decodeGroupExecPreparation(packet().subarray(0, 39), expected)).toThrow(MemoryGroupProtocolFault);
    for (const [initial, maximum] of [[149, 148], [0, 0], [149, 65537]]) {
      expect(() => decodeGroupExecPreparation(packet(initial, maximum), expected)).toThrow(MemoryGroupProtocolFault);
    }
    expect(() => encodeMemoryGroupReceipt({ ...expected, tid: 100, serial: 1n << 64n })).toThrow(MemoryGroupProtocolFault);
  });
});

describe('grouped mapping metadata transport', () => {
  it('keeps shared identity bits and refuses absent, mismatched or out-of-bounds backing metadata', () => {
    const receipt = { group: 23, pid: 100, tid: 100, serial: SERIAL, generation: GENERATION };
    const bytes = new Uint8Array(P.mapping.description_bytes), view = new DataView(bytes.buffer), f = P.mapping.description_fields;
    bytes.set(encodeMemoryGroupReceipt(receipt)); view.setBigUint64(f.token, 0xfffffffffffffffdn, true);
    view.setUint32(f.kind, 1, true); view.setUint32(f.prot, 3, true); view.setUint32(f.flags, 0x21, true);
    view.setBigUint64(f.address, 4n * 65536n, true); view.setBigUint64(f.result, 4n * 65536n, true);
    view.setBigUint64(f.length, 3n * 65536n, true); view.setBigUint64(f.sharedLength, 3n * 65536n, true);
    view.setBigUint64(f.sharedObject, 0xfffffffffffffffdn, true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt)).toMatchObject({ sharedObject: 0xfffffffffffffffdn, sharedLength: 3 * 65536, sharedOffset: 0 });
    for (const [field, value] of [[f.sharedObject, 0n], [f.sharedObject, 17n], [f.sharedOffset, 1n], [f.sharedOffset, 65536n], [f.populationLength, 65536n]] as const) {
      const copy = bytes.slice(); new DataView(copy.buffer).setBigUint64(field, value, true);
      expect(() => decodeGroupMemoryChangeDescription(copy, receipt)).toThrow(/effect/);
    }
  });
  it('decodes bounded descriptor prefixes without accepting smaller anonymous shared objects', () => {
    const receipt = { group: 23, pid: 100, tid: 100, serial: SERIAL, generation: GENERATION };
    const bytes = new Uint8Array(P.mapping.description_bytes), view = new DataView(bytes.buffer), f = P.mapping.description_fields;
    bytes.set(encodeMemoryGroupReceipt(receipt)); view.setBigUint64(f.token, 0xfffffffffffffffdn, true);
    view.setUint32(f.kind, 1, true); view.setUint32(f.prot, 3, true); view.setUint32(f.flags, 1, true);
    view.setBigUint64(f.address, 4n * 65536n, true); view.setBigUint64(f.result, 4n * 65536n, true);
    view.setBigUint64(f.length, 65536n, true); view.setBigUint64(f.sharedLength, 3n * 65536n, true);
    view.setBigUint64(f.sharedObject, 0xfffffffffffffffdn, true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt)).toMatchObject({length: 65536, sharedLength: 3 * 65536, sharedOffset: 0});
    view.setUint32(f.flags, 0x21, true);
    expect(() => decodeGroupMemoryChangeDescription(bytes, receipt)).toThrow(/effect/);
  });
  it('preserves an inherited shared object offset independently of its new remap token', () => {
    const receipt = { group: 23, pid: 100, tid: 100, serial: SERIAL, generation: GENERATION };
    const bytes = new Uint8Array(P.mapping.description_bytes), view = new DataView(bytes.buffer), f = P.mapping.description_fields;
    bytes.set(encodeMemoryGroupReceipt(receipt)); view.setBigUint64(f.token, 0xfffffffffffffffdn, true);
    view.setUint32(f.kind, 4, true); view.setUint32(f.prot, 3, true);
    for (const [field, value] of [[f.address, 8n * 65536n], [f.result, 8n * 65536n], [f.length, 2n * 65536n],
      [f.oldAddress, 4n * 65536n], [f.oldLength, 65536n], [f.sharedObject, 0x8000000000000001n],
      [f.sharedLength, 3n * 65536n], [f.sharedOffset, 65536n]] as const) view.setBigUint64(field, value, true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt)).toMatchObject({ sharedObject: 0x8000000000000001n, sharedOffset: 65536 });
  });

  const page = 65536;
  function description() {
    const receipt = { group: 23, pid: 100, tid: 101, serial: 0xfffffffffffffff1n, generation: 0x8000000100000003n };
    const bytes = new Uint8Array(P.mapping.description_bytes), view = new DataView(bytes.buffer);
    const r = P.receipt_fields, f = P.mapping.description_fields;
    for (const key of ['group', 'pid', 'tid'] as const) view.setUint32(r[key], receipt[key], true);
    view.setBigUint64(r.serial, receipt.serial, true); view.setBigUint64(r.generation, receipt.generation, true);
    view.setBigUint64(f.token, 0xfffffffffffffffdn, true); view.setUint32(f.kind, P.mapping.kinds.map, true);
    view.setUint32(f.prot, 3, true); view.setUint32(f.flags, 0x22, true);
    view.setBigUint64(f.address, BigInt(4 * page), true); view.setBigUint64(f.length, BigInt(page), true);
    view.setBigUint64(f.result, BigInt(4 * page), true);
    return { receipt, bytes, view, f };
  }
  it('bounds file population to the exact new map or remap tail', () => {
    const { receipt, bytes, view, f } = description();
    view.setBigUint64(f.populationAddress, BigInt(4 * page), true);
    view.setBigUint64(f.populationLength, BigInt(page), true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt)).toMatchObject({ populationAddress: 4 * page, populationLength: page });
    view.setBigUint64(f.populationLength, BigInt(2 * page), true);
    expect(() => decodeGroupMemoryChangeDescription(bytes, receipt)).toThrow(/effect/);
    view.setBigUint64(f.populationLength, 0n, true);
    expect(() => decodeGroupMemoryChangeDescription(bytes, receipt)).toThrow(/effect/);
    view.setUint32(f.kind, P.mapping.kinds.remap, true);
    view.setUint32(f.flags, 0, true);
    view.setBigUint64(f.oldAddress, BigInt(2 * page), true); view.setBigUint64(f.oldLength, BigInt(page), true);
    view.setBigUint64(f.length, BigInt(2 * page), true); view.setBigUint64(f.populationAddress, BigInt(5 * page), true);
    view.setBigUint64(f.populationLength, BigInt(page), true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt).kind).toBe('remap');
  });
  it('encodes every original signed channel bit without narrowing addresses or fd sentinels', () => {
    const args = [-1n, (1n << 63n) - 1n, -(1n << 63n), 0n, 4294967295n, 7n];
    const bytes = encodeGroupMemoryChangeRequest(123, args, 4), view = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(P.mapping.request_bytes);
    expect(view.getUint32(P.mapping.request_fields.syscall, true)).toBe(123);
    expect(view.getUint32(P.mapping.request_fields.reserved, true)).toBe(0);
    expect(args.map((_, i) => view.getBigInt64(P.mapping.request_fields.args + 8 * i, true))).toEqual(args);
    expect(() => encodeGroupMemoryChangeRequest(1, args.slice(0, 5), 4)).toThrow();
    expect(() => encodeGroupMemoryChangeRequest(1, [1n << 63n, 0n, 0n, 0n, 0n, 0n], 4)).toThrow();
    expect(() => encodeGroupMemoryChangeRequest(0x100000001, args, 4)).toThrow();
  });
  it('keeps high receipt/token bits in independent frozen metadata', () => {
    const { receipt, bytes, view, f } = description();
    const decoded = decodeGroupMemoryChangeDescription(bytes, receipt, 0xfffffffffffffffdn);
    expect(decoded).toMatchObject({ receipt, kind: 'map', token: 0xfffffffffffffffdn,
      address: 4 * page, length: page, result: 4 * page, prot: 3, flags: 0x22 });
    expect(Object.isFrozen(decoded)).toBe(true); expect(Object.isFrozen(decoded.receipt)).toBe(true);
    view.setBigUint64(f.token, 1n, true); view.setBigUint64(P.receipt_fields.serial, 1n, true);
    expect(decoded.token).toBe(0xfffffffffffffffdn); expect(decoded.receipt.serial).toBe(receipt.serial);
  });
  it('refuses another operation or receipt including differences above bit32', () => {
    const { receipt, bytes } = description();
    expect(() => decodeGroupMemoryChangeDescription(bytes, receipt, 0xfffffffefffffffdn)).toThrow(/exact operation/);
    expect(() => decodeGroupMemoryChangeDescription(bytes, { ...receipt, serial: receipt.serial - (1n << 32n) })).toThrow();
    expect(() => decodeGroupMemoryChangeDescription(bytes, { ...receipt, generation: receipt.generation - (1n << 32n) })).toThrow();
    expect(() => decodeGroupMemoryChangeDescription(bytes.subarray(1), receipt)).toThrow();
  });
  it('refuses malformed reserved, kind, protection, extent and result values', () => {
    for (const corrupt of [(v: DataView, f: ReturnType<typeof description>['f']) => v.setUint32(f.reserved, 1, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setUint32(f.kind, 99, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setUint32(f.prot, 8, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setBigUint64(f.address, 7n, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setBigUint64(f.address, 1n << 40n, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setBigUint64(f.result, 0n, true)]) {
      const { receipt, bytes, view, f } = description(); corrupt(view, f);
      expect(() => decodeGroupMemoryChangeDescription(bytes, receipt)).toThrow();
    }
  });
  it('preserves unaligned byte breaks and zero-length aligned protection effects', () => {
    const { receipt, bytes, view, f } = description();
    view.setUint32(f.flags, 0, true); view.setUint32(f.kind, P.mapping.kinds.break, true);
    view.setBigUint64(f.address, BigInt(3 * page + 7), true); view.setBigUint64(f.result, BigInt(3 * page + 7), true);
    view.setBigUint64(f.length, 0n, true); view.setBigUint64(f.oldAddress, BigInt(2 * page + 3), true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt)).toMatchObject({ kind: 'break', address: 3 * page + 7, oldAddress: 2 * page + 3 });
    view.setUint32(f.kind, P.mapping.kinds.protect, true); view.setBigUint64(f.address, BigInt(3 * page), true);
    view.setBigUint64(f.result, 0n, true); view.setBigUint64(f.oldAddress, 0n, true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt)).toMatchObject({ kind: 'protect', length: 0 });
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
