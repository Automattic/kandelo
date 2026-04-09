/**
 * SharedFS — A block-based filesystem on SharedArrayBuffer.
 *
 * All synchronization uses Atomics (wait/notify/compareExchange)
 * so multiple workers can safely share the same buffer with no
 * message passing.
 *
 * Layout (same as the C implementation):
 *   Block 0: Superblock (0..255) + FD table (256..1791)
 *   Inode bitmap blocks
 *   Block bitmap blocks
 *   Inode table blocks
 *   Data blocks
 */

// ── Constants ────────────────────────────────────────────────────────

export const BLOCK_SIZE = 4096;
export const INODE_SIZE = 128;
export const INODES_PER_BLOCK = BLOCK_SIZE / INODE_SIZE; // 32
export const MAX_NAME = 255;
export const MAX_FDS = 64;
export const MAX_SYMLINK_HOPS = 8;
export const DIRECT_BLOCKS = 10;
export const PTRS_PER_BLOCK = BLOCK_SIZE / 4; // 1024
export const INLINE_SYMLINK_SIZE = DIRECT_BLOCKS * 4; // 40
export const ROOT_INO = 1;
export const FD_TABLE_OFFSET = 256;

export const MAGIC = 0x53464653; // "SFFS"
export const VERSION = 1;

// File types
export const S_IFREG = 0x8000;
export const S_IFDIR = 0x4000;
export const S_IFLNK = 0xa000;
export const S_IFMT = 0xf000;

// Open flags
export const O_RDONLY = 0x0000;
export const O_WRONLY = 0x0001;
export const O_RDWR = 0x0002;
export const O_CREAT = 0x0040;
export const O_TRUNC = 0x0200;
export const O_APPEND = 0x0400;
export const O_DIRECTORY = 0x010000;
export const O_ACCMODE = 0x0003;

// Seek
export const SEEK_SET = 0;
export const SEEK_CUR = 1;
export const SEEK_END = 2;

// Dirent
const DIRENT_HEADER_SIZE = 8;
const DIRENT_ALIGN = 4;

// Error codes
export const EPERM = -1;
export const ENOENT = -2;
export const EIO = -5;
export const EBADF = -9;
export const EEXIST = -17;
export const ENOTDIR = -20;
export const EISDIR = -21;
export const EINVAL = -22;
export const EMFILE = -24;
export const ENOSPC = -28;
export const ENAMETOOLONG = -36;
export const ENOTEMPTY = -39;
export const ELOOP = -40;

// Superblock field byte offsets
const SB_MAGIC = 0;
const SB_VERSION = 4;
const SB_BLOCK_SIZE = 8;
const SB_TOTAL_BLOCKS = 12;
const SB_TOTAL_INODES = 16;
const SB_FREE_BLOCKS = 20;
const SB_FREE_INODES = 24;
const SB_INODE_BITMAP_START = 28;
const SB_BLOCK_BITMAP_START = 32;
const SB_INODE_TABLE_START = 36;
const SB_DATA_START = 40;
const SB_INODE_BITMAP_BLOCKS = 44;
const SB_BLOCK_BITMAP_BLOCKS = 48;
const SB_INODE_TABLE_BLOCKS = 52;
const SB_GENERATION = 56;
const SB_GLOBAL_LOCK = 60;
const SB_MAX_SIZE_BLOCKS = 68;
const SB_GROW_CHUNK_BLOCKS = 72;

// Inode field byte offsets (relative to inode start)
const INO_LOCK_STATE = 0;
const INO_MODE = 8;
const INO_LINK_COUNT = 12;
const INO_SIZE = 16; // uint64
const INO_MTIME = 24; // uint64 (milliseconds since epoch)
const INO_CTIME = 32; // uint64 (milliseconds since epoch)
const INO_ATIME = 40; // uint64 (milliseconds since epoch)
const INO_DIRECT = 48; // 10 * 4 bytes
const INO_INDIRECT = 88;
const INO_DOUBLE_INDIRECT = 92;

// FD entry layout
const FD_IN_USE = 0;
const FD_INO = 4;
const FD_OFFSET = 8; // uint64
const FD_FLAGS = 16;
const FD_IS_DIR = 20;
const FD_ENTRY_SIZE = 24;

// Lock bits
const WRITER_BIT = 0x80000000 | 0; // -2147483648 as int32
const READER_MASK = 0x7fffffff | 0;

// ── Types ────────────────────────────────────────────────────────────

export interface StatResult {
  ino: number;
  mode: number;
  linkCount: number;
  size: number;
  mtime: number;
  ctime: number;
  atime: number;
}

const ERROR_MESSAGES: Record<number, string> = {
  [ENOENT]: "No such file or directory",
  [EIO]: "I/O error",
  [EBADF]: "Bad file descriptor",
  [EEXIST]: "File exists",
  [ENOTDIR]: "Not a directory",
  [EISDIR]: "Is a directory",
  [EINVAL]: "Invalid argument",
  [EMFILE]: "Too many open files",
  [ENOSPC]: "No space left on device",
  [ENAMETOOLONG]: "File name too long",
  [ENOTEMPTY]: "Directory not empty",
  [ELOOP]: "Too many symbolic links",
};

