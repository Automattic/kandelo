import { describe, it, expect } from "vitest";
import { buildRootfsLazyWiring } from "../src/vfs/rootfs-lazy-archives";
import type { DeferredBody } from "../src/vfs/rootfs-lazy-archives";

/**
 * THE MEMBER-REDUCTION CASES MOVED, 2026-09-17, three of them: (a) only the
 * live file member is mapped, (b) the archive table gets the minted id and raw
 * size, (g) a group with no declared length is skipped whole.
 *
 * They asserted `reduceLazyArchiveGroups`, reached through this file because
 * `buildRootfsLazyWiring` used to call it. It no longer does: what a host does
 * with a deferred body is fetch it, so the wiring takes an address, its
 * mirrors and a length, and the member list and mount prefix it used to reduce
 * away are not produced in the first place. The reduction's one remaining
 * caller is the `KLZY` encoder in `memory-fs.ts`, so the cases live beside
 * that encoder now, in `vfs-image-kernel-lazy.test.ts`, and retire with it.
 */

/** Let an in-flight async archive fetch (and its chained `.then`s) settle
 * before making assertions. A macrotask tick is used rather than a fixed
 * number of microtask ticks so the wait is robust to engine-internal
 * microtask-queueing changes around thenable resolution. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type DeferredProvider = (
  uri: string,
  offset: bigint,
  dest: Uint8Array,
) => number;

/** The provider, read as the archive assertions below read it.
 *
 * There is no narrowing left to do: an archive is addressed by the same kind
 * of value a lazy file is, so this is the whole provider under a name that
 * says which resource these particular tests are about. The address of an
 * archive is the first of its transports — the URL the image recorded. */
function archiveReaderOf(
  wiring: { deferredProvider: DeferredProvider },
): DeferredProvider {
  return wiring.deferredProvider;
}

/** A deferred archive as the wiring is handed one: an address, its mirrors in
 * preference order, and what the image said the bytes weigh. */
function archive(overrides: Partial<DeferredBody> = {}): DeferredBody {
  const transports = overrides.transports ?? ["u1"];
  return {
    address: overrides.address ?? transports[0] ?? "",
    transports,
    bytes: "bytes" in overrides ? overrides.bytes : 1,
    sha256: overrides.sha256,
  };
}

