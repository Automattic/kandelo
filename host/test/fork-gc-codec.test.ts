import { describe, expect, it } from "vitest";

import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";
import {
  FORK_GC_FIELD_MUTABLE,
  FORK_GC_FIELD_REFERENCE,
  FORK_GC_LAYOUT_REQUIRES_PROVENANCE,
  ForkGcCodecDescriptor,
  ForkGcConstructorKind,
  ForkGcLayoutKind,
  ForkGcProvenanceRegistry,
  decodeForkGcCodecDescriptor,
} from "../src/fork-gc-codec";
import {
  WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE,
  WPK_FORK_GC_CODEC_HEADER_SIZE,
  WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE,
  WPK_FORK_GC_CODEC_MAGIC,
  WPK_FORK_GC_CODEC_VERSION,
} from "../src/generated/abi";

const GC_OBJECT_MODULE = Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0, 1, 9, 2, 95, 1, 127, 1, 96, 1, 127, 0,
  2, 35, 1, 3, 101, 110, 118, 25, 95, 95, 119, 112, 107, 95, 102, 111,
  114, 107, 95, 114, 101, 102, 95, 103, 99, 95, 116, 114, 97, 110, 115,
  105, 116, 1, 110, 0, 1, 3, 2, 1, 1, 7, 11, 1, 7, 112, 117, 98, 108,
  105, 115, 104, 0, 0, 10, 13, 1, 11, 0, 65, 0, 32, 0, 251, 0, 0, 38,
  0, 11,
);

function descriptorBytes(): Uint8Array {
  const bytes = new Uint8Array(
    WPK_FORK_GC_CODEC_HEADER_SIZE
      + WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE
      + WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE,
  );
  bytes.set(WPK_FORK_GC_CODEC_MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, WPK_FORK_GC_CODEC_VERSION, true);
  view.setUint16(6, WPK_FORK_GC_CODEC_HEADER_SIZE, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 1, true);
  const layout = WPK_FORK_GC_CODEC_HEADER_SIZE;
  view.setUint32(layout, 1, true);
  view.setUint32(layout + 4, 0, true);
  view.setUint8(layout + 8, ForkGcLayoutKind.Struct);
  view.setUint8(layout + 9, ForkGcConstructorKind.Struct);
  view.setUint16(layout + 10, FORK_GC_LAYOUT_REQUIRES_PROVENANCE, true);
  view.setUint32(layout + 12, 0, true);
  view.setUint32(layout + 16, 0, true);
  view.setUint32(layout + 20, 1, true);
  view.setUint32(layout + 24, 0xffff_ffff, true);
  view.setUint32(layout + 28, 1, true);
  view.setUint32(layout + 32, 0, true);
  view.setUint32(layout + 36, 0, true);
  view.setUint32(layout + 40, 1, true);
  const field = layout + WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE;
  view.setUint8(field, 8);
  view.setUint8(
    field + 1,
    FORK_GC_FIELD_MUTABLE | FORK_GC_FIELD_REFERENCE,
  );
  view.setUint32(field + 4, 0xffff_ffff, true);
  view.setUint32(field + 8, 0, true);
  return bytes;
}

function objectFixture(): {
  transit: ForkAnyrefTransitTable;
  publish(value: number): void;
} {
  const transit = new ForkAnyrefTransitTable();
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(GC_OBJECT_MODULE),
    { env: { __wpk_fork_ref_gc_transit: transit.table } },
  );
  return {
    transit,
    publish: instance.exports.publish as (value: number) => void,
  };
}

