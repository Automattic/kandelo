# K2 grounding: generalize `host_proc_read_bytes` / `host_proc_write_bytes`

> Read-only grounding pass, 2026-09-09. Worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch
> `brandonpayton/rust-first-abi44-reconcile` (head of PR #1350).
> No code was changed. Every claim below is labelled **VERIFIED** (read in
> this worktree, cited `file:line`) or **INFERRED** (reasoned, not observed).
>
> Companion records: `2026-09-09-rust-first-value-plan.md` (§5 Tier 1 lists
> K2), `2026-09-09-whole-kernel-rust-migration-census.md` §5 ("the recurring
> shape"), `2026-09-09-runtime-ts-disposition-ledger.md` §2.7.

---

## 0. Executive summary

1. **The primitive is sound and already does the hard thing.** The kernel Wasm
   instance *can* read and write a guest process's linear memory today. The
   comments in `crates/shared/src/ioctl_contract.rs:46-52` and
   `crates/runtime-core/src/netif.rs:8-14` that call this "a process-memory
   address the kernel's separate Wasm instance cannot itself reach" are
   **factually wrong** and are the fourth inherited-and-disproved "floor" in
   this campaign. Correcting them is part of K2's work, not a nicety.
2. **The census undercounts the call sites by one.** Seven Rust call sites,
   not six (`syscalls.rs:1465, 1477, 1539, 1545, 1551, 1633, 1639`), plus one
   test double at `syscalls.rs:20168`.
3. **wasm64 is guarded, not broken** — and only by accident of the one caller.
   `addr: u32` is a latent contract ceiling that becomes a real defect the
   moment a second caller appears. Recommended design: **`addr: u64`,
   `len: u32`** (§2.4).
4. **host-native has no wasmtime wall.** Every primitive it needs already
   exists in the file (`mem_base`, `read_bytes`, `write_bytes`,
   `SharedMemory` clones). The real work is a pid → `SharedMemory` registry
   threaded through four process-creation sites. Sized at ~150-200 lines
   including tests (§3).
5. **The ABI ruling is not clean.** The import *signatures* are not in
   `abi/snapshot.json` at all, so widening them produces **no snapshot diff** —
   which means the snapshot check will pass while the kernel↔host contract
   changes underneath it. This is exactly the "necessary but not sufficient"
   case `docs/agent-guidance/abi.md` warns about. **STRONG DOUBT — maintainer
   decision required before landing** (§7).
6. **Tier 1 is right for the primitive and wrong for the promise.** Changing
   the two imports is small and low-risk. "Dissolves ~2,100 lines of
   pre-dispatch marshalling" is K6, and K6 is *not* low-risk: at least two of
   its conversions (msgsnd/msgrcv, sendmsg/recvmsg) carry real POSIX semantic
   decisions and entangle with K3's blocking-retry snapshots (§6.3, §9).
7. **The recommended first proof is `SIOCGIFCONF`, not msgsnd/msgrcv** (§6).

---

## 1. The current contract, end to end (VERIFIED)

### 1.1 Import declarations — `crates/kernel/src/wasm_api.rs:251-252`

```rust
fn host_proc_write_bytes(pid: i32, addr: u32, src_ptr: *const u8, len: u32) -> i32;
fn host_proc_read_bytes(pid: i32, addr: u32, dst_ptr: *mut u8, len: u32) -> i32;
```

`src_ptr`/`dst_ptr` are **kernel** addresses and therefore compile to `i32` on
a wasm32 kernel and `i64` on a wasm64 kernel; `addr` is a **guest** address
fixed at 32 bits regardless of either width. That asymmetry is the whole of
§2.

### 1.2 Trait methods — `crates/runtime-core/src/process.rs:360-371`

```rust
fn proc_write_bytes(&mut self, pid: i32, addr: u32, src: &[u8]) -> i32 { 0 }

/// Copy `dst.len()` bytes from the wasm process at `pid`'s linear
/// memory at `addr` into the kernel-side scratch `dst`. Returns 0 on
/// success, negative errno on failure.
fn proc_read_bytes(&mut self, pid: i32, addr: u32, dst: &mut [u8]) -> i32 { 0 }
```

**Both defaults return `0` — success — while copying nothing.** For
`proc_read_bytes` that hands the caller a zero-filled buffer and reports
success. Any `HostIO` implementor that does not override these silently
fabricates data. That is a live violation of the platform-values contract
("Prefer truthful failure over convenient illusion"), latent today only
because the sole production implementor overrides both. The correct default
is `-(Errno::ENOSYS as i32)`, matching the neighbouring `gl_query` default
at `process.rs:350-352`.

### 1.3 Production implementor — `crates/kernel/src/wasm_api.rs:1113-1119`

A thin `unsafe` forward. `WasmHostIO` (`wasm_api.rs:318`) is the only
production implementor of the 83-method `HostIO` trait.

### 1.4 The seven Rust call sites — all DRI/KMS

| site | direction | payload |
|---|---|---|
| `syscalls.rs:1465` | read | `GLIO_QUERY` input buffer (`info.in_buf_ptr`, ≤ `gl::MAX_QUERY_IN_LEN`) |
| `syscalls.rs:1477` | write | `GLIO_QUERY` output buffer |
| `syscalls.rs:1539` | write | `DRM_IOCTL_MODE_GETRESOURCES` `crtc_id_ptr` (4 bytes) |
| `syscalls.rs:1545` | write | ditto, `connector_id_ptr` |
| `syscalls.rs:1551` | write | ditto, `encoder_id_ptr` |
| `syscalls.rs:1633` | write | `MODE_GETCONNECTOR` `modes_ptr` (a `WpkDrmModeModeinfo`) |
| `syscalls.rs:1639` | write | ditto, `encoders_ptr` (4 bytes) |

All seven pass `proc.pid` — i.e. **the currently dispatching process**. No
call site targets a peer process. This matters for §4.

`syscalls.rs:20168` is a test-double override.

### 1.5 The TypeScript bodies — `host/src/kernel.ts:2416-2483`

**Write (`host_proc_write_bytes`, kernel → guest), `kernel.ts:2416-2450`:**

1. `procMem = this.callbacks.getProcessMemory?.(pid)`; `undefined` → `-14`
   (`EFAULT`).
2. `checkedWasmImportMemoryRange(procMem, addr, len, 4, …)` — validate the
   guest range.
3. `src = this.#readKernelBytes(src_ptr, len)` — copy out of kernel memory
   (range-checked against `this.#memory` at `this.#kernelPtrWidth`,
   `kernel.ts:2540-2557`).
4. **Re-validate** the guest range: *"Reacquire the process buffer after
   copying the kernel source: another process worker may have grown it in the
   meantime."* (`kernel.ts:2432-2434`).
5. `Uint8Array.prototype.set` into a fresh full-buffer view.
6. Any throw → `catch { return -14 }`.

**Read (`host_proc_read_bytes`, guest → kernel), `kernel.ts:2452-2483`:**

1. **First**, prove the destination: `this.#rustLentKernelDestination(dst_ptr,
   len, …)` — *"Prove the Rust-owned destination before reading caller bytes
   so an invalid kernel range cannot consume a source operation."*
2. `getProcessMemory(pid)`; `undefined` → `-14`.
3. `checkedWasmImportMemoryRange(procMem, addr, len, 4, …)`.
4. Build a view, `sliceUint8Array` it (**a copy**, not a live view).
5. `this.#writeKernelBytes(destination, copy)`.
6. Any throw → `catch { return -14 }`.

### 1.6 What proves the destination is kernel-owned

`#rustLentKernelDestination` (`kernel.ts:2567-2599`) is the ownership proof,
and it is stronger than a range check:

- It range-checks `(dst_ptr, capacity)` against `this.#memory` at the
  **kernel's** pointer width.
- It returns a frozen, `unique symbol`-branded token carrying only
  `capacity`; the pointer never appears on the object.
- The real record lives in a module-private `WeakMap`
  (`rustLentKernelDestinationRecords`, `kernel.ts:259`) binding
  `{ owner, generation, memory, pointer, capacity, label, consumed }`.
- `#writeKernelBytes` (`kernel.ts:2609-2650`) rejects unless `owner === this`
  **and** `generation === this.#memoryGeneration` **and** `memory ===
  this.#memory` **and** `!consumed`; re-checks the range (memory may have
  grown); enforces `exactLength <= range.length`; and sets `consumed = true`
  **before** the copy so a nested or retried import cannot partially rewrite
  bytes a completed import already exposed.

Stated as the doc comment does: *"fitting in the current WebAssembly Memory
proves only addressability, not ownership."*

**Deliberate asymmetry (VERIFIED, and correct):** the *write* direction's
kernel-side **source** goes through `#readKernelBytes`, which is only
range-checked, not ownership-proved. Reading kernel bytes is not a capability
escalation; writing them is.

### 1.7 Range validation mechanics

`checkedWasmImportMemoryRange` (`host/src/kernel-scratch.ts:1113-1143`)
→ `checkedWasmGuestPointerOffset` (`host/src/wasm-guest-pointer.ts:26-60`)
→ `checkedMemoryRange` (`kernel-scratch.ts:1084-1104`)
→ `checkedRange` (`kernel-scratch.ts:1059-1073`).

Properties enforced:

- A memory32 pointer arrives at JS as a **signed** `i32`; width 4 normalizes
  with `value >>> 0`, so guest addresses ≥ 2 GiB are handled correctly
  (`wasm-guest-pointer.ts:44`).
- Rejects any address that is not exactly representable as a JS safe integer
  (`wasm-guest-pointer.ts:56-58`).
- Rejects `pointer === 0 && length !== 0` unless `allowAddressZero`
  (`kernel-scratch.ts:1094`) — neither `host_proc_*` call passes it.
- `end = pointer + length` must be a safe integer, `>= pointer`, and
  `<= buffer.byteLength` **of the current buffer**
  (`kernel-scratch.ts:1068-1071`).

### 1.8 Existing test coverage

`host/test/kernel-public-scratch.test.ts:1075-1160` — three cases: an
unrepresentable length → `-14`; a null process pointer with positive length →
`-14` in both directions **with the target bytes unchanged**; and exact
end-of-memory boundaries (`processEnd - 4` with `len` 4 succeeds, `len` 5 →
`-14`). `host/test/kernel-scratch-contract.test.ts:1511` pins the
`#rustLentKernelDestination` call for `host_proc_read_bytes` as a reviewed
contract site.

**No test exercises a wasm64 process, a mid-copy grow, or a concurrent
writer.** (VERIFIED by grep across `host/test`.)

---

## 2. The wasm64 gap

### 2.1 What happens today (VERIFIED)

**Guarded, not broken — but only because of the single caller.** Every one of
the seven Rust call sites narrows a `u64` guest pointer to `u32` through
`checked_dri_process_pointer` (`syscalls.rs:1040-1042`):

```rust
fn checked_dri_process_pointer(pointer: u64) -> Result<u32, Errno> {
    u32::try_from(pointer).map_err(|_| Errno::EFAULT)
}
```

and `syscalls.rs:1527-1529` documents the ordering rule: *"Validate every
nested address before the first write so a later unrepresentable wasm64
pointer cannot leave earlier outputs partially updated."* A wasm64 guest
handing DRI an address above 4 GiB gets `EFAULT` — a truthful failure, not a
silent truncation.

### 2.2 Why nothing is observably broken yet (VERIFIED + INFERRED)

- `PROCESS_MEMORY_DEFAULT_MAX_PAGES = 16384` (`host/src/generated/abi.ts:925`,
  `crates/shared/src/lib.rs:1925`, `abi/snapshot.json → process_memory_layout
  .defaults.max_pages`) = **1 GiB**. Every guest address fits in `u32` at the
  default. (VERIFIED)
- `maxPages` is host-configurable (`browser-kernel-host.ts:279`,
  `node-kernel-host.ts:413`) and `computeProcessMemoryLayout`
  (`host/src/process-memory.ts:224-226`) validates only
  `Number.isInteger(maximumPages) && maximumPages > CHANNEL_PAGES` — **no
  upper bound**. A host configuring > 65 536 pages for a wasm64 guest creates
  addresses the contract cannot express. (VERIFIED)
- host-native runs **wasm32 guests only** (`crates/host-native/src/guest.rs:
  563-566`: *"native wasm32 guests only, per this file's module doc
  comment"*). Browser workers likewise: *"Only the wasm32 module ships in the
  browser; wasm32 is the guest width"*
  (`browser-kernel-worker-entry.ts:156-158`). wasm64 guests are real but
  Node-host and narrow (`programs/wasm64/mariadb-vfs.vfs.zst`,
  `binary-resolver.ts:204`; `hello64.wasm` per
  `docs/agent-guidance/validation.md`). (VERIFIED)

### 2.3 The defect the generalization creates

Two things break the moment a second caller appears:

1. **The TS bodies hardcode pointer width 4** for the guest range check
   (`kernel.ts:2427`, `2469`). That is *currently* consistent — the Rust
   signature is `u32`, so the value genuinely is 32-bit. It stops being
   consistent the instant `addr` widens, and it is already inconsistent with
   every other guest-address path in the host, all of which resolve width per
   process via `getPtrWidth(pid)` (`kernel-worker.ts:10907-10913`) — see
   `checkedProcessRange` (`kernel-worker.ts:5814-5840`) and
   `checkHandwrittenProcessAddressArguments` (`kernel-worker.ts:5853-5900`),
   whose own comment is the exact warning: *"publish the same
   already-validated physical bits there or a wasm64 address above 4 GiB would
   still alias its low i32."*
2. **`checked_dri_process_pointer` is a per-call-site guard, not a contract
   guard.** A new K6 call site that forgets it truncates silently.

### 2.4 Recommended 64-bit design

**`fn host_proc_read_bytes(pid: i32, addr: u64, dst_ptr: *mut u8, len: u32) -> i32`**
(and the write mirror). `HostIO` becomes
`fn proc_read_bytes(&mut self, pid: i32, addr: u64, dst: &mut [u8]) -> i32`.

Rationale:

- **`addr: u64`, one signature for both guest widths.** The guest address
  space is what varies; a per-width import pair would grow the host surface
  and violate V4. The host normalizes against the *target process's* actual
  width (`getPtrWidth(pid)` on the TS side), which is the same rule every
  other guest-pointer path already follows.
- **`len: u32`, not `usize`.** `len` bounds a **kernel-side** buffer, and the
  kernel's own memory is capped at 1 GiB (`.cargo/config.toml`,
  `--max-memory=1073741824`, both wasm32 and wasm64 target blocks). A `u32`
  length is provably sufficient, keeps the JS value a `number` rather than a
  `bigint` on the common path, and makes the "which side owns this number"
  question unambiguous in the signature itself.
- `checked_dri_process_pointer` then has no callers and is deleted; the
  narrowing check moves into the host body where it belongs (validate against
  the process's real buffer length, which subsumes the 4 GiB question).

**Rejected alternatives**, recorded so they are not relitigated:

- *Keep `u32`, add `host_proc_read_bytes64`.* Grows the surface; V4 forbids.
- *Drop `pid` and use "the currently dispatching process" implicitly* (the
  host already tracks it: `currentHandlePid` in `kernel-worker.ts`,
  `current_pid`/`current_memory` in `host-native/src/guest.rs:988`,
  `8986-8993`). Fewer args, but an implicit contract — precisely the
  "collapsing thirty imports behind one opaque call would score brilliantly
  while making the contract unimplementable" failure the census warns against
  (`census §1`). Keep `pid` explicit.

**Cost of `addr: u64` on the hot path (INFERRED, unmeasured):** an `i64`
parameter reaches a JS import as a `BigInt`. Today that cost is paid only by
DRI. Once K6 routes real syscalls through this primitive it lands in the
syscall hot path. `docs/agent-guidance/performance.md` and the value plan's
own risk 3 make this a measure-before-claiming obligation. See
**NEEDS-DEFER-DECISION #3**.

---

## 3. host-native: what a native implementation actually requires

### 3.1 Current state (VERIFIED)

- `crates/host-native/src/guest.rs` implements **19 distinct `host_*` imports**
  (`host_blob_read, host_clock_gettime, host_close, host_closedir,
  host_debug_log, host_fstat, host_futex_wake, host_getrandom, host_lstat,
  host_open, host_opendir, host_pread, host_read, host_readdir, host_readlink,
  host_seek, host_stat, host_waitpid, host_write`) out of
  `EXPECTED_HOST_IMPORT_COUNT = 84` (`lib.rs:77`, asserted at `lib.rs:414`).
- `host_proc_read_bytes` / `host_proc_write_bytes` are **not among them** and
  fall to `linker.define_unknown_imports_as_traps` (`guest.rs:1010`,
  `lib.rs:200`). Calling either from native traps the kernel — a truthful
  boundary, and the correct current behaviour.

### 3.2 How host-native reaches guest memory (VERIFIED — no wasmtime wall)

Every needed primitive already exists in the file:

- `mem_base(mem: &SharedMemory) -> *mut u8` (`guest.rs:507-509`), with the
  soundness argument stated at `guest.rs:501-505`: *"`SharedMemory`
  pre-reserves its maximum virtual size, so the base pointer is stable across
  `grow`, and the memory is `Send + Sync`, so both the kernel thread (pump)
  and the guest thread read/write it without a `Store` borrow."*
- `read_bytes` / `write_bytes` (`guest.rs:512-519`) — exactly the two copies
  needed.
- Bounds pattern already in use: `mem.data().len()` as the live extent
  (`read_guest_cstring`, `guest.rs:553-562`).
- `SharedMemory` is `Clone`, so a registry can hold owned handles with no
  `Store` borrow and no lifetime entanglement. `host_futex_wake`
  (`guest.rs:1685-1700`) already reaches into **guest** memory from an import
  closure by exactly this route.

**Conclusion: there is no wasmtime wall.** (VERIFIED for the mechanism;
INFERRED that no further wasmtime API is needed, since the two imports need
nothing `host_futex_wake` does not already do.)

### 3.3 The real work: a pid → memory registry

The import closures are built once in `define_kernel_host_imports`
(`guest.rs:1659-1668`), *before* the pump loop that owns
`processes: Vec<GuestProcess>` (`guest.rs:1304`, `9243`). The closures cannot
see that `Vec`. Today they reach the *current* process through two shared
cells set by `bind_and_dispatch` (`guest.rs:8986-8993`):

```rust
*current_memory.lock().unwrap() = guest_mem.clone();
*current_pid.lock().unwrap()    = pid;
```

A `pid`-taking import needs a `pid`-keyed map. Concretely:

1. Add `proc_memories: Arc<Mutex<HashMap<u32, SharedMemory>>>` alongside
   `current_memory` (`guest.rs:981`), and pass it into
   `define_kernel_host_imports`.
2. Register at process creation — **four sites**: the boot process
   (`guest.rs:~1304`, where `processes` is first built) and the three
   `processes.push(child)` sites (`guest.rs:10108`, `10376`, `10460` —
   spawn, fork, and the third child path).
3. Update on `execve` success, where a process's memory is replaced.
   (INFERRED that exec replaces it; `handle_exec_common` builds a new image.
   **Must be confirmed against the exec path when implementing** — a stale
   registry entry here is a silent wrong-memory write, the single most
   dangerous failure mode of this change.)
4. Remove on exit/teardown, so a recycled pid cannot resolve to a dead
   memory.
5. Two `func_wrap` closures that resolve `pid` → `SharedMemory`, bounds-check
   `addr + len` against `mem.data().len()`, bounds-check the kernel-side
   pointer against `kernel_mem.data().len()`, and copy. Return `-EFAULT` on
   every failure, matching the TS bodies' `-14`.

**Size (INFERRED): ~150-200 lines including tests.** Roughly 60 lines of
registry plumbing, ~60 lines for the two closures, ~60-80 lines of tests.
`EXPECTED_HOST_IMPORT_COUNT` does **not** change (implementing an existing
import does not add one); the ratchet's changelog comment at `lib.rs:60-77`
should still record the coverage change.

**Testability:** `crates/host-native` has no `tests/` directory — all tests
are inline `#[cfg(test)]` (`Cargo.toml` lists only `wat` as a dev-dependency).
Factor the copy into free functions (`proc_copy_out`, `proc_copy_in`) taking
`&SharedMemory` so they are unit-testable without instantiating the kernel,
then add one end-to-end case once a real caller exists (§8, Increment 2).

---

## 4. Safety invariants the contract must guarantee

### 4.1 Enumerated (VERIFIED unless marked)

| # | invariant | enforced today by | after generalization |
|---|---|---|---|
| S1 | Kernel-side **destination** is a Rust-owned allocation of the declared capacity, in this exact kernel generation, written at most once | `#rustLentKernelDestination` + `#writeKernelBytes` WeakMap record (`kernel.ts:2567-2650`) | unchanged; host-native needs an equivalent bound (kernel-memory range check — it has no generation concept) |
| S2 | Kernel-side **source** is within the kernel's current memory | `#readKernelBytes` (`kernel.ts:2540-2557`) | unchanged |
| S3 | Guest range is within the target process's **current** buffer, non-null for positive length, exactly representable | `checkedWasmImportMemoryRange` (`kernel-scratch.ts:1113`) | must use `getPtrWidth(pid)`, not the hardcoded `4` |
| S4 | Target process exists | `getProcessMemory(pid) === undefined → -14` | must also survive pid reuse (§4.3) |
| S5 | Guest memory may **grow** between the two halves of a copy | write path re-validates after reading kernel bytes (`kernel.ts:2432-2440`) | must be preserved; the read path does not need it (single acquisition) |
| S6 | The import must not re-enter the kernel | both bodies call no kernel export (VERIFIED by reading them) | must hold for host-native too — `host_waitpid`'s comment (`guest.rs:2185-2199`) states the same rule for the same reason |
| S7 | Kernel and guest memories never alias | distinct `WebAssembly.Memory` / `SharedMemory` objects by construction (INFERRED, but structurally guaranteed) | unchanged |
| S8 | Failure is reported, never fabricated | `catch → -14` in TS; trap in host-native | **`HostIO`'s `{ 0 }` defaults violate this** (§1.2) — fix to `-ENOSYS` |

### 4.2 Concurrent mutation — the invariant that must be *stated*, not enforced

Guest process memory is a `SharedArrayBuffer` (browser/Node) or a wasmtime
`SharedMemory` (native). Another thread of the same process — a pthread, or
the guest's own main thread if the copy happens outside a channel round-trip —
can write those bytes **during** the copy. Neither host serializes against it,
and neither can: there is no lock a Wasm kernel can take over a peer's linear
memory.

Therefore the contract must say, explicitly:

> **The copy is not atomic.** A concurrent writer may tear it at any
> granularity. A successful return means "`len` bytes were transferred", never
> "`len` bytes were transferred as a consistent snapshot".

And the kernel-side consequence, which is the load-bearing rule for K6:

> **Copy once into kernel-owned memory, then parse. Never validate a value in
> guest memory and re-read it afterwards.** Any length, count, index, or
> nested pointer the kernel reads out of guest memory must be validated
> *against the copy it will actually use*, not against a second read.

This is not hypothetical: the pre-dispatch marshalling K6 replaces is full of
exactly these reads — `handleIoctlIfconf` reads `ifc_len` and `ifc_buf` from
guest memory and then uses `ifc_len` to size a write back into guest memory
(`kernel-worker.ts:20207-20255`). Done naively in the kernel, that is a
classic TOCTOU. Done correctly (one `proc_read_bytes` of the outer struct,
then parse the copy), it is safe.

Linux has the same property and the same rule: `copy_from_user` into kernel
memory, then operate on the kernel copy. Kandelo inherits both.

The existing `Uint8Array.prototype.set` / `copy_nonoverlapping` copies are
byte-wise and non-atomic; **they must not be represented as providing any
ordering or tearing guarantee.** (VERIFIED for the mechanism; the
*characterisation* is INFERRED from the spec's memory model, not measured.)

### 4.3 Generation and liveness of the target process

Today every caller passes `proc.pid` — the process the kernel is
synchronously dispatching for — so the target is live by construction and no
exec or exit can interleave (INFERRED, but follows from S6: the import cannot
re-enter the kernel, and the host's dispatch is synchronous inside
`kernel_handle_channel`).

Generalization should **preserve that restriction as a written contract
term**: *the only sound target is the process currently being dispatched
for.* If a future caller needs a peer process's memory (none of K6's
conversions do — msgsnd, msgctl, semctl, ifconf, sendmsg/recvmsg all touch
caller memory only), that is a separate contract change with its own liveness
proof, not an incidental widening.

The host side already has partial protection: `kernel-worker.ts` re-checks
`registration.memory !== expectedMemory` at ten sites (e.g. `8282`, `8599`,
`8641`, `9748`, `10507`) precisely because a pid's memory identity can change.
`getProcessMemory` (`kernel-worker.ts:31148`) performs **no such check** —
it is a bare `this.processes.get(pid)?.memory`. That is fine under the
caller-only restriction and unsound without it.

### 4.4 Errno honesty (VERIFIED — minor, worth fixing in the same change)

`catch { return -14 }` collapses every failure to `EFAULT`, including
`"Kernel not initialized"` (`kernel.ts:2541`, `2568`) and a stale/consumed
destination token (`kernel.ts:2620-2624`). `EFAULT` is the right answer for a
bad guest address; it is the wrong answer for a broken kernel invariant, which
should be fatal, not an errno. Recommend: let non-range errors propagate as
they do elsewhere in `#buildImportObject`, and return `-EFAULT` only for
range/liveness failures.

---

## 5. Scale: how large may a single transfer be?

### 5.1 The bounded scratch channel today (VERIFIED)

`CH_DATA_SIZE = 65536` (`abi/snapshot.json → host_adapter.manifest
.channel_data_size`; `host/src/kernel-worker.ts:98, 657`). Every pre-dispatch
marshalling path checks against it and fails the syscall when exceeded:

- SysV message: `scratchBytes > CH_DATA_SIZE → EINVAL`
  (`kernel-worker.ts:33524-33532`, *"SysV message exceeds bounded kernel
  transport"*).
- msgctl/shmctl: `transferBytes > CH_DATA_SIZE → EIO`
  (`kernel-worker.ts:33810-33823`).
- semctl: same shape (`kernel-worker.ts:33990-33997`).
- read/write: `> CH_DATA_SIZE` diverts to the large-transfer path
  (`kernel-worker.ts:6091`, `12221`, `12228`).

### 5.2 The large-transfer path (VERIFIED)

`#beginLargeTransferScratch` (`kernel-worker.ts:20540-20613`) calls four
kernel exports — `kernel_transfer_scratch_begin` / `_pointer` / `_capacity` /
`_cancel` — to obtain a **kernel-side** region larger than the channel, wraps
it in a `reserveKernelScratchRegion` lease bound to the exact kernel
generation, and `#executeReservedScratchTransfer` (`kernel-worker.ts:20823`)
drives the copy. `#executeMainScratchTransfer` (`kernel-worker.ts:20451`)
handles the `<= CH_DATA_SIZE` case; the selection is at
`kernel-worker.ts:20995-21003`.

### 5.3 What changes with direct cross-memory access

**The `CH_DATA_SIZE` limit does not apply to K2 at all.** When the kernel
reads guest memory itself, the destination is an ordinary kernel allocation
(`alloc::vec![0u8; n]`, as at `syscalls.rs:1461`), bounded only by the
kernel's own memory: `--max-memory=1073741824` = **1 GiB**
(`.cargo/config.toml`, both target blocks). Every K6 conversion therefore
*removes* an artificial 64 KiB cliff rather than inheriting one.

Two consequences worth naming:

- **A POSIX-correctness improvement falls out for free.** The SysV message
  path's `EINVAL` at 64 KiB is a host-transport artefact, not a POSIX errno.
  It is invisible today only because the kernel's own `MSGMNB = 16384`
  (`crates/runtime-core/src/ipc.rs:42`) binds first — but the queue limit is
  `msgctl(IPC_SET)`-adjustable up to `u32` for uid 0 (`ipc.rs:921`,
  `1859-1864`), at which point the host cliff becomes reachable and returns
  the wrong errno. (VERIFIED for the constants; INFERRED that the path is
  reachable — not exercised.)
- **A new bound must be chosen deliberately.** "Unbounded" is not the answer:
  a guest-supplied length must not let the kernel allocate 1 GiB. Every K6
  conversion should keep the kernel's *POSIX* limit as the bound (`MSGMNB`
  for msgsnd, `SEMVMX`/array size for semctl, `ifc_len` for ifconf) and
  reject beyond it with the *POSIX* errno.

### 5.4 Does the large-transfer machinery become unnecessary?

**No — and the plan should not claim it does.** Its remaining justification
narrows but does not vanish:

- **Removed for pre-dispatch marshalling:** the kernel allocates its own
  buffer; no host-visible reservation is needed.
- **Retained for host-byte-source/sink staging:** `host_read(handle, buf_ptr,
  len)` and `host_write(handle, buf_ptr, buf_len)` write into and read from
  **kernel** memory. A large `read(2)`/`write(2)` still needs a kernel-side
  region bigger than the channel for the host to fill or drain. Eliminating
  *that* would require changing the byte-transfer imports themselves to target
  guest memory — a different contract change, arguably part of K9
  (handle-only contract), and out of K2's scope.

Recommended framing for the plan: *K2 removes the bounded-channel limit from
pre-dispatch marshalling; it does not retire `kernel_transfer_scratch_*`.*

---

## 6. Proof target: `SIOCGIFCONF` beats msgsnd/msgrcv

### 6.1 What the plan proposes

`handleSysvMessage` (`kernel-worker.ts:33492-33765`, **274 lines**) against
`crates/runtime-core/src/ipc.rs`.

### 6.2 Recommendation: prove it on `SIOCGIFCONF` first

`handleIoctlIfconf` (`kernel-worker.ts:20189-20286`, **98 lines**) is a
strictly better first proof, on six counts:

1. **The codebase already documents it as the exact gap K2 closes — and
   documents it as a floor that isn't one.**
   `crates/shared/src/ioctl_contract.rs:46-52`:
   > *"`SIOCGIFCONF` is deliberately absent: its `struct ifconf.ifc_buf` is a
   > second, dynamically-sized process-memory pointer nested inside the first,
   > which this table's one-static-size-per-request model cannot express. The
   > host still decodes that outer pointer …"*

   `crates/runtime-core/src/netif.rs:8-14`:
   > *"the host retains only the two things it alone can do: — dereferencing
   > the caller's `struct ifconf.ifc_buf` pointer (a process-memory address
   > **the kernel's separate Wasm instance cannot itself reach** …)"*

   That parenthetical is **false**: `host_proc_write_bytes` reaches exactly
   there, from `syscalls.rs`, today. Closing this path both proves K2 and
   corrects a wrong statement of the platform's boundary — the value plan's
   *"Pattern worth naming: three 'floors' have now been inherited and
   disproved"* gains a fourth.

2. **No blocking, no retry snapshot.** `ioctl` never returns `EAGAIN` here;
   `handleIoctlIfconf` has no `BlockingRetrySnapshot`. msgsnd/msgrcv do
   (`SysvMessageBlockingRetrySnapshot`, `#rememberBlockingRetrySnapshot`,
   `kernel-worker.ts:33670-33690`), which entangles the proof with K3.

3. **The Rust side is already written and already has the host handle.**
   `netif::ifconf_write(pointer_width, out, host)`
   (`crates/runtime-core/src/netif.rs:152-169`) already takes
   `&mut dyn HostIO`. It needs the guest pointer, nothing more.

4. **It is a *nested* pointer — the case the bounded channel structurally
   cannot express.** Proving K2 here proves the general claim; proving it on a
   flat buffer proves only the easy half.

5. **It deletes hand-maintained wasm32/wasm64 offset pairs, which is V2's
   literal definition of done.** `handleIoctlIfconf` carries `pw === 8 ? 16 :
   8` (`:20195`), `getBigUint64(ifconfPtr + 8)` vs
   `getUint32(ifconfPtr + 4)` (`:20211-20213`) — the exact "hand-maintained
   wasm32/wasm64 offset pairs" §8's V2 criterion names.

6. **It is a clean V4 subtraction.** Three kernel exports become unnecessary:
   `kernel_network_ifconf_size` (`wasm_api.rs:11646`),
   `kernel_network_ifreq_size` (`wasm_api.rs:11625`), and
   `kernel_network_ifconf_write` (`wasm_api.rs:11661`, in
   `abi/snapshot.json:2660`) — feeding K13b directly.

**Cost:** `SIOCGIFCONF` must be added to `IOCTL_REQUEST_CONTRACTS`
(`crates/shared/src/ioctl_contract.rs:166-169` — currently commented
"deliberately absent") as `pointer!(SIOCGIFCONF, InOut, 8, 16)`, and the two
host special-cases removed (`kernel-worker.ts:6082-6085` and
`12244-12257`). That **does** change `abi/snapshot.json`
(`ioctl_request_contracts` gains key `34578`) — additively. See §7.

### 6.3 Why msgsnd/msgrcv should be third, not first

Beyond the K3 entanglement, msgsnd carries a **real POSIX semantic decision**
that must be made deliberately:

Today the host copies the message out of guest memory **once, at first
attempt**, and retains it in the retry snapshot (`snapshot.input`,
`kernel-worker.ts:33540-33543, 33571`). Every `EAGAIN` retry re-uses that
copy. If the kernel instead reads guest memory at dispatch time, a retried
msgsnd would read **current** guest memory — copy-at-success rather than
copy-at-entry.

Linux's `do_msgsnd` calls `load_msg()` *before* entering its wait loop, i.e.
copy-at-entry, matching today's behaviour. A naive K6 conversion silently
changes it. The correct conversion is: **the kernel performs the guest read
once, on the first dispatch, and retains the message in kernel state across
`EAGAIN`** — which is a change to `ipc.rs`'s blocking structure, not a
mechanical marshalling move.

**Recommended proof order** (each independently landable):

| order | target | lines removed | why here |
|---|---|---|---|
| 1 | `SIOCGIFCONF` (`handleIoctlIfconf`) | 98 + 2 special-cases | nested pointer, no blocking, Rust side done, corrects a false floor comment |
| 2 | `handleIpcControl` (msgctl/shmctl `IPC_SET`/`IPC_STAT`) | 159 | fixed-size, non-blocking, size already computed by a kernel export; retires `kernel_msqid_ds_bytes`/`kernel_shmid_ds_bytes` |
| 3 | `handleSemctl` (`GETALL`/`SETALL`) | 172 | same shape; retires `kernel_semctl_array_bytes` |
| 4 | `handleSysvMessage` | 274 | **needs the copy-at-entry decision above** |
| 5 | `handleSendmsg` / `handleRecvmsg` | 306 + 420 | largest, nested `msghdr` + control messages + socket blocking; properly K6 |

Named handler totals: **1,429 lines** (measured by LSP-style method-span scan
over `kernel-worker.ts`). The census's *"~2,100"* additionally counts mqueue
paths (`kernel-worker.ts:12369-12470`), the retry-snapshot types
(`:2148-2175`), and the routing in `#handleSyscallInner`. Both figures are
defensible; the 1,429 is the directly-attributable, method-scoped count.

---

## 7. ABI impact — **STRONG DOUBT, maintainer decision required**

### 7.1 The governing rules, quoted

`docs/agent-guidance/abi.md`:

> *"Every incompatible ABI change requires an `ABI_VERSION` bump in
> `crates/shared/src/lib.rs` and a regenerated `abi/snapshot.json` in the same
> change."*

> *"A structural additive change may keep the same `ABI_VERSION` only when
> existing binaries remain valid and existing ABI entries are unchanged.
> Additions still require regenerating and committing `abi/snapshot.json`."*

> *"The snapshot check is necessary but not sufficient. It catches structural
> drift covered by `xtask dump-abi`; it does not prove semantic compatibility.
> Changing an existing syscall's meaning, errno behavior, blocking behavior,
> fd inheritance, memory ownership, or pointer interpretation can require an
> ABI bump even if the snapshot is unchanged."*

`docs/abi-versioning.md` restates the same and adds that CI *"refuses no-bump
snapshot changes unless they are narrowly additive."*

Workflow (`abi.md`), which is also the answer to "never hand-edit":

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
bash scripts/check-abi-version.sh
```

`scripts/check-abi-version.sh:16-18, 50-56` — `update` regenerates in place
via `cargo run -p xtask -- dump-abi`; `check` fails on drift.

### 7.2 The facts (VERIFIED)

- **`env.host_*` import signatures are not in `abi/snapshot.json`.**
  `grep -c host_open abi/snapshot.json` → **0**. The `host_adapter` key holds
  only the channel manifest and the kernel *export* lists. **Widening
  `host_proc_read_bytes`/`host_proc_write_bytes` produces no snapshot diff at
  all.**
- The only structural guard on the import surface is
  `EXPECTED_HOST_IMPORT_COUNT = 84` (`crates/host-native/src/lib.rs:77`,
  asserted `lib.rs:414`) — a **count**, not a signature check. It would not
  move.
- `ABI_VERSION = 44` (`crates/shared/src/lib.rs:120`) exists **only on this
  branch**: `main` is at 43 (`git show main:crates/shared/src/lib.rs:114`).
  ABI 44 is unreleased and in-dev. The value plan's decision 1 states the
  whole campaign is one ABI epoch.
- The §6.2 proof target additionally makes a **real** snapshot change:
  `ioctl_request_contracts` gains an entry, and `kernel_exports` loses three.
  Entry addition is additive; **export removal is not** — it changes the
  `required_kernel_exports` list an existing host validates against.

### 7.3 Reading

**INFERRED, and the reason this is flagged rather than answered:**

1. The signature widening alone is *foldable into in-dev ABI 44* on the
   letter of the rule — no released binary depends on it, `abi/snapshot.json`
   does not describe it, and the campaign is explicitly one epoch.
2. But it changes **pointer interpretation** in a kernel↔host contract, which
   `abi.md` names verbatim as a case that *"can require an ABI bump even if
   the snapshot is unchanged."*
3. And it is a change the snapshot check **cannot see**. Landing it under a
   green `check-abi-version.sh` and calling that validation would be exactly
   the "narrow check supporting a broad claim" the validation contract
   forbids.

**Recommendation:** land it inside ABI 44 without a further bump (44 is
unreleased; a bump to 45 mid-campaign buys nothing and forces a package
rebuild), **and** close the blind spot by teaching `xtask dump-abi` to record
the `env.host_*` import surface — names, arity, and parameter types — parsed
from the built `kernel.wasm`, the same way it already parses kernel exports.
That converts an invisible contract into a checked one and gives
`EXPECTED_HOST_IMPORT_COUNT` a signature-level companion. **This is a
maintainer decision; see NEEDS-DEFER-DECISION #1 and #2.**

---

## 8. Implementation plan

Each increment is independently landable, independently testable, and leaves
the tree green. Host triple below is `aarch64-apple-darwin`
(`rustc -vV | awk '/^host/{print $2}'`).

Provisioning note (`docs/agent-guidance/validation.md`, and the build contract
in `CLAUDE.md`): a fresh worktree has no `local-binaries/kernel.wasm`,
sysroots, or `node_modules`. Build them; a missing artefact is provisioning,
not a blocker.

```bash
scripts/dev-shell.sh ./run.sh setup
scripts/dev-shell.sh bash scripts/build-programs.sh
npm ci && (cd host && npm ci)
```

---

### Increment 0 — truthful `HostIO` defaults *(no ABI surface, no signature change)*

Change `proc_read_bytes` / `proc_write_bytes` defaults in
`crates/runtime-core/src/process.rs:360-371` from `0` to
`-(Errno::ENOSYS as i32)`, matching `gl_query` (`process.rs:350-352`). Fix the
test double at `syscalls.rs:20168` if it relies on the default.

*Why first:* it is the one place the current contract fabricates success, it
is unrelated to every later decision, and it makes every later increment's
failure modes observable instead of silent.

```bash
cargo test --workspace --exclude xtask --target aarch64-apple-darwin
```

---

### Increment 1 — host-native implements both imports at the **current** `u32` signature

Deliberately before the widening, so native parity is proved against a
contract nobody is arguing about.

- `proc_memories: Arc<Mutex<HashMap<u32, SharedMemory>>>` next to
  `current_memory` (`guest.rs:981`); threaded into
  `define_kernel_host_imports` (`guest.rs:1659`).
- Registered at the boot process and the three `processes.push(child)` sites
  (`guest.rs:10108`, `10376`, `10460`); updated on exec-image replacement;
  removed at teardown.
- Two `func_wrap`s over free functions `proc_copy_out` / `proc_copy_in`
  (`&SharedMemory`, offset, len), bounds-checked against `mem.data().len()`
  on the guest side and `kernel_mem.data().len()` on the kernel side,
  `-EFAULT` on any failure.
- Inline `#[cfg(test)]` cases: happy path; guest range past end; kernel range
  past end; unknown pid; exact end-of-memory boundary (mirroring the TS cases
  at `kernel-public-scratch.test.ts:1116-1160`).
- Update the `EXPECTED_HOST_IMPORT_COUNT` changelog comment
  (`lib.rs:60-77`) to record the coverage change; the constant itself does
  not move.

```bash
cargo test -p host-native --target aarch64-apple-darwin
cargo test --workspace --exclude xtask --target aarch64-apple-darwin
```

**Claim this proves:** host-native implements the cross-memory primitive with
the same failure modes as the JS host. It does **not** yet prove any guest
program behaves differently — nothing calls it natively until Increment 3.

---

### Increment 2 — widen to `addr: u64`, `len: u32` **(ABI-gated: do not start until NEEDS-DEFER-DECISION #1 is answered)**

- `crates/kernel/src/wasm_api.rs:251-252` — new signatures.
- `crates/runtime-core/src/process.rs:360-371` — trait `addr: u64`.
- `crates/kernel/src/wasm_api.rs:1113-1119` — impl forward.
- Seven call sites (`syscalls.rs:1465, 1477, 1539, 1545, 1551, 1633, 1639`) —
  pass the `u64` directly; delete `checked_dri_process_pointer`
  (`syscalls.rs:1040-1042`) and its five uses. **Preserve the
  validate-all-before-first-write ordering documented at `syscalls.rs:1527`**
  by validating each pointer through the host import's own return before the
  first write, or by keeping an explicit pre-pass.
- `host/src/kernel.ts:2416-2483` — `addr` arrives as `bigint`; replace the
  hardcoded `4` with the target process's real width. `WasmPosixKernel` has no
  `getPtrWidth`; add a `getProcessPointerWidth?: (pid) => 4 | 8` callback
  beside `getProcessMemory` (`kernel.ts:798`), supplied by
  `kernel-worker.ts:3344` from `this.processes.get(pid)?.ptrWidth`
  (`kernel-worker.ts:10907-10913`). **This is one additional host *callback*,
  internal to the TS host — not a new `env.host_*` import.**
- `crates/host-native/src/guest.rs` — widen the Increment 1 closures.
- Extend `host/test/kernel-public-scratch.test.ts` with a wasm64-process case
  (`kernelHarness({}, 8)` already exists at `:1160`) proving an address above
  4 GiB is rejected rather than aliased to a low address.

```bash
bash scripts/check-abi-version.sh update && git diff --stat abi/snapshot.json   # expected: EMPTY — that is the finding
cargo test --workspace --exclude xtask --target aarch64-apple-darwin
cargo test -p host-native --target aarch64-apple-darwin
(cd host && npx vitest run)
bash scripts/check-abi-version.sh
```

---

### Increment 3 — first proof: `SIOCGIFCONF` in the kernel

- `crates/shared/src/ioctl_contract.rs` — add
  `pointer!(SIOCGIFCONF, InOut, 8, 16)` in sorted position; replace the
  "deliberately absent" comments at `:46-52` and `:166-169` with the truth.
- `crates/runtime-core/src/netif.rs:8-14` — correct the module doc: the
  kernel *can* reach process memory; the one genuinely host-owned fact is the
  IPv4 address.
- `crates/runtime-core/src/syscalls.rs` — handle `SIOCGIFCONF` in the socket
  ioctl path: parse `ifc_len`/`ifc_buf` **from the marshalled copy**, honour
  the null-buffer size query, allocate `min(ifc_len, ifconf_total_size(pw))`
  in kernel memory, `netif::ifconf_write`, `host.proc_write_bytes(pid,
  ifc_buf, &out)`, write `ifc_len` back through the `InOut` struct.
- `host/src/kernel-worker.ts` — delete `handleIoctlIfconf` (`:20189-20286`),
  the `SIOCGIFCONF` case in
  `checkHandwrittenProcessAddressArguments` (`:6082-6085`), and the intercept
  at `:12244-12257`.
- `crates/kernel/src/wasm_api.rs` — remove `kernel_network_ifconf_size`
  (`:11646`), `kernel_network_ifreq_size` (`:11625`), and
  `kernel_network_ifconf_write` (`:11661`).
- host-native: an end-to-end fixture calling `ioctl(fd, SIOCGIFCONF, &ifc)`
  and asserting the returned `ifreq` array — the first native exercise of the
  primitive through a real syscall.

```bash
bash scripts/check-abi-version.sh update && git diff abi/snapshot.json   # ioctl_request_contracts +1; kernel_exports -3
cargo test --workspace --exclude xtask --target aarch64-apple-darwin
cargo test -p host-native --target aarch64-apple-darwin
(cd host && npx vitest run)
scripts/dev-shell.sh scripts/run-libc-tests.sh
scripts/dev-shell.sh scripts/run-posix-tests.sh
cd apps/browser-demos && npx playwright test --grep-invert "@slow" --project=chromium
bash scripts/check-abi-version.sh
```

Browser is required, not optional: `kernel-worker.ts` is a shared cross-host
file and this deletes a host intercept (`docs/agent-guidance/host-runtime.md`,
"Shared files are cross-host changes by default").

---

### Increment 4 — `handleIpcControl` (msgctl/shmctl), then `handleSemctl`

Same shape, no blocking. Retires `kernel_msqid_ds_bytes`,
`kernel_shmid_ds_bytes`, `kernel_semctl_array_bytes` from the export surface.
Deletes 159 + 172 lines. Same validation set as Increment 3, plus the SysV IPC
layout checks `check-abi-version.sh` already runs
(`scripts/check-sysv-ipc-layouts.sh`, invoked at `check-abi-version.sh:24`).

---

### Increment 5 — hand off to K6

`handleSysvMessage` (274) and `handleSendmsg`/`handleRecvmsg` (306 + 420) are
K6, not K2, because each carries a semantic decision beyond the copy (§6.3)
and both touch blocking-retry snapshots that K3 owns. K2 is **done** when the
primitive is 64-bit-correct, implemented on all three hosts, and proved
end-to-end through at least one real syscall on each.

---

## 9. Honest sizing: is K2 Tier 1?

**The primitive: yes.** Increments 0-2 are ~1 trait default, 2 signatures,
7 call sites, 2 TS bodies, and ~200 lines of host-native. Low risk.

**The promise: no.** "The enabler that dissolves *all* pre-dispatch
marshalling" describes K6, and K6 is not low-risk:

- msgsnd/msgrcv changes copy-at-entry to copy-at-success unless `ipc.rs`'s
  blocking structure changes with it (§6.3).
- Every conversion introduces a guest-memory TOCTOU surface that does not
  exist today, because today the host copies once and the kernel only ever
  sees a copy (§4.2).
- sendmsg/recvmsg (726 lines) is entangled with socket blocking and control
  messages.
- The `u64` widening puts a `BigInt` parameter in the syscall hot path once
  K6 lands broadly (§2.4, unmeasured).

**Recommended reclassification:** keep **K2 (the primitive) in Tier 1** with
the wasm64 widening and host-native implementation, add `SIOCGIFCONF` as its
end-to-end proof, and move the phrase *"dissolves all pre-dispatch
marshalling"* onto **K6**, where the risk actually is. That is a
documentation change to the value plan, not a scope change.

**Two corrections to the census, for the record:**
- §5 says "exactly **six** Rust sites"; it is **seven** (`syscalls.rs:1465,
  1477, 1539, 1545, 1551, 1633, 1639`).
- §5's "Two gaps" (u32 addr; host-native missing) omits a third: the
  `HostIO` defaults return success while copying nothing (§1.2).

---

## 10. NEEDS-DEFER-DECISION

### #1 — ABI_VERSION for the signature widening — **STRONG DOUBT**

- **What:** widening `host_proc_read_bytes`/`host_proc_write_bytes` from
  `addr: u32, len: u32` to `addr: u64, len: u32`.
- **Why it needs a decision:** the maintainer asked to be consulted on this
  item's contract change before it lands. The rule does not decide itself: the
  change is invisible to `abi/snapshot.json` (§7.2) yet alters *pointer
  interpretation* in a kernel↔host contract, which `abi.md` names as a
  possible bump trigger *"even if the snapshot is unchanged."*
- **Cost now:** a bump to 45 forces a package/index rebuild
  (`binaries-abi-v{abi}`) mid-campaign for no compatibility benefit — ABI 44
  is unreleased (`main` is 43).
- **Cost later:** none if the campaign stays one epoch, as decision 1 of the
  value plan states. Real only if ABI 44 ships before K6 completes.
- **Recommendation:** fold into in-dev ABI 44, no bump. Ask before landing.

### #2 — Should `xtask dump-abi` record the `env.host_*` import surface? — **STRONG DOUBT**

- **What:** teach the snapshot generator to parse `kernel.wasm`'s imports
  (names, arity, param types) into `abi/snapshot.json`, as it already does for
  exports.
- **Why:** today the *entire* host import contract — 84 imports — is
  structurally unchecked. `EXPECTED_HOST_IMPORT_COUNT` counts them; nothing
  checks their shapes. K2 is the first change to prove that blind spot is
  load-bearing.
- **Cost now:** ~50-100 lines in `xtask`, a one-time large additive snapshot
  diff, and every future import signature change becomes a visible,
  reviewable snapshot diff.
- **Cost later:** every subsequent K-item that reshapes the host contract
  (K9 removes 25 imports; K11, K12) lands invisibly to the ABI check.
- **Recommendation:** do it, as its own change, before or alongside
  Increment 2. It is not K2's scope, and I will not decide it unilaterally.

### #3 — When to benchmark the `BigInt` parameter cost

- **What:** `addr: u64` makes the JS import parameter a `BigInt`.
- **Why:** harmless while only DRI calls it; hot-path once K6 routes real
  syscalls through it. `docs/agent-guidance/performance.md` forbids
  "neutral"/"no regression" claims without numbers.
- **Cost now:** full benchmark suites on Node and browser before/after
  Increment 2 — expensive, and measures a path nothing hot uses yet.
- **Cost later:** the regression, if any, arrives inside K6 mixed with
  several other changes and is much harder to attribute.
- **Recommendation:** do **not** benchmark Increment 2 (state plainly that
  performance was not measured and why). Benchmark at Increment 3, the first
  real syscall on the primitive, and again when K6 converts sendmsg/recvmsg.

### #4 — One additional host *callback* in Increment 2

- **What:** `getProcessPointerWidth?: (pid) => 4 | 8` on
  `WasmPosixKernel`'s callbacks (`kernel.ts:798`).
- **Why flagged:** the brief asks to surface *any* need to add host API
  surface. This is **not** a new `env.host_*` import and does not move
  `EXPECTED_HOST_IMPORT_COUNT`; it is an internal TS callback that already
  has its data (`kernel-worker.ts:10907`).
- **Alternative that adds nothing:** have `getProcessMemory` return
  `{ memory, ptrWidth }`. Slightly more churn, zero new surface.
- **Recommendation:** the alternative. Flagged, not decided.

### #5 — `EXPECTED_HOST_IMPORT_COUNT` semantics

- **What:** the constant counts imports the kernel *declares*, not imports
  host-native *implements* (19 of 84).
- **Why:** the census calls it a ratchet with a maintained changelog. It does
  not currently distinguish "trapped, truthfully" from "implemented". K2
  moves two from the first bucket to the second and the number does not move.
- **Recommendation:** record implemented-vs-trapped in the changelog comment
  as part of Increment 1; do not change the constant's meaning without asking.

---

## 11. VERIFIED vs INFERRED index

**VERIFIED** (read in this worktree): every `file:line` citation; the seven
call sites; the `HostIO` `{ 0 }` defaults; the full TS body logic and its
helper chain; `#rustLentKernelDestination`'s WeakMap/generation/one-shot
proof; `checked_dri_process_pointer`; `PROCESS_MEMORY_DEFAULT_MAX_PAGES` and
the absence of a `maxPages` upper bound; `CH_DATA_SIZE = 65536` and every
guard against it; `#beginLargeTransferScratch`'s four kernel exports;
`MSGMNB = 16384`; host-native's 19 implemented imports and the absence of
`host_proc_*`; `mem_base`/`read_bytes`/`write_bytes`/`SharedMemory` clonability;
`bind_and_dispatch`'s `current_memory`/`current_pid`; the four
`processes.push`/creation sites; `grep -c host_open abi/snapshot.json` = 0;
`ABI_VERSION` 44 here vs 43 on `main`; `ioctl_request_contracts` shape; the
`ioctl_contract.rs` and `netif.rs` "cannot itself reach" comments; the three
existing `host_proc_*` tests and the absence of wasm64/concurrency tests; the
handler line spans in §6.3.

**INFERRED** (reasoned, not observed): that no further wasmtime API is needed
for the native implementation; that exec replaces a pid's memory in
host-native (**must be confirmed when implementing**); that the copy is
non-atomic under a concurrent writer (follows from the memory model, not
measured); that the target is live by construction because the import cannot
re-enter the kernel; that the SysV 64 KiB host cliff is reachable via
`msgctl(IPC_SET)`; the `BigInt` parameter cost; every line-count estimate for
work not yet written.
