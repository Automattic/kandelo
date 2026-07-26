import { describe, expect, it } from "vitest";
import {
  ForkExternrefBroker,
  ForkExternrefTokenRecipeProvider,
  ForkExternrefTokenCache,
} from "../src/fork-reference-broker";

describe("ForkExternrefBroker", () => {
  it("owns aliases once per execution generation and leases them once on fork", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(11);
    const child = broker.createGeneration(12);
    const value = { opaque: true };
    const first = broker.register(parent, value);
    const alias = broker.register(parent, value);
    expect(alias).toBe(first);
    expect(broker.holderCount(first, parent)).toBe(1);

    const lease = broker.acquireFork(parent, child, [first, first, first]);
    expect(lease.handleCount).toBe(1);
    expect(broker.authorize(child, first)).toBe(value);
    expect(broker.holderCount(first, child)).toBe(1);

    expect(broker.releaseGeneration(parent)).toBe(true);
    expect(() => broker.authorize(parent, first)).toThrow("stale");
    expect(broker.authorize(child, first)).toBe(value);
    lease.release();
    expect(() => lease.release()).toThrow("already released");
    expect(() => broker.authorize(child, first)).toThrow("retired");
  });

  it("publishes no partial child ownership when a fork recipe is invalid", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(21);
    const child = broker.createGeneration(22);
    const handle = broker.register(parent, Symbol("opaque"));
    expect(() =>
      broker.acquireFork(parent, child, [handle, handle + 1])
    ).toThrow("unknown externref handle");
    expect(broker.holderCount(handle, child)).toBe(0);
  });

  it("rolls back every child handle when fork publication fails mid-mutation", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(23);
    const child = broker.createGeneration(24);
    const first = broker.register(parent, "first");
    const second = broker.register(parent, "second");
    const state = (
      broker as unknown as {
        generations: WeakMap<
          object,
          { forkHandleCounts: Map<number, number> }
        >;
      }
    ).generations.get(child)!;
    const originalSet = state.forkHandleCounts.set.bind(
      state.forkHandleCounts,
    );
    let writes = 0;
    state.forkHandleCounts.set = (handle, count) => {
      writes++;
      if (writes === 2) throw new Error("injected fork publication failure");
      return originalSet(handle, count);
    };

    expect(() => broker.acquireFork(parent, child, [first, second])).toThrow(
      "injected fork publication failure",
    );
    expect(broker.holderCount(first, child)).toBe(0);
    expect(broker.holderCount(second, child)).toBe(0);
    expect(broker.authorize(parent, first)).toBe("first");
    expect(broker.authorize(parent, second)).toBe("second");
  });

  it("tracks primitive externrefs without conflating distinct values", () => {
    const broker = new ForkExternrefBroker();
    const generation = broker.createGeneration(31);
    const one = broker.register(generation, 1);
    const oneAlias = broker.register(generation, 1);
    const text = broker.register(generation, "1");
    expect(oneAlias).toBe(one);
    expect(text).not.toBe(one);

    const positiveZero = broker.register(generation, 0);
    const negativeZero = broker.register(generation, -0);
    expect(negativeZero).not.toBe(positiveZero);
    expect(Object.is(broker.authorize(generation, positiveZero), 0)).toBe(true);
    expect(Object.is(broker.authorize(generation, negativeZero), -0)).toBe(true);

    const firstNanBytes = new ArrayBuffer(8);
    const firstNanView = new DataView(firstNanBytes);
    firstNanView.setBigUint64(0, 0x7ff8_0000_0000_0001n, true);
    const secondNanBytes = new ArrayBuffer(8);
    const secondNanView = new DataView(secondNanBytes);
    secondNanView.setBigUint64(0, 0x7ff8_0000_0000_0002n, true);
    const firstNan = firstNanView.getFloat64(0, true);
    const secondNan = secondNanView.getFloat64(0, true);
    const firstNanHandle = broker.register(generation, firstNan);
    const firstNanAlias = broker.register(generation, firstNan);
    const secondNanHandle = broker.register(generation, secondNan);
    expect(firstNanAlias).toBe(firstNanHandle);
    expect(secondNanHandle).not.toBe(firstNanHandle);
    const resultBits = (handle: number): bigint => {
      const bytes = new ArrayBuffer(8);
      const view = new DataView(bytes);
      view.setFloat64(
        0,
        broker.authorize(generation, handle) as number,
        true,
      );
      return view.getBigUint64(0, true);
    };
    expect(resultBits(firstNanHandle)).toBe(0x7ff8_0000_0000_0001n);
    expect(resultBits(secondNanHandle)).toBe(0x7ff8_0000_0000_0002n);
  });

  it("accepts every ordinary JavaScript externref shape", () => {
    const broker = new ForkExternrefBroker();
    const generation = broker.createGeneration(32);
    const values = [
      undefined,
      null,
      true,
      7,
      8n,
      "opaque",
      Symbol("opaque"),
      () => 1,
      { opaque: true },
    ];
    const handles = values.map((value) => broker.register(generation, value));
    expect(new Set(handles).size).toBe(values.length);
    values.forEach((value, index) => {
      expect(broker.authorize(generation, handles[index]!)).toBe(value);
    });
  });

  it("tombstones a replaced generation even when its PID is reused", () => {
    const broker = new ForkExternrefBroker();
    const oldGeneration = broker.createGeneration(41);
    const value = { image: "old" };
    const oldHandle = broker.register(oldGeneration, value);

    const replacement = broker.createGeneration(41);
    expect(replacement.id).toBeGreaterThan(oldGeneration.id);
    expect(() => broker.authorize(oldGeneration, oldHandle)).toThrow("stale");
    expect(broker.holderCount(oldHandle, oldGeneration)).toBe(0);
    expect(() => broker.authorize(replacement, oldHandle)).toThrow("retired");

    const replacementHandle = broker.register(replacement, value);
    expect(replacementHandle).toBeGreaterThan(oldHandle);
    expect(broker.authorize(replacement, replacementHandle)).toBe(value);
  });

  it("keeps independent fork leases without multiplying graph aliases", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(51);
    const child = broker.createGeneration(52);
    const handle = broker.register(parent, { opaque: true });
    const first = broker.acquireFork(parent, child, [handle, handle]);
    const second = broker.acquireFork(parent, child, [handle]);

    first.release();
    expect(broker.holderCount(handle, child)).toBe(1);
    second.release();
    expect(broker.holderCount(handle, child)).toBe(0);
    expect(broker.holderCount(handle, parent)).toBe(1);
  });

  it("verifies a complete fork lease before releasing any handle", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(53);
    const child = broker.createGeneration(54);
    const first = broker.register(parent, "first");
    const second = broker.register(parent, "second");
    const lease = broker.acquireFork(parent, child, [first, second]);
    const state = (
      broker as unknown as {
        generations: WeakMap<
          object,
          { forkHandleCounts: Map<number, number> }
        >;
      }
    ).generations.get(child)!;
    state.forkHandleCounts.delete(second);

    expect(() => lease.release()).toThrow("no longer owns fork lease");
    expect(broker.holderCount(first, child)).toBe(1);
    expect(broker.holderCount(second, child)).toBe(1);

    state.forkHandleCounts.set(second, 1);
    lease.release();
    expect(broker.holderCount(first, child)).toBe(0);
    expect(broker.holderCount(second, child)).toBe(0);
  });

  it("does not let a fork lease release a direct generation lease", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(61);
    const child = broker.createGeneration(62);
    const value = { opaque: true };
    const handle = broker.register(parent, value);
    broker.acquire(child, handle);
    const forkLease = broker.acquireFork(parent, child, [handle]);

    forkLease.release();
    expect(broker.authorize(child, handle)).toBe(value);
    broker.release(child, handle);
    expect(() => broker.authorize(child, handle)).toThrow("not authorized");
  });

  it("permanently tombstones explicitly closed handles in every generation", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(71);
    const child = broker.createGeneration(72);
    const value = { resource: "closed" };
    const handle = broker.register(parent, value);
    const lease = broker.acquireFork(parent, child, [handle]);

    broker.tombstone(child, handle);
    expect(() => broker.authorize(parent, handle)).toThrow("retired");
    expect(() => broker.authorize(child, handle)).toThrow("retired");
    lease.release();

    const replacement = broker.register(parent, value);
    expect(replacement).toBeGreaterThan(handle);
    expect(broker.authorize(parent, replacement)).toBe(value);
  });

  it("never reuses wire handles and fails before overflowing u32", () => {
    const broker = new ForkExternrefBroker({ maxHandle: 2 });
    const generation = broker.createGeneration(81);
    const first = broker.register(generation, "first");
    const second = broker.register(generation, "second");
    expect([first, second]).toEqual([1, 2]);
    broker.release(generation, first);
    expect(() => broker.register(generation, "third")).toThrow(
      "handle space exhausted",
    );
    expect(() => broker.authorize(generation, first)).toThrow("retired");
  });

  it("checks generation exhaustion before replacing a live generation", () => {
    const broker = new ForkExternrefBroker({ maxGeneration: 1 });
    const generation = broker.createGeneration(91);
    const handle = broker.register(generation, "still-owned");
    expect(() => broker.createGeneration(91)).toThrow(
      "generation space exhausted",
    );
    expect(broker.authorize(generation, handle)).toBe("still-owned");
  });

  it("rejects a generation token issued by another broker", () => {
    const firstBroker = new ForkExternrefBroker();
    const secondBroker = new ForkExternrefBroker();
    const foreign = firstBroker.createGeneration(101);
    expect(() => secondBroker.register(foreign, "opaque")).toThrow(
      "another broker",
    );
  });
});