describe("fork GC codec metadata", () => {
  it("decodes the canonical structural/provenance layout", () => {
    const descriptor = decodeForkGcCodecDescriptor(descriptorBytes());
    expect(descriptor.require(1)).toMatchObject({
      id: 1,
      kind: ForkGcLayoutKind.Struct,
      provenanceReferenceCount: 1,
    });
  });

  it("rejects malformed magic, field order, and base coordinates", () => {
    const magic = descriptorBytes();
    magic[0] ^= 1;
    expect(() => decodeForkGcCodecDescriptor(magic)).toThrow(/magic/);

    const fields = descriptorBytes();
    new DataView(fields.buffer).setUint32(
      WPK_FORK_GC_CODEC_HEADER_SIZE + 16,
      1,
      true,
    );
    expect(() => decodeForkGcCodecDescriptor(fields)).toThrow();

    expect(() => new ForkGcCodecDescriptor([{
      ...decodeForkGcCodecDescriptor(descriptorBytes()).require(1),
      baseLayoutId: 2,
    }])).toThrow(/invalid base/);
  });
});

describe("ForkGcProvenanceRegistry", () => {
  it("records exact activation/base evidence without retaining a pending root", () => {
    const descriptor = decodeForkGcCodecDescriptor(descriptorBytes());
    const provenance = new ForkGcProvenanceRegistry();
    const { transit, publish } = objectFixture();
    publish(11);
    const object = transit.get(0);
    const token = provenance.begin(
      transit.table,
      descriptor,
      7,
      0,
      7,
      1,
      1,
      0n,
      0n,
      1,
    );
    publish(12);
    const seed = transit.get(0);
    provenance.appendReference(transit.table, token, 0, 0);
    transit.clearSlot(0);
    provenance.end(token);

    expect(provenance.lookup(object, 7, descriptor, 1)).toMatchObject({
      activationId: 7,
      baseLayoutId: 1,
      layoutId: 1,
      references: [seed],
    });
  });

  it("retains a nullable zero-length constructor seed as recipe-zero evidence", () => {
    const descriptor = decodeForkGcCodecDescriptor(descriptorBytes());
    const provenance = new ForkGcProvenanceRegistry();
    const { transit, publish } = objectFixture();
    publish(13);
    const object = transit.get(0);
    const token = provenance.begin(
      transit.table,
      descriptor,
      7,
      0,
      7,
      1,
      1,
      0n,
      0n,
      1,
    );
    transit.clearSlot(0);
    provenance.appendReference(transit.table, token, 0, 0);
    provenance.end(token);

    expect(provenance.lookup(object, 7, descriptor, 1)).toMatchObject({
      references: [null],
    });
  });

  it("fails closed for wrong activation/base and reentrant/interleaved hooks", () => {
    const descriptor = decodeForkGcCodecDescriptor(descriptorBytes());
    const provenance = new ForkGcProvenanceRegistry();
    const { transit, publish } = objectFixture();
    publish(1);
    expect(() => provenance.begin(
      transit.table,
      descriptor,
      3,
      0,
      4,
      1,
      1,
      0n,
      0n,
      1,
    )).toThrow(/cannot register/);
    expect(transit.get(0)).toBeNull();

    publish(2);
    expect(() => provenance.begin(
      transit.table,
      descriptor,
      3,
      0,
      3,
      1,
      2,
      0n,
      0n,
      1,
    )).toThrow(/unknown GC layout/);
    expect(transit.get(0)).toBeNull();

    publish(3);
    const token = provenance.begin(
      transit.table,
      descriptor,
      3,
      0,
      3,
      1,
      1,
      0n,
      0n,
      1,
    );
    publish(4);
    expect(() => provenance.begin(
      transit.table,
      descriptor,
      3,
      0,
      3,
      1,
      1,
      0n,
      0n,
      1,
    )).toThrow(/still pending/);
    expect(() => provenance.end(token)).toThrow(/not active/);

    publish(5);
    const next = provenance.begin(
      transit.table,
      descriptor,
      3,
      0,
      3,
      1,
      1,
      0n,
      0n,
      1,
    );
    publish(6);
    expect(() =>
      provenance.appendReference(transit.table, next, 1, 0)
    ).toThrow(/canonical order/);
    expect(transit.get(0)).toBeNull();
    expect(() => provenance.end(next)).toThrow(/not active/);
  });
});
