# Kernel Message Ring and Syslog Facility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a Kandelo machine a real kernel message ring readable through `klogctl` and `/dev/kmsg`, a real syslog path through `/dev/log` and sysklogd, and canonical `dmesg` and `logger` utilities, replacing two shipping honesty violations.

**Architecture:** A statically allocated structured ring in `crates/runtime-core/src/kmsg.rs`, machine-global because the kernel is a separate Wasm module with its own linear memory. Two read surfaces: `klogctl` (newly routed syscall) and `/dev/kmsg` (new char device whose per-open cursor is the OFD file position). Userspace syslog is upstream sysklogd reading `/dev/kmsg` and listening on a pathname AF_UNIX datagram socket, writing a now-durable `/var/log`.

**Tech Stack:** Rust (`crates/runtime-core`, `crates/kernel`), C (`libc/glue`), TypeScript (`host/src`, `images/vfs`), sysklogd 2.8.0 and util-linux as registry packages.

**Spec:** `docs/superpowers/specs/2026-11-05-kernel-log-and-syslog-design.md`

## Global Constraints

- **Kandelo is not Linux.** No documentation added by this plan may claim, imply, or work toward Linux compatibility. Never define `__linux__`, SDK-wide or per package.
- Ring size is **128 KiB, fixed, statically allocated, not configurable**.
- Record fields: `seq: u64`, `ts_nsec: u64` (`CLOCK_MONOTONIC`), `facility: u8`, `level: u8`, `flags: u8`, `text_len: u16`. **Kernel-internal; never `repr(C)`-exposed, never ABI surface.**
- Priority encoding is `pri = facility * 8 + level` (RFC 5424). Kernel records use facility `LOG_KERN` (0).
- `/dev/kmsg` line format: `<pri>,<seq>,<ts_usec>,<flag>;<text>` — **microseconds** in the line, nanoseconds in storage.
- `VirtualDevice::Kmsg` sentinel is **−13**. −12 is `Clipboard`.
- Ring reads are unrestricted; **clear requires root**. `/dev/kmsg` writes return `EACCES`.
- Overrun returns **`EPIPE`** and resets the cursor to the oldest surviving record.
- ABI: **55 → 56, one bump**, claimed once in Task 3 (`crates/program-abi/src/lib.rs`). Every later task touching ABI surface regenerates `abi/snapshot.json` with `cargo xtask dump-abi` in the same commit. A bump invalidates every built artifact under strict `__abi_version` equality.
- Both new `package.toml` files set `kernel_abi = 56`. Do not copy stale values from neighbouring manifests.
- sysklogd **2.8.0**, BSD-3-Clause. Install `syslogd` and `logger` only — **never its `syslog.h` replacement or `libsyslog`**, which must not shadow musl's.
- util-linux builds **`dmesg` only**.
- `syslogd` is **eager** and dinit-supervised; `dmesg` and `logger` are **lazy file references** via `SHELL_LAZY_BINARY_SPECS`.
- `/var/log` becomes durable on saved computers, bounded by **both** sysklogd rotation and a per-mount byte cap.
- Logging is optional per image: omitting the userspace half must error nowhere.
- Commit subjects use `Area: Purpose`. **No AI attribution lines** in commits or PR descriptions.
- After any `libc/glue` edit, run `scripts/dev-shell.sh bash scripts/build-musl.sh --ensure --core-only` before trusting `./run.sh setup`, Vitest or conformance results.
- Do not edit anything under `packages/registry/` while a package or local build is running.
- Long builds and suites: `scripts/agent-job start -- <cmd>` then `scripts/agent-job wait <id>`, waiting from the main session.

## Review Focus

Five failure modes the spec implies but does not pin. Each has a test added to the task that owns the code.

1. **Embedded newline or NUL in a message forges a record boundary** in the newline-delimited `/dev/kmsg` line format — a program logging `"a\n7,1,0,-;fake"` could synthesise a kernel record. Text must be escaped on render. (Task 4)
2. **A read buffer smaller than the next record** must return `EINVAL`, never a partial or silently truncated record, or a reader with a small buffer loses data believing it read successfully. (Task 4)
3. **A cursor sitting exactly at the eviction boundary** when the ring wraps must yield `EPIPE` exactly once and then the oldest surviving record — the off-by-one here either loses a record silently or repeats `EPIPE` forever. (Task 4)
4. **The `/var/log` byte cap being reached** must surface as `ENOSPC` on write, and the daemon must not spin retrying. (Task 9)
5. **The suppression record itself being rate-limited** would turn a flood into total silence, which is worse than the flood. The `… N messages suppressed` record must always be emitted. (Task 2)

---

### Task 1: Kernel message ring core

**Files:**
- Create: `crates/runtime-core/src/kmsg.rs`
- Modify: `crates/runtime-core/src/lib.rs` (declare `pub mod kmsg;`; remove the dead `debug_log` and its `host_debug_log` import, which have zero callers)
- Modify: `crates/kernel/src/wasm_api.rs` (drop the unused `host_debug_log` import declaration)
- Test: inline `#[cfg(test)] mod tests` in `crates/runtime-core/src/kmsg.rs`, following `crates/runtime-core/src/unix_socket.rs`

