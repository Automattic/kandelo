import assert from "node:assert/strict";
import { test } from "vitest";
import {
  InvalidOverlayActivationError,
  OverlayActivationControlPair, type OverlayActivationRecord,
  UnprovenOverlayActivationCleanupError,
} from "../src/vfs/overlay-generation-activation";
import { activationCodec, decodeOverlayActivation, encodeOverlayActivation, nativeOverlayControlCall } from "./fixtures/native-overlay-activation";
import { createOverlayActivationCodec } from "../src/vfs/overlay-activation-codec";
import { ERRNO } from "../src/generated/abi";

const initial: OverlayActivationRecord = { sequence: 1, generation: 0, slot: "legacy",
  baseDigest: new Uint8Array(32).fill(7), sealDigest: new Uint8Array(32) };
const next: OverlayActivationRecord = { sequence: 2, generation: 1, slot: "g0",
  baseDigest: initial.baseDigest, sealDigest: new Uint8Array(32).fill(9) };

test("native generation authority binds activated content and refuses missing or substituted recovery", () => {
  assert.equal(activationCodec.candidateRole(next, next), "active");
  assert.equal(activationCodec.candidateRole(null, next), "unanchored");
  assert.equal(activationCodec.candidateRole(next, { ...next, slot: "g1", generation: 2 }), "unpublished");
  assert.equal(activationCodec.candidateRole({ ...next, slot: "g1", generation: 2 }, next), "inactive");
  assert.throws(() => activationCodec.candidateRole(next, { ...next, sealDigest: new Uint8Array(32).fill(10) }), InvalidOverlayActivationError);
  assert.throws(() => activationCodec.requireInventory(next, null, false), InvalidOverlayActivationError);
  assert.throws(() => activationCodec.requireInventory(null, null, true), InvalidOverlayActivationError);
  assert.doesNotThrow(() => activationCodec.requireInventory(next, next, true));
  assert.doesNotThrow(() => activationCodec.requireInventory(initial, null, true));
});

test("native ordering rejects ambiguous sealed generations independently of slot ordering", () => {
  const older = { slot: "g9" as const, generation: 2 };
  const newer = { slot: "g0" as const, generation: 3 };
  assert.equal(activationCodec.compareGenerations(older, newer), -1);
  assert.equal(activationCodec.compareGenerations(older, newer, true), 1);
  assert.equal(activationCodec.compareGenerations(newer, newer), 0);
  assert.throws(() => activationCodec.compareGenerations(older, { ...older, slot: "g1" }), /ambiguous sealed generations/);
  assert.throws(() => activationCodec.compareGenerations({ ...older, generation: NaN }, newer), InvalidOverlayActivationError);
});

test("native retention protects active, predecessor, unknown and newer generations", () => {
  const active = { slot: "g2" as const, generation: 8 };
  const source = { slot: "g1" as const, generation: 7 };
  assert.equal(activationCodec.mayRetire(active, source, { slot: "g0", generation: 6 }), true);
  for (const candidate of [active, source, { slot: "g0" as const, generation: 0 }, { slot: "g0" as const, generation: 9 }]) {
    assert.equal(activationCodec.mayRetire(active, source, candidate), false);
  }
  assert.equal(activationCodec.mayReuse(active, { slot: "g0", generation: 9 }), true);
  assert.equal(activationCodec.mayReuse(active, { slot: "g0", generation: 0 }), false);
  assert.equal(activationCodec.mayStage(active, source, active), false);
  assert.equal(activationCodec.mayStage(active, source, { ...source, generation: 0 }), false);
  assert.equal(activationCodec.mayStage(active, source, { slot: "g0", generation: 0 }), true);
  assert.equal(activationCodec.relationship(active, source.slot, source), "predecessor");
  assert.equal(activationCodec.relationship(active, source.slot, { ...source, generation: 9 }), "reused");
  assert.equal(activationCodec.relationship(active, active.slot, active), "self");
  assert.equal(activationCodec.mayRetireUnsealed({ slot: "g1", generation: 2 }, next, "legacy", true), true);
  assert.equal(activationCodec.mayRetireUnsealed({ slot: "g1", generation: 2 }, next, "legacy", false), false);
});

