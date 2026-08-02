import { createHash } from "node:crypto";
import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  inferHomebrewBottlePrefix,
  parseHomebrewInstallReceiptRelocation,
  relocateHomebrewBottleFile,
} from "../src/homebrew-bottle-relocation";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const CURRENT_PREFIX = "/opt/kandelo/homebrew";
const LEGACY_PREFIX = "/home/linuxbrew/.linuxbrew";

describe("Homebrew bottle relocation authority", () => {
  it.each([CURRENT_PREFIX, LEGACY_PREFIX])(
    "derives %s from the authenticated bottle inventory",
    (prefix) => {
      expect(inferHomebrewBottlePrefix([
        {
          sourcePath: "ruby/4.0.5_1/INSTALL_RECEIPT.json",
          vfsPath:
            `${prefix}/Cellar/ruby/4.0.5_1/INSTALL_RECEIPT.json`,
        },
        {
          sourcePath: "ruby/4.0.5_1/lib/ruby.conf",
          vfsPath: `${prefix}/Cellar/ruby/4.0.5_1/lib/ruby.conf`,
        },
      ])).toBe(prefix);
    },
  );

  it.each([CURRENT_PREFIX, LEGACY_PREFIX])(
    "relocates receipt-owned placeholders to %s",
    (prefix) => {
      const receipt = parseHomebrewInstallReceiptRelocation(
        new TextEncoder().encode(JSON.stringify({
          changed_files: ["lib/runtime.conf"],
          runtime_dependencies: [{ full_name: "openjdk@21" }],
        })),
      );
      const source = new TextEncoder().encode([
        "prefix=@@HOMEBREW_PREFIX@@",
        "cellar=@@HOMEBREW_CELLAR@@",
        "repository=@@HOMEBREW_REPOSITORY@@",
        "library=@@HOMEBREW_LIBRARY@@",
        "perl=@@HOMEBREW_PERL@@",
        "java=@@HOMEBREW_JAVA@@",
      ].join("\n"));

      expect(new TextDecoder().decode(relocateHomebrewBottleFile(
        source,
        receipt,
        "ruby/4.0.5_1/lib/runtime.conf",
        prefix,
      ))).toBe([
        `prefix=${prefix}`,
        `cellar=${prefix}/Cellar`,
        `repository=${prefix}`,
        `library=${prefix}/Library`,
        `perl=${prefix}/opt/perl/bin/perl`,
        `java=${prefix}/opt/openjdk@21/libexec`,
      ].join("\n"));
    },
  );

  it("rejects a bottle inventory that mixes installation prefixes", () => {
    expect(() => inferHomebrewBottlePrefix([
      {
        sourcePath: "ruby/4.0.5_1/INSTALL_RECEIPT.json",
        vfsPath:
          `${CURRENT_PREFIX}/Cellar/ruby/4.0.5_1/INSTALL_RECEIPT.json`,
      },
      {
        sourcePath: "ruby/4.0.5_1/lib/ruby.conf",
        vfsPath: `${LEGACY_PREFIX}/Cellar/ruby/4.0.5_1/lib/ruby.conf`,
      },
    ])).toThrow(/mixes installation prefixes/);
  });

  it.each([
    [
      "a non-Cellar path",
      {
        sourcePath: "ruby/4.0.5_1/INSTALL_RECEIPT.json",
        vfsPath: `${CURRENT_PREFIX}/ruby/4.0.5_1/INSTALL_RECEIPT.json`,
      },
      /does not end in/,
    ],
    [
      "an unsafe source path",
      {
        sourcePath: "../INSTALL_RECEIPT.json",
        vfsPath: `${CURRENT_PREFIX}/Cellar/../INSTALL_RECEIPT.json`,
      },
      /unsafe path segment/,
    ],
  ])("rejects %s", (_label, entry, expected) => {
    expect(() => inferHomebrewBottlePrefix([entry])).toThrow(expected);
  });

  it("limits Cellar ownership to marked Homebrew relocation entries", async () => {
    const fixture = homebrewRelocationTreeFixture();

    await expect(fixture.fs.preparePath(fixture.runtimePath)).resolves.toBe(true);
    expect(readFile(fixture.fs, fixture.runtimePath)).toBe(
      `prefix=${LEGACY_PREFIX}\n`,
    );
    expect(readFile(fixture.fs, fixture.ordinaryPath)).toBe(
      "ordinary VFS content\n",
    );
  });

  it("rejects a marked Homebrew relocation entry outside Cellar", async () => {
    const malformedPath = "/var/lib/kandelo/runtime.conf";
    const fixture = homebrewRelocationTreeFixture(malformedPath);

    await expect(fixture.fs.preparePath(malformedPath)).rejects.toThrow(
      /does not end in/,
    );
  });
});

