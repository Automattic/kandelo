import { describe, expect, it } from "vitest";

import { resolveLazyUrl } from "../src/vfs/lazy-url";

describe("lazy asset URL resolution", () => {
  it("resolves relative assets and preserves absolute transports", () => {
    expect(resolveLazyUrl("https://cdn.example.test/release", "tree.zip")).toBe(
      "https://cdn.example.test/release/tree.zip",
    );
    expect(resolveLazyUrl("https://cdn.example.test/release/", "nested/tree.zip")).toBe(
      "https://cdn.example.test/release/nested/tree.zip",
    );
    expect(resolveLazyUrl("https://ignored.example/", "https://cdn.example/tree.zip")).toBe(
      "https://cdn.example/tree.zip",
    );
    expect(resolveLazyUrl("https://ignored.example/", "/assets/tree.zip")).toBe(
      "/assets/tree.zip",
    );
  });
});