test("generation policy uses bounded packets and preserves native resource and transport errors", () => {
  const lengths: number[] = [];
  const codec = createOverlayActivationCodec((operation, bytes) => {
    if (operation >= 21) lengths.push(bytes.length);
    return nativeOverlayControlCall(operation, bytes);
  });
  codec.compareGenerations({ slot: "g0", generation: 1 }, { slot: "g1", generation: 2 });
  codec.candidateRole(next, next);
  codec.requireInventory(next, next, false);
  codec.relationship(next, "legacy", initial);
  codec.mayStage(next, initial, { slot: "g1", generation: 0 });
  codec.mayReclaimUnpublished({ ...next, generation: 2 }, { ...next, generation: 2 },
    { slot: "g1", generation: 1 }, { slot: "g2", generation: 0 });
  assert.deepEqual(lengths, [88, 248, 248, 128, 128, 328]);
  for (const errno of [ERRNO.ENOMEM, ERRNO.ENOSYS]) {
    const failed = createOverlayActivationCodec(() => -errno);
    assert.throws(() => failed.mayReuse(initial, next), error => !(error instanceof InvalidOverlayActivationError)
      && (error as { errno?: number }).errno === errno);
  }
  const broken = createOverlayActivationCodec(() => Uint8Array.of(1));
  assert.throws(() => broken.mayReuse(initial, next), /invalid transport geometry/);
});

test("unpublished cleanup needs current activated identity rather than unknown generation ordering", () => {
  const active = { ...next, slot: "g2" as const, generation: 8 };
  const source = { slot: "g1" as const, generation: 7 };
  const unknown = { slot: "g0" as const, generation: 0 };
  assert.equal(activationCodec.mayRetire(active, source, unknown), false);
  assert.equal(activationCodec.mayReclaimUnpublished(null, active, source, unknown), false);
  assert.equal(activationCodec.mayReclaimUnpublished(active, active, source, unknown), true);
  assert.equal(activationCodec.mayReclaimUnpublished(active, active, source, { ...source, generation: 0 }), false);
  assert.equal(activationCodec.mayReclaimUnpublished(active, active, source, { ...unknown, generation: 9 }), false);
  assert.throws(() => activationCodec.mayReclaimUnpublished(active, { ...active, sealDigest: new Uint8Array(32) }, source, unknown),
    InvalidOverlayActivationError);
});

test("Rust activation codec preserves the canonical stored bytes", () => {
  assert.equal(Buffer.from(encodeOverlayActivation(next)).toString("hex"),
    "4b4f474101000000020000000000000001000000000000000100000000000000" +
    "0707070707070707070707070707070707070707070707070707070707070707" +
    "0909090909090909090909090909090909090909090909090909090909090909" +
    "821b6bb729d2d1d518834fab1901f2b3061f3f4d8414e0b3157db0c120540120");
});

test("native transport rejects unsafe numbers and preserves maximum safe slots", () => {
  for (const sequence of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encodeOverlayActivation({ ...next, sequence }), InvalidOverlayActivationError);
  }
  const highest = { ...next, slot: `g${Number.MAX_SAFE_INTEGER - 1}` as const, sequence: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(decodeOverlayActivation(encodeOverlayActivation(highest)), highest);
  assert.deepEqual(activationCodec.next(highest, highest), highest);
  assert.throws(() => activationCodec.next(highest, { ...highest, generation: 2 }), InvalidOverlayActivationError);
  for (const slot of ["g-1", "g9007199254740991", "g01", "ĝ0"] as OverlayActivationRecord["slot"][]) {
    assert.throws(() => encodeOverlayActivation({ ...next, slot }), InvalidOverlayActivationError);
  }
});

test("codec resource and transport failures are not recast as storage corruption", () => {
  const refused = createOverlayActivationCodec(() => -ERRNO.ENOMEM);
  assert.throws(() => refused.encode(next), error => !(error instanceof InvalidOverlayActivationError)
    && (error as { errno?: number }).errno === ERRNO.ENOMEM);
  const broken = createOverlayActivationCodec(() => 128);
  assert.throws(() => broken.encode(next), error => error instanceof Error && !(error instanceof InvalidOverlayActivationError));
  const primary = new Error("kernel entry is not available");
  const unavailable = createOverlayActivationCodec(() => { throw primary; });
  assert.throws(() => unavailable.decode(new Uint8Array(128)), error => error === primary);
});

