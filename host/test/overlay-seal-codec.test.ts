import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { ERRNO } from "../src/generated/abi";
import { createOverlaySealCodec, InvalidOverlaySealError, type OverlayGenerationSeal, type OverlaySealSourceSlot,
  type OverlayRecoveryEvidence, type OverlayRecoveryVerdict } from "../src/vfs/overlay-seal-codec";
import { checkpointHeader } from "./fixtures/overlay-journal-header";
import { nativeOverlayControlCall, sealCodec } from "./fixtures/native-overlay-activation";

const records: OverlayGenerationSeal[] = [
  { generation: 7, journalLength: 1048577, baseDigest: new Uint8Array(32).fill(3) },
  { generation: 7, journalLength: 1048577, baseDigest: new Uint8Array(32).fill(3), indexLength: 129 },
  { generation: 7, journalLength: 1048577, baseDigest: new Uint8Array(32).fill(3), indexLength: 129,
    source: { slot: "g3", journalLength: 999999 } },
  { generation: 1, journalLength: 1048577, baseDigest: new Uint8Array(32).fill(3), indexLength: 129,
    source: { slot: "legacy", journalLength: 999999, journalDigest: new Uint8Array(32).fill(11) } },
];

test("stale native control capability is refused before generation recovery", () => {
  assert.throws(() => createOverlaySealCodec(() => Uint8Array.of(75, 79, 83, 67, 1, 0, 0, 0)),
    /unsupported control protocol/);
});

test("native seal headers preserve all canonical stored versions and reject every damaged byte", () => {
  for (const record of records) {
    const version = record.source === undefined ? record.indexLength === undefined ? 1 : 2
      : record.source.journalDigest === undefined ? 3 : 4;
    const length = [0, 88, 96, 112, 144][version]!;
    const expected = Buffer.alloc(length);
    expected.write("KOGS");
    expected.writeUInt32LE(version, 4);
    expected.writeBigUInt64LE(BigInt(record.generation), 8);
    expected.writeBigUInt64LE(BigInt(record.journalLength), 16);
    expected.set(record.baseDigest, 24);
    if (record.indexLength !== undefined) expected.writeBigUInt64LE(BigInt(record.indexLength), 56);
    if (record.source !== undefined) {
      expected.writeBigUInt64LE(BigInt(record.source.journalLength), 64);
      expected.writeBigUInt64LE(record.source.slot === "legacy" ? 0n : BigInt(record.source.slot.slice(1)) + 1n, 72);
      if (record.source.journalDigest !== undefined) expected.set(record.source.journalDigest, 80);
    }
    expected.set(createHash("sha256").update(expected.subarray(0, -32)).digest(), length - 32);
    const encoded = sealCodec.encodeHeader(record);
    assert.deepEqual(Buffer.from(encoded), expected);
    assert.equal(sealCodec.headerLength(encoded.subarray(0, 8)), length);
    assert.deepEqual(sealCodec.decodeHeader(encoded), record);
    for (let offset = 0; offset < encoded.length; offset++) {
      const damaged = encoded.slice();
      damaged[offset]! ^= 1;
      assert.throws(() => sealCodec.decodeHeader(damaged), InvalidOverlaySealError);
    }
  }
});

test("native seal transport rejects unsafe lengths, malformed sources and incorrect digest lengths", () => {
  for (const generation of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => sealCodec.encodeHeader({ ...records[0]!, generation }), InvalidOverlaySealError);
  }
  for (const field of ["journalLength", "indexLength"] as const) {
    for (const length of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => sealCodec.encodeHeader({ ...records[1]!, [field]: length }), InvalidOverlaySealError);
    }
  }
  for (const length of [0, 31, 33, 4096]) {
    assert.throws(() => sealCodec.encodeHeader({ ...records[0]!, baseDigest: new Uint8Array(length) }), InvalidOverlaySealError);
    assert.throws(() => sealCodec.encodeHeader({ ...records[3]!,
      source: { ...records[3]!.source!, journalDigest: new Uint8Array(length) } }), InvalidOverlaySealError);
  }
  for (const slot of ["g01", "g-1", "g9007199254740991", "ĝ0"] as OverlaySealSourceSlot[]) {
    assert.throws(() => sealCodec.encodeHeader({ ...records[2]!, source: { slot, journalLength: 3 } }), InvalidOverlaySealError);
  }
  assert.throws(() => sealCodec.encodeHeader({ ...records[3]!, generation: 2 }), InvalidOverlaySealError);
  assert.throws(() => sealCodec.encodeHeader({ ...records[2]!, indexLength: undefined }), InvalidOverlaySealError);
});

