import { describe, it, expect } from "vitest";
import { buildRootfsLazyWiring } from "../src/vfs/rootfs-lazy-archives";

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

  it("(c) first provider call returns EAGAIN and invokes the fetcher", () => {
    const { fetcher, calls } = makeFetcher();
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(fetcher));

    const dest = new Uint8Array(8);
    const result = archiveProvider("u1", 0n, dest);

    expect(result).toBe(-11);
    expect(calls).toEqual(["u1"]);
  });

  it("(d) after the fetch settles, offset 0 fills dest with the archive prefix", async () => {
    const { fetcher, settle } = makeFetcher();
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(fetcher));

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
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(fetcher));

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
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(fetcher));

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
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(fetcher));

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
    const archiveProvider = archiveReaderOf(buildRootfsLazyWiring(fetcher));

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

  // RETIRED 2026-09-17 WITH THE TRANSPORT TABLE, two cases: "fetches a body
  // the image sized nowhere, instead of checking it against nothing" and
  // "tries the next transport on a size mismatch and serves from the good
  // one".
  //
  // Both were about policy the pipe no longer holds. A mirror list has no
  // producer — `registerArchiveMember` takes ONE `archiveUri`, so every record
  // ever built carried exactly `[address]` — and the length check it existed
  // to serve was a weaker duplicate of the DIGEST the kernel verifies when it
  // materializes the bytes. The skip rule was a rule about which bodies
  // deserved a table entry, and there is no table.
  //
  // What replaces the length check is not nothing: it is
  // `digest_accepts(&expected, &data)` in `rootfs.rs`, asserted there and
  // perturbed, and it decides whether the fetched bytes are the RIGHT bytes
  // rather than merely the right number of them.
});

describe("one address space, so nothing needs routing", () => {
  const archiveBytes = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

  /** The pipe, with a fetcher that answers an archive address and a file
   *  address with different bytes. It is handed no table, because there is
   *  none: what distinguishes the two here is the fetcher's answer, which is
   *  exactly as much as the host ever knew. */
  function wiring() {
    const calls: string[] = [];
    const { deferredProvider } = buildRootfsLazyWiring(
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
  it("reports each transfer once, per address", async () => {
    const events: { status: string; kind: string; id: string }[] = [];
    const { deferredProvider } = buildRootfsLazyWiring(
      async (url) => url.endsWith(".zip") ? archiveBytes : new Uint8Array([1, 2]),
      (e) => events.push({ status: e.status, kind: e.kind, id: e.id }),
    );

    // Ask each address twice, so a report-per-ask would show up as four.
    deferredProvider("https://example.invalid/pkg.zip", 0n, new Uint8Array(4));
    deferredProvider("https://example.invalid/pkg.zip", 0n, new Uint8Array(4));
    deferredProvider("https://example.invalid/node", 0n, new Uint8Array(4));
    deferredProvider("https://example.invalid/node", 0n, new Uint8Array(4));
    await flushMicrotasks();

    // ONE KIND FOR BOTH, and that is the claim now. It used to assert
    // `"archive"` for the first and `"file"` for the second, which the pipe
    // decided by looking the address up in its transport table — a second
    // opinion about identity, from the one table the URI relay had left
    // standing. With the table gone the host knows an address and nothing
    // else, so it reports the same kind for every transfer rather than
    // inventing a distinction it cannot make.
    expect(events).toEqual([
      { status: "started", kind: "file", id: "https://example.invalid/pkg.zip" },
      { status: "started", kind: "file", id: "https://example.invalid/node" },
      { status: "complete", kind: "file", id: "https://example.invalid/pkg.zip" },
      { status: "complete", kind: "file", id: "https://example.invalid/node" },
    ]);
  });
});