describe("buildRootfsLazyWiring", () => {
  const ARCHIVE_SIZE = 20;
  const archiveBytes = new Uint8Array(ARCHIVE_SIZE);
  for (let i = 0; i < ARCHIVE_SIZE; i++) archiveBytes[i] = i;

  function makeFetcher() {
    const calls: string[] = [];
    let resolveFetch!: (v: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((resolve) => {
      resolveFetch = resolve;
    });
    const fetcher = async (url: string): Promise<Uint8Array> => {
      calls.push(url);
      return pending;
    };
    return { fetcher, calls, settle: () => resolveFetch(archiveBytes) };
  }

  /** The policy this wiring holds: one archive with two mirrors and a declared
   * length, plus one the image sized nowhere. A body with no declared length
   * is skipped, so its address is fetched directly rather than through a
   * mirror list that could serve something else unchecked. */
  function buildEntries(): DeferredBody[] {
    return [
      archive({ address: "no-size", transports: ["no-size"], bytes: undefined }),
      archive({ transports: ["u1", "u2"], bytes: ARCHIVE_SIZE }),
    ];
  }

  it("(c) first provider call returns EAGAIN and invokes the fetcher", () => {
    const { fetcher, calls } = makeFetcher();
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(buildEntries(), fetcher));

    const dest = new Uint8Array(8);
    const result = archiveProvider("u1", 0n, dest);

    expect(result).toBe(-11);
    expect(calls).toEqual(["u1"]);
  });

  it("(d) after the fetch settles, offset 0 fills dest with the archive prefix", async () => {
    const { fetcher, settle } = makeFetcher();
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(buildEntries(), fetcher));

    const dest0 = new Uint8Array(8);
    expect(archiveProvider("u1", 0n, dest0)).toBe(-11);

    settle();
    await flushMicrotasks();

    const dest = new Uint8Array(8);
    const n = archiveProvider("u1", 0n, dest);
    expect(n).toBe(8);
    expect(dest).toEqual(archiveBytes.subarray(0, 8));
  });

  it("(e) a nonzero offset returns the correct mid-archive slice", async () => {
    const { fetcher, settle } = makeFetcher();
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(buildEntries(), fetcher));

    archiveProvider("u1", 0n, new Uint8Array(1));
    settle();
    await flushMicrotasks();

    const dest = new Uint8Array(5);
    const n = archiveProvider("u1", 10n, dest);
    expect(n).toBe(5);
    expect(dest).toEqual(archiveBytes.subarray(10, 15));
  });

  it("(f) a call past the end returns 0", async () => {
    const { fetcher, settle } = makeFetcher();
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(buildEntries(), fetcher));

    archiveProvider("u1", 0n, new Uint8Array(1));
    settle();
    await flushMicrotasks();

    const dest = new Uint8Array(4);
    const n = archiveProvider("u1", BigInt(ARCHIVE_SIZE), dest);
    expect(n).toBe(0);
  });

  // What replaced "an id this builder never minted". There are no ids to mint,
  // so an address this host holds no POLICY for is not a contract violation —
  // it is the ordinary case, and fetching it directly is the whole point of
  // relaying the address instead of resolving a number through a table.
  it("fetches an address it holds no transport policy for, rather than refusing it", () => {
    const { fetcher, calls } = makeFetcher();
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(buildEntries(), fetcher));

    const dest = new Uint8Array(4);
    expect(archiveProvider("https://elsewhere/x", 0n, dest)).toBe(-11);
    expect(calls).toEqual(["https://elsewhere/x"]);
  });

  // The one address that IS refused, because it is not an address. The kernel
  // sends it when the image declared none, and there is no longer a table to
  // guess from — which is the defect this change removed, so guessing here
  // would put it straight back.
  it("refuses an empty address instead of guessing which resource was meant", () => {
    const { fetcher, calls } = makeFetcher();
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(buildEntries(), fetcher));

    expect(archiveProvider("", 0n, new Uint8Array(4))).toBe(-5);
    expect(calls).toEqual([]);
  });

  // RETIRED 2026-09-17: "falls back to `url` as the sole transport when
  // content.transports is absent". That fallback was a rule about the LEGACY
  // JSON shape — an entry with no `content` carries only a `url` — and reading
  // that shape is no longer this module's job. The rule itself is not gone: it
  // is `declaredTransports` in `module-base-image.ts`, asserted by "rebases an
  // archive's transports AND the url derived from them", which exercises both
  // the listed-transports and the bare-url branch on a real image. Keeping a
  // copy here would have meant hand-building the legacy shape to check a
  // conversion this file no longer performs.

  it("fetches a body the image sized nowhere, instead of checking it against nothing", async () => {
    // THE SKIP RULE, and why it is a skip rather than a tolerance. A transport
    // list is only usable with a declared length: the whole point of trying
    // the next mirror is that the first one served the wrong number of bytes,
    // and with no length to compare against, "wrong" cannot be decided. So a
    // body with no declared length holds no policy at all, and its address is
    // fetched directly — which is what the courier contract does with any
    // address it has no entry for.
    //
    // Admitting it to the table instead would compare a real length against
    // `undefined`, fail every mirror in turn, and end in EIO for an archive
    // whose only fault was that nobody wrote down its size.
    const calls: string[] = [];
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const fetcher = async (url: string): Promise<Uint8Array> => {
      calls.push(url);
      return bytes;
    };
    const unsized = archive({
      address: "no-size",
      transports: ["no-size", "a-mirror"],
      bytes: undefined,
    });

    const read = archiveReaderOf(buildRootfsLazyWiring([unsized], fetcher));
    expect(read("no-size", 0n, new Uint8Array(4))).toBe(-11);
    await flushMicrotasks();

    const dest = new Uint8Array(4);
    expect(read("no-size", 0n, dest)).toBe(4);
    expect(dest).toEqual(bytes);
    // Fetched once, at the address, and the mirror was never consulted.
    expect(calls).toEqual(["no-size"]);
  });

  it("tries the next transport on a size mismatch and serves from the good one", async () => {
    const calls: string[] = [];
    const badBytes = new Uint8Array(ARCHIVE_SIZE - 1); // wrong length
    const fetcher = async (url: string): Promise<Uint8Array> => {
      calls.push(url);
      if (url === "bad-url") return badBytes;
      return archiveBytes;
    };

    const group = archive({
      transports: ["bad-url", "good-url"],
      bytes: ARCHIVE_SIZE,
      sha256: "deadbeef",
    });

    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring([group], fetcher));

    expect(archiveProvider("bad-url", 0n, new Uint8Array(1))).toBe(-11);
    // Let the bad-url fetch settle and the good-url fetch settle in turn.
    await flushMicrotasks();

    expect(calls).toEqual(["bad-url", "good-url"]);

    const dest = new Uint8Array(4);
    const n = archiveProvider("bad-url", 0n, dest);
    expect(n).toBe(4);
    expect(dest).toEqual(archiveBytes.subarray(0, 4));
  });
});