function files(entries: [Uint8Array, Uint8Array], options: { cut?: number; timing?: "before" | "after"; through?: boolean } = {}) {
  const durable = entries.map(bytes => bytes.slice());
  const volatile = entries.map(bytes => bytes.slice());
  let operation = 0;
  const perform = (action: () => void) => {
    const current = operation++;
    if (current === options.cut && options.timing === "before") throw new Error("owner lost");
    action();
    if (current === options.cut && options.timing === "after") throw new Error("owner lost");
  };
  const backend = { activationCodec, open: async (replica: 0 | 1) => ({
    len: () => volatile[replica]!.length,
    readExactAt: (_offset: number | bigint, destination: Uint8Array) => { destination.set(volatile[replica]!); },
    writeAllAt: (_offset: number | bigint, bytes: Uint8Array) => perform(() => {
      volatile[replica] = bytes.slice();
      if (options.through) durable[replica] = bytes.slice();
    }),
    truncate: (length: number | bigint) => perform(() => {
      volatile[replica] = volatile[replica]!.slice(0, Number(length));
      if (options.through) durable[replica] = volatile[replica]!.slice();
    }),
    flush: () => perform(() => { durable[replica] = volatile[replica]!.slice(); }),
    close: () => {},
  }) };
  return { backend, durable };
}

test("fixed activation records round-trip and reject every single-byte change", () => {
  const bytes = encodeOverlayActivation(next);
  assert.deepEqual(decodeOverlayActivation(bytes), next);
  for (let index = 0; index < bytes.length; index++) {
    const damaged = bytes.slice();
    damaged[index]! ^= 1;
    assert.throws(() => decodeOverlayActivation(damaged), InvalidOverlayActivationError);
  }
  for (const value of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encodeOverlayActivation({ ...next, sequence: value }), InvalidOverlayActivationError);
  }
  assert.throws(() => encodeOverlayActivation({ ...next, slot: "g01" }), InvalidOverlayActivationError);
  assert.throws(() => encodeOverlayActivation({ ...initial, generation: 1 }), InvalidOverlayActivationError);
});

test("newest valid replica wins; conflicts and two damaged replicas refuse", async () => {
  const old = encodeOverlayActivation(initial);
  const current = encodeOverlayActivation(next);
  for (const entries of [[old, current], [new Uint8Array([1]), current], [current, new Uint8Array([1])]] as [Uint8Array, Uint8Array][]) {
    const pair = await OverlayActivationControlPair.open(files(entries).backend);
    assert.deepEqual(pair.current, next);
    pair.close();
    assert.throws(() => pair.current, InvalidOverlayActivationError);
  }
  await assert.rejects(() => OverlayActivationControlPair.open(files([Uint8Array.of(1), Uint8Array.of(2)]).backend), InvalidOverlayActivationError);
  const conflict = encodeOverlayActivation({ ...next, sealDigest: new Uint8Array(32).fill(10) });
  await assert.rejects(() => OverlayActivationControlPair.open(files([current, conflict]).backend), InvalidOverlayActivationError);
});

for (const newestReplica of [0, 1] as const) {
  for (const failureKind of ["memory", "unavailable", "protocol"] as const) {
    test(`native ${failureKind} failure on replica ${newestReplica} never authorizes older activation`, async () => {
      const old = encodeOverlayActivation(initial);
      const current = encodeOverlayActivation(next);
      const entries: [Uint8Array, Uint8Array] = newestReplica === 0 ? [current, old] : [old, current];
      const storage = files(entries);
      const refused = createOverlayActivationCodec(() => failureKind === "memory" ? -ERRNO.ENOMEM
        : failureKind === "unavailable" ? -ERRNO.ENOSYS : 128);
      const open = storage.backend.open;
      const closes = [0, 0];
      let selections = 0;
      storage.backend.open = async replica => {
        const handle = await open(replica);
        handle.close = () => { closes[replica]++; };
        return handle;
      };
      storage.backend.activationCodec = {
        ...activationCodec,
        decode: bytes => bytes[8] === next.sequence ? refused.decode(bytes) : activationCodec.decode(bytes),
        select: (...args) => { selections++; return activationCodec.select(...args); },
      };
      await assert.rejects(() => OverlayActivationControlPair.open(storage.backend), error => {
        assert(error instanceof Error && !(error instanceof InvalidOverlayActivationError));
        if (failureKind !== "protocol") {
          assert.equal((error as Error & { errno?: number }).errno,
            failureKind === "memory" ? ERRNO.ENOMEM : ERRNO.ENOSYS);
        }
        return true;
      });
      assert.equal(selections, 0);
      assert.deepEqual(closes, [1, 1]);
      assert.deepEqual(storage.durable, entries);
      const recovered = await OverlayActivationControlPair.open(files(storage.durable as [Uint8Array, Uint8Array]).backend);
      try { assert.deepEqual(recovered.current, next); }
      finally { recovered.close(); }
    });
  }
}

