import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createClosedLazyAssetFetcher,
  loadClosedLazyAssetSources,
  MAX_CLOSED_LAZY_ASSET_BYTES,
  MAX_CLOSED_LAZY_ASSETS,
  snapshotClosedLazyAssets,
  type ClosedLazyAsset,
  type ClosedLazyAssetSource,
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

function sourceBinding(
  url = URL_B,
  sourceUrl = "/assets/package-tree.zip",
  bytes = new Uint8Array([4, 5, 6]),
): ClosedLazyAssetSource {
  return {
    url,
    sourceUrl,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

describe("closed lazy assets", () => {
  it("loads a verified transport source under its canonical deferred-tree URL", async () => {
    const source = new Uint8Array([4, 5, 6, 7]);
    const fetchImpl = vi.fn(async () => new Response(source, {
      headers: { "content-length": String(source.byteLength) },
    }));
    const loaded = await loadClosedLazyAssetSources([
      sourceBinding(URL_B, "/assets/package-tree.zip", source),
    ], { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith("/assets/package-tree.zip", {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    expect(loaded).toEqual([asset(URL_B, source)]);

    const fetcher = createClosedLazyAssetFetcher([
      asset(URL_A, new Uint8Array([1, 2, 3])),
      ...loaded,
    ]);
    expect(new Uint8Array(await (await fetcher(URL_B)).arrayBuffer())).toEqual(source);
    await expect(fetcher("https://example.test/unbound.zip")).rejects.toThrow(
      "do not bind URL",
    );
  });

  it("rejects missing, truncated, oversized, and changed transport sources", async () => {
    const source = new Uint8Array([4, 5, 6]);
    const identity = sourceBinding(URL_B, "/assets/package-tree.zip", source);
    await expect(loadClosedLazyAssetSources([identity], {
      fetchImpl: async () => new Response(null, { status: 404 }),
    })).rejects.toThrow("returned HTTP 404");
    await expect(loadClosedLazyAssetSources([identity], {
      fetchImpl: async () => new Response(source.slice(0, 2)),
    })).rejects.toThrow("has 2 bytes, expected 3");
    await expect(loadClosedLazyAssetSources([identity], {
      fetchImpl: async () => new Response(new Uint8Array([4, 5, 6, 7])),
    })).rejects.toThrow("exceeds 3 bytes");
    await expect(loadClosedLazyAssetSources([{
      ...identity,
      sha256: "0".repeat(64),
    }], {
      fetchImpl: async () => new Response(source),
    })).rejects.toThrow("changed SHA-256");
  });

  it("rejects invalid or mismatched Content-Length and a missing response body", async () => {
    const identity = sourceBinding();
    await expect(loadClosedLazyAssetSources([identity], {
      fetchImpl: async () =>
        new Response(new Uint8Array([4, 5, 6]), {
          headers: { "content-length": "03" },
        }),
    })).rejects.toThrow("has invalid Content-Length");
    await expect(loadClosedLazyAssetSources([identity], {
      fetchImpl: async () =>
        new Response(new Uint8Array([4, 5, 6]), {
          headers: { "content-length": "4" },
        }),
    })).rejects.toThrow("declares 4 bytes, expected 3");
    await expect(loadClosedLazyAssetSources([identity], {
      fetchImpl: async () => new Response(null, { status: 200 }),
    })).rejects.toThrow("has no response body");
  });

  it("validates transport-source identities before fetching", async () => {
    const source = new Uint8Array([4, 5, 6]);
    const identity = sourceBinding(URL_B, "/assets/package-tree.zip", source);
    const fetchImpl = vi.fn(async () => new Response(source));
    await expect(loadClosedLazyAssetSources([
      identity,
      { ...identity, sourceUrl: "/assets/duplicate.zip" },
    ], { fetchImpl })).rejects.toThrow("duplicate URL");
    await expect(loadClosedLazyAssetSources([{
      ...identity,
      sourceUrl: "data:text/plain,not-http",
    }], { fetchImpl })).rejects.toThrow("must be canonical HTTP(S)");
    await expect(loadClosedLazyAssetSources([{
      ...identity,
      url: "http://example.test/not-https",
    }], { fetchImpl })).rejects.toThrow("canonical credential-free HTTPS");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "/assets/package-tree.zip?channel=closed",
    "http://assets.example.test/package-tree.zip",
    "https://assets.example.test/package-tree.zip",
  ])("accepts canonical transport source URL %s", async (sourceUrl) => {
    const source = new Uint8Array([4, 5, 6]);
    const fetchImpl = vi.fn(async () => new Response(source));
    await expect(loadClosedLazyAssetSources([
      sourceBinding(URL_B, sourceUrl, source),
    ], { fetchImpl })).resolves.toEqual([asset(URL_B, source)]);
    expect(fetchImpl).toHaveBeenCalledWith(sourceUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  });

  it.each([
    ["credentials", "https://user:secret@assets.example.test/package.zip"],
    ["fragment", "https://assets.example.test/package.zip#fragment"],
    ["uppercase host", "https://ASSETS.example.test/package.zip"],
    ["dot-segment normalization", "https://assets.example.test/a/../package.zip"],
    ["non-root-relative path", "assets/package.zip"],
    ["network-path reference", "//assets.example.test/package.zip"],
  ])("rejects a transport source URL with %s", async (_name, sourceUrl) => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([4, 5, 6])));
    await expect(loadClosedLazyAssetSources([
      sourceBinding(URL_B, sourceUrl),
    ], { fetchImpl })).rejects.toThrow("must be canonical HTTP(S)");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([0, 17, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxConcurrency %s before fetching",
    async (maxConcurrency) => {
      const fetchImpl = vi.fn(async () => new Response(new Uint8Array([4, 5, 6])));
      await expect(loadClosedLazyAssetSources([sourceBinding()], {
        fetchImpl,
        maxConcurrency,
      })).rejects.toThrow("concurrency must be an integer from 1 to 16");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("limits concurrent fetches while preserving source order", async () => {
    const inputs = [0, 1, 2].map((index) => {
      const bytes = new Uint8Array([10 + index]);
      return {
        bytes,
        binding: sourceBinding(
          `https://example.test/releases/${index}.zip`,
          `https://assets.example.test/releases/${index}.zip`,
          bytes,
        ),
      };
    });
    const started: string[] = [];
    const pending = new Map<string, (response: Response) => void>();
    let active = 0;
    let peakActive = 0;
    const fetchImpl = vi.fn((input: string | URL) => {
      const url = String(input);
      started.push(url);
      active += 1;
      peakActive = Math.max(peakActive, active);
      return new Promise<Response>((resolve) => {
        pending.set(url, (response) => {
          active -= 1;
          resolve(response);
        });
      });
    });

    const loading = loadClosedLazyAssetSources(
      inputs.map(({ binding }) => binding),
      { fetchImpl, maxConcurrency: 2 },
    );
    expect(started).toEqual([
      inputs[0]!.binding.sourceUrl,
      inputs[1]!.binding.sourceUrl,
    ]);

    pending.get(inputs[1]!.binding.sourceUrl)!(new Response(inputs[1]!.bytes));
    await vi.waitFor(() => {
      expect(started).toEqual([
        inputs[0]!.binding.sourceUrl,
        inputs[1]!.binding.sourceUrl,
        inputs[2]!.binding.sourceUrl,
      ]);
    });
    pending.get(inputs[2]!.binding.sourceUrl)!(new Response(inputs[2]!.bytes));
    pending.get(inputs[0]!.binding.sourceUrl)!(new Response(inputs[0]!.bytes));

    const loaded = await loading;
    expect(peakActive).toBe(2);
    expect(loaded.map(({ url }) => url)).toEqual(
      inputs.map(({ binding }) => binding.url),
    );
    expect(loaded.map(({ bytes }) => Array.from(bytes))).toEqual([[10], [11], [12]]);
  });

  it("bounds transport source count and declared total bytes before fetching", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1])));
    const tooMany = Array.from(
      { length: MAX_CLOSED_LAZY_ASSETS + 1 },
      (_, index) => ({
        ...sourceBinding(
          `https://example.test/releases/${index}.zip`,
          `/assets/${index}.zip`,
          new Uint8Array([index & 0xff]),
        ),
      }),
    );
    await expect(loadClosedLazyAssetSources(tooMany, { fetchImpl })).rejects.toThrow(
      `exceed ${MAX_CLOSED_LAZY_ASSETS} bindings`,
    );

    const oversized = [
      {
        ...sourceBinding(URL_A, "/assets/a.zip", new Uint8Array([1])),
        size: MAX_CLOSED_LAZY_ASSET_BYTES,
      },
      {
        ...sourceBinding(URL_B, "/assets/b.zip", new Uint8Array([2])),
        size: 1,
      },
    ];
    await expect(loadClosedLazyAssetSources(oversized, { fetchImpl })).rejects.toThrow(
      `exceed ${MAX_CLOSED_LAZY_ASSET_BYTES} bytes`,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

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
