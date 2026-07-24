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
      signal: expect.any(AbortSignal),
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

  it("trusts the decoded stream length instead of transport Content-Length", async () => {
    const identity = sourceBinding();
    await expect(loadClosedLazyAssetSources([identity], {
      fetchImpl: async () =>
        new Response(new Uint8Array([4, 5, 6]), {
          headers: { "content-length": "03" },
        }),
    })).resolves.toEqual([asset(URL_B, new Uint8Array([4, 5, 6]))]);
    await expect(loadClosedLazyAssetSources([identity], {
      fetchImpl: async () =>
        new Response(new Uint8Array([4, 5, 6]), {
          headers: {
            "content-encoding": "gzip",
            "content-length": "1",
          },
        }),
    })).resolves.toEqual([asset(URL_B, new Uint8Array([4, 5, 6]))]);
  });

  it("rejects a successful response without a body", async () => {
    const identity = sourceBinding();
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
    "/assets/package-tree.zip?",
    "/assets/package-tree.zip?channel=closed",
    "http://assets.example.test/package-tree.zip",
    "http://assets.example.test/package-tree.zip?",
    "https://assets.example.test/package-tree.zip",
    "https://assets.example.test/package-tree.zip?channel=closed",
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
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ["credentials", "https://user:secret@assets.example.test/package.zip"],
    ["fragment", "https://assets.example.test/package.zip#fragment"],
    ["empty fragment", "https://assets.example.test/package.zip#"],
    ["relative empty fragment", "/assets/package.zip#"],
    ["uppercase host", "https://ASSETS.example.test/package.zip"],
    ["dot-segment normalization", "https://assets.example.test/a/../package.zip"],
    ["relative dot-segment normalization", "/assets/a/../package.zip"],
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

  it("rejects empty, sparse, and coercible source manifests before fetching", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([4, 5, 6])));
    await expect(loadClosedLazyAssetSources([], { fetchImpl })).rejects.toThrow(
      "at least one binding",
    );

    const sparse = new Array<ClosedLazyAssetSource>(2);
    sparse[0] = sourceBinding();
    await expect(loadClosedLazyAssetSources(sparse, { fetchImpl })).rejects.toThrow(
      "source 1 is missing",
    );

    const coercibleSha = {
      toString: () => sourceBinding().sha256,
    } as unknown as string;
    await expect(loadClosedLazyAssetSources([{
      ...sourceBinding(),
      sha256: coercibleSha,
    }], { fetchImpl })).rejects.toThrow("invalid fields");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("snapshots every source field before starting transport I/O", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const original = sourceBinding(URL_B, "/assets/original.zip", bytes);
    const mutable = { ...original };
    const manifest = [mutable];
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const loading = loadClosedLazyAssetSources(manifest, { fetchImpl });
    mutable.url = URL_A;
    mutable.sourceUrl = "/assets/mutated.zip";
    mutable.sha256 = "0".repeat(64);
    mutable.size = 1;
    manifest.push(sourceBinding());
    resolveFetch(new Response(bytes));

    await expect(loading).resolves.toEqual([asset(original.url, bytes)]);
    expect(fetchImpl.mock.calls[0]![0]).toBe(original.sourceUrl);
  });

  it("hashes the owned response buffer without an aggregate-sized copy", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const digestInputs: BufferSource[] = [];
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(
      async (algorithm, input) => {
        digestInputs.push(input);
        return digest(algorithm, input);
      },
    );
    try {
      const loaded = await loadClosedLazyAssetSources([
        sourceBinding(URL_B, "/assets/package.zip", bytes),
      ], {
        fetchImpl: async () => new Response(bytes),
      });
      expect(digestInputs).toHaveLength(1);
      expect(digestInputs[0]).toBe(loaded[0]!.bytes.buffer);
    } finally {
      digestSpy.mockRestore();
    }
  });

  it("redacts source queries and cancels an unused HTTP-error body", async () => {
    const cancellationError = new Error("secondary cancellation failure");
    let cancellationReason: unknown;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
        return Promise.reject(cancellationError);
      },
    }), { status: 503 });
    const loading = loadClosedLazyAssetSources([
      sourceBinding(URL_B, "/assets/package.zip?token=private-value"),
    ], { fetchImpl: async () => response });

    const failure = await loading.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "/assets/package.zip?<redacted> returned HTTP 503",
    );
    expect((failure as Error).message).not.toContain("private-value");
    expect(cancellationReason).toBe(failure);
  });

  it("rejects an injected redirected response and cancels its body", async () => {
    let cancellationReason: unknown;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
      },
    }));
    Object.defineProperty(response, "redirected", { value: true });
    const failure = await loadClosedLazyAssetSources([sourceBinding()], {
      fetchImpl: async () => response,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("followed a redirect");
    expect(cancellationReason).toBe(failure);
  });

  it("preserves a pre-aborted caller reason without starting I/O", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped before loading");
    controller.abort(reason);
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([4, 5, 6])));

    await expect(loadClosedLazyAssetSources([sourceBinding()], {
      fetchImpl,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("relays a caller abort to an active fetch and removes its listener", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let internalSignal!: AbortSignal;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchImpl = vi.fn((_input: string | URL, init?: RequestInit) => {
      internalSignal = init!.signal as AbortSignal;
      started();
      return new Promise<Response>((_resolve, reject) => {
        internalSignal.addEventListener(
          "abort",
          () => reject(internalSignal.reason),
          { once: true },
        );
      });
    });
    const loading = loadClosedLazyAssetSources([sourceBinding()], {
      fetchImpl,
      signal: controller.signal,
    });
    await didStart;
    const reason = new Error("caller stopped active loading");
    controller.abort(reason);

    await expect(loading).rejects.toBe(reason);
    expect(internalSignal).not.toBe(controller.signal);
    expect(internalSignal.aborted).toBe(true);
    expect(internalSignal.reason).toBe(reason);
    const listener = addListener.mock.calls[0]![1];
    expect(removeListener).toHaveBeenCalledWith("abort", listener);
  });

  it("removes the caller abort listener after success and transport failure", async () => {
    const scenarios = [
      async () => new Response(new Uint8Array([4, 5, 6])),
      async () => {
        throw new Error("transport failed");
      },
    ];
    for (const fetchImpl of scenarios) {
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      await loadClosedLazyAssetSources([sourceBinding()], {
        fetchImpl,
        signal: controller.signal,
      }).catch(() => undefined);

      const listener = addListener.mock.calls[0]![1];
      expect(removeListener).toHaveBeenCalledWith("abort", listener);
    }
  });

  it("keeps the first worker failure, stops dequeuing, and waits for peer cleanup", async () => {
    const inputs = [0, 1, 2].map((index) => {
      const bytes = new Uint8Array([10 + index]);
      return sourceBinding(
        `https://example.test/releases/${index}.zip`,
        `/assets/${index}.zip`,
        bytes,
      );
    });
    const firstFailure = new Error("first source failed");
    let peerCancelReason: unknown;
    let releasePeerCancel!: () => void;
    const peerCancelGate = new Promise<void>((resolve) => {
      releasePeerCancel = resolve;
    });
    const peerResponse = new Response(new ReadableStream<Uint8Array>({
      cancel(reason) {
        peerCancelReason = reason;
        return peerCancelGate;
      },
    }));
    const started: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      started.push(url);
      if (url === inputs[0]!.sourceUrl) throw firstFailure;
      if (url === inputs[1]!.sourceUrl) return peerResponse;
      return new Response(new Uint8Array([12]));
    });

    const loading = loadClosedLazyAssetSources(inputs, {
      fetchImpl,
      maxConcurrency: 2,
    });
    let settled = false;
    void loading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(peerCancelReason).toBe(firstFailure));
    expect(started).toEqual([inputs[0]!.sourceUrl, inputs[1]!.sourceUrl]);
    expect(settled).toBe(false);
    releasePeerCancel();

    await expect(loading).rejects.toBe(firstFailure);
    expect(started).not.toContain(inputs[2]!.sourceUrl);
  });

  it("returns the exact overflow error only after stream cancellation finishes", async () => {
    let cancellationReason: unknown;
    let releaseCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([4, 5, 6, 7]));
      },
      cancel(reason) {
        cancellationReason = reason;
        return cancellationGate;
      },
    }));
    const loading = loadClosedLazyAssetSources([sourceBinding()], {
      fetchImpl: async () => response,
    });
    let settled = false;
    void loading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(cancellationReason).toBeInstanceOf(Error));
    expect((cancellationReason as Error).message).toContain("exceeds 3 bytes");
    expect(settled).toBe(false);
    releaseCancellation();

    await expect(loading).rejects.toBe(cancellationReason);
  });

  it("preserves an exact stream read failure", async () => {
    const streamFailure = new Error("transport stream failed");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(streamFailure);
      },
    }));

    await expect(loadClosedLazyAssetSources([sourceBinding()], {
      fetchImpl: async () => response,
    })).rejects.toBe(streamFailure);
  });

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
      "empty-fragment URL",
      [asset("https://example.test/a#")],
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

  it("rejects sparse assets and coercible digests before copying bytes", () => {
    const sparse = new Array<ClosedLazyAsset>(2);
    sparse[0] = asset();
    expect(() => snapshotClosedLazyAssets(sparse)).toThrow("asset 1 is missing");

    const coercibleSha = {
      toString: () => asset().sha256,
    } as unknown as string;
    expect(() => snapshotClosedLazyAssets([{
      ...asset(),
      sha256: coercibleSha,
    }])).toThrow("invalid fields");
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
