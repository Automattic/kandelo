import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  ArchiveError,
  archiveFileUrl,
  buildArchiveSearchUrl,
  createInternetArchiveResolver,
  downloadArchiveFile,
  downloadArchiveThumbnail,
  getArchiveItem,
  parseArchiveLocator,
  readArchiveLocator,
  readArchiveNestedZip,
  readArchiveZip,
  readArchiveZipMember,
  readNestedZipMember,
  searchArchive,
  zipMemberProblem,
  type ArchiveFetch,
} from "../src/internet-archive";
import {
  parseKandeloDemoConfig,
  resolveDemoLibrary,
  validateKandeloDemoConfig,
} from "../src/demo-config";
import { materializeBootInputs } from "../src/boot-inputs";
import type { BootDescriptor, BootInput } from "../src/kernel-host";

const ROM = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
const INNER = zipSync({ "Demo (USA).nes": ROM, "Demo (USA).txt": new TextEncoder().encode("x") });
const ZIP = zipSync({
  "games/demo.nes": ROM,
  "readme.txt": new TextEncoder().encode("hi"),
  // Stored, as collections usually store already-compressed per-game ZIPs.
  "sets/demo.zip": [INNER, { level: 0 }],
});

const METADATA = {
  metadata: { identifier: "demo-item", title: "Demo item" },
  d1: "ia800100.us.archive.org",
  dir: "/12/items/demo-item",
  files: [
    { name: "demo.nes", size: String(ROM.length), format: "Unknown" },
    { name: "set.zip", size: String(ZIP.length), format: "ZIP" },
    { name: "../escape.nes", size: "1" },
  ],
};