describe("ForkExternrefTokenCache", () => {
  it("reconstructs one worker-local identity per stable handle", () => {
    const parent = new ForkExternrefTokenCache(11);
    const child = new ForkExternrefTokenCache(12);

    const parentValue = parent.materialize(7);
    const childValue = child.materialize(7);
    expect(parent.materialize(7)).toBe(parentValue);
    expect(child.materialize(7)).toBe(childValue);
    expect(childValue).not.toBe(parentValue);
    expect(parent.encode(parentValue)).toBe(7);
    expect(child.encode(childValue)).toBe(7);
    expect(parent.encode(childValue)).toBeNull();
    expect(child.encode(parentValue)).toBeNull();
    expect(child.encode({})).toBeNull();
  });

  it("rejects handles that cannot round-trip through the u32 recipe contract", () => {
    const cache = new ForkExternrefTokenCache(13);
    expect(() => cache.materialize(0x1_0000_0000)).toThrow(
      "invalid externref handle",
    );
  });

  it("rejects worker generation ids outside the u32 wire contract", () => {
    expect(() => new ForkExternrefTokenCache(0)).toThrow(
      "externref worker generation",
    );
    expect(() => new ForkExternrefTokenCache(0x1_0000_0000)).toThrow(
      "externref worker generation",
    );
  });
});

describe("ForkExternrefTokenRecipeProvider", () => {
  it("round-trips owner handles through canonical worker tokens", () => {
    const cache = new ForkExternrefTokenCache(14);
    const provider = new ForkExternrefTokenRecipeProvider(cache);
    const token = provider.materialize(41);
    expect(provider.capture(token)).toBe(41);
    expect(provider.materialize(41)).toBe(token);
  });

  it("adopts a raw Worker externref only when fork capture needs a child recipe", () => {
    const cache = new ForkExternrefTokenCache(15);
    const raw = Object.freeze({ workerLocal: true });
    const token = cache.materialize(43);
    const normalized: unknown[] = [];
    const provider = new ForkExternrefTokenRecipeProvider(
      cache,
      (value) => {
        normalized.push(value);
        return token;
      },
    );

    expect(provider.capture(raw)).toBe(43);
    expect(normalized).toEqual([raw]);
    expect(provider.materialize(43)).toBe(token);
  });

  it("detects a host import that bypassed process ownership", () => {
    const provider = new ForkExternrefTokenRecipeProvider(
      new ForkExternrefTokenCache(16),
    );
    expect(() => provider.capture({ raw: true })).toThrow(
      /without passing through the process reference owner/,
    );
  });
});
