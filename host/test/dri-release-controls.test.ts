import { describe, expect, it } from "vitest";
import { decodeDriReleaseRequest as decode, encodeDriReleaseReply as reply,
  sameDriReleasePlan, DriReleaseControl as C, DriReleasePhase as P } from "../src/dri/release-controls.js";

type Effect = [number, number, number, bigint, bigint, bigint?, bigint?];
// Wire fixture is deliberately specified by ABI offsets, independent of the codec.
function packet(control = C.Begin as number, effects: Effect[] = [], grant = 11n): Uint8Array {
  const out = new Uint8Array(64 + effects.length * 48), v = new DataView(out.buffer);
  v.setUint32(0, 0x52495244, true); v.setUint16(4, 1, true); v.setUint16(6, control, true);
  v.setBigUint64(8, 91n, true); v.setUint32(16, 7, true);
  v.setBigUint64(24, 0xffff_ffff_ffff_ffffn, true); v.setBigUint64(32, grant, true);
  v.setBigUint64(40, BigInt(effects.length), true); v.setBigUint64(48, BigInt(effects.length * 48), true);
  effects.forEach(([tag, pid, object, a, b, c = 0n, d = 0n], i) => {
    const off = 64 + i * 48;
    v.setUint32(off, tag, true); v.setInt32(off + 4, pid, true); v.setUint32(off + 8, object, true);
    for (const [j, word] of [a, b, c, d].entries()) v.setBigUint64(off + 16 + j * 8, word, true);
  });
  return out;
}
const all: Effect[] = [[1, 7, 3, 4096n, 8192n], [2, 7, 3, 0n, 0n],
  [3, 7, 25, 0n, 0n], [4, 7, 25, 0xffff_ffff_ffff_ffffn, 0n],
  [5, 7, 0, 12n, 13n], [6, 82, 34, 0n, 0n]];