test("native streaming SHA-256 matches independent hashing and bounds every transfer", () => {
  let maximum = 0;
  const codec = createOverlaySealCodec((operation, input) => {
    maximum = Math.max(maximum, input.length);
    return nativeOverlayControlCall(operation, input);
  });
  const bytes = Uint8Array.from({ length: 1024 * 1024 + 131 }, (_, index) => index % 251);
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, bytes.length]) {
    for (const size of [13, 4096, 65536, bytes.length]) {
      const hash = codec.hasher();
      for (let offset = 0; offset < length; offset += size) hash.update(bytes.subarray(offset, Math.min(length, offset + size)));
      assert.deepEqual(Buffer.from(hash.finish()), createHash("sha256").update(bytes.subarray(0, length)).digest());
      assert.throws(() => hash.finish(), /already finished/);
      assert.throws(() => hash.update(Uint8Array.of(1)), /already finished/);
      hash.reset();
      hash.update(Uint8Array.of(97, 98, 99));
      assert.deepEqual(Buffer.from(hash.finish()), createHash("sha256").update("abc").digest());
    }
  }
  assert.equal(maximum, 60 * 1024 + 112);
});

test("native seal resource and transport failures cannot be classified as corruption", () => {
  for (const errno of [ERRNO.ENOMEM, ERRNO.ENOSYS]) {
    const codec = createOverlaySealCodec((operation, input) => operation === 10 ? nativeOverlayControlCall(operation, input) : -errno);
    assert.throws(() => codec.headerLength(new Uint8Array(8)), error => error instanceof Error
      && !(error instanceof InvalidOverlaySealError) && (error as Error & { errno?: number }).errno === errno);
  }
  const broken = createOverlaySealCodec((operation, input) => operation === 10 ? nativeOverlayControlCall(operation, input) : new Uint8Array(3));
  assert.throws(() => broken.headerLength(new Uint8Array(8)), error => error instanceof Error && !(error instanceof InvalidOverlaySealError));
  assert.throws(() => createOverlaySealCodec(() => -ERRNO.EINVAL), error => error instanceof Error
    && !(error instanceof InvalidOverlaySealError) && (error as Error & { errno?: number }).errno === ERRNO.ENOSYS);
  for (const [operation, errno] of [[7, ERRNO.EINVAL], [8, ERRNO.EIO]] as const) {
    const codec = createOverlaySealCodec((requested, input) => requested === operation ? -errno : nativeOverlayControlCall(requested, input));
    const hash = codec.hasher();
    assert.throws(() => operation === 7 ? hash.update(Uint8Array.of(1)) : hash.finish(), error => error instanceof Error
      && !(error instanceof InvalidOverlaySealError) && (error as Error & { errno?: number }).errno === errno);
  }
});

test("native digest state carries byte counts across 4 GiB without low-word aliasing", () => {
  for (const length of [0xffff_ffffn, 0x1_ffff_ffffn]) {
    const initial = nativeOverlayControlCall(6, Uint8Array.of(0));
    assert(initial instanceof Uint8Array);
    const input = new Uint8Array(113);
    input.set(initial);
    const view = new DataView(input.buffer);
    view.setBigUint64(32, length, true);
    view.setUint32(40, 63, true);
    input.fill(7, 48, 111);
    input[112] = 9;
    const result = nativeOverlayControlCall(7, input);
    assert(result instanceof Uint8Array);
    const output = new DataView(result.buffer, result.byteOffset, result.byteLength);
    assert.equal(output.getBigUint64(32, true), length + 1n);
    assert.equal(output.getUint32(40, true), 0);
    assert(result.subarray(48).every(byte => byte === 0));
  }
});

