import { describe, expect, it } from "vitest";
import {
  ForkExternrefBroker,
  ForkExternrefTokenCache,
} from "../src/fork-reference-broker";

// Nothing registers a host value with the broker since the cross-worker
// host-import transport was removed, so a generation's handle set is always
// empty. What is still observable -- and what the process owner relies on --
// is generation lifetime and the fork grant's refusal of any handle the
// parent does not own.
describe("ForkExternrefBroker", () => {
  it("grants an empty handle set to a distinct child generation", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(11);
    const child = broker.createGeneration(12);
    const lease = broker.acquireFork(parent, child, []);
    expect(lease.handleCount).toBe(0);
    expect(lease.generation).toBe(child);
  });

  it("requires distinct process generations for a fork", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(13);
    expect(() => broker.acquireFork(parent, parent, [])).toThrow(
      "distinct process generations",
    );
  });

  it("refuses a handle the parent does not own", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(21);
    const child = broker.createGeneration(22);
    expect(() => broker.acquireFork(parent, child, [1])).toThrow(
      "unknown externref handle 1",
    );
    expect(() => broker.acquireFork(parent, child, [0])).toThrow(
      "invalid externref handle",
    );
    expect(() => broker.acquireFork(parent, child, [0x1_0000_0000])).toThrow(
      "invalid externref handle",
    );
  });

  it("retires a replaced generation even when its PID is reused", () => {
    const broker = new ForkExternrefBroker();
    const oldGeneration = broker.createGeneration(41);
    const replacement = broker.createGeneration(41);
    const child = broker.createGeneration(42);
    expect(replacement.id).toBeGreaterThan(oldGeneration.id);
    expect(() => broker.acquireFork(oldGeneration, child, [])).toThrow(
      "stale externref generation",
    );
    expect(broker.acquireFork(replacement, child, []).handleCount).toBe(0);
    // A replaced generation is already closed; releasing it is a no-op.
    expect(broker.releaseGeneration(oldGeneration)).toBe(false);
  });

  it("releases a generation exactly once", () => {
    const broker = new ForkExternrefBroker();
    const parent = broker.createGeneration(51);
    const child = broker.createGeneration(52);
    expect(broker.releaseGeneration(parent)).toBe(true);
    expect(broker.releaseGeneration(parent)).toBe(false);
    expect(() => broker.acquireFork(parent, child, [])).toThrow(
      "stale externref generation",
    );
  });

  it("rejects a generation token issued by another broker", () => {
    const firstBroker = new ForkExternrefBroker();
    const secondBroker = new ForkExternrefBroker();
    const foreign = firstBroker.createGeneration(101);
    const local = secondBroker.createGeneration(102);
    expect(() => secondBroker.acquireFork(foreign, local, [])).toThrow(
      "another broker",
    );
    expect(() => secondBroker.releaseGeneration(foreign)).toThrow(
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