**Interfaces:**
- Consumes: nothing
- Produces: `pub struct KmsgRing`, `pub struct KmsgRecordRef<'a>` (borrowed view of one record: `seq`, `ts_nsec`, `facility`, `level`, `flags`, `text: &'a [u8]`), `pub const KMSG_CAPACITY_BYTES: usize = 128 * 1024`, `pub unsafe fn global_kmsg_ring() -> &'static mut KmsgRing`, `KmsgRing::push(&mut self, facility: u8, level: u8, ts_nsec: u64, text: &[u8]) -> u64` (returns the assigned `seq`), `KmsgRing::read_at(&self, seq: u64) -> Result<KmsgRecordRef<'_>, Errno>`, `KmsgRing::oldest_seq(&self) -> u64`, `KmsgRing::head_seq(&self) -> u64`, `KmsgRing::clear(&mut self)`, `KmsgRing::byte_len(&self) -> usize`, `KmsgRing::unread_bytes(&self, seq: u64) -> usize`

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn push_assigns_monotonic_sequence_numbers()
#[test] fn read_at_returns_the_pushed_record()       // facility, level, ts_nsec, text round-trip
#[test] fn wraparound_evicts_oldest_and_keeps_seq_monotonic()  // seq never reused after eviction
#[test] fn read_at_evicted_seq_is_epipe()
#[test] fn text_longer_than_capacity_is_truncated_with_the_truncation_flag()
#[test] fn clear_empties_the_ring_and_does_not_reset_seq()
#[test] fn oldest_and_head_seq_bracket_the_live_records()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p runtime-core --target "$(rustc -vV | awk '/^host/ {print $2}')" --lib kmsg`
Expected: FAIL — `kmsg` module not found.

- [ ] **Step 3: Implement the ring in `crates/runtime-core/src/kmsg.rs`**

One pre-allocated `[u8; KMSG_CAPACITY_BYTES]` byte ring holding header-plus-text records, so steady state allocates nothing. Expose it through the `static` + `UnsafeCell` + `unsafe fn global_*()` pattern used by `crates/runtime-core/src/unix_socket.rs:235`. `seq` is assigned from a counter that eviction never rewinds.

- [ ] **Step 4: Run tests to verify they pass**

Run: same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-core/src/kmsg.rs crates/runtime-core/src/lib.rs crates/kernel/src/wasm_api.rs
git commit -m "Kernel: Add the kernel message ring"
```

---

### Task 2: Rate limiting and suppression records

**Files:**
- Modify: `crates/runtime-core/src/kmsg.rs`
- Test: same inline test module

**Interfaces:**
- Consumes: Task 1's `KmsgRing`
- Produces: `pub struct CallsiteLimiter`, `KmsgRing::push_limited(&mut self, site: CallsiteId, facility: u8, level: u8, ts_nsec: u64, text: &[u8]) -> Option<u64>`, `pub type CallsiteId = u32`

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn push_limited_admits_the_first_burst_then_suppresses()
#[test] fn suppression_emits_a_count_record_naming_how_many_were_dropped()
#[test] fn suppression_record_is_never_itself_suppressed()   // Review Focus 5
#[test] fn distinct_callsites_are_limited_independently()
#[test] fn the_window_reopens_after_the_quiet_interval()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p runtime-core --target "$(rustc -vV | awk '/^host/ {print $2}')" --lib kmsg`
Expected: FAIL — `push_limited` not defined.

- [ ] **Step 3: Implement per-callsite limiting**

Token-bucket or burst-then-interval per `CallsiteId`, chosen for a fixed-size table rather than a map, since the callsite set is static. The suppression record bypasses the limiter unconditionally.

- [ ] **Step 4: Run tests to verify they pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-core/src/kmsg.rs
git commit -m "Kernel: Rate-limit kernel log callsites with honest suppression counts"
```

---

### Task 3: ABI 56 and `klogctl`

**Files:**
- Modify: `crates/program-abi/src/lib.rs:227` (`ABI_VERSION` 55 → 56)
- Modify: `libc/glue/syscall_glue.c:1909` (remove `SYS_SYSLOG` from the `-EPERM` block; route it near the `SYS_UNAME` / `SYS_SYSCONF` cases)
- Modify: `crates/kernel/src/wasm_api.rs` (export `kernel_syslog`)
- Modify: `crates/runtime-core/src/syscalls.rs` (handler)
- Modify: `abi/snapshot.json` (regenerated)
- Test: inline tests in `crates/runtime-core/src/syscalls.rs`; `tests/libc/` case for the routed syscall

**Interfaces:**
- Consumes: Task 1 `global_kmsg_ring`, Task 2 limiter
- Produces: `pub fn sys_syslog(host: &mut impl HostIO, action: i32, buf: *mut u8, len: i32, uid: u32) -> Result<i32, Errno>`; C entry `kernel_syslog(action, buf_ptr, len)`

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn action_3_read_all_returns_every_live_record_with_pri_prefixes()
#[test] fn action_9_size_unread_matches_bytes_after_the_cursor()
#[test] fn action_10_size_buffer_reports_128_kib()
#[test] fn action_2_read_consumes_what_it_returns()
#[test] fn actions_4_and_5_require_root()            // non-root → EPERM
#[test] fn actions_6_7_8_console_level_return_einval()
#[test] fn unknown_action_returns_einval()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p runtime-core --target "$(rustc -vV | awk '/^host/ {print $2}')" --lib syslog`
Expected: FAIL — `sys_syslog` not defined.

