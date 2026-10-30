import { describe, expect, it } from "vitest";
import { createOwnedJobLifetime } from "../src/owned-job-lifetime";

describe("owned job namespace lifetime", () => {
  it("publishes an immutable observation, not a mutable retirement capability", () => {
    const owner = createOwnedJobLifetime();
    expect(Object.isFrozen(owner.token)).toBe(true);
    expect(owner.token.closed).toBe(false);
    expect(() => Object.defineProperty(owner.token, "closed", { value: true })).toThrow();
    owner.close(); owner.close();
    expect(owner.token.closed).toBe(true);
  });
  it("does not confuse a replacement owner with retirement of its predecessor", () => {
    const first = createOwnedJobLifetime();
    const second = createOwnedJobLifetime();
    expect(first.token).not.toBe(second.token);
    second.close();
    expect(first.token.closed).toBe(false);
    expect(second.token.closed).toBe(true);
  });
});
