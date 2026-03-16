/**
 * SharedLockTable — SharedArrayBuffer-backed advisory file lock table.
 *
 * Shared across all worker threads so that cross-process fcntl/flock
 * advisory locks are visible to every process (worker).
 *
 * SAB layout (Int32Array view):
 *   Header (16 bytes = 4 x i32):
 *     [0] spinlock       — 0=free, 1=held
 *     [1] count          — number of active lock entries
 *     [2] capacity       — max entries (fixed at creation)
 *     [3] wake_counter   — bumped on every unlock (Atomics.notify for F_SETLKW)
 *
 *   Entries (32 bytes = 8 x i32 each, starting at byte offset 16):
 *     [+0] path_hash     — FNV-1a hash of file path (i32)
 *     [+1] pid           — owning process ID (i32)
 *     [+2] lock_type     — F_RDLCK=0, F_WRLCK=1, F_UNLCK=2 (i32)
 *     [+3] _reserved     — padding (i32)
 *     [+4] start_lo      — lock start offset low 32 bits (i32)
 *     [+5] start_hi      — lock start offset high 32 bits (i32)
 *     [+6] len_lo        — lock length low 32 bits (i32)
 *     [+7] len_hi        — lock length high 32 bits (i32)
 */

const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4; // 16
const ENTRY_INTS = 8;

// Header offsets (Int32Array indices)
const SPINLOCK = 0;
const COUNT = 1;
const CAPACITY = 2;
const WAKE_COUNTER = 3;

// Entry field offsets relative to entry base (Int32Array indices)
const E_PATH_HASH = 0;
const E_PID = 1;
const E_LOCK_TYPE = 2;
// 3 = reserved
const E_START_LO = 4;
const E_START_HI = 5;
const E_LEN_LO = 6;
const E_LEN_HI = 7;

// Lock types (must match crates/shared/src/lib.rs lock_type)
const F_RDLCK = 0;
const F_WRLCK = 1;
const F_UNLCK = 2;

export interface LockInfo {
  pathHash: number;
  pid: number;
  lockType: number;
  start: bigint;
  len: bigint;
}

export class SharedLockTable {
  private view: Int32Array;
  private sab: SharedArrayBuffer;

