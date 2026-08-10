import { describe, expect, it } from "vitest";

import { BoundedHttpResponseChunks } from "../src/networking/in-kernel-http";

describe("in-kernel HTTP response bounds", () => {
  it("rejects a response before retaining bytes beyond the caller ceiling", () => {
    const chunks = new BoundedHttpResponseChunks(5);
    chunks.push(new Uint8Array([1, 2, 3]));
    expect(() => chunks.push(new Uint8Array([4, 5, 6]))).toThrow(
      /response exceeds its 5-byte bound/,
    );
    expect([...chunks.concat()]).toEqual([1, 2, 3]);
  });
});
