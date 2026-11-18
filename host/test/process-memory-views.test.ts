import { describe, it, expect } from 'vitest';
import { GroupProcessAddressSpace, ProcessAddressFault } from '../src/process-address-space';
import { captureProcessRead, processDataView, processMemoryByteLength, readProcessBytes, writeProcessBytes, fillProcessBytes, borrowOrCopyProcessBytes } from '../src/process-memory-views';
import { ForkModuleStateArena, ForkModuleStateRecordKind } from '../src/fork-module-state';
import { LinkedForkContinuation, readForkContinuationAnchor, writeForkContinuationAnchor } from '../src/fork-continuation';
import { ForkFunctionCatalog } from '../src/fork-function-catalog';
import { ForkReferenceTransaction } from '../src/fork-reference-transaction';
import { createStackCaptureImport } from '../src/wasm-stack-capture';
import * as stack from '../src/generated/program-extensions';
import { WPK_FORK_LINKED_FRAME_POINTER_WIDTHS, WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT, WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS } from '../src/generated/abi';
const P = 65536;
function fixture() {
  const memory = new WebAssembly.Memory({ initial: 24, maximum: 32, shared: true }), root = P;
  const words = new Uint32Array(memory.buffer), pte = root / 4 + 16; words[root / 4] = 8;
  for (let i = 0; i < 8; i++) words[pte + i] = (4 + i * 2) * P | 3;
  const group = new GroupProcessAddressSpace({ memory, root, maximumPages: 32, assertLive: () => {} });
  return { memory, words, pte, group };
}
describe('explicit process views and copies', () => {
  it('keeps a native syscall read bound to its observed extent after concurrent growth', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    new Uint8Array(memory.buffer).fill(7);
    const captured = captureProcessRead(memory);
    memory.grow(1); new Uint8Array(memory.buffer)[P] = 91;
    expect(captured.byteLength).toBe(P);
    expect(captured.readBytes(P - 1, 1)[0]).toBe(7);
    expect(() => captured.readBytes(P - 1, 2)).toThrow(ProcessAddressFault);
    expect(() => captured.dataView(P, 1)).toThrow(ProcessAddressFault);
    expect(() => captured.findZero(P, 1)).toThrow(ProcessAddressFault);
    expect(captureProcessRead(memory).readBytes(P, 1)[0]).toBe(91);
  });
  it('reads bounded virtual scalar and byte snapshots through scattered pages', () => {
    const { group } = fixture(), captured = captureProcessRead(group);
    processDataView(group).setBigInt64(P - 3, -1234567890123n, true);
    expect(captured.dataView(P - 3, 8).getBigInt64(0, true)).toBe(-1234567890123n);
    const bytes = captured.readBytes(P - 3, 8);
    group.fillBytes(P - 3, 8, 0);
    expect(new DataView(bytes.buffer).getBigInt64(0, true)).toBe(-1234567890123n);
    group.detachHostAccess();
    expect(() => captured.readBytes(0, 1)).toThrow(ProcessAddressFault);
    expect(() => captured.dataView(0, 1)).toThrow(ProcessAddressFault);
    expect(() => captured.findZero(0, 1)).toThrow(ProcessAddressFault);
  });
  it('stops virtual C-string reads at NUL without probing the next inaccessible page', () => {
    const { group, words, pte } = fixture(), captured = captureProcessRead(group);
    group.fillBytes(P - 3, 3, 91); group.writeBytes(P - 1, new Uint8Array([0]));
    words[pte + 1] = 0;
    expect(captured.findZero(P - 3, 8)).toBe(2);
    group.writeBytes(P - 1, new Uint8Array([91]));
    expect(() => captured.findZero(P - 3, 8)).toThrow(ProcessAddressFault);
  });
  it('writes stack packets through split virtual pages and checks authority before formatting', () => {
    const { group, words, pte } = fixture();
    let calls = 0;
    const capture = createStackCaptureImport(group, 4, new ArrayBuffer(0), () => false,
      () => { calls++; return 'at inner (wasm://wasm/a:wasm-function[1]:0x32)'; });
    const address = P - 17, capacity = 256;
    fillProcessBytes(group, address, capacity, 0xa5);
    const length = capture(address, capacity, 8);
    expect(length).toBeGreaterThan(stack.STACK_HEADER_BYTES);
    const packet = processDataView(group, address, length);
    expect(packet.getUint32(0, true)).toBe(stack.STACK_MAGIC);
    expect(packet.getUint32(stack.STACK_COUNT_OFFSET, true)).toBe(1);
    expect(calls).toBe(1);
    fillProcessBytes(group, address, capacity, 0xa5);
    words[pte + 1] &= ~2;
    expect(capture(address, capacity, 8)).toBe(stack.STACK_INVALID_ADDRESS);
    expect(calls).toBe(1);
    expect(readProcessBytes(group, address, capacity)).toEqual(new Uint8Array(capacity).fill(0xa5));
  });
  it('rechecks stack output authority after a synchronous callback changes mappings', () => {
    const { group, words, pte } = fixture(), address = P - 17, capacity = 256;
    fillProcessBytes(group, address, capacity, 0xa5);
    const capture = createStackCaptureImport(group, 4, new ArrayBuffer(0), () => false,
      () => { words[pte + 1] &= ~2; return ''; });
    expect(capture(address, capacity, 8)).toBe(stack.STACK_INVALID_ADDRESS);
    expect(readProcessBytes(group, address, capacity)).toEqual(new Uint8Array(capacity).fill(0xa5));
    group.detachHostAccess();
    expect(capture(address, capacity, 8)).toBe(stack.STACK_INVALID_ADDRESS);
  });
  it('captures and replays split reference payloads and zeroes scattered scratch', () => {
    const { group } = fixture(), released: number[] = [];
    const provider = { capture: () => 1, materialize: () => ({ child: true }) };
    const parent = new ForkReferenceTransaction(new ForkFunctionCatalog(), provider, group,
      () => P, address => { released.push(address); }, 'virtual references');
    parent.beginCapture();
    const scratch = parent.reserveScratch(70000);
    fillProcessBytes(group, scratch, 70000, 0x77);
    parent.releaseScratch(scratch, 70000);
    expect(readProcessBytes(group, scratch, 70000).every(value => value === 0)).toBe(true);
    const token = {};
    parent.setExceptionSlotProvider({ throwSlot: () => { throw token; }, clearSlots: () => {} });
    const exception = parent.claimExceptionSlot(1), external = parent.encodeExternref({});
    const scalars = new Uint8Array(70000).fill(0x92);
    writeProcessBytes(group, P - 2, scalars);
    const ids = processDataView(group, 3 * P - 2, 8);
    ids.setUint32(0, 0, true); ids.setUint32(4, external, true);
    parent.defineException(exception, 0, 1, 1, P - 2, scalars.length, 3 * P - 2, 2);
    let next = 4 * P;
    const arena = new ForkModuleStateArena(group, 4, size => { const at = next; next += size; return at; }, () => {}, 'virtual recipes');
    arena.begin(); arena.appendModule({ activationId: 0, templateId: new Uint8Array(32) });
    parent.sealInto(arena); arena.seal(); const records = arena.records();
    const child = new ForkReferenceTransaction(new ForkFunctionCatalog(), provider, group);
    child.attachChild(records);
    expect(child.loadException(exception, 0, 1, 1, 32, scalars.length, 3 * P - 2, 2)).toBe(1);
    expect(readProcessBytes(group, 32, scalars.length)).toEqual(scalars);
    expect(ids.getUint32(0, true)).toBe(0); expect(ids.getUint32(4, true)).toBe(external);
    child.finishReplay(); parent.abort(); expect(released).toEqual([P]);
    expect(readProcessBytes(group, P, 2 * P).every(value => value === 0)).toBe(true);
    arena.release();
  });
  it('refuses a split reference-vector store before changing its writable prefix', () => {
    const { group, words, pte } = fixture();
    const transaction = new ForkReferenceTransaction(new ForkFunctionCatalog(),
      { capture: () => 1, materialize: () => null }, group);
    transaction.beginCapture();
    transaction.setExceptionSlotProvider({ throwSlot: () => { throw {}; }, clearSlots: () => {} });
    const id = transaction.claimExceptionSlot(0);
    fillProcessBytes(group, 32, 8, 0);
    transaction.defineException(id, 0, 1, 1, 0, 0, 32, 2);
    fillProcessBytes(group, P - 2, 8, 0xa5); words[pte + 1] &= ~2;
    expect(() => transaction.loadException(id, 0, 1, 1, 0, 0, P - 2, 2)).toThrow(ProcessAddressFault);
    expect(readProcessBytes(group, P - 2, 8)).toEqual(new Uint8Array(8).fill(0xa5));
    words[pte + 1] |= 2; transaction.abort();
  });
  it('refuses a buffer-shaped substitute for genuine native Memory', () => {
    const fake = { buffer: new ArrayBuffer(P) } as unknown as WebAssembly.Memory;
    expect(() => processDataView(fake)).toThrow(TypeError);
    expect(() => readProcessBytes(fake, 0, 1)).toThrow(TypeError);
    expect(() => writeProcessBytes(fake, 0, new Uint8Array([1]))).toThrow(TypeError);
  });
  it('marks borrowed native spans and owned grouped snapshots explicitly', () => {
    const { group } = fixture(), native = new WebAssembly.Memory({ initial: 1 });
    fillProcessBytes(group, 0, 4, 1); fillProcessBytes(native, 0, 4, 1);
    const a = borrowOrCopyProcessBytes(native, 0, 4), b = borrowOrCopyProcessBytes(group, 0, 4);
    expect(a.borrowed).toBe(true); expect(b.borrowed).toBe(false);
    fillProcessBytes(group, 0, 4, 2); fillProcessBytes(native, 0, 4, 2);
    expect([...a.bytes]).toEqual([2, 2, 2, 2]); expect([...b.bytes]).toEqual([1, 1, 1, 1]);
  });
  it.each([4, 8] as const)('captures, attaches and releases module-state records through scattered roots (field width %s)', width => {
    const { group } = fixture(); let next = P; const releases: number[] = [];
    const allocate = (size: number) => { const addr = next; next += size; if (next > group.byteLength) throw Error('fixture capacity'); return addr; };
    const arena = new ForkModuleStateArena(group, width, allocate, addr => { releases.push(addr); }, 'virtual module state');
    const root = arena.begin();
    arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(1) });
    arena.appendRecord({ kind: ForkModuleStateRecordKind.ReferenceRecipe, activationId: 0, ownerId: 1, payload: new Uint8Array(70000).fill(0x91) });
    arena.seal(); const records = arena.records();
    expect(records).toHaveLength(2); expect(records[1].payload).toEqual(new Uint8Array(70000).fill(0x91));
    expect(arena.recordViews()[1].payload).toEqual(records[1].payload);
    const borrowed = new ForkModuleStateArena(group, width, () => { throw Error('borrow must not allocate'); }, () => { throw Error('borrow must not deallocate'); }, 'borrowed virtual arena');
    borrowed.attachBorrowed(width === 8 ? BigInt(root) : root);
    expect(borrowed.records()[1].payload).toEqual(records[1].payload); borrowed.detachBorrowed();
    arena.release(); expect(releases.length).toBe(2);
  });
  it('packs mixed unaligned signed, unsigned, float and i64 fields exactly like native storage', () => {
    const { group } = fixture(), native = new WebAssembly.Memory({ initial: 8, maximum: 8, shared: true });
    const a = processDataView(native, P - 17, 128), b = processDataView(group, P - 17, 128);
    for (const view of [a, b]) {
      view.setInt8(0, -7); view.setUint8(1, 254);
      view.setInt16(3, -12345, true); view.setUint16(6, 54321);
      view.setInt32(9, -314159, true); view.setUint32(14, 0xfefdfcfb, true);
      view.setFloat32(19, Math.PI, true); view.setFloat64(24, Math.E);
      view.setBigInt64(35, -0x123456789abcdefn, true); view.setBigUint64(46, 0xfedcba9876543210n);
    }
    expect(readProcessBytes(group, P - 17, 128)).toEqual(readProcessBytes(native, P - 17, 128));
    expect(b.getInt8(0)).toBe(a.getInt8(0)); expect(b.getUint8(1)).toBe(a.getUint8(1));
    expect(b.getInt16(3, true)).toBe(a.getInt16(3, true)); expect(b.getUint16(6)).toBe(a.getUint16(6));
    expect(b.getInt32(9, true)).toBe(a.getInt32(9, true)); expect(b.getUint32(14, true)).toBe(a.getUint32(14, true));
    expect(b.getFloat32(19, true)).toBe(a.getFloat32(19, true)); expect(b.getFloat64(24)).toBe(a.getFloat64(24));
    expect(b.getBigInt64(35, true)).toBe(a.getBigInt64(35, true)); expect(b.getBigUint64(46)).toBe(a.getBigUint64(46));
    expect('buffer' in b).toBe(false); expect(a).toBeInstanceOf(DataView);
  });
  it('checks view extent, every split destination permission and revoked ownership', () => {
    const { group, words, pte } = fixture(), view = processDataView(group, P - 2, 4);
    view.setUint32(0, 0xa5a5a5a5); words[pte + 1] &= ~2;
    expect(() => view.setUint32(0, 0)).toThrow(ProcessAddressFault);
    expect(view.getUint32(0)).toBe(0xa5a5a5a5);
    expect(() => view.getUint8(4)).toThrow(ProcessAddressFault);
    expect(() => processDataView(group, -1, 1)).toThrow(ProcessAddressFault);
    group.detachHostAccess(); expect(() => view.getUint8(0)).toThrow(ProcessAddressFault);
  });
  it('copies bytes without turning staged reads into writable guest aliases', () => {
    const { group } = fixture();
    fillProcessBytes(group, P - 2, 5, 7); const copy = readProcessBytes(group, P - 2, 5);
    copy.fill(3); expect([...readProcessBytes(group, P - 2, 5)]).toEqual([7, 7, 7, 7, 7]);
    writeProcessBytes(group, P - 2, copy); expect([...readProcessBytes(group, P - 2, 5)]).toEqual([3, 3, 3, 3, 3]);
    expect(processMemoryByteLength(group)).toBe(8 * P);
  });
  it.each([4, 8] as const)('records and replays linked continuation frames through scattered roots (pointer width %s)', ptrWidth => {
    const { group } = fixture(), layout = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(value => value.bytes === ptrWidth)!;
    let next = P; const released: number[] = [];
    const allocate = (size: number) => { const address = next; next += size; if (next > group.byteLength) throw Error('fixture capacity'); return address; };
    const format = { version: WPK_FORK_LINKED_FRAME_FORMAT_VERSION, ptrWidth,
      alignment: WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT, flags: WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
      chunkHeaderSize: layout.chunkHeaderSize, nodeHeaderSize: layout.nodeHeaderSize, fixedPrefixSize: 128 };
    const continuation = new LinkedForkContinuation(group, format, allocate, address => { released.push(address); }, 'virtual continuation');
    const root = continuation.beginUnwind(); writeForkContinuationAnchor(group, 512, ptrWidth, Number(root));
    expect(readForkContinuationAnchor(group, 512, ptrWidth)).toBe(Number(root));
    const size = ptrWidth === 8 ? 90000n : 90000;
    const frame = continuation.reserveFrame(size);
    fillProcessBytes(group, Number(frame), 90000, 0xa5); continuation.commitFrame(frame);
    continuation.beginReplay();
    expect(continuation.nextFrame(size)).toBe(frame);
    expect(readProcessBytes(group, Number(frame), 90000).every(value => value === 0xa5)).toBe(true);
    continuation.release(); expect(released.length).toBeGreaterThan(0);
  });
});