describe("private DRI physical-control codec (inactive)", () => {
  it("copies exact full-width owners and all ordered effects, including a foreign session", () => {
    const bytes = packet(C.Begin, all), request = decode(bytes)!;
    expect(request).toMatchObject({control: C.Begin, token: 91n, pid: 7,
      execGeneration: 0xffff_ffff_ffff_ffffn, grant: 11n});
    expect(request.effects.map(e => [e.tag, e.sourcePid, e.object, e.a, e.b, e.c, e.d]))
      .toEqual(all.map(([t,p,o,a,b]) => [t,p,o,a,b,0n,0n]));
    bytes.fill(0);
    expect(request.effects[0].a).toBe(4096n);
    expect(Object.isFrozen(request) && Object.isFrozen(request.effects)
      && request.effects.every(Object.isFrozen)).toBe(true);
  });
  it("accepts a valid plan beyond the unrelated GL64KiB cap", () => {
    const request = decode(packet(C.Begin, Array.from({length: 1600}, () => all[1])));
    expect(request?.effects).toHaveLength(1600);
  });
  it("seals order, multiplicity, owner, generation and grant, not control kind", () => {
    const begin = decode(packet(C.Begin, all))!, poll = decode(packet(C.Poll, all))!;
    expect(sameDriReleasePlan(begin, poll)).toBe(true);
    expect(sameDriReleasePlan(begin, decode(packet(C.Poll, [...all].reverse()))!)).toBe(false);
    expect(sameDriReleasePlan(begin, decode(packet(C.Poll, [...all, all[0]]))!)).toBe(false);
    expect(sameDriReleasePlan(begin, decode(packet(C.Poll, all, 12n))!)).toBe(false);
    const foreign = all.map(e => [...e] as Effect); foreign[5][1] = 83;
    expect(sameDriReleasePlan(begin, decode(packet(C.Poll, foreign))!)).toBe(false);
    expect(sameDriReleasePlan(begin, {...poll, execGeneration: 1n})).toBe(false);
  });
  it.each([
    [0, 4, 0], [4, 2, 2], [6, 2, 0], [6, 2, 6], [20, 4, 1], [56, 8, 1],
    [8, 8, 0], [8, 8, 0x8000_0000_0000_0000n], [16, 4, 0], [16, 4, 0x8000_0000],
    [32, 8, 0], [40, 8, 2], [40, 8, 0xffff_ffff_ffff_ffffn], [48, 8, 47],
    [64 + 12, 4, 1], [64 + 32, 8, 1], [64 + 40, 8, 1],
  ])("rejects malformed offset%s/width%s/value%s without effects", (offset, width, value) => {
    const bytes = packet(C.Begin, [all[0]]), v = new DataView(bytes.buffer);
    if (width === 2) v.setUint16(Number(offset), Number(value), true);
    else if (width === 4) v.setUint32(Number(offset), Number(value), true);
    else v.setBigUint64(Number(offset), BigInt(value), true);
    expect(decode(bytes)).toBeNull();
  });
  it.each<Effect>([[0,7,3,0n,0n], [7,7,3,0n,0n], [2,8,3,0n,0n], [6,0,3,0n,0n],
    [1,7,3,4096n,0n], [1,7,3,0xffff_ffff_ffff_ffffn,1n], [2,7,0,0n,0n],
    [2,7,3,1n,0n], [3,7,3,0n,1n], [4,7,0,1n,0n], [4,7,3,0n,0n],
    [5,7,3,1n,1n], [5,7,0,0n,1n], [6,8,3,0n,1n]])(
      "refuses malformed effect %j", (...effect) => expect(decode(packet(C.Begin, [effect]))).toBeNull());
  it("rejects truncated and trailing data, including non-header-only reservations", () => {
    const bytes = packet(C.Begin, all);
    expect(decode(bytes.subarray(0, 63))).toBeNull();
    expect(decode(bytes.subarray(0, bytes.length - 1))).toBeNull();
    expect(decode(new Uint8Array([...bytes, 0]))).toBeNull();
    expect(decode(packet(C.Reserve, [all[0]], 0n))).toBeNull();
    expect(decode(packet(C.ReleaseReservation, [all[0]]))).toBeNull();
    expect(decode(packet(C.Reserve, [], 11n))).toBeNull();
  });
  it("separates reserve/release acknowledgement from retirement and validates every reply field", () => {
    const reserve = decode(packet(C.Reserve, [], 0n))!, release = decode(packet(C.ReleaseReservation))!;
    const bytes = reply(reserve, P.Reserved, 11n)!;
    const v = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(48);
    expect([v.getUint32(0,true), v.getUint16(4,true), v.getUint16(6,true), v.getBigUint64(8,true),
      v.getBigUint64(16,true), v.getUint32(24,true), v.getUint32(28,true),
      v.getBigUint64(32,true), v.getBigUint64(40,true)])
      .toEqual([0x52495244,1,P.Reserved,91n,11n,7,0,0xffff_ffff_ffff_ffffn,0n]);
    expect(reply(reserve, P.Rejected, 0n, 12)).not.toBeNull();
    expect(reply(release, P.ReservationReleased)).not.toBeNull();
    expect(reply(reserve, P.Retired, 11n)).toBeNull();
    expect(reply(release, P.Retired)).toBeNull();
    expect(reply(reserve, P.Reserved, 0n)).toBeNull();
    expect(reply(reserve, P.Rejected, 11n, 12)).toBeNull();
  });
  it("cannot encode terminal phases for the wrong control or disguise errno/grant mismatch", () => {
    const begin = decode(packet(C.Begin))!, poll = decode(packet(C.Poll))!, forget = decode(packet(C.Forget))!;
    expect(reply(begin, P.Pending)).not.toBeNull();
    expect(reply(poll, P.Retired)).not.toBeNull();
    expect(reply(forget, P.Forgotten)).not.toBeNull();
    expect(reply(begin, P.Forgotten)).toBeNull();
    expect(reply(forget, P.Retired)).toBeNull();
    expect(reply(poll, P.Reserved)).toBeNull();
    expect(reply(begin, P.Rejected, 11n, 0)).toBeNull();
    expect(reply(begin, P.Pending, 11n, 12)).toBeNull();
    expect(reply(begin, P.Retired, 12n)).toBeNull();
    expect(reply({...begin, token: 0n}, P.Pending)).toBeNull();
  });
});