test("native seal transport preserves maximum safe lengths and source-slot identities", () => {
  const record: OverlayGenerationSeal = { generation: Number.MAX_SAFE_INTEGER,
    journalLength: Number.MAX_SAFE_INTEGER, indexLength: Number.MAX_SAFE_INTEGER,
    baseDigest: new Uint8Array(32).fill(19), source: {
      slot: `g${Number.MAX_SAFE_INTEGER - 1}`, journalLength: Number.MAX_SAFE_INTEGER,
    } };
  assert.deepEqual(sealCodec.decodeHeader(sealCodec.encodeHeader(record)), record);
});

test("native journal policy checks the complete header before returning its base identity", () => {
  const header = Buffer.alloc(sealCodec.journalHeaderLength());
  assert.equal(header.length, 72);
  header.write("KOVL");
  header.writeUInt32LE(1, 4);
  header.fill(23, 8, 40);
  header.set(createHash("sha256").update(header.subarray(0, 40)).digest(), 40);
  assert.deepEqual(sealCodec.journalBaseDigest(header), new Uint8Array(32).fill(23));
  for (let offset = 0; offset < header.length; offset++) {
    const damaged = Uint8Array.from(header);
    damaged[offset]! ^= 1;
    assert.throws(() => sealCodec.journalBaseDigest(damaged), InvalidOverlaySealError);
  }
  for (let length = 0; length < header.length; length++) {
    assert.throws(() => sealCodec.journalBaseDigest(header.subarray(0, length)), InvalidOverlaySealError);
  }
  assert.throws(() => sealCodec.journalBaseDigest(new Uint8Array(73)), InvalidOverlaySealError);
});

test("native journal resource errors and transport mismatches are not corruption", () => {
  for (const operation of [11, 12]) {
    for (const errno of [ERRNO.ENOMEM, ERRNO.ENOSYS, ERRNO.EINVAL]) {
      const codec = createOverlaySealCodec((requested, input) => requested === operation ? -errno : nativeOverlayControlCall(requested, input));
      assert.throws(() => operation === 11 ? codec.journalHeaderLength() : codec.journalBaseDigest(new Uint8Array(72)), error =>
        error instanceof Error && !(error instanceof InvalidOverlaySealError) && (error as Error & { errno?: number }).errno === errno);
    }
    const broken = createOverlaySealCodec((requested, input) => requested === operation ? new Uint8Array(3) : nativeOverlayControlCall(requested, input));
    assert.throws(() => operation === 11 ? broken.journalHeaderLength() : broken.journalBaseDigest(new Uint8Array(72)), error =>
      error instanceof Error && !(error instanceof InvalidOverlaySealError));
  }
  for (const length of [0, 145, 0xffff_ffff]) {
    const codec = createOverlaySealCodec((requested, input) => {
      if (requested !== 11) return nativeOverlayControlCall(requested, input);
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, length, true);
      return bytes;
    });
    assert.throws(() => codec.journalHeaderLength(), /invalid header transport/);
  }
});

