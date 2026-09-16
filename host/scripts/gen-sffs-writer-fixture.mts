// Generates the cross-language fixtures that pin the Rust SFFS WRITER
// (crates/runtime-core/src/sffs_write.rs) to the TypeScript one.
//
// WHY A BYTE FIXTURE, AND NOT A ROUND TRIP
//
// A writer that the reader can read back proves only that the two halves
// agree with each other — including where they agree on a bug. The claim
// worth making is that for the same tree the Rust writer emits the SAME
// BYTES as `host/src/vfs/sharedfs-vendor.ts`, field for field, allocation
// for allocation. So these fixtures are the raw SFFS filesystem body
// produced by the vendor, and the Rust test asserts equality against them.
//
// The body, deliberately, not a VFSI container: the container's JSON
// sections are host authority (fetch URLs, integrity, activation) and are
// not what W-2 moves. The container is W-3/W-4.
//
// THE ONE PINNED NON-DETERMINISM: TIMESTAMPS
//
// Every create path stamps `Date.now()`, and `utimens` overwrites ctime
// with `Date.now()` unconditionally, so timestamps cannot be made
// deterministic by choosing values. They are pinned instead:
// `snapshotBytes({ normalizeTimestampsMs: 0 })` rewrites atime/mtime/ctime
// to 0 on every allocated inode and leaves 0 in every free slot. The Rust
// side sets `now_ms: 0`. Nothing else is pinned or relaxed — allocation
// order, the superblock generation counter, INO_DIR_SEQUENCE,
// INO_DATA_SEQUENCE and record placement all have to match on their own.
//
// OP ORDERING IS PART OF THE CONTRACT
//
// Files are written open/write/close -> chown -> chmod. Both `write` and
// `chown` clear S_ISUID/S_ISGID on a regular file, so only a trailing
// chmod can produce a setuid file. The Rust side mirrors this exactly as
// create_file -> set_owner -> set_mode.
//
// The fixtures are stored raw-DEFLATE compressed so a multi-megabyte image
// that exercises double-indirect blocks and a >64 KiB directory costs a
// few KiB in the tree. The Rust test inflates with `miniz_oxide`, which
// `runtime-core` already depends on.
//
// Regenerate with:
//   scripts/dev-shell.sh bash -c 'cd host && npx tsx scripts/gen-sffs-writer-fixture.mts'

import { deflateRawSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SharedFS } from "../src/vfs/sharedfs-vendor";

const BLOCK_SIZE = 4096;

const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

const enc = new TextEncoder();

interface FixtureSpec {
  name: string;
  sizeBytes: number;
  maxSizeBytes?: number;
  build(fs: SharedFS): void;
}

/** open/write/close -> chown -> chmod. See the ordering note above. */
function writeFile(
  fs: SharedFS,
  path: string,
  data: Uint8Array,
  mode: number,
  uid = 0,
  gid = 0,
): void {
  const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
  if (data.length > 0) fs.write(fd, data);
  fs.close(fd);
  fs.chown(path, uid, gid);
  fs.chmod(path, mode);
}

/** A cheaply compressible but position-dependent byte pattern. */
function pattern(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 7 + seed) % 251;
  return out;
}