/** A fake Archive: JSON endpoints plus a download host that honours ranges. */
function archive(overrides: { metadata?: unknown; files?: Record<string, Uint8Array> } = {}) {
  const files = overrides.files ?? { "demo.nes": ROM, "set.zip": ZIP };
  const requests: string[] = [];
  const fetchImpl: ArchiveFetch = async (url, init) => {
    requests.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === "archive.org" && parsed.pathname.startsWith("/metadata/")) {
      return Response.json(overrides.metadata ?? METADATA);
    }
    if (parsed.hostname === "archive.org" && parsed.pathname === "/advancedsearch.php") {
      return Response.json({
        response: {
          numFound: 2,
          docs: [
            { identifier: "demo-item", title: "Demo item", downloads: 12 },
            { identifier: "bad/id", title: "skipped" },
          ],
        },
      });
    }
    const name = decodeURIComponent(parsed.pathname.split("/").pop()!);
    const body = files[name];
    if (!body) return new Response("missing", { status: 404 });
    const range = new Headers(init.headers).get("range");
    if (!range) return new Response(body, { headers: { "Content-Length": String(body.length) } });
    const suffix = /^bytes=-(\d+)$/.exec(range);
    const explicit = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = suffix ? Math.max(0, body.length - Number(suffix[1])) : Number(explicit[1]);
    const end = suffix ? body.length - 1 : Math.min(Number(explicit[2]), body.length - 1);
    return new Response(body.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${body.length}`, ETag: '"z1"' },
    });
  };
  return { fetchImpl, requests };
}

describe("Internet Archive search", () => {
  it("quotes the visitor's words so they cannot change the image's clause", () => {
    const url = buildArchiveSearchUrl('mario" OR subject:"anything', 'subject:"NES"');
    const q = url.searchParams.get("q")!;
    expect(q.startsWith('(subject:"NES") AND ((title:"mario\\"')).toBe(true);
    expect(q).toContain('title:"OR"');
  });

  it("returns valid items and skips malformed identifiers", async () => {
    const { fetchImpl } = archive();
    const page = await searchArchive("demo", 'subject:"NES"', { fetch: fetchImpl });
    expect(page).toEqual({
      items: [{ identifier: "demo-item", title: "Demo item", downloads: 12 }],
      total: 2,
    });
  });

  it("bounds the visitor's text and the page size", () => {
    expect(() => buildArchiveSearchUrl("x".repeat(121), "q")).toThrow(ArchiveError);
    expect(() => buildArchiveSearchUrl("x", "q", 1, 51)).toThrow(/rows/);
  });
});

describe("Internet Archive items", () => {
  it("builds download URLs on the item's own host, skipping unsafe names", async () => {
    const { fetchImpl } = archive();
    const item = await getArchiveItem("demo-item", { fetch: fetchImpl });
    expect(item.files.map((file) => file.name)).toEqual(["demo.nes", "set.zip"]);
    expect(archiveFileUrl(item, "demo.nes")).toBe(
      "https://ia800100.us.archive.org/12/items/demo-item/demo.nes",
    );
  });

  it.each([
    ["a host outside archive.org", { ...METADATA, d1: "evil.example" }, /download host/],
    ["a directory for another item", { ...METADATA, dir: "/12/items/other" }, /unsafe directory/],
    ["metadata for another identifier", { ...METADATA, metadata: { identifier: "other" } }, /different item/],
    ["an empty answer (no such item)", {}, /no Internet Archive item/],
  ])("rejects %s", async (_label, metadata, message) => {
    const { fetchImpl } = archive({ metadata });
    await expect(getArchiveItem("demo-item", { fetch: fetchImpl })).rejects.toThrow(message);
  });

  it("downloads a file within its cap and checks the declared size", async () => {
    const { fetchImpl } = archive();
    const item = await getArchiveItem("demo-item", { fetch: fetchImpl });
    await expect(downloadArchiveFile(item, "demo.nes", { fetch: fetchImpl, maxBytes: 1024 }))
      .resolves.toEqual(ROM);
    await expect(downloadArchiveFile(item, "demo.nes", { fetch: fetchImpl, maxBytes: 10 }))
      .rejects.toThrow(/300 bytes; the limit is 10/);
    const short = archive({ files: { "demo.nes": ROM.slice(0, 5) } });
    await expect(downloadArchiveFile(item, "demo.nes", { fetch: short.fetchImpl, maxBytes: 1024 }))
      .rejects.toThrow(/should be 300 bytes but 5 arrived/);
  });

  it("lists a ZIP and extracts one member by range", async () => {
    const { fetchImpl } = archive();
    const item = await getArchiveItem("demo-item", { fetch: fetchImpl });
    const directory = await readArchiveZip(item, "set.zip", { fetch: fetchImpl });
    expect(directory.entries.map((entry) => entry.fileName))
      .toEqual(["games/demo.nes", "readme.txt", "sets/demo.zip"]);
    expect(zipMemberProblem(directory.entries[0], 1024)).toBeNull();
    expect(zipMemberProblem(directory.entries[0], 10)).toMatch(/over the 10-byte limit/);
    await expect(
      readArchiveZipMember(item, "set.zip", directory, "games/demo.nes", { fetch: fetchImpl, maxBytes: 1024 }),
    ).resolves.toEqual(ROM);
    await expect(
      readArchiveZipMember(item, "set.zip", directory, "nope.nes", { fetch: fetchImpl, maxBytes: 1024 }),
    ).rejects.toThrow(/has no member nope.nes/);
  });

  it("opens a ZIP inside a ZIP and extracts one of its members", async () => {
    const { fetchImpl } = archive();
    const item = await getArchiveItem("demo-item", { fetch: fetchImpl });
    const directory = await readArchiveZip(item, "set.zip", { fetch: fetchImpl });
    const nested = await readArchiveNestedZip(item, "set.zip", directory, "sets/demo.zip", {
      fetch: fetchImpl,
    });
    expect(nested.entries.map((entry) => entry.fileName))
      .toEqual(["Demo (USA).nes", "Demo (USA).txt"]);
    expect(readNestedZipMember(nested, "Demo (USA).nes", 1024)).toEqual(ROM);
    expect(() => readNestedZipMember(nested, "Demo (USA).nes", 10)).toThrow(/over the 10-byte limit/);
    expect(() => readNestedZipMember(nested, "nope.nes", 1024)).toThrow(/has no member nope.nes/);
    // The nested ZIP is read whole, so its own size is held to the archive cap.
    await expect(readArchiveNestedZip(item, "set.zip", directory, "sets/demo.zip", {
      fetch: fetchImpl,
      maxArchiveBytes: 16,
    })).rejects.toThrow(/over the 16-byte limit/);
    await expect(readArchiveNestedZip(item, "set.zip", directory, "games/demo.nes", {
      fetch: fetchImpl,
    })).rejects.toThrow(/could not read games\/demo.nes as a ZIP/);
  });
});

describe("Internet Archive thumbnails", () => {
  it("returns a same-origin image Blob and refuses anything else", async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
    let asked = "";
    const blob = await downloadArchiveThumbnail("demo-item", {
      fetch: async (url) => {
        asked = url;
        return new Response(jpeg, { headers: { "Content-Type": "image/jpeg; charset=UTF-8" } });
      },
    });
    expect(asked).toBe("https://archive.org/services/img/demo-item");
    expect(blob.type).toBe("image/jpeg");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(jpeg);
    await expect(downloadArchiveThumbnail("demo-item", {
      fetch: async () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
    })).rejects.toThrow(/not an image/);
    await expect(downloadArchiveThumbnail("bad/id", { fetch: async () => new Response() }))
      .rejects.toThrow(/not an Internet Archive identifier/);
  });
});

describe("Internet Archive locators and the boot-input resolver", () => {
  it("accepts exactly item, file and an optional member", () => {
    expect(parseArchiveLocator({ item: "demo-item", file: "set.zip", member: "games/demo.nes" }))
      .toEqual({ item: "demo-item", file: "set.zip", member: "games/demo.nes" });
    expect(parseArchiveLocator({ item: "demo-item", file: "set.zip", member: "a.zip", inner: "b.nes" }))
      .toEqual({ item: "demo-item", file: "set.zip", member: "a.zip", inner: "b.nes" });
    expect(() => parseArchiveLocator({ item: "demo-item", file: "set.zip", inner: "b.nes" }))
      .toThrow(/inside a member/);
    expect(() => parseArchiveLocator({ item: "demo-item", file: "a", url: "https://x" }))
      .toThrow(/unexpected locator field/);
    expect(() => parseArchiveLocator({ item: "demo-item", file: "../../etc/passwd" }))
      .toThrow(/unsafe/);
    expect(() => parseArchiveLocator("demo-item")).toThrow(/must be an object/);
  });

  it("fetches a member through the resolver and passes the boot-input checks", async () => {
    const { fetchImpl } = archive();
    const bytes = await readArchiveLocator(
      { item: "demo-item", file: "set.zip", member: "games/demo.nes" },
      { fetch: fetchImpl, metadataFetch: fetchImpl, maxBytes: 1024 },
    );
    expect(bytes).toEqual(ROM);

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ROM));
    const input: BootInput = {
      id: "rom",
      filename: "demo.nes",
      byteLength: ROM.length,
      sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
      source: {
        kind: "resolver",
        resolver: "internet-archive",
        locator: { item: "demo-item", file: "set.zip", member: "games/demo.nes" },
      },
    };
    const written = new Map<string, Uint8Array>();
    await materializeBootInputs(descriptor([input]), {
      resolvers: {
        "internet-archive": createInternetArchiveResolver({ fetch: fetchImpl, metadataFetch: fetchImpl }),
      },
      mkdir: () => {},
      writeFile: (path, data) => { written.set(path, data); },
    });
    expect(written.get("/run/kandelo/inputs/rom/demo.nes")).toEqual(ROM);
  });

  it("resolves a member of a nested ZIP", async () => {
    const { fetchImpl } = archive();
    await expect(readArchiveLocator(
      { item: "demo-item", file: "set.zip", member: "sets/demo.zip", inner: "Demo (USA).nes" },
      { fetch: fetchImpl, metadataFetch: fetchImpl, maxBytes: ROM.length },
    )).resolves.toEqual(ROM);
  });

  it("never downloads more than the link says the file is", async () => {
    const { fetchImpl } = archive();
    const resolver = createInternetArchiveResolver({ fetch: fetchImpl, metadataFetch: fetchImpl });
    const input = {
      id: "rom", filename: "demo.nes", byteLength: 10, sha256: "0".repeat(64),
      source: { kind: "resolver" as const, resolver: "internet-archive", locator: { item: "demo-item", file: "demo.nes" } },
    };
    await expect(resolver(input.source.locator, { input })).rejects.toThrow(/limit is 10/);
  });
});

describe("image-owned library metadata", () => {
  const library = {
    provider: "internet-archive",
    inputId: "rom",
    groups: [{ label: "NES", query: 'mediatype:software AND subject:"NES"' }],
    featured: [{ item: "carpetshark", title: "Carpet Shark", group: "NES" }],
    bundled: [{ path: "/usr/share/roms/test.nes", title: "Test suite", group: "NES" }],
  };
  const withIngest = (lib: unknown, ingest: unknown = {
    accept: [".nes"], targetPath: "/var/rom", maxBytes: 1024,
  }) => ({ version: 1, profiles: { retro: { ingest, library: lib } } });

  it("resolves a declared library with its default archive cap", () => {
    const config = parseKandeloDemoConfig(JSON.stringify(withIngest(library)))!;
    expect(resolveDemoLibrary(config, "retro")).toEqual({ ...library, maxArchiveBytes: 64 * 1024 * 1024 });
  });

  it.each([
    ["no ingest to load into", { version: 1, profiles: { retro: { library } } }, /requires .*ingest/],
    ["an unknown provider", withIngest({ ...library, provider: "somewhere" }), /provider must be/],
    ["no groups", withIngest({ ...library, groups: [] }), /groups must be an array of 1/],
    ["a featured entry in an undeclared group", withIngest({ ...library, featured: [{ item: "x", title: "X", group: "SNES" }] }), /names no declared group/],
    ["a featured entry that is not an identifier", withIngest({ ...library, featured: [{ item: "a/b", title: "X" }] }), /Internet Archive identifier/],
    ["a relative bundled path", withIngest({ ...library, bundled: [{ path: "roms/x.nes", title: "X" }] }), /must be absolute/],
    ["two default bundled entries", withIngest({ ...library, bundled: [{ path: "/a.nes", title: "A", default: true }, { path: "/b.nes", title: "B", default: true }] }), /at most one entry as the default/],
    ["a non-boolean default", withIngest({ ...library, bundled: [{ path: "/a.nes", title: "A", default: "yes" }] }), /default must be a boolean/],
    ["an archive cap past the ceiling", withIngest({ ...library, maxArchiveBytes: 512 * 1024 * 1024 }), /ceiling/],
  ])("rejects %s", (_label, config, message) => {
    expect(() => validateKandeloDemoConfig(config as never)).toThrow(message);
  });
});

function descriptor(inputs: BootInput[]): BootDescriptor {
  return {
    version: 1,
    id: "retro",
    title: "Retro",
    base: "kandelo:shell@abi45",
    runtime: { arch: "wasm32", kernel: "kernel@sha256:abc", memoryPages: 1024, features: ["pty"], time: "real" },
    packages: [],
    mounts: [{ path: "/", source: "image", ref: "shell.vfs@local" }],
    boot: { argv: ["sh"], cwd: "/", env: {}, inputs },
  } as BootDescriptor;
}
