# Rust GPU Slice 1 (Execution Foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A grouped guest program can create a kernel GPU context, submit a
low-level command stream that clears an offscreen surface, wait for it, and
read the pixels back. The work executes in a Rust executor module inside a
kernel-owned GPU worker, against WebGL 2 in browsers.

**Architecture:** This is slice 1 of iteration 1 in the design.
- **The kernel (`kgpu`)** owns GPU contexts, submission sequence numbers, the
  translation of guest ranges into graphics-memory extents, page pins,
  retirement and parked waits.
- **The kernel-worker host** drains submissions from the kernel. It forwards
  them over a `SharedArrayBuffer` ring to a GPU worker, and feeds completions
  back to the kernel.
- **The GPU worker** copies each command range into a Rust executor module.
  The executor decodes it, enforces context isolation and calls its WebGL 2
  backend through imports.

**Tech Stack:** Rust (nightly-2026-04-27; `no_std` + `alloc` + `dlmalloc` for
the executor), TypeScript host (browser module Workers, Node
`worker_threads`), WebGL 2, Vitest, Playwright.

**Spec:** `docs/plans/2026-11-27-rust-gpu-driver-design.md`

## Roadmap (iteration 1)

Each slice gets its own plan when it starts; the order is dependency order.

1. **Execution foundations.** This plan.
2. **Userspace driver skeleton.** Rust `libEGL`/`libGLESv2` static libraries
   linked into C programs, with EGL clear and swap.
3. **GLES2 state model by area,** driven by dEQP families.
4. **GLSL ES 1.00 front end,** link rules, reflection and GLSL ES 3.00 output.
5. **Presentation and KMS** in the GPU worker, with fences signaled by
   completions.
6. **Move into the graphics group:** the demos and the conformance runner.
7. **Bring-up** of Sway+Foot, ScummVM, Freeciv, SDL2 and modeset in Firefox,
   then WebKit, then Chromium.
8. **Switch:** delete the old stack, bump versions and update the docs.

## Global Constraints

- **Clean room.** Do not read or port `host/src/webgl/**`,
  `libc/glue/libglesv2_stub.c`, `libc/glue/libegl_stub.c`,
  `libc/glue/gl_abi.h`, or the architecture documentation's description of
  their internals.
- **No coexistence machinery.** Add no shims or flags that select between old
  and new stacks. The old `GLIO_*` path stays untouched until slice 8.
- **Non-blocking workers.** The GPU worker never blocks (`Atomics.wait` is
  forbidden there), and the kernel never waits on the GPU worker.
- **Read once.** Each command byte is read once, into executor memory, before
  it is acted on. Executor state never lives in group pages. Guest virtual
  addresses are never used as backing offsets.
- **Grouped programs only.** A `kgpu` request from a process outside a memory
  group fails with `EOPNOTSUPP`.
- **No renderer means failure.** With no renderer (Node without an
  embedder-supplied WebGL 2), context creation fails with `ENODEV`.
- **The guest interface is a program extension, not ioctls** (Ruling R9).
  The ABI-56 base program surface and `abi/supported-program-baseline.json`
  are frozen (`docs/persistent-program-compatibility.md`,
  `docs/program-extensions.md`). Programs reach kgpu through the required
  import `kandelo.kgpu.v1.__kandelo_kgpu_v1(arg: pointer, size: i32, op: i32) -> i32`,
  following `kandelo.klog.v1`. It returns a non-negative result or a
  negative errno and never sets `errno`. Ops are `KGPU_OP_CONTEXT_CREATE = 1`,
  `KGPU_OP_CONTEXT_DESTROY = 2`, `KGPU_OP_SUBMIT = 3` and `KGPU_OP_WAIT = 4`,
  and `size` must equal the op's struct size or the result is `-22`. The
  process worker serves the import by issuing kernel-host request
  `extension_requests::KGPU_V1 = 602` on the calling thread's own channel.
  The kernel stages `arg` through that request's InOut descriptor in
  `host_abi::EXTENSION_REQUEST_DESCRIPTORS`, so no argument bytes pass
  through host code. `ABI_VERSION`, the program digest and the base ioctl
  contract table do not change.
- **Host adapter version.** Bump `HOST_ADAPTER_VERSION` from 41 to 42 once
  on this branch, in Task 2 (request 602 and its descriptor). Later kgpu
  kernel exports and imports in this slice extend version 42 and add to its
  history line.
  Regenerate `abi/snapshot.json` with
  `scripts/dev-shell.sh bash scripts/check-abi-version.sh update`.
- **Versioning the new formats.** The new formats carry their own constants:
  `KGPU_STREAM_VERSION = 1` and `KGPU_PROTOCOL_VERSION = 1`.
- **Commands run through `scripts/dev-shell.sh`.** The host target is
  `aarch64-apple-darwin` on the maintainer's machine; use
  `rustc -vV | awk '/^host/ {print $2}'` elsewhere.