describe("one address space, so nothing needs routing", () => {
  const archiveBytes = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

  /** A wiring holding transport policy for ONE archive address, alongside a
   * fetcher that answers any other address with file bytes. */
  function wiring() {
    const calls: string[] = [];
    const { deferredProvider } = buildRootfsLazyWiring(
      [
        archive({
          transports: ["https://example.invalid/pkg.zip"],
          bytes: archiveBytes.length,
          sha256: "x",
        }),
      ],
      async (url) => {
        calls.push(url);
        return url.endsWith(".zip") ? archiveBytes : new Uint8Array([0x01, 0x02]);
      },
    );
    return { deferredProvider, calls };
  }

  // This replaces "serves id 1 as a lazy FILE and id 1 as an ARCHIVE,
  // differently". That test existed because the two id spaces OVERLAPPED — the
  // same number 1 named an inode and an archive, and only a `kind` argument
  // told them apart. Under URI addressing the collision it guarded against
  // cannot be constructed: the address is the identity, so two resources are
  // the same resource exactly when their addresses match. What is left to
  // check is that one provider really does serve both without a discriminator.
  it("serves a file address and an archive address without being told which is which", async () => {
    const { deferredProvider, calls } = wiring();

    const fileDest = new Uint8Array(4);
    expect(deferredProvider("https://example.invalid/node", 0n, fileDest)).toBe(-11);
    const archiveDest = new Uint8Array(4);
    expect(deferredProvider("https://example.invalid/pkg.zip", 0n, archiveDest)).toBe(-11);
    await flushMicrotasks();

    expect(deferredProvider("https://example.invalid/node", 0n, fileDest)).toBe(2);
    expect(fileDest.subarray(0, 2)).toEqual(new Uint8Array([0x01, 0x02]));
    expect(deferredProvider("https://example.invalid/pkg.zip", 0n, archiveDest)).toBe(4);
    expect(archiveDest).toEqual(archiveBytes);

    // Each address was fetched once and on its own behalf.
    expect(calls).toEqual([
      "https://example.invalid/node",
      "https://example.invalid/pkg.zip",
    ]);
  });

  it("caches per address, so a second reader of the same resource refetches nothing", async () => {
    const { deferredProvider, calls } = wiring();

    expect(deferredProvider("https://example.invalid/node", 0n, new Uint8Array(4))).toBe(-11);
    await flushMicrotasks();
    expect(deferredProvider("https://example.invalid/node", 2n, new Uint8Array(4))).toBe(0);

    expect(calls).toEqual(["https://example.invalid/node"]);
  });

  // One transfer, ONE pair of events, and the kind the resource actually is.
  // This exists because the wiring briefly reported twice: the provider gained
  // reporting for both kinds while an archive-specific fetcher wrapper upstream
  // was still reporting too, so every archive transfer emitted its events twice
  // and every FILE transfer was additionally announced as an archive — one
  // fetcher now serves both, so the wrapper stamped its own kind on everything
  // passing through it. Asserting the kind is what distinguishes that from a
  // plain duplicate.
  it("reports each transfer once, under the kind the address actually is", async () => {
    const events: { status: string; kind: string; id: string }[] = [];
    const { deferredProvider } = (() => {
      const { deferredProvider } = buildRootfsLazyWiring(
        [
          archive({
            transports: ["https://example.invalid/pkg.zip"],
            bytes: archiveBytes.length,
            sha256: "x",
          }),
        ],
        async (url) =>
          url.endsWith(".zip") ? archiveBytes : new Uint8Array([1, 2]),
        (e) => events.push({ status: e.status, kind: e.kind, id: e.id }),
      );
      return { deferredProvider };
    })();

    // Ask each address twice, so a report-per-ask would show up as four.
    deferredProvider("https://example.invalid/pkg.zip", 0n, new Uint8Array(4));
    deferredProvider("https://example.invalid/pkg.zip", 0n, new Uint8Array(4));
    deferredProvider("https://example.invalid/node", 0n, new Uint8Array(4));
    deferredProvider("https://example.invalid/node", 0n, new Uint8Array(4));
    await flushMicrotasks();

    expect(events).toEqual([
      { status: "started", kind: "archive", id: "https://example.invalid/pkg.zip" },
      { status: "started", kind: "file", id: "https://example.invalid/node" },
      { status: "complete", kind: "archive", id: "https://example.invalid/pkg.zip" },
      { status: "complete", kind: "file", id: "https://example.invalid/node" },
    ]);
  });
});

