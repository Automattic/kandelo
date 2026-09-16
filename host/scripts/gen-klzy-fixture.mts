// Generates the committed cross-language fixture used by the in-kernel (Rust)
// KLZY decoder tests under crates/runtime-core/src/testdata/klzy-v1.bin.
//
// This is the drift guard for the VFS image's kernel-facing lazy-linkage
// section (see the layout doc next to its constants in
// crates/shared/src/lib.rs, the encoder in host/src/vfs/kernel-lazy-section.ts,
// and the decoder in crates/runtime-core/src/klzy.rs): the fixture is emitted
// by the REAL TypeScript encoder, then a Rust test `include_bytes!`-loads it
// and asserts every field round-trips. It is the same device
// rtfs-v3-lazy.bin provides for the RTFS manifest.
//
// Section described:
//   archive 1  4096 bytes, mount prefix "/usr"
//     bin/one            12 bytes, ino 101
//     share/tw ö.txt     34 bytes, ino 102   (multi-byte UTF-8 + a space)
//   archive 2  8192 bytes, mount prefix "/opt/ünïcøde"
//     lib/three          56 bytes, ino 103
//   one URL-backed lazy file, 4242 bytes, ino 100 (archive id 0, no path)
//
// The unicode names and the URL-backed record are deliberate: they are the two
// shapes today's shipped images do NOT exercise (every production source path
// is ASCII), so without them the fixture would only prove the format works for
// the inputs that happen to exist right now.
//
// Regenerate with:
//   cd host && npx tsx scripts/gen-klzy-fixture.mts
// (or `scripts/dev-shell.sh bash -c 'cd host && npx tsx scripts/gen-klzy-fixture.mts'`
// if running outside a shell that already has tsx on PATH).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeKernelLazySection,
  encodeKernelLazySection,
} from "../src/vfs/kernel-lazy-section";
import type {
  LazyFileEntry,
  SerializedLazyArchiveEntry,
} from "../src/vfs/memory-fs";

const lazyFiles: LazyFileEntry[] = [
  {
    ino: 100,
    generation: 1,
    dataSequence: 1,
    path: "/var/lib/single",
    paths: ["/var/lib/single"],
    url: "https://example.invalid/single.bin",
    size: 4242,
  },
];

function member(
  ino: number,
  size: number,
  sourcePath: string,
  mountPrefix: string,
) {
  return {
    vfsPath: `${mountPrefix}/${sourcePath}`,
    ino,
    generation: 1,
    dataSequence: 1,
    size,
    isSymlink: false,
    deleted: false,
    archivePath: sourcePath,
    sourcePath,
    type: "file" as const,
    inodeGroup: sourcePath,
  };
}

const archives: SerializedLazyArchiveEntry[] = [
  {
    kind: "kandelo-legacy-zip-v1",
    url: "https://example.invalid/one.zip",
    mountPrefix: "/usr",
    integrity: { bytes: 4096 },
    materialized: false,
    entries: [
      member(101, 12, "bin/one", "/usr"),
      member(102, 34, "share/tw ö.txt", "/usr"),
    ],
  },
  {
    kind: "kandelo-legacy-zip-v1",
    url: "https://example.invalid/two.zip",
    mountPrefix: "/opt/ünïcøde",
    integrity: { bytes: 8192 },
    materialized: false,
    entries: [member(103, 56, "lib/three", "/opt/ünïcøde")],
  },
] as unknown as SerializedLazyArchiveEntry[];

const section = encodeKernelLazySection(lazyFiles, archives);

// Fail loudly here rather than committing a fixture the real decoder rejects.
const decoded = decodeKernelLazySection(section);
if (decoded.archives.length !== 2 || decoded.files.length !== 4) {
  throw new Error(
    `unexpected fixture shape: ${decoded.archives.length} archives, ` +
      `${decoded.files.length} files`,
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../crates/runtime-core/src/testdata/klzy-v1.bin");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, section);
console.log(`wrote ${out} (${section.byteLength} bytes)`);
