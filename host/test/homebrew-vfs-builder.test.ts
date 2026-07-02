import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gzipSync } from "fflate";
import { ABI_VERSION } from "../src/generated/abi";
import {
  buildHomebrewVfs,
  type HomebrewVfsBuildResult,
} from "../src/homebrew-vfs-builder";
import {
  planHomebrewVfs,
  type HomebrewLinkManifest,
  type HomebrewTapMetadata,
} from "../src/homebrew-vfs-planner";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const PREFIX = "/home/linuxbrew/.linuxbrew";
const CELLAR = `${PREFIX}/Cellar`;
const KEG = `${CELLAR}/hello/2.12.1`;
const TAP_COMMIT = "1111111111111111111111111111111111111111";
const KANDELO_COMMIT = "2222222222222222222222222222222222222222";
const CACHE_KEY = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const WRONG_SHA = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

interface TarSpec {
  path: string;
  type?: "file" | "directory" | "symlink" | "hardlink";
  data?: string | Uint8Array;
  linkName?: string;
  mode?: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bottleTar(entries: TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) chunks.push(tarHeader(entry), tarPayload(entry));
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return gzipSync(tar);
}

function tarHeader(entry: TarSpec): Uint8Array {
  const header = new Uint8Array(512);
  const data = tarEntryData(entry);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.byteLength);
  writeOctal(header, 136, 12, 0);
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  header[156] = typeflag(entry);
  if (entry.linkName) writeString(header, 157, 100, entry.linkName);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, 148, 8, checksum);
  header[155] = 0x20;
  return header;
}

function tarPayload(entry: TarSpec): Uint8Array {
  const data = tarEntryData(entry);
  const padded = Math.ceil(data.byteLength / 512) * 512;
  const out = new Uint8Array(padded);
  out.set(data);
  return out;
}

function tarEntryData(entry: TarSpec): Uint8Array {
  if ((entry.type ?? "file") !== "file") return new Uint8Array();
  if (entry.data instanceof Uint8Array) return entry.data;
  return utf8(entry.data ?? "");
}