  private constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.view = new Int32Array(sab);
  }

  static create(capacity: number = 256): SharedLockTable {
    const byteLen = HEADER_BYTES + capacity * ENTRY_INTS * 4;
    const sab = new SharedArrayBuffer(byteLen);
    const table = new SharedLockTable(sab);
    Atomics.store(table.view, SPINLOCK, 0);
    Atomics.store(table.view, COUNT, 0);
    Atomics.store(table.view, CAPACITY, capacity);
    Atomics.store(table.view, WAKE_COUNTER, 0);
    return table;
  }

  static fromBuffer(sab: SharedArrayBuffer): SharedLockTable {
    return new SharedLockTable(sab);
  }

  getBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  // --- Spinlock ---

  private acquire(): void {
    while (Atomics.compareExchange(this.view, SPINLOCK, 0, 1) !== 0) {
      Atomics.wait(this.view, SPINLOCK, 1, 1); // wait 1ms then retry
    }
  }

  private release(): void {
    Atomics.store(this.view, SPINLOCK, 0);
    Atomics.notify(this.view, SPINLOCK, 1);
  }

  // --- Entry helpers (must hold spinlock) ---

  private entryBase(index: number): number {
    return HEADER_INTS + index * ENTRY_INTS;
  }

  private readEntry(index: number): LockInfo {
    const base = this.entryBase(index);
    return {
      pathHash: this.view[base + E_PATH_HASH],
      pid: this.view[base + E_PID],
      lockType: this.view[base + E_LOCK_TYPE],
      start: this.i64FromParts(
        this.view[base + E_START_LO],
        this.view[base + E_START_HI],
      ),
      len: this.i64FromParts(
        this.view[base + E_LEN_LO],
        this.view[base + E_LEN_HI],
      ),
    };
  }

  private writeEntry(index: number, entry: LockInfo): void {
    const base = this.entryBase(index);
    this.view[base + E_PATH_HASH] = entry.pathHash;
    this.view[base + E_PID] = entry.pid;
    this.view[base + E_LOCK_TYPE] = entry.lockType;
    this.view[base + 3] = 0; // reserved
    const [sLo, sHi] = this.i64ToParts(entry.start);
    this.view[base + E_START_LO] = sLo;
    this.view[base + E_START_HI] = sHi;
    const [lLo, lHi] = this.i64ToParts(entry.len);
    this.view[base + E_LEN_LO] = lLo;
    this.view[base + E_LEN_HI] = lHi;
  }

  private removeEntryUnsafe(index: number): void {
    const count = this.view[COUNT];
    if (index < count - 1) {
      // Swap with last entry
      const lastBase = this.entryBase(count - 1);
      const base = this.entryBase(index);
      for (let i = 0; i < ENTRY_INTS; i++) {
        this.view[base + i] = this.view[lastBase + i];
      }
    }
    this.view[COUNT] = count - 1;
  }

  // --- i64 helpers ---

  private i64FromParts(lo: number, hi: number): bigint {
    return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
  }

  private i64ToParts(val: bigint): [number, number] {
    const lo = Number(val & 0xffffffffn);
    const hi = Number((val >> 32n) & 0xffffffffn);
    return [lo, hi];
  }

  // --- Range overlap (matches lock.rs logic) ---

  private static rangesOverlap(
    s1: bigint,
    l1: bigint,
    s2: bigint,
    l2: bigint,
  ): boolean {
    const e1 = l1 === 0n ? BigInt("0x7fffffffffffffff") : s1 + l1;
    const e2 = l2 === 0n ? BigInt("0x7fffffffffffffff") : s2 + l2;
    return s1 < e2 && s2 < e1;
  }

  // --- Conflict detection (matches lock.rs FileLock::conflicts_with) ---

  private static conflicts(
    existing: LockInfo,
    lockType: number,
    start: bigint,
    len: bigint,
    pid: number,
  ): boolean {
    // Same process never conflicts
    if (existing.pid === pid) return false;
    // Check range overlap
    if (!SharedLockTable.rangesOverlap(existing.start, existing.len, start, len))
      return false;
    // Read-read is compatible
    if (existing.lockType === F_RDLCK && lockType === F_RDLCK) return false;
    return true;
  }

  // --- Core API ---

  /**
   * Check if a lock would be blocked. Returns the blocking lock info, or null.
   * (Used for F_GETLK and for F_SETLK conflict check.)
   */
  getBlockingLock(
    pathHash: number,
    lockType: number,
    start: bigint,
    len: bigint,
    pid: number,
  ): LockInfo | null {
    this.acquire();
    try {
      return this._getBlockingLockUnsafe(pathHash, lockType, start, len, pid);
    } finally {
      this.release();
    }
  }

  private _getBlockingLockUnsafe(
    pathHash: number,
    lockType: number,
    start: bigint,
    len: bigint,
    pid: number,
  ): LockInfo | null {
    const count = this.view[COUNT];
    for (let i = 0; i < count; i++) {
      const entry = this.readEntry(i);
      if (entry.pathHash !== pathHash) continue;
      if (SharedLockTable.conflicts(entry, lockType, start, len, pid)) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Set a lock (non-blocking). For F_UNLCK, removes matching locks.
   * Returns true on success, false if conflicting lock exists (EAGAIN).
   */
  setLock(
    pathHash: number,
    pid: number,
    lockType: number,
    start: bigint,
    len: bigint,
  ): boolean {
    this.acquire();
    try {
      return this._setLockUnsafe(pathHash, pid, lockType, start, len);
    } finally {
      this.release();
    }
  }

  private _setLockUnsafe(
    pathHash: number,
    pid: number,
    lockType: number,
    start: bigint,
    len: bigint,
  ): boolean {
    // For unlock: remove overlapping locks from same pid on same path, then wake waiters
    if (lockType === F_UNLCK) {
      let i = 0;
      while (i < this.view[COUNT]) {
        const entry = this.readEntry(i);
        if (
          entry.pathHash === pathHash &&
          entry.pid === pid &&
          SharedLockTable.rangesOverlap(entry.start, entry.len, start, len)
        ) {
          this.removeEntryUnsafe(i);
          // don't increment i — swapped entry now at i
        } else {
          i++;
        }
      }
      // Wake any F_SETLKW waiters
      Atomics.add(this.view, WAKE_COUNTER, 1);
      Atomics.notify(this.view, WAKE_COUNTER);
      return true;
    }

    // Check for conflicts
    if (this._getBlockingLockUnsafe(pathHash, lockType, start, len, pid)) {
      return false; // caller should return EAGAIN
    }

    // Remove overlapping locks from same pid on same path (upgrade/replace)
    let i = 0;
    while (i < this.view[COUNT]) {
      const entry = this.readEntry(i);
      if (
        entry.pathHash === pathHash &&
        entry.pid === pid &&
        SharedLockTable.rangesOverlap(entry.start, entry.len, start, len)
      ) {
        this.removeEntryUnsafe(i);
      } else {
        i++;
      }
    }

    // Add new lock entry
    const count = this.view[COUNT];
    const capacity = this.view[CAPACITY];
    if (count >= capacity) {
      return false; // table full — treat as EAGAIN
    }
    this.writeEntry(count, { pathHash, pid, lockType, start, len });
    this.view[COUNT] = count + 1;
    return true;
  }

  /**
   * Set a lock, blocking until it can be acquired (F_SETLKW).
   * Uses Atomics.wait on wake_counter to sleep between retries.
   */
  setLockWait(
    pathHash: number,
    pid: number,
    lockType: number,
    start: bigint,
    len: bigint,
  ): void {
    while (true) {
      this.acquire();
      const blocker = this._getBlockingLockUnsafe(
        pathHash,
        lockType,
        start,
        len,
        pid,
      );
      if (!blocker) {
        this._setLockUnsafe(pathHash, pid, lockType, start, len);
        this.release();
        return;
      }
      const wakeCount = Atomics.load(this.view, WAKE_COUNTER);
      this.release();
      Atomics.wait(this.view, WAKE_COUNTER, wakeCount, 5000); // wait up to 5s, retry
    }
  }

  /**
   * Remove all locks held by a given pid (cleanup on process exit).
   */
  removeLocksByPid(pid: number): void {
    this.acquire();
    try {
      let i = 0;
      while (i < this.view[COUNT]) {
        const entry = this.readEntry(i);
        if (entry.pid === pid) {
          this.removeEntryUnsafe(i);
        } else {
          i++;
        }
      }
      // Wake any F_SETLKW waiters
      Atomics.add(this.view, WAKE_COUNTER, 1);
      Atomics.notify(this.view, WAKE_COUNTER);
    } finally {
      this.release();
    }
  }

  /**
   * FNV-1a hash of a string, returning a signed i32.
   */
  static hashPath(path: string): number {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < path.length; i++) {
      hash ^= path.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV prime
    }
    return hash | 0; // coerce to signed i32
  }
}