test("native recovery inspects complete checksummed index headers and owns the conversion threshold", () => {
  assert.equal(sealCodec.indexHeaderLength(), 160);
  for (let version = 1; version <= 5; version++) {
    const header = checkpointHeader(version);
    assert.equal(sealCodec.indexRequiresConversion(header), version <= 2);
    for (let offset = 0; offset < header.length; offset++) {
      const damaged = header.slice();
      damaged[offset]! ^= 1;
      assert.throws(() => sealCodec.indexRequiresConversion(damaged), InvalidOverlaySealError);
    }
  }
  assert.throws(() => sealCodec.indexRequiresConversion(new Uint8Array(159)), InvalidOverlaySealError);
  for (const length of [0, 32 * 1024 * 1024 - 1, 32 * 1024 * 1024, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
    assert.equal(sealCodec.shouldConvertJournal(length), length >= 32 * 1024 * 1024);
  }
});

test("native seal geometry preserves every header version and large chunk-table lengths", () => {
  for (const record of [...records, { ...records[1]!, journalLength: Number.MAX_SAFE_INTEGER, indexLength: Number.MAX_SAFE_INTEGER }]) {
    const header = sealCodec.encodeHeader(record);
    assert.deepEqual(sealCodec.layout(header), { chunkBytes: 1024 * 1024, digestBytes: 32,
      totalBytes: header.length + 32 * (Math.ceil(record.journalLength / (1024 * 1024)) + Math.ceil((record.indexLength ?? 0) / (1024 * 1024))) });
  }
});

test("native seal storage policy checks appended tails, index presence, root identity and exact size", () => {
  const record = records[1]!;
  const header = sealCodec.encodeHeader(record);
  const layout = sealCodec.layout(header);
  for (const journalLength of [record.journalLength - 1, record.journalLength, record.journalLength + 1]) {
    for (const allowAppendedTail of [false, true]) {
      for (const indexLength of [undefined, 0, record.indexLength! - 1, record.indexLength, record.indexLength! + 1]) {
        for (const sealLength of [layout.totalBytes - 1, layout.totalBytes, layout.totalBytes + 1]) {
          const inventory = { journalLength, indexLength, sealLength, allowAppendedTail, expectedBaseDigest: record.baseDigest };
          const valid = (allowAppendedTail ? journalLength >= record.journalLength : journalLength === record.journalLength)
            && indexLength === record.indexLength && sealLength === layout.totalBytes;
          if (valid) sealCodec.verifyStorage(header, inventory);
          else assert.throws(() => sealCodec.verifyStorage(header, inventory), InvalidOverlaySealError);
        }
      }
    }
  }
  for (const expectedBaseDigest of [new Uint8Array(32).fill(4), new Uint8Array(31), new Uint8Array(33)]) {
    assert.throws(() => sealCodec.verifyStorage(header, { journalLength: record.journalLength, indexLength: record.indexLength,
      sealLength: layout.totalBytes, allowAppendedTail: false, expectedBaseDigest }), InvalidOverlaySealError);
  }
  const unindexed = sealCodec.encodeHeader(records[0]!);
  sealCodec.verifyStorage(unindexed, { journalLength: records[0]!.journalLength, indexLength: 999,
    sealLength: sealCodec.layout(unindexed).totalBytes, allowAppendedTail: false });
});

test("native seal geometry and storage protocol errors cannot authorize corruption fallback", () => {
  const header = sealCodec.encodeHeader(records[1]!);
  const inventory = { journalLength: records[1]!.journalLength, indexLength: records[1]!.indexLength,
    sealLength: sealCodec.layout(header).totalBytes, allowAppendedTail: false };
  for (const operation of [17, 18]) {
    const invoke = (codec: ReturnType<typeof createOverlaySealCodec>) => operation === 17 ? codec.layout(header) : codec.verifyStorage(header, inventory);
    for (const errno of [ERRNO.ENOMEM, ERRNO.EINVAL, ERRNO.ENOSYS]) {
      const codec = createOverlaySealCodec((requested, input) => requested === operation ? -errno : nativeOverlayControlCall(requested, input));
      assert.throws(() => invoke(codec), error => error instanceof Error && !(error instanceof InvalidOverlaySealError)
        && (error as Error & { errno?: number }).errno === errno);
    }
    const broken = createOverlaySealCodec((requested, input) => requested === operation ? new Uint8Array(operation === 17 ? 15 : 3) : nativeOverlayControlCall(requested, input));
    assert.throws(() => invoke(broken), error => error instanceof Error && !(error instanceof InvalidOverlaySealError));
    const invalid = createOverlaySealCodec((requested, input) => requested === operation ? new Uint8Array(operation === 17 ? 16 : 4).fill(255) : nativeOverlayControlCall(requested, input));
    assert.throws(() => invoke(invalid), error => error instanceof Error && !(error instanceof InvalidOverlaySealError));
  }
  assert.throws(() => sealCodec.verifyStorage(new Uint8Array(145), inventory), InvalidOverlaySealError);
});

test("native source eligibility consumes verified predecessor, retirement and digest evidence", () => {
  const cases: Array<[OverlayRecoveryEvidence, OverlayRecoveryVerdict]> = [
    [{ source: "none" }, "eligible"], [{ source: "self" }, "superseded"],
    [{ source: "unsealed", expectedLength: 72, observedLength: 0 }, "stale"],
    [{ source: "unsealed", expectedLength: 72, observedLength: 0, hasDigest: true }, "eligible"],
    [{ source: "unsealed", expectedLength: 72, observedLength: 72 }, "eligible"],
    [{ source: "unsealed", expectedLength: 72, observedLength: 72, hasDigest: true }, "verify-digest"],
    [{ source: "unsealed", expectedLength: 72, observedLength: 72, hasDigest: true, digestMatches: true }, "eligible"],
    [{ source: "unsealed", expectedLength: 72, observedLength: 72, hasDigest: true, digestMatches: false }, "superseded"],
    [{ source: "unsealed", expectedLength: 72, observedLength: 73, hasDigest: true, digestMatches: true }, "superseded"],
    [{ source: "sealed", expectedLength: 72, observedLength: 73, unverifiedSealLength: 144 }, "unresolved"],
    [{ source: "sealed", expectedLength: 72, observedLength: 73, unverifiedSealLength: 144, slotReused: true }, "eligible"],
    [{ source: "sealed", expectedLength: 72, observedLength: 73 }, "eligible"],
    [{ source: "sealed", expectedLength: 72, observedLength: 72, verifiedPredecessor: true }, "eligible"],
    [{ source: "sealed", expectedLength: 72, observedLength: 73, verifiedPredecessor: true }, "superseded"],
    [{ source: "sealed", expectedLength: 72, observedLength: 72, verifiedPredecessor: true, supersededPredecessor: true }, "superseded"],
  ];
  for (const [evidence, expected] of cases) assert.equal(sealCodec.classifySource(evidence), expected, JSON.stringify(evidence));
});

test("native recovery refuses malformed evidence and does not classify protocol or memory errors as corruption", () => {
  for (const evidence of [{ source: "none", hasDigest: true }, { source: "sealed", expectedLength: 72, supersededPredecessor: true },
    { source: "unsealed", expectedLength: 72, digestMatches: true }, { source: "sealed", expectedLength: Number.MAX_SAFE_INTEGER + 1 },
    { source: "unsealed", expectedLength: 0 } ] as OverlayRecoveryEvidence[]) {
    assert.throws(() => sealCodec.classifySource(evidence), error => error instanceof Error
      && !(error instanceof InvalidOverlaySealError) && (error as Error & { errno?: number }).errno === ERRNO.EINVAL);
  }
  for (const operation of [13, 14, 15, 16]) {
    const invoke = (codec: ReturnType<typeof createOverlaySealCodec>) => operation === 13 ? codec.indexHeaderLength()
      : operation === 14 ? codec.indexRequiresConversion(checkpointHeader())
      : operation === 15 ? codec.shouldConvertJournal(72) : codec.classifySource({ source: "none" });
    for (const errno of [ERRNO.ENOMEM, ERRNO.EINVAL, ERRNO.ENOSYS]) {
      const codec = createOverlaySealCodec((requested, input) => requested === operation ? -errno : nativeOverlayControlCall(requested, input));
      assert.throws(() => invoke(codec), error => error instanceof Error && !(error instanceof InvalidOverlaySealError)
        && (error as Error & { errno?: number }).errno === errno);
    }
    for (const length of [3, 4]) {
      const codec = createOverlaySealCodec((requested, input) => requested === operation ? new Uint8Array(length).fill(255) : nativeOverlayControlCall(requested, input));
      assert.throws(() => invoke(codec), error => error instanceof Error && !(error instanceof InvalidOverlaySealError));
    }
  }
});