export class SFSError extends Error {
  constructor(
    public code: number,
    message?: string,
  ) {
    super(message || ERROR_MESSAGES[code] || `Error ${code}`);
    this.name = "SFSError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Safely decode a Uint8Array that may be backed by SharedArrayBuffer.
 * Browsers reject SAB-backed views in TextDecoder.decode().
 */
function safeDecode(view: Uint8Array): string {
  if (view.buffer instanceof SharedArrayBuffer) {
    return decoder.decode(new Uint8Array(view));
  }
  return decoder.decode(view);
}

function align4(x: number): number {
  return (x + 3) & ~3;
}

// ── SharedFS ─────────────────────────────────────────────────────────

export class SharedFS {
  private view: DataView;
  private i32: Int32Array;
  private u8: Uint8Array;

  private constructor(public readonly buffer: SharedArrayBuffer) {
    this.view = new DataView(buffer);
    this.i32 = new Int32Array(buffer);
    this.u8 = new Uint8Array(buffer);
  }

  // ── Factory methods ──────────────────────────────────────────────

  static mkfs(buffer: SharedArrayBuffer): SharedFS {
    const sizeBytes = buffer.byteLength;
    if (sizeBytes < BLOCK_SIZE * 16) throw new SFSError(EINVAL);

    const totalBlocks = Math.floor(sizeBytes / BLOCK_SIZE);
    let totalInodes = Math.floor(totalBlocks / 4);
    if (totalInodes < 32) totalInodes = 32;
    totalInodes =
      Math.ceil(totalInodes / INODES_PER_BLOCK) * INODES_PER_BLOCK;

    const maxBlocks = totalBlocks * 4;

    const inodeBitmapBlocks = Math.ceil(totalInodes / (BLOCK_SIZE * 8));
    const blockBitmapBlocks = Math.ceil(maxBlocks / (BLOCK_SIZE * 8));
    const inodeTableBlocks = Math.ceil(
      (totalInodes * INODE_SIZE) / BLOCK_SIZE,
    );

    const inodeBitmapStart = 1;
    const blockBitmapStart = inodeBitmapStart + inodeBitmapBlocks;
    const inodeTableStart = blockBitmapStart + blockBitmapBlocks;
    const dataStart = inodeTableStart + inodeTableBlocks;

    if (dataStart >= totalBlocks) throw new SFSError(ENOSPC);

    // Zero the buffer
    new Uint8Array(buffer).fill(0);

    const fs = new SharedFS(buffer);

    // Write superblock
    fs.w32(SB_MAGIC, MAGIC);
    fs.w32(SB_VERSION, VERSION);
    fs.w32(SB_BLOCK_SIZE, BLOCK_SIZE);
    fs.w32(SB_TOTAL_BLOCKS, totalBlocks);
    fs.w32(SB_TOTAL_INODES, totalInodes);
    fs.w32(SB_INODE_BITMAP_START, inodeBitmapStart);
    fs.w32(SB_BLOCK_BITMAP_START, blockBitmapStart);
    fs.w32(SB_INODE_TABLE_START, inodeTableStart);
    fs.w32(SB_DATA_START, dataStart);
    fs.w32(SB_INODE_BITMAP_BLOCKS, inodeBitmapBlocks);
    fs.w32(SB_BLOCK_BITMAP_BLOCKS, blockBitmapBlocks);
    fs.w32(SB_INODE_TABLE_BLOCKS, inodeTableBlocks);
    fs.w32(SB_MAX_SIZE_BLOCKS, maxBlocks);
    fs.w32(SB_GROW_CHUNK_BLOCKS, 256);

    // Mark metadata blocks as used in block bitmap
    const bbStart = blockBitmapStart * BLOCK_SIZE;
    for (let b = 0; b < dataStart; b++) {
      const wordIdx = (bbStart >> 2) + (b >> 5);
      fs.i32[wordIdx] |= 1 << (b & 31);
    }

    const freeDataBlocks = totalBlocks - dataStart;
    Atomics.store(fs.i32, SB_FREE_BLOCKS >> 2, freeDataBlocks);

    // Mark inodes 0 and 1 as used
    const ibStart = inodeBitmapStart * BLOCK_SIZE;
    fs.i32[ibStart >> 2] |= 0x3;
    Atomics.store(fs.i32, SB_FREE_INODES >> 2, totalInodes - 2);

    // Initialize root inode (inode 1) as empty directory
    const rootOff = fs.inodeOffset(ROOT_INO);
    fs.w32(rootOff + INO_MODE, S_IFDIR | 0o755);
    fs.w32(rootOff + INO_LINK_COUNT, 2);

    // Allocate a data block for root's directory entries
    const rootBlock = fs.blockAlloc();
    if (rootBlock < 0) throw new SFSError(ENOSPC);
    fs.w32(rootOff + INO_DIRECT, rootBlock);

    // Write "." and ".." entries
    const dBase = rootBlock * BLOCK_SIZE;
    const dotRecLen = align4(DIRENT_HEADER_SIZE + 1);
    const dotdotRecLen = align4(DIRENT_HEADER_SIZE + 2);

    // "."
    fs.w32(dBase, ROOT_INO); // ino
    fs.view.setUint16(dBase + 4, dotRecLen, true); // rec_len
    fs.view.setUint16(dBase + 6, 1, true); // name_len
    fs.u8[dBase + DIRENT_HEADER_SIZE] = 0x2e; // '.'

    // ".."
    const ddOff = dBase + dotRecLen;
    fs.w32(ddOff, ROOT_INO);
    fs.view.setUint16(ddOff + 4, dotdotRecLen, true);
    fs.view.setUint16(ddOff + 6, 2, true);
    fs.u8[ddOff + DIRENT_HEADER_SIZE] = 0x2e;
    fs.u8[ddOff + DIRENT_HEADER_SIZE + 1] = 0x2e;

    fs.w64(rootOff + INO_SIZE, dotRecLen + dotdotRecLen);

    Atomics.store(fs.i32, SB_GENERATION >> 2, 1);

    return fs;
  }

  static mount(buffer: SharedArrayBuffer): SharedFS {
    const fs = new SharedFS(buffer);
    if (fs.r32(SB_MAGIC) !== MAGIC) throw new SFSError(EINVAL, "Bad magic");
    if (fs.r32(SB_VERSION) !== VERSION)
      throw new SFSError(EINVAL, "Bad version");
    if (fs.r32(SB_BLOCK_SIZE) !== BLOCK_SIZE)
      throw new SFSError(EINVAL, "Bad block size");
    return fs;
  }

  // ── Low-level read/write helpers ─────────────────────────────────

  private r32(off: number): number {
    return this.view.getUint32(off, true);
  }
  private w32(off: number, v: number): void {
    this.view.setUint32(off, v, true);
  }
  private r64(off: number): number {
    return Number(this.view.getBigUint64(off, true));
  }
  private w64(off: number, v: number): void {
    this.view.setBigUint64(off, BigInt(v), true);
  }

  // ── Superblock lock (for grow) ───────────────────────────────────

  private sbLock(): void {
    const idx = SB_GLOBAL_LOCK >> 2;
    for (;;) {
      const old = Atomics.compareExchange(this.i32, idx, 0, 1);
      if (old === 0) return;
      Atomics.wait(this.i32, idx, 1);
    }
  }

  private sbUnlock(): void {
    const idx = SB_GLOBAL_LOCK >> 2;
    Atomics.store(this.i32, idx, 0);
    Atomics.notify(this.i32, idx, Infinity);
  }

  // ── Block allocator ──────────────────────────────────────────────

  private blockAlloc(): number {
    const totalBlocks = this.r32(SB_TOTAL_BLOCKS);
    const bbStart = this.r32(SB_BLOCK_BITMAP_START) * BLOCK_SIZE;
    const numWords = Math.ceil(totalBlocks / 32);

    for (let w = 0; w < numWords; w++) {
      const idx = (bbStart >> 2) + w;
      const word = Atomics.load(this.i32, idx);
      if (word === -1) continue; // all bits set (0xFFFFFFFF as int32)

      for (let bit = 0; bit < 32; bit++) {
        const blockNo = w * 32 + bit;
        if (blockNo >= totalBlocks) return ENOSPC;
        if (word & (1 << bit)) continue;

        const desired = word | (1 << bit);
        const old = Atomics.compareExchange(this.i32, idx, word, desired);
        if (old === word) {
          Atomics.sub(this.i32, SB_FREE_BLOCKS >> 2, 1);
          // Zero the newly allocated block
          const off = blockNo * BLOCK_SIZE;
          this.u8.fill(0, off, off + BLOCK_SIZE);
          return blockNo;
        }
        // CAS failed — retry this word
        w--;
        break;
      }
    }
    return ENOSPC;
  }

  private blockAllocWithGrow(): number {
    let blk = this.blockAlloc();
    if (blk !== ENOSPC) return blk;
    const grew = this.grow();
    if (grew < 0) return ENOSPC;
    blk = this.blockAlloc();
    return blk;
  }

  private blockFree(blockNo: number): void {
    const bbStart = this.r32(SB_BLOCK_BITMAP_START) * BLOCK_SIZE;
    const idx = (bbStart >> 2) + (blockNo >> 5);
    const bit = blockNo & 31;

    for (;;) {
      const word = Atomics.load(this.i32, idx);
      const desired = word & ~(1 << bit);
      const old = Atomics.compareExchange(this.i32, idx, word, desired);
      if (old === word) break;
    }
    Atomics.add(this.i32, SB_FREE_BLOCKS >> 2, 1);
  }

  // ── Growth ───────────────────────────────────────────────────────

  private grow(): number {
    this.sbLock();
    try {
      if (Atomics.load(this.i32, SB_FREE_BLOCKS >> 2) > 0) return 0;

      const current = this.r32(SB_TOTAL_BLOCKS);
      const maxBlocks = this.r32(SB_MAX_SIZE_BLOCKS);
      let growBy = this.r32(SB_GROW_CHUNK_BLOCKS);
      let newTotal = current + growBy;

      if (newTotal > maxBlocks) {
        newTotal = maxBlocks;
        growBy = newTotal - current;
        if (growBy === 0) return ENOSPC;
      }

      const neededBytes = newTotal * BLOCK_SIZE;
      if (this.buffer.byteLength < neededBytes) {
        // Try to grow the SharedArrayBuffer
        try {
          (this.buffer as any).grow(neededBytes);
          this.view = new DataView(this.buffer);
          this.i32 = new Int32Array(this.buffer);
          this.u8 = new Uint8Array(this.buffer);
        } catch {
          return ENOSPC;
        }
      }

      this.w32(SB_TOTAL_BLOCKS, newTotal);
      Atomics.add(this.i32, SB_FREE_BLOCKS >> 2, growBy);
      Atomics.add(this.i32, SB_GENERATION >> 2, 1);
      return 0;
    } finally {
      this.sbUnlock();
    }
  }

  // ── Inode helpers ────────────────────────────────────────────────

  private inodeOffset(ino: number): number {
    const tableStart = this.r32(SB_INODE_TABLE_START);
    const block = tableStart + Math.floor(ino / INODES_PER_BLOCK);
    const off = (ino % INODES_PER_BLOCK) * INODE_SIZE;
    return block * BLOCK_SIZE + off;
  }

  private inodeAlloc(): number {
    const totalInodes = this.r32(SB_TOTAL_INODES);
    const ibStart = this.r32(SB_INODE_BITMAP_START) * BLOCK_SIZE;
    const numWords = Math.ceil(totalInodes / 32);

    for (let w = 0; w < numWords; w++) {
      const idx = (ibStart >> 2) + w;
      const word = Atomics.load(this.i32, idx);
      if (word === -1) continue;

      for (let bit = 0; bit < 32; bit++) {
        const ino = w * 32 + bit;
        if (ino >= totalInodes) return ENOSPC;
        if (word & (1 << bit)) continue;

        const desired = word | (1 << bit);
        const old = Atomics.compareExchange(this.i32, idx, word, desired);
        if (old === word) {
          Atomics.sub(this.i32, SB_FREE_INODES >> 2, 1);
          // Zero the inode
          const off = this.inodeOffset(ino);
          this.u8.fill(0, off, off + INODE_SIZE);
          return ino;
        }
        w--;
        break;
      }
    }
    return ENOSPC;
  }

  private inodeFree(ino: number): void {
    const ibStart = this.r32(SB_INODE_BITMAP_START) * BLOCK_SIZE;
    const idx = (ibStart >> 2) + (ino >> 5);
    const bit = ino & 31;

    for (;;) {
      const word = Atomics.load(this.i32, idx);
      const desired = word & ~(1 << bit);
      const old = Atomics.compareExchange(this.i32, idx, word, desired);
      if (old === word) break;
    }
    Atomics.add(this.i32, SB_FREE_INODES >> 2, 1);
  }

  // ── Inode locking ────────────────────────────────────────────────

  private inodeReadLock(ino: number): void {
    const lockIdx = (this.inodeOffset(ino) + INO_LOCK_STATE) >> 2;
    for (;;) {
      const cur = Atomics.load(this.i32, lockIdx);
      if (cur & WRITER_BIT) {
        Atomics.wait(this.i32, lockIdx, cur);
        continue;
      }
      const old = Atomics.compareExchange(
        this.i32,
        lockIdx,
        cur,
        cur + 1,
      );
      if (old === cur) return;
    }
  }

  private inodeReadUnlock(ino: number): void {
    const lockIdx = (this.inodeOffset(ino) + INO_LOCK_STATE) >> 2;
    const prev = Atomics.sub(this.i32, lockIdx, 1);
    if ((prev & READER_MASK) === 1) {
      Atomics.notify(this.i32, lockIdx, 1);
    }
  }

  private inodeWriteLock(ino: number): void {
    const lockIdx = (this.inodeOffset(ino) + INO_LOCK_STATE) >> 2;
    for (;;) {
      const cur = Atomics.load(this.i32, lockIdx);
      if (cur !== 0) {
        Atomics.wait(this.i32, lockIdx, cur);
        continue;
      }
      const old = Atomics.compareExchange(
        this.i32,
        lockIdx,
        0,
        WRITER_BIT,
      );
      if (old === 0) return;
    }
  }

  private inodeWriteUnlock(ino: number): void {
    const lockIdx = (this.inodeOffset(ino) + INO_LOCK_STATE) >> 2;
    Atomics.store(this.i32, lockIdx, 0);
    Atomics.notify(this.i32, lockIdx, Infinity);
  }

  // ── Inode block mapping ──────────────────────────────────────────

  private inodeBlockMap(
    ino: number,
    fileBlock: number,
    allocate: boolean,
  ): number {
    const inoOff = this.inodeOffset(ino);

    // Direct blocks: 0..9
    if (fileBlock < DIRECT_BLOCKS) {
      const ptr = this.r32(inoOff + INO_DIRECT + fileBlock * 4);
      if (ptr !== 0) return ptr;
      if (!allocate) return 0;
      const blk = this.blockAllocWithGrow();
      if (blk < 0) return blk;
      this.w32(inoOff + INO_DIRECT + fileBlock * 4, blk);
      return blk;
    }

    // Single indirect: 10..1033
    fileBlock -= DIRECT_BLOCKS;
    if (fileBlock < PTRS_PER_BLOCK) {
      let ind = this.r32(inoOff + INO_INDIRECT);
      if (ind === 0) {
        if (!allocate) return 0;
        ind = this.blockAllocWithGrow();
        if (ind < 0) return ind;
        this.w32(inoOff + INO_INDIRECT, ind);
      }
      const ptrOff = ind * BLOCK_SIZE + fileBlock * 4;
      const ptr = this.r32(ptrOff);
      if (ptr !== 0) return ptr;
      if (!allocate) return 0;
      const blk = this.blockAllocWithGrow();
      if (blk < 0) return blk;
      this.w32(ptrOff, blk);
      return blk;
    }

    // Double indirect: 1034..1024*1024+1033
    fileBlock -= PTRS_PER_BLOCK;
    if (fileBlock < PTRS_PER_BLOCK * PTRS_PER_BLOCK) {
      const idx1 = Math.floor(fileBlock / PTRS_PER_BLOCK);
      const idx2 = fileBlock % PTRS_PER_BLOCK;

      let dind = this.r32(inoOff + INO_DOUBLE_INDIRECT);
      if (dind === 0) {
        if (!allocate) return 0;
        dind = this.blockAllocWithGrow();
        if (dind < 0) return dind;
        this.w32(inoOff + INO_DOUBLE_INDIRECT, dind);
      }

      const l1Off = dind * BLOCK_SIZE + idx1 * 4;
      let l1 = this.r32(l1Off);
      if (l1 === 0) {
        if (!allocate) return 0;
        l1 = this.blockAllocWithGrow();
        if (l1 < 0) return l1;
        this.w32(l1Off, l1);
      }

      const l2Off = l1 * BLOCK_SIZE + idx2 * 4;
      const ptr = this.r32(l2Off);
      if (ptr !== 0) return ptr;
      if (!allocate) return 0;
      const blk = this.blockAllocWithGrow();
      if (blk < 0) return blk;
      this.w32(l2Off, blk);
      return blk;
    }

    return EINVAL;
  }

  // ── Inode data I/O ───────────────────────────────────────────────

  private inodeReadData(
    ino: number,
    offset: number,
    dst: Uint8Array,
    count: number,
  ): number {
    const inoOff = this.inodeOffset(ino);
    const size = this.r64(inoOff + INO_SIZE);
    if (offset >= size) return 0;
    if (offset + count > size) count = size - offset;

    let totalRead = 0;
    let dstPos = 0;

    while (count > 0) {
      const fileBlock = Math.floor(offset / BLOCK_SIZE);
      const blockOff = offset % BLOCK_SIZE;
      let chunk = BLOCK_SIZE - blockOff;
      if (chunk > count) chunk = count;

      const phys = this.inodeBlockMap(ino, fileBlock, false);
      if (phys <= 0) {
        dst.fill(0, dstPos, dstPos + chunk);
      } else {
        const src = phys * BLOCK_SIZE + blockOff;
        dst.set(this.u8.subarray(src, src + chunk), dstPos);
      }

      dstPos += chunk;
      offset += chunk;
      count -= chunk;
      totalRead += chunk;
    }
    return totalRead;
  }

  private inodeWriteData(
    ino: number,
    offset: number,
    src: Uint8Array,
    count: number,
  ): number {
    const inoOff = this.inodeOffset(ino);
    let totalWritten = 0;
    let srcPos = 0;

    while (count > 0) {
      const fileBlock = Math.floor(offset / BLOCK_SIZE);
      const blockOff = offset % BLOCK_SIZE;
      let chunk = BLOCK_SIZE - blockOff;
      if (chunk > count) chunk = count;

      const phys = this.inodeBlockMap(ino, fileBlock, true);
      if (phys < 0) return totalWritten > 0 ? totalWritten : phys;

      const dstOff = phys * BLOCK_SIZE + blockOff;
      this.u8.set(src.subarray(srcPos, srcPos + chunk), dstOff);

      srcPos += chunk;
      offset += chunk;
      count -= chunk;
      totalWritten += chunk;
    }

    const size = this.r64(inoOff + INO_SIZE);
    if (offset > size) {
      this.w64(inoOff + INO_SIZE, offset);
    }
    return totalWritten;
  }

  private freeBlocksFrom(ino: number, fromBlock: number): void {
    const inoOff = this.inodeOffset(ino);

    // Direct blocks
    for (let i = fromBlock; i < DIRECT_BLOCKS; i++) {
      const ptr = this.r32(inoOff + INO_DIRECT + i * 4);
      if (ptr) {
        this.blockFree(ptr);
        this.w32(inoOff + INO_DIRECT + i * 4, 0);
      }
    }

    // Single indirect
    const ind = this.r32(inoOff + INO_INDIRECT);
    if (ind) {
      const start =
        fromBlock > DIRECT_BLOCKS ? fromBlock - DIRECT_BLOCKS : 0;
      for (let i = start; i < PTRS_PER_BLOCK; i++) {
        const ptrOff = ind * BLOCK_SIZE + i * 4;
        const ptr = this.r32(ptrOff);
        if (ptr) {
          this.blockFree(ptr);
          this.w32(ptrOff, 0);
        }
      }
      if (start === 0) {
        this.blockFree(ind);
        this.w32(inoOff + INO_INDIRECT, 0);
      }
    }

    // Double indirect
    const dind = this.r32(inoOff + INO_DOUBLE_INDIRECT);
    if (dind) {
      const absStart =
        fromBlock > DIRECT_BLOCKS + PTRS_PER_BLOCK
          ? fromBlock - DIRECT_BLOCKS - PTRS_PER_BLOCK
          : 0;
      const i1Start = Math.floor(absStart / PTRS_PER_BLOCK);

      for (let i1 = i1Start; i1 < PTRS_PER_BLOCK; i1++) {
        const l1Off = dind * BLOCK_SIZE + i1 * 4;
        const l1 = this.r32(l1Off);
        if (!l1) continue;

        const i2Start = i1 === i1Start ? absStart % PTRS_PER_BLOCK : 0;
        for (let i2 = i2Start; i2 < PTRS_PER_BLOCK; i2++) {
          const l2Off = l1 * BLOCK_SIZE + i2 * 4;
          const ptr = this.r32(l2Off);
          if (ptr) {
            this.blockFree(ptr);
            this.w32(l2Off, 0);
          }
        }
        if (i2Start === 0) {
          this.blockFree(l1);
          this.w32(l1Off, 0);
        }
      }
      if (i1Start === 0) {
        this.blockFree(dind);
        this.w32(inoOff + INO_DOUBLE_INDIRECT, 0);
      }
    }
  }

  private inodeTruncate(ino: number, newSize: number): void {
    const inoOff = this.inodeOffset(ino);
    const curSize = this.r64(inoOff + INO_SIZE);
    if (newSize >= curSize) {
      this.w64(inoOff + INO_SIZE, newSize);
      return;
    }
    const keepBlocks = Math.ceil(newSize / BLOCK_SIZE);
    this.freeBlocksFrom(ino, keepBlocks);
    this.w64(inoOff + INO_SIZE, newSize);
  }

  // ── Directory operations ─────────────────────────────────────────

  private dirLookup(dirIno: number, name: Uint8Array): number {
    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    let pos = 0;

    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (recLen === 0) return EIO;

        if (entIno !== 0 && entNameLen === name.length) {
          let match = true;
          for (let i = 0; i < name.length; i++) {
            if (this.u8[abs + DIRENT_HEADER_SIZE + i] !== name[i]) {
              match = false;
              break;
            }
          }
          if (match) return entIno;
        }
        off += recLen;
      }
      pos += remain;
    }
    return ENOENT;
  }