test("publication repairs replicas and rejects rollback or base substitution", async () => {
  const storage = files([encodeOverlayActivation(initial), new Uint8Array()]);
  const pair = await OverlayActivationControlPair.open(storage.backend);
  await pair.prepare();
  pair.publish(pair.next(initial));
  assert.deepEqual(storage.durable[0], storage.durable[1]);
  pair.publish(pair.next(next));
  assert.deepEqual(pair.current, next);
  assert.throws(() => pair.next(initial), InvalidOverlayActivationError);
  assert.throws(() => pair.next({ ...next, generation: 2, baseDigest: new Uint8Array(32) }), InvalidOverlayActivationError);
  pair.close();
});

test("retains uncertain close ownership and never retries a potentially consumed handle", async () => {
  const storage = files([encodeOverlayActivation(next), encodeOverlayActivation(next)]);
  const open = storage.backend.open;
  const closes = [0, 0];
  storage.backend.open = async replica => {
    const handle = await open(replica);
    handle.close = () => { closes[replica]++; if (replica === 0) throw new Error("unproven descriptor close"); };
    return handle;
  };
  const pair = await OverlayActivationControlPair.open(storage.backend);
  let failure: unknown;
  try { pair.close(); } catch (error) { failure = error; }
  assert(failure instanceof UnprovenOverlayActivationCleanupError);
  assert.equal(failure.resources.length, 1);
  pair.close();
  assert.deepEqual(closes, [1, 1]);
  await assert.rejects(() => pair.prepare(), InvalidOverlayActivationError);
});

for (const freshReplica of [0, 1] as const) {
  for (const phase of ["repair", "advance"] as const) {
    test(`repairs degraded source replicas before a torn ${phase} with fresh replica ${freshReplica}`, async () => {
      const current = encodeOverlayActivation(next);
      const old = encodeOverlayActivation(initial);
      const entries: [Uint8Array, Uint8Array] = freshReplica === 0 ? [current, old] : [old, current];
      const storage = files(entries);
      const open = storage.backend.open;
      let armed = phase === "repair";
      const damagedReplica = phase === "repair" ? 1 - freshReplica : 0;
      storage.backend.open = async replica => {
        const handle = await open(replica);
        const write = handle.writeAllAt;
        handle.writeAllAt = (offset, bytes) => {
          if (armed && replica === damagedReplica) {
            write(offset, bytes.subarray(0, 64));
            handle.flush();
            throw new Error("torn activation write");
          }
          write(offset, bytes);
        };
        return handle;
      };
      const pair = await OverlayActivationControlPair.open(storage.backend);
      if (phase === "repair") await assert.rejects(() => pair.prepare(), /torn activation write/);
      else {
        await pair.prepare();
        assert.deepEqual(storage.durable, [current, current]);
        armed = true;
        assert.throws(() => pair.publish(pair.next({ ...next, generation: 2, slot: "g1", sealDigest: new Uint8Array(32).fill(11) })), /torn activation write/);
      }
      const recovered = await OverlayActivationControlPair.open(files(storage.durable as [Uint8Array, Uint8Array]).backend);
      assert.deepEqual(recovered.current, next);
      recovered.close();
      pair.close();
    });
  }
}

for (const through of [false, true]) {
  for (const timing of ["before", "after"] as const) {
    for (let cut = 0; cut < 8; cut++) {
      test(`control publication crash cut ${through ? "write-through" : "flush-only"}/${timing}/${cut}`, async () => {
        const bytes = encodeOverlayActivation(initial);
        const storage = files([bytes, bytes], { cut, timing, through });
        const pair = await OverlayActivationControlPair.open(storage.backend);
        await assert.rejects(async () => { await pair.prepare(); pair.publish(pair.next(next)); }, /owner lost/);
        assert.throws(() => pair.current, InvalidOverlayActivationError);
        assert.throws(() => pair.next(next), InvalidOverlayActivationError);
        await assert.rejects(() => pair.prepare(), InvalidOverlayActivationError);
        const recovered = await OverlayActivationControlPair.open(files(storage.durable as [Uint8Array, Uint8Array]).backend);
        assert(["legacy", "g0"].includes(recovered.current!.slot));
        assert.deepEqual(recovered.current, recovered.current!.slot === "legacy" ? initial : next);
        recovered.close();
        pair.close();
      });
    }
  }
}