function typeflag(entry: TarSpec): number {
  switch (entry.type ?? "file") {
    case "file": return "0".charCodeAt(0);
    case "directory": return "5".charCodeAt(0);
    case "symlink": return "2".charCodeAt(0);
    case "hardlink": return "1".charCodeAt(0);
  }
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = utf8(value);
  if (bytes.byteLength > length) throw new Error(`test tar field too long: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 2, "0");
  writeString(target, offset, length, `${text}\0`);
}

function standardEntries(overrides: TarSpec[] = []): TarSpec[] {
  return [
    { path: "hello/2.12.1/bin/hello", data: "#!/bin/sh\necho hello\n", mode: 0o755 },
    { path: "hello/2.12.1/.brew/hello.rb", data: "class Hello < Formula\nend\n" },
    { path: "hello/2.12.1/INSTALL_RECEIPT.json", data: "{}\n" },
    ...overrides,
  ];
}

function metadataForBottle(
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {},
): HomebrewTapMetadata {
  const bottle = {
    arch: "wasm32",
    bottle_tag: "wasm32_kandelo",
    kandelo_abi: ABI_VERSION,
    cellar: CELLAR,
    prefix: PREFIX,
    url: "file:///tmp/hello.bottle.tar.gz",
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    cache_key_sha: CACHE_KEY,
    link_manifest: "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json",
    runtime_support: ["node"],
    browser_compatible: false,
    fork_instrumentation: "not-required",
    status: "success",
    built_by: "https://example.invalid/actions/runs/1",
    built_from: {
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: KANDELO_COMMIT,
      tap_repository: "Automattic/kandelo-homebrew",
      tap_commit: TAP_COMMIT,
      formula_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    ...overrides,
  };
  return {
    schema: 1,
    tap_repository: "Automattic/kandelo-homebrew",
    tap_name: "automattic/kandelo-homebrew",
    tap_commit: TAP_COMMIT,
    kandelo_repository: "Automattic/kandelo",
    kandelo_commit: KANDELO_COMMIT,
    kandelo_abi: ABI_VERSION,
    release_tag: `bottles-abi-v${ABI_VERSION}`,
    generated_at: "2026-06-28T00:00:00Z",
    generator: "test",
    packages: [{
      name: "hello",
      full_name: "automattic/kandelo-homebrew/hello",
      version: "2.12.1",
      formula_revision: 0,
      bottle_rebuild: 0,
      formula_path: "Formula/hello.rb",
      formula_metadata: "Kandelo/formula/hello.json",
      dependencies: [],
      bottles: [bottle],
    }],
  } as unknown as HomebrewTapMetadata;
}

function linkManifest(
  bytes: Uint8Array,
  overrides: Partial<HomebrewLinkManifest> = {},
): HomebrewLinkManifest {
  return {
    schema: 1,
    package: "hello",
    version: "2.12.1",
    arch: "wasm32",
    kandelo_abi: ABI_VERSION,
    prefix: PREFIX,
    cellar: CELLAR,
    keg: KEG,
    bottle: {
      url: "file:///tmp/hello.bottle.tar.gz",
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      cache_key_sha: CACHE_KEY,
      payload_root: "hello/2.12.1",
    },
    links: [{
      type: "symlink",
      source: "Cellar/hello/2.12.1/bin/hello",
      target: "bin/hello",
    }],
    receipts: [
      "Cellar/hello/2.12.1/.brew/hello.rb",
      "Cellar/hello/2.12.1/INSTALL_RECEIPT.json",
    ],
    env: { PATH_prepend: ["bin"] },
    ...overrides,
  };
}

async function buildFixture(
  bytes: Uint8Array,
  opts: {
    metadataOverrides?: Record<string, unknown>;
    linkOverrides?: Partial<HomebrewLinkManifest>;
    loadBytes?: Uint8Array;
  } = {},
): Promise<HomebrewVfsBuildResult> {
  const manifest = linkManifest(bytes, opts.linkOverrides);
  const plan = await planHomebrewVfs(metadataForBottle(bytes, opts.metadataOverrides), {
    packages: ["hello"],
    arch: "wasm32",
    runtime: "node",
    loadLinkManifest: () => manifest,
  });
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  return buildHomebrewVfs(plan, {
    fs,
    loadBottleBytes: () => opts.loadBytes ?? bytes,
  });
}

function readVfsFile(fs: MemoryFileSystem, path: string): string {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(st.size);
    fs.read(fd, bytes, null, bytes.length);
    return new TextDecoder().decode(bytes);
  } finally {
    fs.close(fd);
  }
}

describe("Homebrew VFS builder", () => {
  it("pours a verified bottle, validates receipts, applies prefix links, and writes metadata", async () => {
    const bytes = bottleTar(standardEntries());
    const result = await buildFixture(bytes);

    expect(readVfsFile(result.fs, `${KEG}/bin/hello`)).toContain("echo hello");
    expect(result.fs.readlink(`${PREFIX}/bin/hello`)).toBe(`${KEG}/bin/hello`);
    expect(readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json")).toContain("hello");
    expect(result.report.packages[0]).toMatchObject({
      name: "hello",
      source_status: "success",
      staged_files: 3,
      links: ["bin/hello"],
    });
  });

  it("supports keg-relative link sources and receipts", async () => {
    const bytes = bottleTar(standardEntries());
    const result = await buildFixture(bytes, {
      linkOverrides: {
        links: [{ type: "symlink", source: "bin/hello", target: "bin/hello" }],
        receipts: [".brew/hello.rb", "INSTALL_RECEIPT.json"],
      },
    });

    expect(result.fs.readlink(`${PREFIX}/bin/hello`)).toBe(`${KEG}/bin/hello`);
  });

  it("records last-green fallback source status in the report", async () => {
    const bytes = bottleTar(standardEntries());
    const metadataOverrides = {
      status: "failed",
      error: "latest rebuild failed",
      last_attempt: "2026-06-28T00:00:00Z",
      last_attempt_by: "https://example.invalid/actions/runs/2",
      url: undefined,
      sha256: undefined,
      bytes: undefined,
      cache_key_sha: undefined,
      link_manifest: undefined,
      fallback_url: "file:///tmp/hello.last-green.tar.gz",
      fallback_sha256: sha256(bytes),
      fallback_bytes: bytes.byteLength,
      fallback_cache_key_sha: CACHE_KEY,
      fallback_link_manifest: "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json",
      fallback_built_at: "2026-06-27T00:00:00Z",
    };
    const result = await buildFixture(bytes, {
      metadataOverrides,
      linkOverrides: {
        bottle: {
          url: "file:///tmp/hello.last-green.tar.gz",
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
          cache_key_sha: CACHE_KEY,
          payload_root: "hello/2.12.1",
        },
      },
    });

    expect(result.report.packages[0].source_status).toBe("fallback");
    expect(result.report.packages[0].metadata_status).toBe("failed");
  });

  it("rejects byte count mismatches before extraction", async () => {
    const bytes = bottleTar(standardEntries());
    await expect(buildFixture(bytes, {
      metadataOverrides: { bytes: bytes.byteLength + 1 },
      linkOverrides: {
        bottle: {
          url: "file:///tmp/hello.bottle.tar.gz",
          sha256: sha256(bytes),
          bytes: bytes.byteLength + 1,
          cache_key_sha: CACHE_KEY,
          payload_root: "hello/2.12.1",
        },
      },
    })).rejects.toThrow("byte count");
  });

  it("rejects sha256 mismatches before extraction", async () => {
    const bytes = bottleTar(standardEntries());
    await expect(buildFixture(bytes, {
      metadataOverrides: { sha256: WRONG_SHA },
      linkOverrides: {
        bottle: {
          url: "file:///tmp/hello.bottle.tar.gz",
          sha256: WRONG_SHA,
          bytes: bytes.byteLength,
          cache_key_sha: CACHE_KEY,
          payload_root: "hello/2.12.1",
        },
      },
    })).rejects.toThrow("bottle sha256");
  });

  it("rejects missing receipts after staging", async () => {
    const bytes = bottleTar(standardEntries([
      { path: "hello/2.12.1/INSTALL_RECEIPT.json", type: "hardlink" },
    ]).filter((entry) => entry.path !== "hello/2.12.1/INSTALL_RECEIPT.json"));

    await expect(buildFixture(bytes)).rejects.toThrow("receipt");
  });

  it("rejects unsafe tar paths", async () => {
    const bytes = bottleTar([
      { path: "../evil", data: "bad" },
      ...standardEntries(),
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow("unsafe path segment");
  });

  it("rejects unsupported hardlinks", async () => {
    const bytes = bottleTar([
      ...standardEntries(),
      { path: "hello/2.12.1/bin/hello2", type: "hardlink", linkName: "hello/2.12.1/bin/hello" },
    ]);

    await expect(buildFixture(bytes)).rejects.toThrow("unsupported tar hardlink");
  });
});