function homebrewRelocationTreeFixture(
  runtimePath = `${LEGACY_PREFIX}/Cellar/ruby/4.0.5_1/lib/runtime.conf`,
): {
  fs: MemoryFileSystem;
  runtimePath: string;
  ordinaryPath: string;
} {
  const sourceRoot = "ruby/4.0.5_1";
  const keg = `${LEGACY_PREFIX}/Cellar/${sourceRoot}`;
  const runtimeSourcePath = `${sourceRoot}/lib/runtime.conf`;
  const ordinarySourcePath = "share/non-homebrew.txt";
  const ordinaryPath = "/etc/kandelo/non-homebrew.txt";
  const receipt = new TextEncoder().encode(JSON.stringify({
    changed_files: ["lib/runtime.conf"],
  }) + "\n");
  const runtime = new TextEncoder().encode("prefix=@@HOMEBREW_PREFIX@@\n");
  const relocatedRuntime = new TextEncoder().encode(
    `prefix=${LEGACY_PREFIX}\n`,
  );
  const ordinary = new TextEncoder().encode("ordinary VFS content\n");
  const source = [
    { path: sourceRoot, mode: 0o755 },
    { path: `${sourceRoot}/INSTALL_RECEIPT.json`, mode: 0o644, data: receipt },
    { path: `${sourceRoot}/lib`, mode: 0o755 },
    { path: runtimeSourcePath, mode: 0o644, data: runtime },
    { path: ordinarySourcePath, mode: 0o644, data: ordinary },
  ];
  const tar = testTar(source);
  const payload = gzipSync(tar);
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  fs.setLazyFetcher(async () => new Response(payload));
  fs.registerLazyTree({
    decoder: "homebrew-bottle-tar-gzip-v1",
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    sha256: createHash("sha256").update(payload).digest("hex"),
    bytes: payload.byteLength,
    expandedBytes: tar.byteLength,
    sourceEntryCount: source.length,
    transports: ["https://example.invalid/ruby.tar.gz"],
    source: {
      schema: 1,
      kind: "homebrew-bottle-tar-gzip-v1",
      entries: source.map((entry) => ({
        sourcePath: entry.path,
        type: entry.data === undefined ? "directory" as const : "file" as const,
        mode: entry.mode,
        size: entry.data?.byteLength ?? 0,
      })),
    },
  }, source.map((entry) => ({
    vfsPath: entry.path === runtimeSourcePath
      ? runtimePath
      : entry.path === ordinarySourcePath
        ? ordinaryPath
        : `${LEGACY_PREFIX}/Cellar/${entry.path}`,
    sourcePath: entry.path,
    materialization: entry.path === runtimeSourcePath
      ? "archive-homebrew-relocate" as const
      : "archive" as const,
    type: entry.data === undefined ? "directory" as const : "file" as const,
    mode: entry.mode,
    size: entry.path === runtimeSourcePath
      ? relocatedRuntime.byteLength
      : entry.data?.byteLength ?? 0,
    ...(entry.data === undefined ? {} : { inodeGroup: entry.path }),
  })), "/", {
    mode: "first-use",
    capabilities: ["test:retired-homebrew-prefix"],
    roots: [keg],
  });
  return { fs, runtimePath, ordinaryPath };
}

interface TestTarEntry {
  path: string;
  mode: number;
  data?: Uint8Array;
}

function testTar(entries: readonly TestTarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeTarString(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.data?.byteLength ?? 0);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.data === undefined ? "5" : "0").charCodeAt(0);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    writeTarOctal(
      header,
      148,
      8,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    header[155] = 0x20;
    chunks.push(header);
    if (entry.data !== undefined) {
      const padded = new Uint8Array(
        Math.ceil(entry.data.byteLength / 512) * 512,
      );
      padded.set(entry.data);
      chunks.push(padded);
    }
  }
  chunks.push(new Uint8Array(1024));
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const tar = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return tar;
}

function writeTarString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error(`test TAR field too long: ${value}`);
  target.set(bytes, offset);
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const digits = value.toString(8).padStart(length - 2, "0");
  writeTarString(target, offset, length, `${digits}\0`);
}

function readFile(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const file = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    fs.read(file, bytes, null, bytes.byteLength);
    return new TextDecoder().decode(bytes);
  } finally {
    fs.close(file);
  }
}
