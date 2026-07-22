import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createClosedLazyAssetFetcher,
  snapshotClosedLazyAssets,
  type ClosedLazyAsset,
} from "../src/vfs/closed-lazy-assets";

const URL_A = "https://github.com/example/project/releases/download/v1/a.tar.gz";
const URL_B = "https://github.com/example/project/releases/download/v1/b.tar.gz";

function asset(
  url = URL_A,
  bytes = new Uint8Array([1, 2, 3]),
): ClosedLazyAsset {
  return {
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    bytes,
  };
}

describe("closed lazy assets", () => {
  it("serves exact snapshotted bytes and content length", async () => {
    const source = new Uint8Array([1, 2, 3]);
    const fetcher = createClosedLazyAssetFetcher([asset(URL_A, source)]);
    source.fill(9);

    const first = await fetcher(URL_A);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-length")).toBe("3");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    const second = await fetcher(URL_A);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("rejects an unbound URL without delegating to ambient fetch", async () => {
    const fetcher = createClosedLazyAssetFetcher([asset()]);
    await expect(fetcher(URL_B)).rejects.toThrow("do not bind URL");
  });

  it("verifies SHA-256 before creating a successful response", async () => {
    const binding = asset();
    binding.sha256 = "0".repeat(64);
    const fetcher = createClosedLazyAssetFetcher([binding]);
    await expect(fetcher(URL_A)).rejects.toThrow("changed SHA-256 before response");
  });

  it.each([
    ["empty set", [], "at least one"],
    ["duplicate URL", [asset(), asset()], "duplicate URL"],
    [
      "non-HTTPS URL",
      [asset("http://example.test/a")],
      "canonical credential-free HTTPS",
    ],
    [
      "credentialed URL",
      [asset("https://user@example.test/a")],
      "canonical credential-free HTTPS",
    ],
    [
      "fragment URL",
      [asset("https://example.test/a#fragment")],
      "canonical credential-free HTTPS",
    ],
    [
      "noncanonical URL",
      [asset("https://EXAMPLE.test/a")],
      "canonical credential-free HTTPS",
    ],
    [
      "wrong size",
      [{ ...asset(), size: 4 }],
      "has 3 bytes, expected 4",
    ],
    [
      "invalid SHA-256",
      [{ ...asset(), sha256: "wrong" }],
      "invalid fields",
    ],
  ])("rejects %s", (_name, assets, message) => {
    expect(() => snapshotClosedLazyAssets(assets)).toThrow(message);
  });

  it("returns defensive byte copies", () => {
    const source = new Uint8Array([4, 5, 6]);
    const snapshot = snapshotClosedLazyAssets([asset(URL_A, source)]);
    expect(snapshot[0]!.bytes).not.toBe(source);
    source.fill(0);
    expect(snapshot[0]!.bytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("copies Buffer inputs instead of retaining their shared slice", () => {
    const source = Buffer.from([7, 8, 9]);
    const snapshot = snapshotClosedLazyAssets([asset(URL_A, source)]);
    source.fill(0);
    expect(snapshot[0]!.bytes).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("rejects more than 128 bindings before copying their bytes", () => {
    const assets = Array.from({ length: 129 }, (_, index) =>
      asset(`https://example.test/release/${index}`, new Uint8Array([index & 0xff]))
    );
    expect(() => snapshotClosedLazyAssets(assets)).toThrow("exceed 128 bindings");
  });
});