- **Browser order:** Firefox, then WebKit, then Chromium.
- **Comments say why.** Every new module opens with a comment stating its
  ownership and why it exists (`document-why-the-implementation`).

## Review Focus

1. **Modified or garbage command streams.** A guest may rewrite its command
   memory between submit and execution, or submit garbage. The executor must
   reject a malformed record with a context fault. It must never trap, never
   loop, and never touch another context's objects. (Task 6 fuzz test.)
2. **Exit, exec, fatal signal or context destroy with work in flight.** The pins
   stay until the executor retires the submission, then all are released with
   no leak. A parked wait returns `EINTR` on a caught signal. (Task 4 tests.)
3. **Bad ranges.** Submit ranges that are unmapped, cross discontiguous
   frames, or name a read-only page as a readback destination fail with
   `EFAULT` before anything is queued. A valid multi-page range produces
   exact extents. (Task 3 tests.)
4. **Ring full.** The submitting thread parks and resumes when space frees.
   Nothing is dropped and the kernel never blocks. (Task 4 and Task 7 tests.)
5. **GPU worker death or lost WebGL context.** Every context on the device
   becomes lost. Parked waits complete with `EIO`, later submits fail with
   `EIO`, and machine teardown terminates the worker. (Task 7 test.)

---

### Task 1: Command-stream format crate (`kgpu-stream`)

**Files:**
- Create: `crates/kgpu-stream/Cargo.toml` (`no_std`, no dependencies)
- Create: `crates/kgpu-stream/src/lib.rs`
- Modify: `Cargo.toml` (add `crates/kgpu-stream` to workspace members)
- Modify: `tools/xtask/src/dump_abi.rs` (generate and check the C header)
- Create (generated): `libc/musl-overlay/include/kandelo/kgpu_stream.h`

**Interfaces:**
- Produces:
  - `pub const KGPU_STREAM_VERSION: u16 = 1;`
  - Record header `{ op: u16, flags: u16, len: u32 }`, little-endian, where
    `len` is the payload length. Records are 4-byte aligned.
  - Stream header `{ magic: u32 = 0x5547_4B4B /* "KKGU" */, version: u16,
    reserved: u16, context: u32, record_bytes: u32 }`.
  - `pub enum Op { Viewport = 1, ClearColor = 2, Clear = 3, ReadPixels = 4 }`
  - Payloads:
    - `Viewport { x: i32, y: i32, w: i32, h: i32 }`
    - `ClearColor { r: f32, g: f32, b: f32, a: f32 }`
    - `Clear { mask: u32 }`, with bits COLOR = 0x4000, DEPTH = 0x100,
      STENCIL = 0x400 (WebGL values)
    - `ReadPixels { x: i32, y: i32, w: i32, h: i32, buffer: u32 }`, where
      `buffer` indexes the submission's buffer table, and the format is
      RGBA8
  - `pub struct Encoder<'a> { .. }` with
    `fn new(out: &'a mut [u8], context: u32) -> Self`, one method per op
    (`viewport`, `clear_color`, `clear`, `read_pixels`) returning
    `Result<(), StreamError>`, and
    `fn finish(self) -> Result<usize, StreamError>`.
  - `pub fn decode(bytes: &[u8]) -> Result<Decoded<'_>, StreamError>`, where
    `Decoded { context: u32, records: RecordIter<'_> }`, and
    `RecordIter: Iterator<Item = Result<Command, StreamError>>`.
  - `pub enum Command` mirrors `Op` with typed payloads.
  - `pub enum StreamError { BadMagic, BadVersion, Truncated, Misaligned,
    UnknownOp(u16), BadLength { op: u16, len: u32 }, Overflow }`

- [ ] **Step 1: Write failing tests** in `crates/kgpu-stream/src/lib.rs`
  `#[cfg(test)]`:
  - `encode_decode_roundtrip`: encode viewport(0,0,4,4), clear_color(0.25,0.5,0.75,1.0),
    clear(0x4000) and read_pixels(0,0,4,4,0) for context 7. Decoding yields
    exactly those four commands and `context == 7`.
  - `rejects_bad_magic_version_truncation`: each mutated header yields its
    named error.
  - `rejects_unknown_op_and_wrong_length`: `UnknownOp(99)`;
    `BadLength{op:2,len:12}`.
  - `encoder_reports_overflow`: a 16-byte buffer yields `Overflow` on the
    first record.
- [ ] **Step 2: Run the tests and confirm they fail.**
  `scripts/dev-shell.sh cargo test -p kgpu-stream --target aarch64-apple-darwin`.
  Expected: compile errors or FAIL.
- [ ] **Step 3: Implement the crate.** Decoding never allocates and never
  panics on any input: use checked arithmetic and return errors.
- [ ] **Step 4: Add header generation to `dump_abi`.** It emits
  `KGPU_STREAM_VERSION`, the magic, op numbers, clear bits and packed payload
  struct definitions with `_Static_assert` sizes into
  `libc/musl-overlay/include/kandelo/kgpu_stream.h`. `--check` fails on drift.