- [ ] **Step 3: Bump `ABI_VERSION` to 56 and regenerate the snapshot**

Run: `cargo xtask dump-abi`

- [ ] **Step 4: Implement the handler and route the syscall**

Action table exactly as the Global Constraints list it. `SYS_SYSLOG` stays Kandelo syscall 304. Reads unrestricted; 4 and 5 gated on `uid == 0`.

- [ ] **Step 5: Rebuild musl, since the glue changed**

Run: `scripts/dev-shell.sh bash scripts/build-musl.sh --ensure --core-only`

- [ ] **Step 6: Run tests to verify they pass** — Step 2's command. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/program-abi/src/lib.rs abi/snapshot.json libc/glue/syscall_glue.c crates/kernel/src/wasm_api.rs crates/runtime-core/src/syscalls.rs
git commit -m "POSIX: Route klogctl to the kernel message ring (ABI 56)"
```

---

### Task 4: `/dev/kmsg`

**Files:**
- Modify: `crates/runtime-core/src/syscalls.rs` (`VirtualDevice::Kmsg`, `match_virtual_device`, `host_handle`/`from_host_handle`, read/write/lseek dispatch)
- Modify: `crates/runtime-core/src/devfs.rs` (list `kmsg` in `/dev`, and its `stat`)
- Modify: `abi/snapshot.json` (regenerated — new sentinel)
- Test: inline tests in `crates/runtime-core/src/syscalls.rs`

**Interfaces:**
- Consumes: Task 1 ring, Task 3's ABI 56 epoch
- Produces: `VirtualDevice::Kmsg` at sentinel −13; `pub fn kmsg_render_line(rec: &KmsgRecordRef<'_>, out: &mut [u8]) -> Result<usize, Errno>`

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn open_dev_kmsg_yields_a_chardevice_ofd_with_sentinel_minus_13()
#[test] fn each_read_returns_exactly_one_record_in_pri_seq_usec_flag_format()
#[test] fn timestamps_render_as_microseconds_from_nanosecond_storage()
#[test] fn two_opens_have_independent_cursors()
#[test] fn forked_child_sharing_the_ofd_shares_the_cursor()
#[test] fn lseek_set_rewinds_to_oldest_and_end_seeks_to_tail()
#[test] fn write_to_dev_kmsg_returns_eacces()
#[test] fn embedded_newline_and_nul_are_escaped_not_emitted_raw()   // Review Focus 1
#[test] fn buffer_smaller_than_the_next_record_returns_einval()     // Review Focus 2
#[test] fn cursor_exactly_at_the_eviction_boundary_yields_one_epipe_then_oldest()  // Review Focus 3
#[test] fn dev_kmsg_is_listed_in_dev_and_stats_as_a_character_device()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p runtime-core --target "$(rustc -vV | awk '/^host/ {print $2}')" --lib kmsg_device`
Expected: FAIL — `VirtualDevice::Kmsg` not defined.

- [ ] **Step 3: Implement the device**

**The cursor is the OFD file position** — no side table. Confirm first that CharDevice OFDs retain the offset field rather than discarding it; if they discard it, that is the one place this task changes OFD handling. Escape `\n` and NUL when rendering text, because the line format is newline-delimited and raw text would let a message forge a record boundary.

- [ ] **Step 4: Regenerate the ABI snapshot** — `cargo xtask dump-abi`

- [ ] **Step 5: Run tests to verify they pass** — Step 2's command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/runtime-core/src/syscalls.rs crates/runtime-core/src/devfs.rs abi/snapshot.json
git commit -m "POSIX: Add /dev/kmsg with per-open record cursors"
```

---

### Task 5: Authored kernel events

**Files:**
- Modify: `crates/runtime-core/src/syscalls.rs`, `crates/runtime-core/src/process.rs`, `crates/runtime-core/src/signal.rs`, `crates/runtime-core/src/memory.rs`, `crates/kernel/src/wasm_api.rs` (call sites)
- Test: inline tests beside each call site

**Interfaces:**
- Consumes: Task 2 `push_limited`
- Produces: `pub fn klog(host: &mut impl HostIO, site: CallsiteId, level: u8, args: ...)` convenience wrapper in `kmsg.rs` that reads `CLOCK_MONOTONIC` and pushes

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn boot_records_abi_version_wasm_width_memory_budget_and_rootfs_identity()
#[test] fn mounting_a_vfs_image_records_the_mount()
#[test] fn device_attach_records_the_device()        // fb0, dri/card0, input/event{0,1}, dsp, clipboard
#[test] fn process_death_by_signal_records_pid_and_signal()
#[test] fn memory_budget_refusal_records_the_refusal()
#[test] fn fork_save_buffer_overflow_records_the_overflow()
#[test] fn unavailable_host_capability_records_which_one()
```

- [ ] **Step 2: Run tests to verify they fail** — `cargo test -p runtime-core ... --lib klog`. Expected: FAIL.

- [ ] **Step 3: Thread `host` to each call site and emit the events**

Only the event classes listed in the spec. **No syscall-hot-path logging.** Where a call site lacks a `HostIO` reference, thread `host` through rather than emitting a record without a timestamp.

- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-core/src crates/kernel/src
git commit -m "Kernel: Record boot, mount, device and process-death events"
```

---

### Task 6: `ENOSYS` reporting

**Files:**
- Modify: `crates/runtime-core/src/syscalls.rs` (the unimplemented-syscall return path)
- Test: inline tests

**Interfaces:**
- Consumes: Task 2 `push_limited`, Task 5 `klog`
- Produces: nothing new

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn an_unimplemented_syscall_records_its_number_and_name()
#[test] fn a_spinning_caller_is_suppressed_and_the_boot_log_survives()
#[test] fn enosys_records_do_not_appear_for_implemented_syscalls()
```

- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Emit a rate-limited record on the `ENOSYS` path**

One `CallsiteId` per syscall number so a flood from one syscall does not suppress reporting of a different one.

- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-core/src/syscalls.rs
git commit -m "Kernel: Report unimplemented syscalls to the kernel log"
```

---

### Task 7: Blocking tail and `poll`

**Files:**
- Modify: `crates/runtime-core/src/syscalls.rs` (blocking read registration; the `POLLIN` gate beside `crate::mouse::has_data()` at `:15640`)
- Test: inline tests, plus `host/test/kmsg-poll.test.ts`

**Interfaces:**
- Consumes: Task 4's device; `BlockingRetryOperation::Read` with `BlockingRetryTarget::Ofd(StableOfdTarget)` (`crates/runtime-core/src/blocked_retry.rs:153`, admitted by `supports()` at `:227`)
- Produces: nothing new

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn read_at_the_tail_blocks_rather_than_returning_zero()
#[test] fn a_pushed_record_wakes_a_blocked_reader()
#[test] fn pollin_is_clear_at_the_tail_and_set_once_a_record_arrives()
#[test] fn o_nonblock_read_at_the_tail_returns_eagain()
```

- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Register the blocking read and gate `POLLIN` on `cursor < head_seq`**

No new `BlockingRetryTarget` variant — `Ofd` already covers it.

- [ ] **Step 4: Run tests to verify they pass.** Also run `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/kmsg-poll.test.ts'`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-core/src/syscalls.rs host/test/kmsg-poll.test.ts
git commit -m "POSIX: Support blocking tail reads and poll on /dev/kmsg"
```

---

### Task 8: `/dev/console` as a real device

**Files:**
- Modify: `crates/runtime-core/src/syscalls.rs:267` (split `/dev/console` out of the `/dev/null` arm; new `VirtualDevice` variant and sentinel −14)
- Modify: `abi/snapshot.json` (regenerated)
- Test: inline tests

**Interfaces:**
- Consumes: Task 1 ring, Task 3's ABI 56 epoch
- Produces: `VirtualDevice::Console` at sentinel −14

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn writes_to_dev_console_reach_the_console_not_dev_null()
#[test] fn kernel_ring_records_are_echoed_to_the_console()
#[test] fn writes_arriving_at_dev_console_never_enter_the_ring()  // one-way, console-ward
#[test] fn log_cons_fallback_from_musl_syslog_reaches_the_console()
```

- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement the device**

Flow is one-way: ring records echo **to** the console, the way `printk` writes both. Userspace writes arriving **at** `/dev/console` reach the console only and never enter the ring — routing them in would be injection by a second path and would break the guarantee that every record is kernel-sourced.

- [ ] **Step 4: Regenerate the ABI snapshot** — `cargo xtask dump-abi`

- [ ] **Step 5: Run tests to verify they pass.** Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/runtime-core/src/syscalls.rs abi/snapshot.json
git commit -m "POSIX: Make /dev/console a real device instead of /dev/null"
```

---

### Task 9: Durable `/var/log` with a byte cap

**Files:**
- Modify: `crates/runtime-core/src/tmpfs.rs:119` (remove `/var/log` from `SCRATCH_MOUNTS`; use the existing `byte_limit` field for the remaining mounts' cap plumbing)
- Modify: `host/src/vfs/default-mounts.ts:77` (drop the `/var/log` scratch entry) and `KERNEL_TMPFS_OWNED_PREFIXES`
- Modify: `docs/browser-support.md` (the volatile-mount list no longer includes `/var/log`)
- Test: inline Rust tests; `host/test/vfs/default-mounts.test.ts:112`

**Interfaces:**
- Consumes: nothing
- Produces: `/var/log` served from the rootfs journal; a per-mount byte cap honored on write

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn var_log_is_not_a_scratch_mount()
#[test] fn var_log_writes_persist_through_the_rootfs_journal()
#[test] fn a_write_past_the_var_log_byte_cap_returns_enospc()   // Review Focus 4
#[test] fn an_image_with_no_var_log_content_still_mounts()
```

```typescript
// host/test/vfs/default-mounts.test.ts
it("no longer declares /var/log as a scratch mount")
it("still refuses a scratch mount the kernel tmpfs does not serve")
```

- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL — `/var/log` still in `SCRATCH_MOUNTS`.

- [ ] **Step 3: Move `/var/log` onto the journal and enforce the cap**

Returning `ENOSPC` rather than silently dropping is what lets a daemon react instead of believing it logged. Update `docs/browser-support.md` in the same commit, since persisting `/var/log` also persists the nginx, mariadb, php-fpm and ruby-todo service logs already written there — an intended behavior change for those products that must be documented.

- [ ] **Step 4: Run tests to verify they pass.** Run the Rust filter and `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/vfs/default-mounts.test.ts'`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-core/src/tmpfs.rs host/src/vfs/default-mounts.ts host/test/vfs/default-mounts.test.ts docs/browser-support.md
git commit -m "Browser: Persist /var/log on saved computers with a byte cap"
```

---

### Task 10: Make `/dev/log` bindable

**Files:**
- Modify: `crates/runtime-core/src/devfs.rs:54` (recognize `/dev/log` as a bindable socket name)
- Modify: `crates/runtime-core/src/syscalls.rs:14238` (`sys_bind`'s devfs arm) and the `unlink`/`stat` paths for the same name
- Test: inline tests in `crates/runtime-core/src/devfs.rs` and `crates/runtime-core/src/syscalls.rs`

**Interfaces:**
- Consumes: `crates/runtime-core/src/unix_socket.rs` registry
- Produces: `pub fn devfs::is_bindable_socket_path(path: &[u8]) -> bool`

**Why this task exists:** the spec claimed `/dev/log` was ordinary use of existing machinery. The registry is indeed mature, but the **namespace is not writable**: `devfs::is_delegated_path` covers only `/dev/shm`, so a `bind()` of a name that does not already exist under `/dev` fails resolution with `EROFS`, and an existing name yields `EADDRINUSE` (see the comment in `sys_bind`). Without this task sysklogd cannot create its listening socket and the whole syslog half is dead. musl hardcodes `/dev/log` in `src/misc/syslog.c`, so moving the path is not an option — relocating it would break `syslog(3)`, which is the POSIX part of this work.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn binding_dev_log_creates_the_socket_instead_of_erofs()
#[test] fn a_second_bind_of_dev_log_returns_eaddrinuse()
#[test] fn dev_log_appears_in_dev_listings_and_stats_as_a_socket()
#[test] fn unlinking_dev_log_releases_the_name_for_rebinding()
#[test] fn other_new_names_under_dev_still_return_erofs()
#[test] fn connecting_to_dev_log_reaches_the_bound_endpoint()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p runtime-core --target "$(rustc -vV | awk '/^host/ {print $2}')" --lib dev_log`
Expected: FAIL — binding returns `EROFS`.

- [ ] **Step 3: Implement the bindable name**

Add a narrow devfs predicate for socket names the kernel permits `bind()` to create, and consult it in `sys_bind` before the existing `EADDRINUSE` short-circuit. `/dev/log` is the only such name. The endpoint itself lives in the path-keyed unix socket registry, exactly as other pathname sockets do; devfs owns only the name's existence, `stat` and `unlink`. Keep every other new name under `/dev` returning `EROFS` — this is one permitted name, not a writable `/dev`.

- [ ] **Step 4: Run tests to verify they pass** — Step 2's command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-core/src/devfs.rs crates/runtime-core/src/syscalls.rs
git commit -m "POSIX: Allow a syslog daemon to bind /dev/log"
```

---

### Task 11: sysklogd package

**Files:**
- Create: `packages/registry/sysklogd/package.toml`, `packages/registry/sysklogd/build.toml`, `packages/registry/sysklogd/build-sysklogd.sh`
- Modify: `packages/sets/local-supported.toml` (add a `[[packages]]` entry, `class = "user-software"`)

**Interfaces:**
- Consumes: Task 4's `/dev/kmsg`, which sysklogd reads natively
- Produces: outputs `syslogd` (`syslogd.wasm`) and `logger` (`logger.wasm`)

- [ ] **Step 1: Write the package manifests and build script**

Follow `packages/registry/lhasa/` as the current-contract autoconf reference: `source scripts/package-build-roots.sh`, `kandelo_package_load_source_metadata`, `kandelo_package_prepare_build_roots`, `kandelo_package_stage_verified_source`, `source sdk/activate.sh`, `wasm32posix-configure`, `make`, then `install_local_binary` per output. `kernel_abi = 56`. License `BSD-3-Clause`. Pin the 2.8.0 release tarball with its sha256.

**Install `syslogd` and `logger` only.** Configure must not install sysklogd's `syslog.h` or `libsyslog`: Kandelo's `syslog(3)` is musl's, and the entire point is that unmodified programs linking musl start working.

- [ ] **Step 2: Build it**

Run: `scripts/agent-job start -- bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh sysklogd wasm32` then `scripts/agent-job wait <id>`
Expected: both outputs produced. On failure, fix the **first** error, not the last.

Two risks the spec records as unproven: upstream claims musl compatibility only for the client-side `syslog()` API, not for building the daemon against musl; and since ABI 46 the SDK permits unresolved executable symbols only from its generated host import list, so configure probes may need `ac_cv_func_*` / `ac_cv_funclib_*` seeds from real archive symbols (`sdk/config.site`). If anything demands `__linux__`, that is a boundary to surface, not to satisfy.

- [ ] **Step 3: Verify the outputs resolve**

Run: `cargo xtask build-deps output-path sysklogd syslogd.wasm`
Expected: a path, not a hardcoded guess.

- [ ] **Step 4: Commit**

```bash
git add packages/registry/sysklogd packages/sets/local-supported.toml
git commit -m "Packages: Add sysklogd 2.8.0 for syslogd and logger"
```

---

### Task 12: util-linux `dmesg` package

**Files:**
- Create: `packages/registry/util-linux/package.toml`, `build.toml`, `build-util-linux.sh`
- Modify: `packages/sets/local-supported.toml`

**Interfaces:**
- Consumes: Tasks 3 and 4 (`klogctl` and `/dev/kmsg`, which upstream `dmesg` reads)
- Produces: output `dmesg` (`dmesg.wasm`)

- [ ] **Step 1: Check for an existing package first**

The spec records that a util-linux session was noted as owning `renice`. If a `util-linux` package already exists on another branch, join it rather than creating a second. Record what you found either way.

- [ ] **Step 2: Write the manifests and build script**

`lhasa` shape again. **Build `dmesg` and nothing else** — the narrowest possible target against a project that assumes Linux throughout. `kernel_abi = 56`.

- [ ] **Step 3: Build it**

Run: `scripts/agent-job start -- bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh util-linux wasm32` then wait.

If it cannot build without `__linux__`, **stop and surface the boundary** rather than defining it. The fallback is a different canonical `dmesg` upstream — not a Kandelo-written one.

- [ ] **Step 4: Verify `dmesg` runs against the real ring**

Run `dmesg` in a machine and confirm it prints the Task 5 boot records with decoded priorities.

- [ ] **Step 5: Commit**

```bash
git add packages/registry/util-linux packages/sets/local-supported.toml
git commit -m "Packages: Add util-linux dmesg"
```

---

### Task 13: Image wiring and the end-to-end syslog path

**Files:**
- Modify: `images/vfs/lib/init/shell-binaries.ts:61` (lazy specs for `dmesg` and `logger`)
- Modify: `images/vfs/scripts/dinit-image-helpers.ts` and the product recipes under `images/vfs/products/` that opt in (eager `syslogd` plus its dinit service)
- Create: `host/test/syslog-end-to-end.test.ts`, `host/test/bare-bones-image.test.ts`

**Interfaces:**
- Consumes: Tasks 11 and 12's outputs; `crates/runtime-core/src/unix_socket.rs` for `/dev/log`
- Produces: a machine where `logger` reaches `/var/log/messages`

- [ ] **Step 1: Write the failing tests**

```typescript
// syslog-end-to-end.test.ts
it("delivers `logger -t test hello` through /dev/log to /var/log/messages with tag and priority")
it("copies kernel ring records into the daemon's output")
it("rotates /var/log/messages at the configured size")

// bare-bones-image.test.ts  — the optionality contract
it("drops syslog(3) without error when no /dev/log exists")   // POSIX: syslog() returns void
it("declares no syslogd dinit service in an image without the package")
it("still serves dmesg and /dev/kmsg with no userspace logging installed")
it("fails logger honestly with a diagnostic and non-zero exit when no daemon is running")
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/syslog-end-to-end.test.ts test/bare-bones-image.test.ts'`
Expected: FAIL.

- [ ] **Step 3: Wire the images**

`syslogd` eager and dinit-supervised in opting-in products; `dmesg` and `logger` as lazy file references. Configure sysklogd's rotation in `syslog.conf` — the option names are in `syslog.conf(5)`, not the README.

- [ ] **Step 4: Run tests to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add images/vfs host/test/syslog-end-to-end.test.ts host/test/bare-bones-image.test.ts
git commit -m "Images: Ship syslogd, dmesg and logger with optional logging"
```

---

### Task 14: Remove the `logger` fake

**Files:**
- Modify: `packages/registry/posix-utils-lite/src/posix-utils-lite.c:392` (delete `util_logger` and its dispatch entry at `:2054`)
- Modify: `packages/registry/posix-utils-lite/package.toml:105` (drop the `logger` output)
- Modify: `docs/posix-status.md` (remove `logger` from the placeholder list; record that it is now canonical sysklogd)

**Interfaces:**
- Consumes: Task 13's installed `logger`
- Produces: nothing

- [ ] **Step 1: Write the failing test**

```typescript
it("resolves /usr/bin/logger to sysklogd's logger, not the posix-utils-lite applet")
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL — the applet still shadows it.

- [ ] **Step 3: Delete the fake and update the status doc**

This discharges the item the posix-utils-lite replacement campaign parked on this work.

- [ ] **Step 4: Run the test to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/registry/posix-utils-lite docs/posix-status.md
git commit -m "Packages: Replace the posix-utils-lite logger fake with sysklogd's"
```

---

### Task 15: Program-digest tolerance (accepted-digest set + human affirmation)

**Files:**
- Modify: `tools/xtask/src/dump_abi.rs` (surface the existing classifier's additive/breaking verdict as machine-readable output)
- Modify: `tools/xtask/src/local_abi_identity.rs`, `tools/xtask/src/supported_program_baseline.rs`
- Modify: `host/src/constants.ts:2533` (admission: accept a guest digest in the accepted set, not only the current one)
- Create: an accepted-digest record (extend `abi/supported-program-baseline.json` or a sibling artifact — your call, stated in the report)
- Test: xtask unit tests; `host/test/` admission cases

**Interfaces:**
- Consumes: the classifier already in `dump_abi.rs` — `report.additive`, `report.breaking`, `breaking_sections`, `additive_top_level_section()`, and the shape comparators `classify_additive_array_by_number_name` / `..._by_name` / `..._object_by_key`
- Produces: an accepted-digest set the host consults at admission, plus the affirmation record that authorizes extending it

**Why this exists:** today a program carries ONE 32-byte hash over all 27 `abi_surfaces.program` sections, so admission can only compare for equality — you cannot partially match a hash. The classifier already knows, per section and per entry, whether a change was additive, and that knowledge is discarded before admission. This task stops discarding it.

**The gate is human-asserted, not mechanical.** A change can be additive in schema and breaking in behavior: a new errno an existing syscall can now return, a reserved flag bit gaining meaning, a `repr(C)` struct gaining a field. No classifier can see those. So extending the accepted set requires BOTH the classifier calling every moved section additive AND an explicit author affirmation that the addition is behaviorally safe for existing programs. Never one without the other.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn an_additive_only_change_proposes_keeping_the_prior_digest_accepted()
#[test] fn a_breaking_change_resets_the_accepted_set_to_the_current_digest_only()
#[test] fn extending_the_accepted_set_without_an_affirmation_is_refused()
#[test] fn an_affirmation_cannot_authorize_a_breaking_change()
```

```typescript
it("admits a stamped guest whose digest is in the accepted set")
it("still fails hard for a stamped guest outside the accepted set")
it("still warns once and passes for an unstamped legacy guest")
```

- [ ] **Step 2: Run tests to verify they fail.** Expected: FAIL — no accepted-set concept exists.

- [ ] **Step 3: Implement.** The classifier proposes; the affirmation authorizes; the host accepts set membership. Keep the existing hard failure for anything outside the set.

- [ ] **Step 4: Run tests to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git commit -m "ABI: Accept additive program-surface changes with an author affirmation"
```

---

### Task 16: Narrow the baseline guidance and the gate

**Files:**
- Modify: `docs/persistent-program-compatibility.md` (the passage at ~:79-86)
- Modify: `tools/xtask/src/supported_program_baseline.rs` (compare against the declared ABI, not the literal value 55)
- Modify: `host/test/supported-program-baseline.test.ts`

**Interfaces:**
- Consumes: Task 15's accepted-digest set
- Produces: a gate that permits a deliberate epoch bump

**Three defects to fix, all in the maintainer's own 2026-10-30 commit `a1f8442718`:**

1. **It states a prohibition instead of the invariant.** Delete "refuses new program-surface fields as well as changed or removed fields, even if the ordinary snapshot classifier calls the change additive" and "do not work around that". Keep the true and non-obvious fact underneath: an additive program-surface change still invalidates every persisted program under strict digest equality, so being additive is not an exemption — it needs either a version bump or an affirmed accepted-set extension (Task 15).
2. **The gate pins the literal value 55.** Change it to assert the baseline matches the *declared* ABI, so a deliberate bump is not refused.
3. **The suite asserts the wrong thing.** `host/test/supported-program-baseline.test.ts` asserts the ABI-55 cohort RUNS on the current kernel, which strict-equality ABI cannot provide across any bump — those cases can only pass while ABI stays 55, making the suite incompatible with ever bumping. A v56 cohort cannot fix it: cohorts come from a pinned EARLIER main revision, and none exists at 56. **Flip the assertion** — once the declared ABI moves past the cohort's, assert the cohort is REFUSED with a legible reason, not that it executes. Do not mark these cases as expected failures; an XFAIL is green whatever the failure.

- [ ] **Step 1: Write the failing tests**

```typescript
it("refuses the ABI-55 cohort with a legible reason when the declared ABI is newer")
it("still runs a cohort whose ABI equals the declared ABI")
```
```rust
#[test] fn the_gate_accepts_a_baseline_matching_the_declared_abi()
#[test] fn the_gate_still_refuses_a_baseline_that_does_not_match()
```

- [ ] **Step 2: Run tests to verify they fail.**
- [ ] **Step 3: Rewrite the guidance passage and the gate; flip the suite.**
- [ ] **Step 4: Run tests to verify they pass.** The 8 previously-red cases must be green for the right reason — refusal asserted, not refusal ignored.
- [ ] **Step 5: Commit**

```bash
git commit -m "ABI: Let the program baseline move with a deliberate epoch bump"
```

---

### Task 17: Settle this branch's epoch

**Files:**
- Modify: `crates/program-abi/src/lib.rs`, `abi/snapshot.json`, `abi/supported-program-baseline.json` and the accepted-digest record, as the outcome requires
- Possibly restore: `crates/wasm-artifact/tests/supported_program_baseline_refusal.rs`

**Interfaces:**
- Consumes: Tasks 15 and 16

**Why last:** with tolerance built, this branch's own change may no longer need the epoch bump — which is the outcome the maintainer originally wanted, reached correctly instead of by weakening the admission signal. Determine it empirically; do not assume either way.

Three sections moved when `SYS_SYSLOG` was routed: `syscalls`, `syscall_arg_descriptors` and `channel_scalar_contract`. `syscall_arg_descriptors` is already in `additive_top_level_section()`; the other two are judged by the shape comparators and have not been checked.

- [ ] **Step 1: Run the classifier against this branch's snapshot change and record its per-section verdict.**

- [ ] **Step 2: Decide by that verdict.**
  - **Every moved section additive** → drop the bump, return `ABI_VERSION` to 55, and extend the accepted set with the affirmation that syscall 304's prior contract was a fake-success stub (`304 => 0`) that nothing could usefully depend on. ABI-55 programs keep running.
  - **Any moved section breaking** → keep ABI 56, keep the moved baseline, and restore the negative test proving an ABI-55 program is refused by an ABI-56 kernel.

- [ ] **Step 3: Record the outcome and its reasoning in the report, quotably — it goes in the PR description.**

- [ ] **Step 4: Run `cargo xtask check-program-baseline` and the host admission tests; report both.**

- [ ] **Step 5: Commit**

---

### Task 19: Two dishonest syscall stubs

**Runs after Task 8**, at the end of the kernel half, before the packages.

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs:7579` (`323` `sync_file_range`) and `:7544` (`287` `personality`)
- Modify: `docs/posix-status.md`
- Test: inline tests beside each

**Why:** deleting Task 3's `304 => 0` fake-success stub prompted a check for siblings. Five remain, and they are not equivalent. `229` `sched_yield` and `307` `fadvise64` returning 0 are **correct** — POSIX lets advice be ignored and yielding is legitimately a no-op here, so leave them (a comment recording why is welcome). `257` `membarrier` claims "single-threaded per process in Wasm", which may be stale given pthread support — verify the premise and report rather than guessing. The other two are being fixed here:

- **`323` `sync_file_range` → "advisory, no-op".** Unlike `fadvise`, this carries durability semantics: a caller receiving 0 believes its data reached storage. That became consequential when persistence shipped — saved computers now have a real rootfs journal behind `/var/log` and homes. Either flush what the call names, or return the honest failure. Do not keep claiming success.
- **`287` `personality` → "return 0 (current personality, PER_LINUX)".** Kandelo explicitly disavows being a Linux target and intends no Linux compatibility, so answering `PER_LINUX` is both a fabricated value and a compatibility claim the project rejects. Return the honest answer for a system that has no personality concept.

A broader audit of every dishonest return is deliberately **not** in this task; its prompt is handed off separately at `.context/syscall-honesty-audit-prompt.md`.

- [ ] **Step 1: Write the failing tests** — one per syscall, asserting the honest behavior rather than the current constant.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement both, and verify `membarrier`'s single-threaded premise against real pthread support — report the finding without changing it.**
- [ ] **Step 4: Run the tests plus the runtime-core lib suite.**
- [ ] **Step 5: Record every verdict in `docs/posix-status.md`** — including that `sched_yield` and `fadvise64` are correct as-is, so a later reader does not re-litigate them.
- [ ] **Step 6: Commit**

```bash
git commit -m "POSIX: Stop claiming success for sync_file_range and personality"
```

---

### Task 18: Documentation and full validation

**Files:**
- Modify: `docs/posix-status.md` (the new facility; `dmesg`, `/dev/kmsg` and `klogctl` as non-POSIX by design; `klogctl` actions 6/7/8 unimplemented; userspace `/dev/kmsg` writes unimplemented)
- Modify: `docs/abi-versioning.md` (the ABI 56 epoch and what it invalidates)
- Modify: `docs/architecture.md` (the facility and its layering)

- [ ] **Step 1: Write the documentation**

State plainly that **Kandelo is not Linux and intends no Linux compatibility**, that `dmesg` is universal Unix originating in 4.xBSD, that neither it nor `/dev/kmsg` nor `klogctl` is POSIX, and that the POSIX parts of this facility are `syslog(3)` and `logger(1)`. Document the chosen read interfaces as a design decision with its stated engineering reason, never as a compatibility claim. Document each unimplemented piece as a gap, not a silence.

- [ ] **Step 2: Rebuild everything, since ABI 56 invalidates every artifact**

Run: `scripts/agent-job start -- ./run.sh setup --all` then `scripts/agent-job wait <id>`

- [ ] **Step 3: Run the full suites**

```bash
bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh cargo-workspace
bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest
bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh libc
bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh posix
bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh sortix
```

Conformance suites are required, not optional: this touches syscall behavior, fd semantics, VFS semantics, device behavior and libc glue. Baseline any pre-existing failures against a pristine `origin/main` worktree before attributing one to this work.

- [ ] **Step 4: Verify in the browser**

Run: `./run.sh browser`
Confirm by hand: `dmesg` prints boot records; `logger` lands in `/var/log/messages`; the log survives reload on a saved computer and is lost on a temporary one; a bare-bones image boots with no logging and no error.

- [ ] **Step 5: Confirm Node and browser parity** for every host-visible behavior. No Node-first landing.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "Docs: Document the kernel log and syslog facility"
```

---

## Deferred to follow-up work

Recorded in the spec, deliberately not in this plan: dynamic scratch-mount registration for temporary mounts beneath `/var/log`; userspace `/dev/kmsg` writes; `klogctl` console-level actions 6, 7 and 8; a kernel build flag to omit the ring; and reconciling the browser UI's boot-log pane, which calls itself `syslog` while being fed host-synthesized demo progress lines.
