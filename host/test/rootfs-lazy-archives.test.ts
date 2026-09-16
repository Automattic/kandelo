import { describe, it, expect } from "vitest";
import { buildRootfsLazyWiring } from "../src/vfs/rootfs-lazy-archives";
import { reduceLazyArchiveGroups } from "../src/vfs/kernel-lazy-section";
import type { SerializedLazyArchiveEntry } from "../src/vfs/memory-fs";

/**
 * The lazy manifest `buildRootfsLazyWiring` used to return and nothing read.
 *
 * It is gone from production: the kernel parses the image's own KLZY section,
 * so the host builds only a fetch table. The member reduction it exercised is
 * still real — `encodeKernelLazySection` writes those members — so these
 * assertions now go straight at `reduceLazyArchiveGroups`, which is where that
 * behaviour lives, instead of through a wiring call that no longer reports it.
 */
function lazyManifest(entries: SerializedLazyArchiveEntry[]) {
  const files = new Map<string, { archiveId: number; sourcePath: string }>();
  const archives: { archiveId: number; size: number }[] = [];
  for (const group of reduceLazyArchiveGroups(entries)) {
    archives.push({ archiveId: group.archiveId, size: group.archiveBytes });
    for (const member of group.members) {
      files.set(member.vfsPath, {
        archiveId: group.archiveId,
        sourcePath: member.sourcePath,
      });
    }
  }
  return { files, archives };
}

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

/** Minimal fake `SerializedLazyArchiveEntry` group. Only the fields the
 * builder reads are populated; unused required fields get placeholder
 * values so the object satisfies the type. */
function makeGroup(
  overrides: Partial<SerializedLazyArchiveEntry>,
): SerializedLazyArchiveEntry {
  return {
    kind: "kandelo-deferred-tree-v3",
    url: "",
    mountPrefix: "/",
    materialized: false,
    entries: [],
    ...overrides,
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

  function buildEntries(): SerializedLazyArchiveEntry[] {
    const validGroup = makeGroup({
      content: {
        decoder: "zip-v1",
        mediaType: "application/zip",
        sha256: "deadbeef",
        bytes: ARCHIVE_SIZE,
        expandedBytes: ARCHIVE_SIZE * 2,
        sourceEntryCount: 4,
        transports: ["u1", "u2"],
      },
      entries: [
        {
          vfsPath: "/a/dir",
          ino: 1,
          size: 0,
          isSymlink: false,
          deleted: false,
          type: undefined,
        },
        {
          vfsPath: "/a/link",
          ino: 2,
          size: 0,
          isSymlink: true,
          deleted: false,
          type: "symlink",
          sourcePath: "bin/link",
        },
        {
          vfsPath: "/a/f",
          ino: 3,
          size: 6,
          isSymlink: false,
          deleted: false,
          type: "file",
          sourcePath: "bin/f",
        },
        {
          vfsPath: "/a/gone",
          ino: 4,
          size: 0,
          isSymlink: false,
          deleted: true,
          type: "file",
          sourcePath: "bin/gone",
        },
        {
          vfsPath: "/a/nosource",
          ino: 5,
          size: 1,
          isSymlink: false,
          deleted: false,
          type: "file",
        },
      ],
    });

    // Group missing both content.bytes and integrity.bytes: must be skipped
    // entirely (no id minted, no members, no archive-table entry).
    const skippedGroup = makeGroup({
      content: undefined,
      integrity: undefined,
      url: "",
      entries: [
        {
          vfsPath: "/b/should-not-appear",
          ino: 10,
          size: 3,
          isSymlink: false,
          deleted: false,
          type: "file",
          sourcePath: "bin/should-not-appear",
        },
      ],
    });

    return [skippedGroup, validGroup];
  }

  it("(a) includes only the live file member with correct mapping", () => {
    const lazyInput = lazyManifest(buildEntries());

    expect(lazyInput.files.size).toBe(1);
    expect(lazyInput.files.get("/a/f")).toEqual({
      archiveId: 1,
      sourcePath: "bin/f",
    });
    expect(lazyInput.files.has("/a/dir")).toBe(false);
    expect(lazyInput.files.has("/a/link")).toBe(false);
    expect(lazyInput.files.has("/a/gone")).toBe(false);
    expect(lazyInput.files.has("/a/nosource")).toBe(false);
  });

  it("(b) archives table has one entry with the minted id and raw size", () => {
    const lazyInput = lazyManifest(buildEntries());

    expect(lazyInput.archives).toEqual([{ archiveId: 1, size: ARCHIVE_SIZE }]);
  });

  it("(g) a group missing content.bytes and integrity.bytes is skipped, and the surviving group still gets a stable id", () => {
    const lazyInput = lazyManifest(buildEntries());

    expect(lazyInput.files.has("/b/should-not-appear")).toBe(false);
    // Only one archive-table entry total (the skipped group contributed none).
    expect(lazyInput.archives).toHaveLength(1);
    expect(lazyInput.archives[0]!.archiveId).toBe(1);
    expect(lazyInput.files.get("/a/f")!.archiveId).toBe(1);
  });

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

  it("falls back to `url` as the sole transport when content.transports is absent", () => {
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<Uint8Array> => {
      calls.push(url);
      return archiveBytes;
    };

    const group = makeGroup({
      content: undefined,
      integrity: { sha256: "x", bytes: ARCHIVE_SIZE },
      url: "legacy-url",
      entries: [
        {
          vfsPath: "/c/f",
          ino: 20,
          size: 6,
          isSymlink: false,
          deleted: false,
          type: "file",
          sourcePath: "bin/f",
        },
      ],
    });

    const wiring = buildRootfsLazyWiring([group], fetcher);
    const lazyInput = lazyManifest(buildEntries());
    const archiveProvider = archiveReaderOf(wiring);
    expect(lazyInput.archives).toEqual([{ archiveId: 1, size: ARCHIVE_SIZE }]);

    archiveProvider("legacy-url", 0n, new Uint8Array(1));
    expect(calls).toEqual(["legacy-url"]);
  });

  it("tries the next transport on a size mismatch and serves from the good one", async () => {
    const calls: string[] = [];
    const badBytes = new Uint8Array(ARCHIVE_SIZE - 1); // wrong length
    const fetcher = async (url: string): Promise<Uint8Array> => {
      calls.push(url);
      if (url === "bad-url") return badBytes;
      return archiveBytes;
    };

    const group = makeGroup({
      content: {
        decoder: "zip-v1",
        mediaType: "application/zip",
        sha256: "deadbeef",
        bytes: ARCHIVE_SIZE,
        expandedBytes: ARCHIVE_SIZE * 2,
        sourceEntryCount: 1,
        transports: ["bad-url", "good-url"],
      },
      entries: [
        {
          vfsPath: "/c/f",
          ino: 20,
          size: 6,
          isSymlink: false,
          deleted: false,
          type: "file",
          sourcePath: "bin/f",
        },
      ],
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
        makeGroup({
          kind: "kandelo-legacy-zip-v1",
          url: "https://example.invalid/pkg.zip",
          mountPrefix: "/a",
          integrity: { sha256: "x", bytes: archiveBytes.length },
          entries: [
            {
              vfsPath: "/a/f",
              ino: 42,
              size: 2,
              isSymlink: false,
              deleted: false,
              type: "file",
              sourcePath: "bin/f",
            },
          ],
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