- [ ] **Step 5: Run the tests, plus**
  `scripts/dev-shell.sh bash scripts/check-abi-version.sh update`, then
  `scripts/dev-shell.sh bash scripts/check-abi-version.sh`.
  Expected: tests PASS and the check is clean.
- [ ] **Step 6: Commit.** Message: `GPU: Define the kgpu command-stream format`.

### Task 2: kgpu program extension and kernel–host records

**Files:**
- Create: `crates/shared/src/kgpu.rs` (and add `pub mod kgpu;` in `crates/shared/src/lib.rs`)
- Modify: `crates/program-abi/src/program_extensions.rs` (declare `kandelo.kgpu.v1` / `__kandelo_kgpu_v1`, as `kandelo.klog.v1` is declared at `:79`), then regenerate with `cargo xtask program-extensions` (`abi/program-extensions.json`, host constants, SDK linker allowance)
- Modify: `crates/shared/src/lib.rs` (`extension_requests::KGPU_V1 = 602`; its descriptor in `host_abi::EXTENSION_REQUEST_DESCRIPTORS`, sized per op; `HOST_ADAPTER_VERSION = 42` with history line "42 adds the kgpu.v1 extension request")
- Revert from commit 6bc9063e91: the four `IOCTL_REQUEST_CONTRACTS` entries and anything else that moved the base program digest
- Modify (generated): `abi/snapshot.json`, `host/src/generated/abi.ts`
- Modify: `tools/xtask/src/dump_abi.rs` (generate `libc/musl-overlay/include/kandelo/kgpu.h`: op numbers, the argument structs with `_Static_assert` sizes, access flags, limits, and the import declaration `int __kandelo_kgpu_v1(void *arg, int size, int op)` with `import_module("kandelo.kgpu.v1")` / `import_name("__kandelo_kgpu_v1")` attributes; `--check` fails on drift)

**Interfaces:**
- Produces (in `wasm_posix_shared::kgpu`):
  - Op argument structs (op numbers in Global Constraints):
    - `KGPU_OP_CONTEXT_CREATE`: `KgpuContextCreate { flags: u32, context: u32 /*out*/ }`, 8 bytes.
    - `KGPU_OP_CONTEXT_DESTROY`: `KgpuContextDestroy { context: u32, pad: u32 }`, 8 bytes.
    - `KGPU_OP_SUBMIT`: `KgpuSubmit { context: u32, flags: u32, stream_addr: u64, stream_len: u32, buffer_count: u32, buffers_addr: u64, seqno: u64 /*out*/ }`, 40 bytes.
    - Buffer table entries: `KgpuBuffer { addr: u64, len: u32, access: u32 }`, 16 bytes. `access` is `KGPU_ACCESS_READ = 1`, `KGPU_ACCESS_WRITE = 2`. At most `KGPU_MAX_BUFFERS = 64` entries, and `stream_len` is at most `KGPU_MAX_STREAM = 1 << 20`.
    - `KGPU_OP_WAIT`: `KgpuWait { context: u32, flags: u32, seqno: u64, timeout_ns: i64 }`, 24 bytes. A negative timeout means infinite; zero means poll and returns `ETIME` if pending.
  - `pub const KGPU_PROTOCOL_VERSION: u32 = 1;`
  - `pub struct Extent { offset: u64, len: u32, pad: u32 }`, 16 bytes: a byte range in the group backing.
  - Submission record (kernel to host), little-endian:
    - header `{ kind: u32 (1=Submit, 2=ContextCreate, 3=ContextDestroy), context: u32, seqno: u64, stream_extent_count: u32, buffer_count: u32 }`
    - then `stream_extent_count` `Extent`s
    - then per buffer `{ access: u32, extent_count: u32 }` followed by its `Extent`s.
  - Completion record (host to kernel): `{ kind: u32 (1=Retired, 2=ContextLost, 3=ContextReady), context: u32, seqno: u64, status: i32, pad: u32 }`, 24 bytes. `status` is 0 or a negative errno.
  - `pub fn encode_submission(..)` / `pub fn decode_submission(..)` and `encode_completion` / `decode_completion`, using the same no-panic rules as Task 1.

- [ ] **Step 1: Write failing tests** in `crates/shared/src/kgpu.rs`:
  - `struct_sizes_match_contract`: `size_of` checks for every struct.
  - `op_numbers_and_descriptor`: op constants are 1–4, `extension_requests::KGPU_V1 == 602`, and its descriptor stages one InOut buffer of at most `size_of::<KgpuSubmit>()` bytes.
  - `submission_roundtrip_multi_extent`: two stream extents and one buffer
    with three extents round-trip exactly.
  - `completion_roundtrip`
  - `decode_rejects_truncated_and_oversized_counts`
- [ ] **Step 2: Run the tests and confirm they fail.**
  `scripts/dev-shell.sh cargo test -p wasm-posix-shared --target aarch64-apple-darwin kgpu`
