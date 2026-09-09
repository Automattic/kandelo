import { describe, expect, it } from "vitest";
import { HostRandomProvider } from "../src/vfs/random";

describe("HostRandomProvider", () => {
  it("draws exactly the requested length", () => {
    const provider = new HostRandomProvider();
    expect(provider.getRandomBytes(0)).toHaveLength(0);
    expect(provider.getRandomBytes(16)).toHaveLength(16);
  });

  it("fills a draw larger than one getRandomValues call may", () => {
    // crypto.getRandomValues refuses more than 65536 bytes at a time, so a
    // larger draw crosses the chunk boundary.
    const bytes = new HostRandomProvider().getRandomBytes(65536 + 512);
    expect(bytes).toHaveLength(65536 + 512);
    const tail = bytes.subarray(65536);
    expect(tail.some((byte) => byte !== 0)).toBe(true);
  });
});