describe("the deferred provider as a dumb bytes pipe", () => {
  /** A wiring with no transport policy at all: every address is fetched
   * directly, which is the lazy-FILE case. */
  function pipe(
    fetcher: (url: string) => Promise<Uint8Array>,
    onProgress?: Parameters<typeof buildRootfsLazyWiring>[2],
  ) {
    return buildRootfsLazyWiring([], fetcher, onProgress).deferredProvider;
  }

  it("answers EAGAIN while a fetch is in flight and bytes once it lands", async () => {
    let release!: (b: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((r) => { release = r; });
    const read = pipe(() => pending);
    const dest = new Uint8Array(8);

    // First ask starts the fetch and reports "not yet" — the same answer the
    // kernel's own byte source gives, which its retry loop is built for.
    expect(read("https://x/a", 0n, dest)).toBe(-11); // EAGAIN
    expect(read("https://x/a", 0n, dest)).toBe(-11);

    release(new Uint8Array([1, 2, 3, 4]));
    await flushMicrotasks();

    expect(read("https://x/a", 0n, dest)).toBe(4);
    expect(Array.from(dest.subarray(0, 4))).toEqual([1, 2, 3, 4]);
    // Offsets and end-of-file, so the kernel can walk a file in pieces.
    expect(read("https://x/a", 2n, dest)).toBe(2);
    expect(read("https://x/a", 4n, dest)).toBe(0);
  });

  it("reports a failed fetch once and stays failed", async () => {
    const read = pipe(() => Promise.reject(new Error("404")));
    const dest = new Uint8Array(4);
    expect(read("https://x/gone", 0n, dest)).toBe(-11); // EAGAIN: the attempt started
    await flushMicrotasks();
    // EIO, and it does not return to EAGAIN. A pipe that retries forever is a
    // hang, not a failure, and the guest would spin on it.
    expect(read("https://x/gone", 0n, dest)).toBe(-5);
    expect(read("https://x/gone", 0n, dest)).toBe(-5);
  });

  it("reports the transfer while staying silent about materialization", async () => {
    // Progress is a property of the FETCH, which is the host's job. Whether the
    // file is materialized is the kernel's, and the pipe says nothing about it.
    const events: { status: string; loadedBytes: number; kind: string }[] = [];
    let release!: (b: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((r) => { release = r; });
    const read = pipe(
      () => pending,
      (e) => events.push({ status: e.status, loadedBytes: e.loadedBytes, kind: e.kind }),
    );

    expect(read("https://x/big", 0n, new Uint8Array(4))).toBe(-11);
    expect(events.map((e) => e.status)).toEqual(["started"]);
    // Reported as a FILE, because that is what an address with no transport
    // policy is. The host says what it knows rather than inventing a kind.
    expect(events[0]!.kind).toBe("file");

    release(new Uint8Array([9, 9, 9, 9]));
    await flushMicrotasks();
    expect(events.map((e) => e.status)).toEqual(["started", "complete"]);
    expect(events[1]!.loadedBytes).toBe(4);
  });

  it("reports a failed transfer with its address", async () => {
    const events: { status: string; error?: string }[] = [];
    const read = pipe(
      () => Promise.reject(new Error("404 Not Found")),
      (e) => events.push({ status: e.status, error: e.error }),
    );
    read("https://x/gone", 0n, new Uint8Array(4));
    await flushMicrotasks();
    expect(events.map((e) => e.status)).toEqual(["started", "error"]);
    expect(events[1]!.error).toContain("https://x/gone");
  });
});