- [ ] **Step 3: Implement the extension declaration, request 602 and its descriptor.**
- [ ] **Step 4: Regenerate the ABI artifacts**
  (`cargo xtask program-extensions`, then
  `scripts/dev-shell.sh bash scripts/check-abi-version.sh update`), then run
  the tests and `scripts/dev-shell.sh bash scripts/check-abi-version.sh`.
  Expected: PASS and clean, including `check-program-baseline` with the
  ABI-56 digest unchanged.
- [ ] **Step 5: Commit.** Message: `GPU: Declare the kgpu.v1 program extension`.

### Task 3: Device I/O extents and pins in group memory

**Files:**
- Create: `crates/runtime-core/src/memory_group/storage/device_io.rs` (and register it in the storage module)
- Modify: `crates/runtime-core/src/memory_group/storage/reclaim.rs` (skip device-pinned frames, as it does at `:378-387` for native pins)
- Modify: `crates/runtime-core/src/memory_group/storage/retirement.rs` (image retirement waits for device pins, as at `:69`)
- Test: `crates/runtime-core/src/memory_group/storage/tests.rs`

**Interfaces:**
- Consumes: the page-table format in `crates/program-abi/src/memory_group_layout.rs`.
  - The root header is 64 bytes, followed by one `u32` PTE per 64 KiB page.
  - The frame is `pte >> 16`. Bit 0 means present and readable;
    `pte & 3 == 3` means writable.
  - Follow the translator pattern of `execution_word_address`
    (`storage/fork.rs:8-23`).
- Produces (on `impl Storage`):
  - `pub fn device_extents(&self, image: ImageId, addr: u64, len: u32, write: bool) -> Result<Vec<Extent>, Errno>`
    - Merges physically adjacent frames.
    - Returns `EFAULT` for a non-present page, a write to a page that isn't
      writable, or overflow.
    - `len == 0` returns an empty list.
  - `pub fn device_pin(&mut self, image: ImageId, extents: &[Extent]) -> DevicePinId`
  - `pub fn device_unpin(&mut self, pin: DevicePinId)`: releasing an unknown id is a
    no-op that returns nothing.
  - `pub fn device_pinned_frames(&self) -> usize`, for tests and inspection.

- [ ] **Step 1: Write failing tests:**
  - `device_extents_single_page`
  - `device_extents_merges_adjacent_frames`
  - `device_extents_splits_discontiguous_frames`: map two virtual pages to
    frames 5 and 9. A range spanning them yields two extents with exact
    offsets and lengths.
  - `device_extents_unmapped_is_efault`
  - `device_extents_write_to_readonly_is_efault`
  - `pinned_frames_survive_reclaim`: pin, unmap the range, run reclaim; the
    frames are not reused. After `device_unpin`, reclaim frees them.
  - `retirement_waits_for_device_pins`
- [ ] **Step 2: Run the tests and confirm they fail.**
  `scripts/dev-shell.sh cargo test -p runtime-core --target aarch64-apple-darwin gpu_`
- [ ] **Step 3: Implement.** Pins hold frame references in `self`, never in
  group pages.
- [ ] **Step 4: Run the tests, then the full `runtime-core` suite.** Expected:
  PASS.
- [ ] **Step 5: Commit.** Message: `Kernel: Translate and pin device I/O extents in group memory`.

### Task 4: Kernel `kgpu` device — contexts, submission, retirement, waits

**Files:**
- Create: `crates/runtime-core/src/dri/kgpu/mod.rs`, `context.rs`, `queue.rs`, `wait.rs`
- Modify: the kernel's extension-request dispatch (where `extension_requests::KLOG_V1` (600) is served) to route `KGPU_V1` (602) by op to `KgpuDevice`, plus exit and exec cleanup hooks next to the existing DRM cleanup
- Modify: `crates/runtime-core/src/wait_queue.rs` (add `WakeSource::KgpuSeqno { device: u32, context: u32, seqno: u64 }`)
- Modify: `crates/runtime-core/src/wait_park.rs` (add a `Resume` variant that publishes the wait result)
- Test: `#[cfg(test)]` modules in `dri/kgpu/*.rs`, and tests through the same extension-request entry the klog tests use

