import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gzipSync } from "fflate";
import { ABI_VERSION } from "../src/generated/abi";
import {
  buildHomebrewVfs,
  type HomebrewVfsBuildResult,
  type HomebrewVfsSelectionSource,
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

function declaredNixGnuTar(): string {
  const executable = (process.env.PATH ?? "")
    .split(":")
    .map((directory) => join(directory, "tar"))
    .find((candidate) => {
      try {
        return lstatSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  if (!executable ||
      !/^\/nix\/store\/[0-9a-z]{32}-gnutar-[^/]+\/bin\/tar$/.test(executable) ||
      realpathSync(executable) !== executable) {
    throw new Error("Homebrew VFS PAX fixture requires the flake-declared Nix GNU tar");
  }
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" });
  if (!version.startsWith("tar (GNU tar) ")) {
    throw new Error("Homebrew VFS PAX fixture requires the flake-declared Nix GNU tar");
  }
  return executable;
}

function tarTypeflags(tar: Uint8Array): string[] {
  const flags: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = new TextDecoder()
      .decode(header.subarray(124, 136))
      .replaceAll("\0", "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    flags.push(String.fromCharCode(header[156] || "0".charCodeAt(0)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return flags;
}

function gnuPaxBottle(receipt: Uint8Array): {
  bytes: Uint8Array;
  gnuTar: string;
  typeflags: string[];
} {
  const gnuTar = declaredNixGnuTar();
  const root = mkdtempSync(join(tmpdir(), "kandelo-homebrew-pax-"));
  try {
    const payload = join(root, "hello", "2.12.1");
    mkdirSync(join(payload, "bin"), { recursive: true });
    mkdirSync(join(payload, ".brew"), { recursive: true });
    mkdirSync(join(payload, "share"), { recursive: true });
    writeFileSync(join(payload, "bin", "hello"), "#!/bin/sh\necho hello\n");
    chmodSync(join(payload, "bin", "hello"), 0o755);
    writeFileSync(join(payload, ".brew", "hello.rb"), "class Hello < Formula\nend\n");
    writeFileSync(join(payload, "INSTALL_RECEIPT.json"), receipt);
    // A safe component longer than the ustar name field forces a local PAX
    // header and exercises the same parser path as publisher-created bottles.
    writeFileSync(join(payload, "share", "p".repeat(120)), "PAX path fixture\n");

    const archive = join(root, "hello.tar");
    execFileSync(gnuTar, [
      "--create",
      "--numeric-owner",
      "--mtime=2024-01-22 17:12:37",
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=pax",
      "--pax-option=globexthdr.name=/GlobalHead.%n,exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
      "--file",
      archive,
      "hello/2.12.1",
    ], { cwd: root });
    const tar = new Uint8Array(readFileSync(archive));
    return { bytes: gzipSync(tar), gnuTar, typeflags: tarTypeflags(tar) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_commit: TAP_COMMIT,
      formula_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    ...overrides,
  };
  return {
    schema: 1,
    tap_repository: "kandelo-dev/homebrew-tap-core",
    tap_name: "kandelo-dev/tap-core",
    tap_commit: TAP_COMMIT,
    kandelo_repository: "Automattic/kandelo",
    kandelo_commit: KANDELO_COMMIT,
    kandelo_abi: ABI_VERSION,
    release_tag: `bottles-abi-v${ABI_VERSION}`,
    generated_at: "2026-06-28T00:00:00Z",
    generator: "test",
    packages: [{
      name: "hello",
      full_name: "kandelo-dev/tap-core/hello",
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
    selectionSource?: HomebrewVfsSelectionSource;
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
    selectionSource: opts.selectionSource,
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
    expect(result.report.selection).toMatchObject({
      kind: "packages",
      requested_packages: ["hello"],
    });
  });

  it("composes a real GNU PAX bottle while preserving its sanitized receipt bytes", async () => {
    const receipt = utf8(JSON.stringify({
      source: {
        path: "Formula/hello.rb",
        tap: "kandelo-dev/tap-core",
        versions: { stable: "2.12.1" },
      },
      built_as_bottle: true,
      poured_from_bottle: false,
    }) + "\n");
    const bottle = gnuPaxBottle(receipt);
    expect(bottle.gnuTar).toMatch(/^\/nix\/store\/[0-9a-z]{32}-gnutar-[^/]+\/bin\/tar$/);
    expect(bottle.typeflags.some((flag) => flag === "x" || flag === "g")).toBe(true);

    const result = await buildFixture(bottle.bytes);
    const installedReceiptBytes = readVfsFile(result.fs, `${KEG}/INSTALL_RECEIPT.json`);
    expect(installedReceiptBytes).toBe(new TextDecoder().decode(receipt));
    const installedReceipt = JSON.parse(installedReceiptBytes);
    expect(installedReceipt.source.tap).toBe("kandelo-dev/tap-core");
    expect(installedReceipt.source).not.toHaveProperty("tap_git_head");
    const composition = JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    );
    expect(composition.metadata).toMatchObject({
      tap_name: "kandelo-dev/tap-core",
      tap_commit: TAP_COMMIT,
    });
  });

  it("records bounded Brewfile and requested-root provenance", async () => {
    const bytes = bottleTar(standardEntries());
    const brewfile = utf8(
      'tap "kandelo-dev/tap-core"\nbrew "hello"\n',
    );
    const result = await buildFixture(bytes, {
      selectionSource: {
        kind: "brewfile",
        parser: "kandelo-static-brewfile-v1",
        sha256: sha256(brewfile),
        bytes: brewfile.byteLength,
        requestedPackages: ["hello"],
      },
    });
    const expectedRootsSha = sha256(utf8(JSON.stringify(["hello"])));

    expect(result.report.selection).toEqual({
      kind: "brewfile",
      requested_packages: ["hello"],
      requested_packages_sha256: expectedRootsSha,
      brewfile: {
        parser: "kandelo-static-brewfile-v1",
        sha256: sha256(brewfile),
        bytes: brewfile.byteLength,
      },
    });
    expect(JSON.parse(
      readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"),
    ).selection).toEqual(result.report.selection);
  });

  it("rejects invalid Brewfile provenance before loading bottle bytes", async () => {
    const bytes = bottleTar(standardEntries());
    let loaded = false;
    const manifest = linkManifest(bytes);
    const plan = await planHomebrewVfs(metadataForBottle(bytes), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: () => manifest,
    });
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    await expect(buildHomebrewVfs(plan, {
      fs,
      selectionSource: {
        kind: "brewfile",
        parser: "kandelo-static-brewfile-v1",
        sha256: "not-a-sha",
        bytes: 10,
        requestedPackages: ["hello"],
      } as HomebrewVfsSelectionSource,
      loadBottleBytes() {
        loaded = true;
        return bytes;
      },
    })).rejects.toThrow("selection provenance is invalid");
    expect(loaded).toBe(false);
  });

  it("rejects Brewfile roots that differ from the plan before loading bottle bytes", async () => {
    const bytes = bottleTar(standardEntries());
    let loaded = false;
    const plan = await planHomebrewVfs(metadataForBottle(bytes), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: () => linkManifest(bytes),
    });
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    await expect(buildHomebrewVfs(plan, {
      fs,
      selectionSource: {
        kind: "brewfile",
        parser: "kandelo-static-brewfile-v1",
        sha256: sha256(utf8('brew "other"\n')),
        bytes: 13,
        requestedPackages: ["other"],
      },
      loadBottleBytes() {
        loaded = true;
        return bytes;
      },
    })).rejects.toThrow("requested packages do not match the plan roots");
    expect(loaded).toBe(false);
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