  private dirAddEntry(
    dirIno: number,
    name: Uint8Array,
    childIno: number,
  ): number {
    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    const needed = align4(DIRENT_HEADER_SIZE + name.length);

    // Track last entry position for potential recLen extension
    let lastEntAbs = -1;

    // Scan existing entries for a deleted slot or slack space
    let pos = 0;
    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (recLen === 0) return EIO;

        if (entIno === 0 && recLen >= needed) {
          // Reuse deleted entry
          this.w32(abs, childIno);
          this.view.setUint16(abs + 6, name.length, true);
          this.u8.set(name, abs + DIRENT_HEADER_SIZE);
          return 0;
        }

        // Check for slack space at end of this entry
        const actualLen = align4(DIRENT_HEADER_SIZE + entNameLen);
        const slack = recLen - actualLen;
        if (entIno !== 0 && slack >= needed) {
          // Shrink current entry, insert new one in slack
          this.view.setUint16(abs + 4, actualLen, true);
          const newAbs = abs + actualLen;
          this.w32(newAbs, childIno);
          this.view.setUint16(newAbs + 4, slack, true);
          this.view.setUint16(newAbs + 6, name.length, true);
          this.u8.set(name, newAbs + DIRENT_HEADER_SIZE);
          return 0;
        }

        lastEntAbs = abs;
        off += recLen;
      }
      pos += remain;
    }

    // No space found — append a new entry at the end.
    // Directory entries must not cross block boundaries (like ext2).
    let appendPos = dirSize;
    let fileBlock = Math.floor(appendPos / BLOCK_SIZE);
    let blockOff = appendPos % BLOCK_SIZE;

    if (blockOff !== 0 && blockOff + needed > BLOCK_SIZE) {
      // Entry doesn't fit in remaining space — skip to next block.
      const gap = BLOCK_SIZE - blockOff;
      if (gap >= DIRENT_HEADER_SIZE) {
        // Write a padding entry (ino=0) to fill the gap
        const padPhys = this.inodeBlockMap(dirIno, fileBlock, false);
        if (padPhys > 0) {
          const padAbs = padPhys * BLOCK_SIZE + blockOff;
          this.w32(padAbs, 0);
          this.view.setUint16(padAbs + 4, gap, true);
          this.view.setUint16(padAbs + 6, 0, true);
        }
      } else if (lastEntAbs >= 0) {
        // Gap too small for a padding entry — extend last entry's recLen
        const oldRecLen = this.view.getUint16(lastEntAbs + 4, true);
        this.view.setUint16(lastEntAbs + 4, oldRecLen + gap, true);
      }
      appendPos = (fileBlock + 1) * BLOCK_SIZE;
      fileBlock++;
      blockOff = 0;
    }

    // Need a new block?
    let phys: number;
    if (blockOff === 0) {
      phys = this.inodeBlockMap(dirIno, fileBlock, true);
      if (phys < 0) return phys;
    } else {
      phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;
    }

    const abs = phys * BLOCK_SIZE + blockOff;
    this.w32(abs, childIno);
    this.view.setUint16(abs + 4, needed, true);
    this.view.setUint16(abs + 6, name.length, true);
    this.u8.set(name, abs + DIRENT_HEADER_SIZE);

    this.w64(inoOff + INO_SIZE, appendPos + needed);
    return 0;
  }

  private dirRemoveEntry(dirIno: number, name: Uint8Array): number {
    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    let pos = 0;

    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return EIO;

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (recLen === 0) return EIO;

        if (entIno !== 0 && entNameLen === name.length) {
          let match = true;
          for (let i = 0; i < name.length; i++) {
            if (this.u8[abs + DIRENT_HEADER_SIZE + i] !== name[i]) {
              match = false;
              break;
            }
          }
          if (match) {
            this.w32(abs, 0); // mark as deleted
            return 0;
          }
        }
        off += recLen;
      }
      pos += remain;
    }
    return ENOENT;
  }

  private dirIsEmpty(dirIno: number): boolean {
    const inoOff = this.inodeOffset(dirIno);
    const dirSize = this.r64(inoOff + INO_SIZE);
    let pos = 0;

    while (pos < dirSize) {
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(dirIno, fileBlock, false);
      if (phys <= 0) return true;

      const blockBase = phys * BLOCK_SIZE;
      let remain = dirSize - pos;
      if (remain > BLOCK_SIZE - blockOff) remain = BLOCK_SIZE - blockOff;

      let off = blockOff;
      while (off < blockOff + remain) {
        const abs = blockBase + off;
        const entIno = this.r32(abs);
        const recLen = this.view.getUint16(abs + 4, true);
        const entNameLen = this.view.getUint16(abs + 6, true);

        if (recLen === 0) break;

        if (entIno !== 0) {
          // Skip "." and ".."
          if (entNameLen === 1 && this.u8[abs + DIRENT_HEADER_SIZE] === 0x2e)
          {
            off += recLen;
            continue;
          }
          if (
            entNameLen === 2 &&
            this.u8[abs + DIRENT_HEADER_SIZE] === 0x2e &&
            this.u8[abs + DIRENT_HEADER_SIZE + 1] === 0x2e
          ) {
            off += recLen;
            continue;
          }
          return false;
        }
        off += recLen;
      }
      pos += remain;
    }
    return true;
  }

  // ── Path resolution ──────────────────────────────────────────────

  private pathResolve(path: string, followSymlinks: boolean): number {
    if (!path.startsWith("/")) return ENOENT;

    let ino = ROOT_INO;
    const parts = path.split("/").filter((p) => p.length > 0);

    let symlinkHops = 0;

    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (part.length > MAX_NAME) return ENAMETOOLONG;

      const inoOff = this.inodeOffset(ino);
      const mode = this.r32(inoOff + INO_MODE);
      if ((mode & S_IFMT) !== S_IFDIR) return ENOTDIR;

      const nameBytes = encoder.encode(part);
      const childIno = this.dirLookup(ino, nameBytes);
      if (childIno < 0) return childIno;

      // Check if child is symlink
      const childOff = this.inodeOffset(childIno);
      const childMode = this.r32(childOff + INO_MODE);

      if ((childMode & S_IFMT) === S_IFLNK) {
        const isLast = pi === parts.length - 1;
        if (!isLast || followSymlinks) {
          if (++symlinkHops > MAX_SYMLINK_HOPS) return ELOOP;

          // Read symlink target
          const linkSize = this.r64(childOff + INO_SIZE);
          let target: string;
          if (linkSize <= INLINE_SYMLINK_SIZE) {
            target = safeDecode(
              this.u8.subarray(
                childOff + INO_DIRECT,
                childOff + INO_DIRECT + linkSize,
              ),
            );
          } else {
            const buf = new Uint8Array(linkSize);
            this.inodeReadData(childIno, 0, buf, linkSize);
            target = decoder.decode(buf);
          }

          // Resolve symlink
          if (target.startsWith("/")) {
            // Absolute symlink — restart from root
            ino = ROOT_INO;
            const targetParts = target
              .split("/")
              .filter((p) => p.length > 0);
            const remaining = parts.slice(pi + 1);
            parts.length = 0;
            parts.push(...targetParts, ...remaining);
            pi = -1; // will be incremented to 0
          } else {
            // Relative symlink — splice into remaining path
            const targetParts = target
              .split("/")
              .filter((p) => p.length > 0);
            const remaining = parts.slice(pi + 1);
            parts.length = pi;
            parts.push(...targetParts, ...remaining);
            pi--; // re-process from current position
          }
          continue;
        }
      }

      ino = childIno;
    }

    return ino;
  }

  private pathResolveParent(path: string): {
    parentIno: number;
    name: string;
  } {
    if (!path.startsWith("/"))
      throw new SFSError(EINVAL, "Path must be absolute");

    const parts = path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) throw new SFSError(EINVAL, "Cannot operate on /");

    const name = parts.pop()!;
    if (name.length > MAX_NAME) throw new SFSError(ENAMETOOLONG);

    const parentPath = "/" + parts.join("/");
    const parentIno = this.pathResolve(parentPath, true);
    if (parentIno < 0) throw new SFSError(parentIno);

    const pOff = this.inodeOffset(parentIno);
    const pMode = this.r32(pOff + INO_MODE);
    if ((pMode & S_IFMT) !== S_IFDIR) throw new SFSError(ENOTDIR);

    return { parentIno, name };
  }

  // ── FD table ─────────────────────────────────────────────────────

  private fdAlloc(ino: number, flags: number, isDir: boolean): number {
    for (let i = 0; i < MAX_FDS; i++) {
      const base = FD_TABLE_OFFSET + i * FD_ENTRY_SIZE;
      const idx = base >> 2;
      const old = Atomics.compareExchange(this.i32, idx, 0, 1);
      if (old === 0) {
        this.w32(base + FD_INO, ino);
        this.w64(base + FD_OFFSET, 0);
        this.w32(base + FD_FLAGS, flags);
        this.w32(base + FD_IS_DIR, isDir ? 1 : 0);
        return i;
      }
    }
    return EMFILE;
  }

  private fdGet(
    fd: number,
  ): {
    base: number;
    ino: number;
    offset: number;
    flags: number;
    isDir: boolean;
  } | null {
    if (fd < 0 || fd >= MAX_FDS) return null;
    const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
    const inUse = Atomics.load(this.i32, base >> 2);
    if (!inUse) return null;
    return {
      base,
      ino: this.r32(base + FD_INO),
      offset: this.r64(base + FD_OFFSET),
      flags: this.r32(base + FD_FLAGS),
      isDir: this.r32(base + FD_IS_DIR) !== 0,
    };
  }

  private fdFree(fd: number): void {
    if (fd >= 0 && fd < MAX_FDS) {
      const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
      Atomics.store(this.i32, base >> 2, 0);
    }
  }

  // ── Build stat result from inode ─────────────────────────────────

  private buildStat(ino: number): StatResult {
    const off = this.inodeOffset(ino);
    return {
      ino,
      mode: this.r32(off + INO_MODE),
      linkCount: this.r32(off + INO_LINK_COUNT),
      size: this.r64(off + INO_SIZE),
      mtime: this.r64(off + INO_MTIME),
      ctime: this.r64(off + INO_CTIME),
      atime: this.r64(off + INO_ATIME),
    };
  }

  // ── Public API: File operations ──────────────────────────────────

  open(path: string, flags: number, createMode: number = 0o644): number {
    const accMode = flags & O_ACCMODE;
    const creating = (flags & O_CREAT) !== 0;

    let ino = this.pathResolve(path, true);

    if (ino < 0 && ino === ENOENT && creating) {
      // Create the file
      const { parentIno, name } = this.pathResolveParent(path);
      this.inodeWriteLock(parentIno);
      try {
        // Double-check it doesn't exist now
        const nameBytes = encoder.encode(name);
        const existing = this.dirLookup(parentIno, nameBytes);
        if (existing >= 0) {
          ino = existing;
        } else {
          const newIno = this.inodeAlloc();
          if (newIno < 0) throw new SFSError(ENOSPC);

          const newOff = this.inodeOffset(newIno);
          this.w32(newOff + INO_MODE, S_IFREG | (createMode & 0o7777));
          this.w32(newOff + INO_LINK_COUNT, 1);
          this.w64(newOff + INO_SIZE, 0);
          const now = Date.now();
          this.w64(newOff + INO_ATIME, now);
          this.w64(newOff + INO_MTIME, now);
          this.w64(newOff + INO_CTIME, now);

          const rc = this.dirAddEntry(parentIno, nameBytes, newIno);
          if (rc < 0) {
            this.inodeFree(newIno);
            throw new SFSError(rc);
          }
          ino = newIno;
        }
      } finally {
        this.inodeWriteUnlock(parentIno);
      }
    }

    if (ino < 0) throw new SFSError(ino);

    const inoOff = this.inodeOffset(ino);
    const mode = this.r32(inoOff + INO_MODE);

    if ((mode & S_IFMT) === S_IFDIR) {
      if (accMode !== O_RDONLY) throw new SFSError(EISDIR);
    }

    // O_DIRECTORY: reject non-directories
    if ((flags & O_DIRECTORY) && (mode & S_IFMT) !== S_IFDIR) {
      throw new SFSError(ENOTDIR);
    }

    // Truncate if requested
    if (flags & O_TRUNC) {
      if ((mode & S_IFMT) === S_IFDIR) throw new SFSError(EISDIR);
      this.inodeWriteLock(ino);
      this.inodeTruncate(ino, 0);
      this.inodeWriteUnlock(ino);
    }

    const fd = this.fdAlloc(ino, flags, false);
    if (fd < 0) throw new SFSError(fd);

    // If append, set offset to end
    if (flags & O_APPEND) {
      const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
      this.w64(base + FD_OFFSET, this.r64(inoOff + INO_SIZE));
    }

    return fd;
  }

  close(fd: number): void {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    this.fdFree(fd);
  }

  read(fd: number, buffer: Uint8Array): number {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);

    this.inodeReadLock(entry.ino);
    try {
      const nread = this.inodeReadData(
        entry.ino,
        entry.offset,
        buffer,
        buffer.length,
      );
      // Update offset
      const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
      this.w64(base + FD_OFFSET, entry.offset + nread);
      return nread;
    } finally {
      this.inodeReadUnlock(entry.ino);
    }
  }

  write(fd: number, data: Uint8Array): number {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);

    const accMode = entry.flags & O_ACCMODE;
    if (accMode === O_RDONLY) throw new SFSError(EBADF);

    this.inodeWriteLock(entry.ino);
    try {
      let offset = entry.offset;
      if (entry.flags & O_APPEND) {
        const inoOff = this.inodeOffset(entry.ino);
        offset = this.r64(inoOff + INO_SIZE);
      }

      const nwritten = this.inodeWriteData(
        entry.ino,
        offset,
        data,
        data.length,
      );
      // Update offset
      const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
      this.w64(base + FD_OFFSET, offset + nwritten);
      return nwritten;
    } finally {
      this.inodeWriteUnlock(entry.ino);
    }
  }

  lseek(fd: number, offset: number, whence: number): number {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);

    let newOffset: number;
    if (whence === SEEK_SET) {
      newOffset = offset;
    } else if (whence === SEEK_CUR) {
      newOffset = entry.offset + offset;
    } else if (whence === SEEK_END) {
      const inoOff = this.inodeOffset(entry.ino);
      const size = this.r64(inoOff + INO_SIZE);
      newOffset = size + offset;
    } else {
      throw new SFSError(EINVAL);
    }

    if (newOffset < 0) throw new SFSError(EINVAL);

    const base = FD_TABLE_OFFSET + fd * FD_ENTRY_SIZE;
    this.w64(base + FD_OFFSET, newOffset);
    return newOffset;
  }

  ftruncate(fd: number, length: number): void {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    if ((entry.flags & O_ACCMODE) === O_RDONLY) throw new SFSError(EBADF);

    this.inodeWriteLock(entry.ino);
    try {
      this.inodeTruncate(entry.ino, length);
    } finally {
      this.inodeWriteUnlock(entry.ino);
    }
  }

  fstat(fd: number): StatResult {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    this.inodeReadLock(entry.ino);
    try {
      return this.buildStat(entry.ino);
    } finally {
      this.inodeReadUnlock(entry.ino);
    }
  }

  // ── Public API: Path operations ──────────────────────────────────

  stat(path: string): StatResult {
    const ino = this.pathResolve(path, true);
    if (ino < 0) throw new SFSError(ino);
    this.inodeReadLock(ino);
    try {
      return this.buildStat(ino);
    } finally {
      this.inodeReadUnlock(ino);
    }
  }

  lstat(path: string): StatResult {
    const ino = this.pathResolve(path, false); // don't follow symlinks
    if (ino < 0) throw new SFSError(ino);
    this.inodeReadLock(ino);
    try {
      return this.buildStat(ino);
    } finally {
      this.inodeReadUnlock(ino);
    }
  }

  unlink(path: string): void {
    const { parentIno, name } = this.pathResolveParent(path);
    const nameBytes = encoder.encode(name);

    this.inodeWriteLock(parentIno);
    try {
      const childIno = this.dirLookup(parentIno, nameBytes);
      if (childIno < 0) throw new SFSError(childIno);

      const childOff = this.inodeOffset(childIno);
      const mode = this.r32(childOff + INO_MODE);
      if ((mode & S_IFMT) === S_IFDIR) throw new SFSError(EISDIR);

      const rc = this.dirRemoveEntry(parentIno, nameBytes);
      if (rc < 0) throw new SFSError(rc);

      this.inodeWriteLock(childIno);
      const linkCount = this.r32(childOff + INO_LINK_COUNT);
      if (linkCount <= 1) {
        this.inodeTruncate(childIno, 0);
        this.w32(childOff + INO_LINK_COUNT, 0);
        this.inodeWriteUnlock(childIno);
        this.inodeFree(childIno);
      } else {
        this.w32(childOff + INO_LINK_COUNT, linkCount - 1);
        this.inodeWriteUnlock(childIno);
      }
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  rename(oldPath: string, newPath: string): void {
    const { parentIno: oldParent, name: oldName } =
      this.pathResolveParent(oldPath);
    const { parentIno: newParent, name: newName } =
      this.pathResolveParent(newPath);
    const oldNameBytes = encoder.encode(oldName);
    const newNameBytes = encoder.encode(newName);

    // Lock both parents (consistent order to avoid deadlock)
    const first = Math.min(oldParent, newParent);
    const second = Math.max(oldParent, newParent);
    this.inodeWriteLock(first);
    if (first !== second) this.inodeWriteLock(second);

    try {
      const srcIno = this.dirLookup(oldParent, oldNameBytes);
      if (srcIno < 0) throw new SFSError(srcIno);

      // Remove any existing entry at destination
      const existingIno = this.dirLookup(newParent, newNameBytes);
      if (existingIno >= 0) {
        const existOff = this.inodeOffset(existingIno);
        const existMode = this.r32(existOff + INO_MODE);
        if ((existMode & S_IFMT) === S_IFDIR) throw new SFSError(EISDIR);
        this.dirRemoveEntry(newParent, newNameBytes);
        this.inodeWriteLock(existingIno);
        this.inodeTruncate(existingIno, 0);
        this.w32(existOff + INO_LINK_COUNT, 0);
        this.inodeWriteUnlock(existingIno);
        this.inodeFree(existingIno);
      }

      // Add entry in new directory
      const rc = this.dirAddEntry(newParent, newNameBytes, srcIno);
      if (rc < 0) throw new SFSError(rc);

      // Remove entry from old directory
      this.dirRemoveEntry(oldParent, oldNameBytes);

      // Update link counts for directory renames
      const srcOff = this.inodeOffset(srcIno);
      const srcMode = this.r32(srcOff + INO_MODE);
      if (
        (srcMode & S_IFMT) === S_IFDIR &&
        oldParent !== newParent
      ) {
        const oldPOff = this.inodeOffset(oldParent);
        this.w32(
          oldPOff + INO_LINK_COUNT,
          this.r32(oldPOff + INO_LINK_COUNT) - 1,
        );
        const newPOff = this.inodeOffset(newParent);
        this.w32(
          newPOff + INO_LINK_COUNT,
          this.r32(newPOff + INO_LINK_COUNT) + 1,
        );
      }
    } finally {
      if (first !== second) this.inodeWriteUnlock(second);
      this.inodeWriteUnlock(first);
    }
  }

  mkdir(path: string, mode: number = 0o755): void {
    const { parentIno, name } = this.pathResolveParent(path);
    const nameBytes = encoder.encode(name);

    this.inodeWriteLock(parentIno);
    try {
      const existing = this.dirLookup(parentIno, nameBytes);
      if (existing >= 0) throw new SFSError(EEXIST);

      const newIno = this.inodeAlloc();
      if (newIno < 0) throw new SFSError(ENOSPC);

      const newOff = this.inodeOffset(newIno);
      this.w32(newOff + INO_MODE, S_IFDIR | mode);
      this.w32(newOff + INO_LINK_COUNT, 2);
      this.w64(newOff + INO_SIZE, 0);
      const now = Date.now();
      this.w64(newOff + INO_ATIME, now);
      this.w64(newOff + INO_MTIME, now);
      this.w64(newOff + INO_CTIME, now);

      // Allocate data block for . and ..
      const blk = this.blockAllocWithGrow();
      if (blk < 0) {
        this.inodeFree(newIno);
        throw new SFSError(ENOSPC);
      }
      this.w32(newOff + INO_DIRECT, blk);

      const dBase = blk * BLOCK_SIZE;
      const dotRecLen = align4(DIRENT_HEADER_SIZE + 1);
      const dotdotRecLen = align4(DIRENT_HEADER_SIZE + 2);

      // "."
      this.w32(dBase, newIno);
      this.view.setUint16(dBase + 4, dotRecLen, true);
      this.view.setUint16(dBase + 6, 1, true);
      this.u8[dBase + DIRENT_HEADER_SIZE] = 0x2e;

      // ".."
      const ddOff = dBase + dotRecLen;
      this.w32(ddOff, parentIno);
      this.view.setUint16(ddOff + 4, dotdotRecLen, true);
      this.view.setUint16(ddOff + 6, 2, true);
      this.u8[ddOff + DIRENT_HEADER_SIZE] = 0x2e;
      this.u8[ddOff + DIRENT_HEADER_SIZE + 1] = 0x2e;

      this.w64(newOff + INO_SIZE, dotRecLen + dotdotRecLen);

      // Add entry in parent
      const rc = this.dirAddEntry(parentIno, nameBytes, newIno);
      if (rc < 0) {
        this.blockFree(blk);
        this.inodeFree(newIno);
        throw new SFSError(rc);
      }

      // Increment parent link count (for "..")
      const pOff = this.inodeOffset(parentIno);
      this.w32(pOff + INO_LINK_COUNT, this.r32(pOff + INO_LINK_COUNT) + 1);
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  rmdir(path: string): void {
    const { parentIno, name } = this.pathResolveParent(path);
    const nameBytes = encoder.encode(name);

    this.inodeWriteLock(parentIno);
    try {
      const childIno = this.dirLookup(parentIno, nameBytes);
      if (childIno < 0) throw new SFSError(childIno);

      const childOff = this.inodeOffset(childIno);
      const mode = this.r32(childOff + INO_MODE);
      if ((mode & S_IFMT) !== S_IFDIR) throw new SFSError(ENOTDIR);

      this.inodeWriteLock(childIno);
      try {
        if (!this.dirIsEmpty(childIno)) throw new SFSError(ENOTEMPTY);

        this.dirRemoveEntry(parentIno, nameBytes);
        this.inodeTruncate(childIno, 0);
        this.w32(childOff + INO_LINK_COUNT, 0);
      } finally {
        this.inodeWriteUnlock(childIno);
      }
      this.inodeFree(childIno);

      // Decrement parent link count
      const pOff = this.inodeOffset(parentIno);
      this.w32(pOff + INO_LINK_COUNT, this.r32(pOff + INO_LINK_COUNT) - 1);
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  symlink(target: string, linkPath: string): void {
    const { parentIno, name } = this.pathResolveParent(linkPath);
    const nameBytes = encoder.encode(name);
    const targetBytes = encoder.encode(target);

    this.inodeWriteLock(parentIno);
    try {
      const existing = this.dirLookup(parentIno, nameBytes);
      if (existing >= 0) throw new SFSError(EEXIST);

      const newIno = this.inodeAlloc();
      if (newIno < 0) throw new SFSError(ENOSPC);

      const newOff = this.inodeOffset(newIno);
      this.w32(newOff + INO_MODE, S_IFLNK | 0o777);
      this.w32(newOff + INO_LINK_COUNT, 1);

      if (targetBytes.length <= INLINE_SYMLINK_SIZE) {
        // Store inline in direct block pointers area
        this.u8.set(targetBytes, newOff + INO_DIRECT);
        this.w64(newOff + INO_SIZE, targetBytes.length);
      } else {
        this.w64(newOff + INO_SIZE, 0);
        const written = this.inodeWriteData(
          newIno,
          0,
          targetBytes,
          targetBytes.length,
        );
        if (written < 0) {
          this.inodeFree(newIno);
          throw new SFSError(written);
        }
      }

      const rc = this.dirAddEntry(parentIno, nameBytes, newIno);
      if (rc < 0) {
        this.inodeFree(newIno);
        throw new SFSError(rc);
      }
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  chmod(path: string, mode: number): void {
    const ino = this.pathResolve(path, true);
    if (ino < 0) throw new SFSError(ino);
    this.inodeWriteLock(ino);
    try {
      const off = this.inodeOffset(ino);
      const oldMode = this.r32(off + INO_MODE);
      this.w32(off + INO_MODE, (oldMode & S_IFMT) | (mode & 0o7777));
      this.w64(off + INO_CTIME, Date.now());
    } finally {
      this.inodeWriteUnlock(ino);
    }
  }

  fchmod(fd: number, mode: number): void {
    const entry = this.fdGet(fd);
    if (!entry) throw new SFSError(EBADF);
    this.inodeWriteLock(entry.ino);
    try {
      const off = this.inodeOffset(entry.ino);
      const oldMode = this.r32(off + INO_MODE);
      this.w32(off + INO_MODE, (oldMode & S_IFMT) | (mode & 0o7777));
      this.w64(off + INO_CTIME, Date.now());
    } finally {
      this.inodeWriteUnlock(entry.ino);
    }
  }

  utimens(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    const ino = this.pathResolve(path, true);
    if (ino < 0) throw new SFSError(ino);
    this.inodeWriteLock(ino);
    try {
      const off = this.inodeOffset(ino);
      const UTIME_NOW = 0x3fffffff;
      const UTIME_OMIT = 0x3ffffffe;
      const now = Date.now();
      if (atimeNsec !== UTIME_OMIT) {
        const atimeMs = atimeNsec === UTIME_NOW ? now : atimeSec * 1000 + Math.floor(atimeNsec / 1_000_000);
        this.w64(off + INO_ATIME, atimeMs);
      }
      if (mtimeNsec !== UTIME_OMIT) {
        const mtimeMs = mtimeNsec === UTIME_NOW ? now : mtimeSec * 1000 + Math.floor(mtimeNsec / 1_000_000);
        this.w64(off + INO_MTIME, mtimeMs);
      }
      this.w64(off + INO_CTIME, now);
    } finally {
      this.inodeWriteUnlock(ino);
    }
  }

  link(existingPath: string, newPath: string): void {
    const srcIno = this.pathResolve(existingPath, true);
    if (srcIno < 0) throw new SFSError(srcIno);
    const srcOff = this.inodeOffset(srcIno);
    const srcMode = this.r32(srcOff + INO_MODE);
    if ((srcMode & S_IFMT) === S_IFDIR) throw new SFSError(EPERM);

    const { parentIno, name } = this.pathResolveParent(newPath);
    const nameBytes = encoder.encode(name);

    this.inodeWriteLock(parentIno);
    try {
      const existing = this.dirLookup(parentIno, nameBytes);
      if (existing >= 0) throw new SFSError(EEXIST);
      const rc = this.dirAddEntry(parentIno, nameBytes, srcIno);
      if (rc < 0) throw new SFSError(rc);
      this.inodeWriteLock(srcIno);
      try {
        const linkCount = this.r32(srcOff + INO_LINK_COUNT);
        this.w32(srcOff + INO_LINK_COUNT, linkCount + 1);
        this.w64(srcOff + INO_CTIME, Date.now());
      } finally {
        this.inodeWriteUnlock(srcIno);
      }
    } finally {
      this.inodeWriteUnlock(parentIno);
    }
  }

  readlink(path: string): string {
    const ino = this.pathResolve(path, false);
    if (ino < 0) throw new SFSError(ino);

    const inoOff = this.inodeOffset(ino);
    const mode = this.r32(inoOff + INO_MODE);
    if ((mode & S_IFMT) !== S_IFLNK) throw new SFSError(EINVAL);

    const size = this.r64(inoOff + INO_SIZE);
    if (size <= INLINE_SYMLINK_SIZE) {
      return safeDecode(
        this.u8.subarray(inoOff + INO_DIRECT, inoOff + INO_DIRECT + size),
      );
    }

    this.inodeReadLock(ino);
    try {
      const buf = new Uint8Array(size);
      this.inodeReadData(ino, 0, buf, size);
      return decoder.decode(buf);
    } finally {
      this.inodeReadUnlock(ino);
    }
  }

  // ── Public API: Directory reading ────────────────────────────────

  opendir(path: string): number {
    const ino = this.pathResolve(path, true);
    if (ino < 0) throw new SFSError(ino);

    const inoOff = this.inodeOffset(ino);
    const mode = this.r32(inoOff + INO_MODE);
    if ((mode & S_IFMT) !== S_IFDIR) throw new SFSError(ENOTDIR);

    const dd = this.fdAlloc(ino, O_RDONLY, true);
    if (dd < 0) throw new SFSError(dd);
    return dd;
  }

  readdirEntry(
    dd: number,
  ): { name: string; stat: StatResult } | null {
    const entry = this.fdGet(dd);
    if (!entry || !entry.isDir) throw new SFSError(EBADF);

    const inoOff = this.inodeOffset(entry.ino);
    const dirSize = this.r64(inoOff + INO_SIZE);

    while (entry.offset < dirSize) {
      const pos = entry.offset;
      const fileBlock = Math.floor(pos / BLOCK_SIZE);
      const blockOff = pos % BLOCK_SIZE;
      const phys = this.inodeBlockMap(entry.ino, fileBlock, false);
      if (phys <= 0) return null;

      const abs = phys * BLOCK_SIZE + blockOff;
      const entIno = this.r32(abs);
      const recLen = this.view.getUint16(abs + 4, true);
      const entNameLen = this.view.getUint16(abs + 6, true);

      if (recLen === 0) return null;

      // Advance offset — update both the SAB (persistent) and the local
      // snapshot so the while loop progresses past deleted entries (entIno=0).
      entry.offset = pos + recLen;
      const base = FD_TABLE_OFFSET + dd * FD_ENTRY_SIZE;
      this.w64(base + FD_OFFSET, pos + recLen);

      if (entIno !== 0) {
        const nameStr = safeDecode(
          this.u8.subarray(
            abs + DIRENT_HEADER_SIZE,
            abs + DIRENT_HEADER_SIZE + entNameLen,
          ),
        );
        return { name: nameStr, stat: this.buildStat(entIno) };
      }
    }

    return null;
  }

  closedir(dd: number): void {
    this.close(dd);
  }

  readdir(path: string): string[] {
    const dd = this.opendir(path);
    const entries: string[] = [];
    try {
      let entry;
      while ((entry = this.readdirEntry(dd)) !== null) {
        if (entry.name !== "." && entry.name !== "..") {
          entries.push(entry.name);
        }
      }
    } finally {
      this.closedir(dd);
    }
    return entries;
  }

  // ── High-level helpers ───────────────────────────────────────────

  writeFile(path: string, data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const fd = this.open(path, O_WRONLY | O_CREAT | O_TRUNC);
    try {
      this.write(fd, bytes);
    } finally {
      this.close(fd);
    }
  }

  readFile(path: string): Uint8Array {
    const fd = this.open(path, O_RDONLY);
    try {
      const st = this.fstat(fd);
      const buf = new Uint8Array(st.size);
      this.read(fd, buf);
      return buf;
    } finally {
      this.close(fd);
    }
  }

  readFileText(path: string): string {
    return decoder.decode(this.readFile(path));
  }
}