**Interfaces:**
- Consumes: Task 2 types; Task 3 `device_extents` / `device_pin` / `device_unpin`; `Parks::park` (`wait_park.rs:303`) and `finish_with` (`:350`).
- Produces:
  - `pub struct KgpuDevice`, owned by the process table. It holds contexts
    keyed by id (owner pid and open file description), a FIFO outbox of
    encoded submission records with a byte capacity of 256 KiB, in-flight
    submissions (seqno → `DevicePinId` list), per-context `last_retired`, a
    `lost` flag and `renderer_available: bool`.
  - `fn drain_outbox(&mut self, out: &mut [u8]) -> usize`: copies whole
    records only.
  - `fn complete(&mut self, records: &[u8]) -> Result<(), Errno>`:
    - `Retired` unpins and advances `last_retired`;
    - `ContextLost` marks the context lost;
    - each wakes `KgpuSeqno` waiters through `note_source_ready`.
  - Op semantics:
    - **Non-grouped caller:** every `kgpu` op returns `EOPNOTSUPP`.
    - **CONTEXT_CREATE:** `ENODEV` when `!renderer_available`. Otherwise it
      allocates an id, queues a ContextCreate record and returns
      immediately.
    - **SUBMIT:**
      - Validates the stream header magic and version only: the kernel
        does not decode records.
      - Translates the stream range (read) and each buffer (with its
        access), pins them and assigns the next seqno.
      - Queues the record. If the outbox lacks room, it parks the caller
        until a drain makes room.
      - Returns `EIO` if the context is lost.
    - **WAIT:**
      - Returns at once if `seqno <= last_retired`.
      - A zero timeout gives `ETIME` if pending; otherwise the caller parks
        on `KgpuSeqno`.
      - A caught signal gives `EINTR`, and a lost context gives `EIO`.
    - **CONTEXT_DESTROY:** valid only for the owner; queues a destroy record.
  - Cleanup:
    - Exit or exec queues destroy for the owner's contexts (contexts belong to the process, not to an fd).
    - Pins stay until `Retired` arrives for every in-flight seqno.

- [ ] **Step 1: Write failing tests** (with a fake grouped image from the
  Task 3 test helpers and `renderer_available = true` unless noted):
  - `create_without_renderer_is_enodev`
  - `ungrouped_caller_is_eopnotsupp`
  - `submit_queues_record_with_extents_and_pins`: drain and decode with
    `decode_submission`. The extents equal `device_extents` output, and the
    seqno is 1, then 2.
  - `submit_bad_magic_is_einval`
  - `submit_unmapped_buffer_is_efault_and_nothing_queued`
  - `wait_returns_after_retired_completion`: park, then `complete(Retired)`;
    the waiter's resume result is 0 and the pins are released.
  - `wait_zero_timeout_pending_is_etime`
  - `wait_interrupted_by_signal_is_eintr`
  - `context_lost_fails_waiters_and_submits_with_eio`
  - `outbox_full_parks_submitter_until_drain`
  - `exit_with_inflight_keeps_pins_until_retired`: exit, assert pins are
    held; `complete(Retired)`, assert `device_pinned_frames() == 0`.
  - `destroy_by_non_owner_is_eperm`
- [ ] **Step 2: Run the tests and confirm they fail.**
  `scripts/dev-shell.sh cargo test -p runtime-core --target aarch64-apple-darwin kgpu`
- [ ] **Step 3: Implement.** Follow `Parks::park`'s existing contract for
  grouped tasks. Completion publication for grouped tasks goes through
  `group_completion.rs`, exactly as other parked syscalls do; do not add a
  second path.
- [ ] **Step 4: Run the tests, then the workspace suite.**
  `scripts/dev-shell.sh cargo test --workspace --exclude xtask --target aarch64-apple-darwin`.
  Expected: PASS.
- [ ] **Step 5: Commit.** Message: `Kernel: Add kgpu contexts, submission and parked waits`.

### Task 5: Kernel Wasm boundary for `kgpu`

**Files:**
- Modify: `crates/runtime-core/src/process.rs`: `HostIO` gains `fn kgpu_kick(&self)`
- Modify: `crates/kernel/src/wasm_api.rs`:
  - the import `host_kgpu_kick()` in the `env` block (`:58`);
  - the `WasmHostIO` impl (`:530`);
  - the exports `kernel_kgpu_drain(out_ptr: u32, out_cap: u32) -> u32`,
    `kernel_kgpu_complete(in_ptr: u32, len: u32) -> i32` and
    `kernel_kgpu_set_renderer(available: u32)`, plus
    `kernel_device_pinned_frames() -> u32` (the Task 3 count, used by
    inspection)
- Modify: `crates/shared/src/lib.rs` (extend the version-42 history line from Task 2: "…, kgpu submission drain, completion and kick")
- Modify: the process-worker host code that serves `kandelo.klog.v1` (find it from `extension_requests::KLOG_V1` / `__kandelo_klogctl_v1` in `host/src`): serve `kandelo.kgpu.v1.__kandelo_kgpu_v1` the same way, issuing request 602 on the calling thread's channel, on both Node and browser process workers
- Modify: `packages/registry/kernel/build-kernel.sh` (add the new exports to `wasm_require_exports`)
- Modify (generated): `abi/snapshot.json`, `host/src/generated/abi.ts`

**Interfaces:**
- Consumes: Task 4 `drain_outbox` and `complete`.
- Produces the host contract:
  - The kernel calls `host_kgpu_kick()` synchronously whenever the outbox
    goes from empty to non-empty. The host must not re-enter the kernel
    inside that call.
  - The host later calls `kernel_kgpu_drain` from a kernel entry until it
    returns 0.
  - `kernel_kgpu_complete` returns 0, or a negative errno for a malformed
    record (which faults the device: all contexts are lost).