const fixtures: FixtureSpec[] = [
  {
    // Every structure a small image can carry: nested directories, an
    // empty file, a file that spans the ten direct blocks into the single
    // indirect block, both symlink forms (inline at <= 40 bytes and
    // block-backed above it), a hard link, and a setuid file that only the
    // trailing chmod can produce.
    name: "sffs-small",
    sizeBytes: 128 * 1024,
    build(fs) {
      writeFile(fs, "/hello.txt", enc.encode("hello sffs\n"), 0o644);
      writeFile(fs, "/empty", new Uint8Array(0), 0o600);
      fs.mkdir("/dir", 0o755);
      fs.chown("/dir", 0, 0);
      writeFile(fs, "/dir/nested.txt", enc.encode("nested\n"), 0o644, 12, 34);
      fs.mkdir("/dir/deep", 0o700);
      fs.chown("/dir/deep", 0, 0);
      writeFile(fs, "/dir/deep/leaf", enc.encode("leaf\n"), 0o444);
      // 45000 bytes crosses 10 * 4096 = 40960, so it allocates the single
      // indirect block.
      writeFile(fs, "/big.txt", pattern(45000, 1), 0o644);
      fs.symlink("hello.txt", "/link");
      fs.symlink(
        "/dir/deep/a-target-path-long-enough-to-need-its-own-block",
        "/longlink",
      );
      fs.link("/hello.txt", "/hardlink");
      // setuid survives only because chmod comes last.
      writeFile(fs, "/suid", enc.encode("#!/bin/sh\n"), 0o4755, 0, 0);
    },
  },
  {
    // The two paths a small image cannot reach.
    //
    // 1. A directory past DIR_INDEX_MIN_SIZE (64 KiB), where the vendor
    //    switches to its in-process index and the free-slot policy changes.
    //    Name lengths are varied so records land at many different
    //    alignments, which is what creates the end-of-block padding records
    //    and the too-small-gap rec_len extensions in the first place.
    // 2. A file past 10 + 1024 blocks, which reaches the double-indirect
    //    block.
    name: "sffs-wide",
    sizeBytes: 8 * 1024 * 1024,
    maxSizeBytes: 64 * 1024 * 1024,
    build(fs) {
      fs.mkdir("/wide", 0o755);
      for (let i = 0; i < 3000; i++) {
        // Name length cycles 1..37 characters.
        const width = 1 + (i % 37);
        const name = `${i}`.padStart(width, "n").slice(0, width);
        writeFile(fs, `/wide/${name}-${i}`, new Uint8Array(0), 0o644);
      }
      // 10 direct + 1024 single-indirect = 1034 blocks = 4235264 bytes.
      // Add a partial block past that to land inside double-indirect.
      writeFile(fs, "/huge.bin", pattern(1034 * BLOCK_SIZE + 1234, 9), 0o644);
    },
  },
  {
    // Pins the ONE decision `sffs-wide` cannot distinguish: which remembered
    // free record the vendor's directory index reuses.
    //
    // `useDirIndexFreeSlot` scans its free list from the END, not from the
    // start. In `sffs-wide` that choice is invisible, because the free list
    // only ever held two slots (12 and 24 bytes) and the single reuse needed
    // more than 12 — so a forward scan skips the small slot and lands on the
    // same record a backward scan picks. Measured, not assumed.
    //
    // This tree forces the distinction. Every phase-one name is exactly 32
    // bytes, so each record is align4(8 + 32) = 40 bytes and each 4096-byte
    // block ends with a gap too small for another record: a padding record.
    // By the time the directory passes DIR_INDEX_MIN_SIZE the free list holds
    // a padding record per block, all the same size. Phase two then adds
    // names short enough to fit ANY of them, so the first reuse lands in a
    // different place depending on the scan direction, and the images differ.
    name: "sffs-slots",
    sizeBytes: 1024 * 1024,
    maxSizeBytes: 32 * 1024 * 1024,
    build(fs) {
      fs.mkdir("/slots", 0o755);
      // 1700 * 40 bytes is comfortably past the 64 KiB index threshold.
      for (let i = 0; i < 1700; i++) {
        const name = `${i}`.padStart(32, "0");
        writeFile(fs, `/slots/${name}`, new Uint8Array(0), 0o644);
      }
      // needed = align4(8 + 2..3) = 12, which fits every padding record above.
      for (let i = 0; i < 40; i++) {
        writeFile(fs, `/slots/s${i}`, new Uint8Array(0), 0o644);
      }
    },
  },
  {
    // Forces the one directory branch the other fixtures never reach: a
    // trailing gap too small to hold a padding record, where the vendor
    // instead EXTENDS the previous record's rec_len to absorb it.
    //
    // Every rec_len is 4-aligned, so a gap is always a multiple of 4 and the
    // only gap that separates "gap >= 8" from "gap >= 4" is exactly 4. That
    // needs a directory whose records land on 4092 in a block. With 4-byte
    // names every record is align4(8 + 4) = 12 bytes: block 0 holds "." and
    // ".." (24) plus 339 records (4068) = 4092, and every later block holds
    // 341 records (4092). So every single block ends with a 4-byte gap.
    //
    // The directory is also taken past DIR_INDEX_MIN_SIZE so the extension
    // runs on BOTH paths: the linear scan, which already knows the last
    // record, and the index path, which does not and has to go find it with
    // findLastDirEntryInBlock.
    name: "sffs-tail",
    sizeBytes: 2 * 1024 * 1024,
    maxSizeBytes: 128 * 1024 * 1024,
    build(fs) {
      fs.mkdir("/tail", 0o755);
      for (let i = 0; i < 6000; i++) {
        writeFile(fs, `/tail/${name4(i)}`, new Uint8Array(0), 0o644);
      }
    },
  },
];

const ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Exactly four characters, so every directory record is 12 bytes. */
function name4(i: number): string {
  let out = "";
  let n = i;
  for (let k = 0; k < 4; k++) {
    out = ALPHA[n % 36] + out;
    n = Math.floor(n / 36);
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../crates/runtime-core/src/testdata");
mkdirSync(outDir, { recursive: true });

for (const fixture of fixtures) {
  const sab = new SharedArrayBuffer(fixture.sizeBytes);
  const fs = SharedFS.mkfs(sab, fixture.maxSizeBytes);
  fixture.build(fs);
  const body = fs.snapshotBytes({ normalizeTimestampsMs: 0 });
  if (body.byteLength !== fixture.sizeBytes) {
    // A non-growable SharedArrayBuffer cannot grow, so the snapshot must be
    // exactly the length mkfs was given. If this ever trips, the fixture
    // outgrew its buffer and the Rust side's growth model is being tested
    // by accident rather than on purpose.
    throw new Error(
      `${fixture.name}: snapshot is ${body.byteLength} bytes, expected ${fixture.sizeBytes}`,
    );
  }
  const packed = deflateRawSync(body, { level: 9 });
  const out = join(outDir, `${fixture.name}.sffs.deflate`);
  writeFileSync(out, packed);
  console.log(
    `wrote ${out} (${packed.byteLength} bytes, ${body.byteLength} uncompressed)`,
  );
}