- [ ] **Step 1: Write the failing test** `host/test/kgpu-boundary.test.ts`.
  It loads the built kernel with a recorded `host_kgpu_kick` and a fake
  grouped program fixture calling `__kandelo_kgpu_v1` for CONTEXT_CREATE then SUBMIT (via
  `compileSdkFixture` + `runCentralizedProgram`, as in
  `host/test/egl-dmabuf-smoke.test.ts`), and asserts:
  - the kick fires once;
  - `kernel_kgpu_drain` yields ContextCreate then Submit records;
  - feeding `Retired` lets the program's `KGPU_WAIT` return 0.
- [ ] **Step 2: Build the kernel and confirm the test fails.**
  `scripts/dev-shell.sh bash packages/registry/kernel/build-kernel.sh`, then
  `cd host && npx vitest run test/kgpu-boundary.test.ts`.
- [ ] **Step 3: Implement**, bump the version and regenerate the ABI artifacts.
- [ ] **Step 4: Run the test and `scripts/dev-shell.sh bash scripts/check-abi-version.sh`.**
  Expected: PASS and clean.
- [ ] **Step 5: Commit.** Message: `Kernel: Expose kgpu drain, completion and kick to hosts`.

### Task 6: Executor crate and Wasm module

**Files:**
- Create: `crates/gpu-executor/Cargo.toml`: `no_std`, `dlmalloc` on wasm32. Depends on `kgpu-stream` and `wasm-posix-shared` (`kgpu` module only). Binary target `kandelo-gpu-executor-module` behind feature `standalone`.
- Create: `crates/gpu-executor/src/lib.rs` (executor core), `src/backend.rs` (trait plus `NullBackend` and `RecordingBackend`), `src/wasm.rs` (exports and the imported backend), `src/bin/module.rs`
- Create: `crates/gpu-executor/build-wasm.sh`, modeled on `crates/program-policy/build-wasm.sh`:
  - private, non-shared memory, initial 2 MiB, max 256 MiB;
  - explicit exports;
  - an import check allowing `env.memory` plus the `kgpu_backend.*` imports listed below;
  - stages `local-binaries/kandelo_gpu_executor32.wasm` and its `.build-key`.
- Modify: `tools/xtask/src/local_build.rs` (add a `CORESIDENT_SIDE_MODULES` entry with `node_name: "kandelo-gpu-executor"`, `closure_crates: &["kandelo-gpu-executor", "kgpu-stream", "wasm-posix-shared"]`)
- Modify: `Cargo.toml` (workspace member)

**Interfaces:**
- Consumes: Task 1 `decode` and `Command`; Task 2 submission-record decoding.
- Produces:
  - The backend trait:
    ```rust
    pub trait Backend {
        fn create_surface(&mut self, context: u32, width: u32, height: u32) -> Result<(), i32>;
        fn destroy_surface(&mut self, context: u32);
        fn viewport(&mut self, context: u32, x: i32, y: i32, w: i32, h: i32);
        fn clear_color(&mut self, context: u32, rgba: [f32; 4]);
        fn clear(&mut self, context: u32, mask: u32);
        fn read_pixels(&mut self, context: u32, x: i32, y: i32, w: i32, h: i32,
                       dst: &[wasm_posix_shared::kgpu::Extent]) -> Result<(), i32>;
        fn is_lost(&self) -> bool;
    }
    ```
  - `pub struct Executor<B: Backend>`:
    - `fn handle_record(&mut self, record: &[u8], stream: &[u8]) -> Completion`
    - `record` is the decoded submission metadata.
    - `stream` holds the command bytes the shell already copied into
      executor memory.
  - In slice 1 a context's surface is 4×4.
  - The stream's `context` must equal the record's `context`, otherwise the
    context faults (`ContextLost`, status `-EPROTO`).
  - `ReadPixels.buffer` must index a WRITE buffer whose total length is at
    least `w*h*4`; otherwise the result is `-EINVAL` and the context is lost.
  - Wasm exports:
    - `ge_version() -> u32`, which is `KGPU_PROTOCOL_VERSION`
    - `ge_alloc(len: u32) -> u32` and `ge_free(ptr, len)`
    - `ge_handle(record_ptr, record_len, stream_ptr, stream_len, out_ptr) -> i32`,
      which writes one 24-byte completion record to `out_ptr`
  - Wasm imports (module `kgpu_backend`): `create_surface`, `destroy_surface`,
    `viewport`, `clear_color`, `clear`, `read_pixels(context, x, y, w, h,
    extents_ptr, extent_count) -> i32` and `is_lost() -> i32`, with the same
    meanings as the trait.

- [ ] **Step 1: Write failing native tests** with `RecordingBackend`:
  - `clear_and_readback_records_calls`: the exact recorded sequence is
    create_surface(7,4,4), viewport, clear_color([0.2,0.4,0.6,1.0]),
    clear(0x4000), read_pixels(…, dst extents).
  - `stream_context_mismatch_faults_context`
  - `readpixels_into_read_only_buffer_faults`
  - `garbage_streams_never_panic`: 10,000 deterministic pseudo-random byte
    strings, each 0–512 bytes, through `handle_record`. Each yields a
    completion, with no panic.
  - `null_backend_reports_enodev_on_create`
- [ ] **Step 2: Run the tests and confirm they fail.**
  `scripts/dev-shell.sh cargo test -p kandelo-gpu-executor --target aarch64-apple-darwin`
- [ ] **Step 3: Implement the core, `wasm.rs`, `build-wasm.sh` and the side-module registration.**
- [ ] **Step 4: Run the native tests, then**
  `scripts/dev-shell.sh bash crates/gpu-executor/build-wasm.sh`.
  Expected: tests PASS, the import check passes and the artifact is staged.
- [ ] **Step 5: Commit.** Message: `GPU: Add the Rust GPU executor module`.

### Task 7: GPU worker and kernel-worker host glue

**Files:**
- Create: `host/src/device-worker/ring.ts`: SPSC byte ring over a `SharedArrayBuffer`, with 64 KiB of data and head/tail `Int32Array` words.
  `push(record: Uint8Array): boolean` and `pop(out: Uint8Array): number`, neither blocking.
- Create: `host/src/kgpu/gpu-worker.ts`: the worker entry. It does the following:
  - Receives `{ executorBytes | executorUrl, groupMemory: WebAssembly.Memory, submissions: SAB, completions: SAB, port: MessagePort, renderer: "webgl2" | "null" }`.
  - Instantiates the executor with the backend imports.
  - On each `port` message (the doorbell), drains `submissions` and, for each
    record, copies every stream extent from `groupMemory.buffer` into
    `ge_alloc` memory before calling `ge_handle`.
  - Pushes completions and posts one doorbell back when the completion ring
    goes from empty to non-empty.
- Create: `host/src/kgpu/webgl2-backend.ts`: implements the `kgpu_backend` imports.
  - Each context gets a 4×4 framebuffer object on one `WebGL2RenderingContext` from an `OffscreenCanvas(1,1)`.
  - `read_pixels` reads into a scratch buffer, then writes it across the destination extents in `groupMemory`.
  - A `webglcontextlost` event makes `is_lost()` true.
- Create: `host/src/kgpu/null-backend.ts`
- Create: `host/src/kgpu/kgpu-host.ts`: the kernel-worker side. Exports
  `class KgpuHost { constructor(opts: { createWorker: () => Worker | NodeWorkerHandle; groupMemory: () => WebAssembly.Memory | null; renderer: "webgl2" | "null" }); onKick(): void; onDoorbell(): void; terminate(): void }`.
  - Starts the worker lazily on the first kick.
  - `onKick` schedules a kernel entry that loops `kernel_kgpu_drain` into the ring and posts a doorbell.
  - `onDoorbell` pops completions and calls `kernel_kgpu_complete` within a kernel entry.
  - If the worker exits or errors, it calls `kernel_kgpu_complete` with ContextLost for every live context.
- Modify: `host/src/kernel.ts` `#buildImportObject` (`:2603`): add `host_kgpu_kick`.
- Modify: `host/src/kernel-worker.ts`: construct `KgpuHost`, call `kernel_kgpu_set_renderer(1)` at init where a renderer exists, and call `terminate()` at kernel teardown.
- Modify: `host/src/browser-kernel-worker-entry.ts` and `host/src/node-kernel-worker-entry.ts` to supply `createWorker`:
  - browser: a module Worker from `gpu-worker.ts?worker&url`;
  - Node: `worker_threads`, following `host/src/program-policy-node.ts:7-11`;
  - Node passes `"null"` unless the embedder supplied a WebGL 2 factory.
- Modify: the `getMemoryGroupUsage()` backing snapshot. It adds
  `devicePinnedFrames` from `kernel_device_pinned_frames()`, copied like the
  other counters (`docs/shared-memory-groups.md`, "Desktop-first opt-in").
- Modify: `host/tsup.config.ts` (add the worker entry), and `host/src/binary-resolver.ts` (resolve `kandelo_gpu_executor32.wasm` as `:1937` does for the policy module).
- Test: `host/test/kgpu-ring.test.ts`, `host/test/kgpu-host.test.ts`

**Interfaces:**
- Consumes: Task 5 exports and import; Task 6 module exports and imports.
- Produces: `KgpuHost` as above. Doorbells are `MessagePort` messages carrying no payload.

- [ ] **Step 1: Write failing tests:**
  - `kgpu-ring.test.ts`: in-order delivery across wraparound; `push` returns
    `false` when full and never overwrites.
  - `kgpu-host.test.ts`, using a Node worker with the executor and the
    WebGL 2 test double from `host/test/support/logging-graphics-gl.ts`,
    injected through the backend:
    - `clear_and_readback_roundtrip`: the guest fixture reads 51,102,153,255
      for all 16 pixels;
    - `ring_full_backpressure_completes_all`: 200 submissions, all retire in
      order;
    - `worker_crash_loses_contexts`: terminate the worker mid-run, and the
      parked wait returns `EIO`;
    - `node_null_renderer_create_is_enodev`.
- [ ] **Step 2: Run the tests and confirm they fail.**
  `cd host && npx vitest run test/kgpu-ring.test.ts test/kgpu-host.test.ts`
- [ ] **Step 3: Implement.** The GPU worker uses no `Atomics.wait`; its wakeups
  are port messages only.
- [ ] **Step 4: Run the tests, then the whole host suite**
  (`cd host && npx vitest run`). Expected: PASS.
- [ ] **Step 5: Commit.** Message: `Host: Run kgpu submissions in a kernel-owned GPU worker`.

### Task 8: End-to-end guest program in browsers

**Files:**
- Create: `programs/kgpu-clear.c`. Using only `<kandelo/kgpu_stream.h>`, `<kandelo/kgpu.h>` and `__kandelo_kgpu_v1`, it does the following:
  - creates a context;
  - encodes viewport, clear-color 0.2/0.4/0.6/1.0, clear COLOR, and a 4×4
    readback into a 64-byte heap buffer;
  - submits, waits with an infinite timeout, and prints the 16 RGBA pixels
    as `pixel i r g b a`;
  - exits 0, or 1 with the failing call and errno.
- Create: `apps/browser-demos/test/kgpu-clear.spec.ts`
- Test: the spec above, plus a Node case in `host/test/kgpu-host.test.ts` that runs the same program grouped and expects `ENODEV` from create.

**Interfaces:**
- Consumes: Tasks 1–7.

- [ ] **Step 1: Write the failing spec**, modeled on
  `apps/browser-demos/test/grouped-vfs-launch.spec.ts`:
  - convert the program with `sdk/bin/wasm32posix-shared-memory`;
  - boot `BrowserKernel` with `experimentalMemoryGroup: { maximumPages: 512 }`;
  - spawn with `executionBackend: "memory-group"`;
  - assert exit 0 and that all 16 lines read `51 102 153 255`.

  A second test spawns the same program ungrouped and asserts that the
  output names `EOPNOTSUPP`. A third test spawns, reads back, exits and
  repeats 20 times, asserting that `getMemoryGroupUsage().backing.devicePinnedFrames`
  returns to 0.
- [ ] **Step 2: Build the inputs and run the spec; confirm it fails.**
  `scripts/dev-shell.sh bash scripts/build-programs.sh`, then
  `cd apps/browser-demos && npx playwright test test/kgpu-clear.spec.ts --project=firefox`.
- [ ] **Step 3: Fix the failures at their owning layer** until the spec passes.
- [ ] **Step 4: Run the spec on each engine, in this order:**
  `--project=firefox`, `--project=webkit`, `--project=chromium`. Expected:
  PASS on all three. Then run `./run.sh test browser-memory` and report its
  result.
- [ ] **Step 5: Commit.** Message: `GPU: Prove kgpu clear and readback end to end`.

### Task 9: Measure the backend crossing style and record slice 1

**Files:**
- Create: `apps/browser-demos/test/kgpu-crossing-bench.spec.ts`, tagged `@slow`.
  - It runs 10,000 clear-and-viewport pairs through the executor two ways:
    one import per call, and an experimental batched variant (a
    `kgpu_backend.run_batch(ptr, len)` import executing a compact call list
    in JavaScript).
  - It reports median time per call on each engine.
- Create: `docs/measurements/2026-11-27-kgpu-crossing.md`: method, machine, engine versions, results, and the decision with its reason.
- Modify: `docs/architecture.md`: a new section, "Kernel GPU execution (kgpu)", describing slice 1 as implemented. It covers the ownership split, the `kandelo.kgpu.v1` extension, extents and pins, rings, the GPU worker and the Node boundary.
- Modify: `docs/plans/2026-11-27-rust-gpu-driver-design.md`: record the crossing decision under Backends.

- [ ] **Step 1: Write the bench spec** and run it on Firefox, WebKit and
  Chromium: `npx playwright test test/kgpu-crossing-bench.spec.ts --project=<engine>`.
- [ ] **Step 2: Record the results and decision.** Keep the batched variant
  only if it wins by a margin larger than run-to-run spread on at least two
  engines. Otherwise delete it.
- [ ] **Step 3: Update the docs.**
- [ ] **Step 4: Run the final slice validation:**
  - `scripts/dev-shell.sh cargo test --workspace --exclude xtask --target aarch64-apple-darwin`
  - `cd host && npx vitest run`
  - the Task 8 spec on all three engines
  - `scripts/dev-shell.sh bash scripts/check-abi-version.sh`

  Record exactly what ran and what did not.
- [ ] **Step 5: Commit.** Message: `Docs: Record kgpu slice 1 and the crossing decision`.
