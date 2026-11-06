# Kernel message ring and syslog facility

Design date: 2026-11-05. Decisions recorded in the [Decision log](#decision-log) were made by the maintainer during the brainstorming session that produced this spec. Baseline tree: `21cfba152d`, program ABI 55.

## Why

A Kandelo machine cannot currently tell you anything about itself.

The kernel emits no diagnostics at all. `debug_log()` (`crates/runtime-core/src/lib.rs:119`) has **zero callers**, and the `host_debug_log` import is declared in both `crates/kernel/src/wasm_api.rs:59` and the host (`host/src/kernel.ts:1856`, which forwards to `console.log`) but is never invoked. There is no kernel message buffer, so there is nothing for a `dmesg` to read: no `/dev/kmsg` and no `/proc/kmsg` (see the device list in `crates/runtime-core/src/devfs.rs` and the procfs entry set in `crates/runtime-core/src/procfs.rs`), and `klogctl` is refused outright — `SYS_SYSLOG` is short-circuited in the libc glue at `libc/glue/syscall_glue.c:1909` and never reaches the kernel.

Two consequences matter.

**Platform gaps are invisible from inside the machine.** When a ported program fails because Kandelo lacks a syscall, the only trace is an errno the program may not report. The person who most needs that information — someone assembling a minimal image, or porting new software — has no way to ask the system what it refused to do.

**Diagnosis after a problem or crash is impossible.** Nothing records device attach, image mounts, process death by signal, allocation failure, or host capability loss. After a failure the evidence is gone.

Two honesty violations ship today as a direct result:

- `syslog(3)` **silently discards every message**. musl connects a `SOCK_DGRAM` AF_UNIX socket to `/dev/log`; no such socket exists, the connect fails, and musl drops the message unless `LOG_CONS` or `LOG_PERROR` is set. `LOG_CONS` opens `/dev/console`, which is itself aliased to `/dev/null` (`crates/runtime-core/src/syscalls.rs:267`), so even the fallback discards.
- `logger(1)` **prints to stdout instead of logging**. `util_logger` in `packages/registry/posix-utils-lite/src/posix-utils-lite.c:392` formats the message and `fprintf`s it. It is one of the fakes catalogued by the posix-utils-lite replacement campaign, which parked it explicitly on "the syslog work in another worktree" — this work.

This design closes all of the above: a real kernel message ring with real read interfaces, a real syslog path, and canonical upstream utilities in place of the fake.

## Kandelo is not Linux

This section is normative, at the maintainer's explicit direction.

`dmesg(8)` is not a Linux invention. It originates in 4.x BSD and ships on macOS, FreeBSD, OpenBSD, NetBSD, illumos/Solaris and AIX. Nothing in this design is adopted because Linux does it.

Neither `dmesg` nor `/dev/kmsg` nor `klogctl(2)` is POSIX. POSIX specifies `syslog(3)`, `openlog(3)`, `closelog(3)` and `setlogmask(3)` (XSI) and the `logger(1)` utility. **Those parts of this work are north-star POSIX conformance.** The kernel message ring and its read interfaces are a facility POSIX does not describe at all, so there is no conformance target to hit — only a design to choose.

Where POSIX is silent, `CLAUDE.md` makes Linux-observable behavior a tiebreaker among otherwise-equivalent designs. The read interfaces here are chosen for the engineering reasons given in [Architecture survey and choice](#architecture-survey-and-choice), and the fact that they match Linux is a tiebreak, not a goal. **Kandelo does not claim, intend, or work toward Linux compatibility.** Documentation for this facility must say so where a reader could otherwise infer a compatibility promise, and the SDK must never define `__linux__` (see the standing rule; gnulib's demand for it is what blocked the gettext tools in the posix-utils campaign).

## Architecture survey and choice

Four distinct architectures exist in this space:

| | Kernel store | What `dmesg` reads | Concurrent readers |
|---|---|---|---|
| **Linux** | structured records; per-record facility, level, monotonic timestamp, sequence number | `/dev/kmsg` — one record per `read(2)`, independent cursor per `open(2)`, non-destructive; or `klogctl(2)` | yes, naturally |
| **FreeBSD / OpenBSD / NetBSD** | `msgbuf`, flat characters, no timestamps | non-destructive `sysctl kern.msgbuf` snapshot, while `/dev/klog` separately **drains** into syslogd | no — one drain consumer, plus a cursorless snapshot |
| **illumos / Solaris** | kernel msgbuf, but syslogd owns the log | `/var/adm/messages` — `dmesg` is literally a syslog reader | n/a |
| **macOS ≥ 10.12** | unified `os_log` store, structured, deferred formatting, `.tracev3` | nothing; `dmesg` is vestigial and `log show` replaced it | yes |

**Chosen: the Linux-shaped mechanism** — `/dev/kmsg` with per-open cursors, plus `klogctl` as a compatibility surface.

The deciding reason is concurrent readers. This design builds both halves of the facility, so `dmesg` and a syslog daemon are simultaneous readers of the same ring. The BSD architecture cannot serve that: `/dev/klog` drains, so whatever syslogd consumes `dmesg` can never see — which is precisely why FreeBSD gives `dmesg` a *separate* sysctl snapshot. That works, but a snapshot has no cursor, so `dmesg --follow` and a tailing syslogd cannot both be served from it. Linux's per-open, non-destructive cursor is the only one of the four that cleanly serves N readers with tailing.

Two supporting reasons: structured records with per-record levels and timestamps are wanted regardless, and the BSDs have neither; and the chosen upstream daemon (sysklogd, below) already reads `/dev/kmsg` natively, keeping a `syslogd.cache` of the last kernel message consumed.

The Solaris architecture was seriously considered because it is far cheaper and fits the persistence decision well. It was rejected because boot messages are produced before any daemon exists, so a kernel buffer is required anyway — and under that design `dmesg` could never show the boot log, which is the single most valuable thing in it.

## 1. The kernel message ring

A new `crates/runtime-core/src/kmsg.rs` owns one statically allocated ring, exposed through the established kernel-global pattern (`static` + `UnsafeCell` + `unsafe fn global_*()`, as in `crates/runtime-core/src/unix_socket.rs:235`).

**The ring is machine-global by construction.** The kernel is a separate Wasm module with its own linear memory, so `fork`, `exec` and copy-on-write never touch it. There is no `fork.rs` serialization, no `process_snapshot_wire` work, and none of the process-state coherence cost that per-process kernel state carries. `Snapshot` in `web-libs/kandelo-session/src/kernel-host.ts` is a boot-descriptor/share artifact rather than a live memory image, so no restore path has to reconstruct the ring: it is machine-lifetime state and dies at reboot, exactly as a real kernel ring does.

### Record format

A fixed header plus variable text in one pre-allocated byte ring, so steady state allocates nothing:

| Field | Type | Purpose |
|---|---|---|
| `seq` | `u64` | monotonic, never reused; survives wraparound |
| `ts_nsec` | `u64` | nanoseconds, machine-relative — see the correction below |
| `facility` | `u8` | RFC 5424 / Linux encoding; kernel records are `LOG_KERN` (0) |
| `level` | `u8` | 0–7, emergency through debug |
| `flags` | `u8` | continuation, truncation |
| `text_len` | `u16` | payload length |

This struct stays **kernel-internal and out of the ABI.** `repr(C)` structs are ABI surface under the ABI contract, so the committed contract is instead the *textual* `/dev/kmsg` line format and the `klogctl` byte stream — the same choice Linux made. The only ABI-adjacent additions are listed in [ABI impact](#abi-impact).

`seq` is included from the start even though `klogctl` does not expose it, because it is what makes the `/dev/kmsg` per-open cursor work and what lets a reader detect it was overrun. Retrofitting sequence numbers after a daemon already depends on the read surface is the expensive ordering.

Using the real syslog `pri = facility * 8 + level` encoding from the start means the syslog layer needs no translation step: the same byte serves `dmesg --decode` and the `<pri>` prefix a daemon expects.

### Size

**128 KiB, fixed, statically allocated.**

Derivation rather than precedent: a ~24-byte header plus 60–100 bytes of text is ~110 bytes per record, so 128 KiB holds roughly 1,200 records. A Kandelo boot produces an estimated 20–50 (boot identity, image mounts, about six device attaches, host capabilities) — roughly 5 KiB. 128 KiB is therefore about 25× the boot log, and protecting the boot log from eviction is the entire purpose of the sizing.

The memory cost is charged to kernel memory, flat per machine, and is negligible against the browser memory envelope. It is **not** configurable in v1: a boot-time knob means new boot-descriptor surface, and descriptors are untrusted input requiring validation and caps.

### What gets recorded

Because `debug_log()` has no callers, there is no existing message stream to inherit and nothing to migrate. Content is authored deliberately.

**Rule: record real kernel state transitions that a user could not otherwise observe. Never tracing.**

In scope for v1:

- boot identity — kernel ABI version, wasm32/wasm64, memory budget, rootfs image identity and its ABI
- VFS image mount and unmount
- device attach and detach (`fb0`, `dri/card0`, `input/event{0,1}`, `dsp`, clipboard)
- process death by signal
- allocation failure, memory-budget refusal, and fork save-buffer overflow
- host capability unavailability (`SharedArrayBuffer`, WebGL, audio worklet)
- **unimplemented syscalls (`ENOSYS`)** — see below

Explicitly excluded: per-syscall tracing. That is the existing opt-in syscall trace ring in `host/src/kernel-worker.ts`, a different tool with a different budget.

### `ENOSYS` reporting and rate limiting

Logging `ENOSYS` returns turns the ring into a live answer to "what does this program need that Kandelo lacks," which serves the platform-values requirement that gaps stay visible better than anything else in the v1 set.

It is also the highest-volume candidate by a wide margin, which makes **rate limiting load-bearing rather than a guardrail.** A program spinning on an unimplemented syscall would otherwise evict the boot log within seconds. Per-callsite suppression is required in the same step, emitting an honest `… N messages suppressed` record rather than quietly dropping.

### Hot path

The performance contract names conditional debug-ring logging for trivial syscalls as a known-bad optimization not to repeat. **This design stays out of that trap by construction:** every event above is boot-, device- or process-lifecycle scale, and `ENOSYS` is a failure path. No kernel-log call is added to the syscall hot path.

### Known cost

The monotonic clock is reached through `host.host_clock_gettime(CLOCK_MONOTONIC)` on a `HostIO` reference, and not every prospective log site necessarily holds one. `host` will be threaded where needed rather than emitting records with a missing-timestamp sentinel; half-timestamped output is the kind of plausible-looking falsehood the platform-values contract forbids. The per-callsite cost is to be enumerated during planning.

**Correction (2026-11-06), after implementation.** An earlier draft of this spec asserted that `CLOCK_MONOTONIC` was "already defined as nanoseconds since kernel boot". That was wrong, and the claim reached the implementation plan before a reviewer caught it. The host's monotonic clock is not machine-relative on either host: Node returns raw `process.hrtime.bigint()` for that clock id (`host/src/platform/node.ts:629`), whose origin is arbitrary and in practice host uptime, while the browser returns `performance.now()`, counting from the worker's time origin. The two hosts therefore disagreed, in the one field `dmesg` prints first, which is a host-parity defect as well as a false statement.

The fix is in the kernel, not the host. The ring captures a baseline on its first monotonic read and stores `now - baseline`, so the first record sits at zero and both hosts become machine-relative identically. The host's clock is deliberately left alone, because the same `CLOCK_MONOTONIC` is what **guest programs** receive from `clock_gettime`: POSIX requires only monotonicity, not a boot origin, so the host's answer is not wrong — it simply is not the origin this one consumer wants. Rebasing there would have changed observable behavior for every guest program to suit the log.

Timestamps are therefore *machine-relative*, measured from the kernel's first monotonic read, and should be described that way rather than as time since boot.

## 2. Read surfaces

### `klogctl` (step 1)

`SYS_SYSLOG` is Kandelo syscall 304 (`libc/glue/syscall_glue.c:236` — Kandelo's own numbering, not Linux's 103), currently returning `-EPERM` from the glue without reaching the kernel. It is lifted out of that block and routed like any real syscall, following the `SYS_UNAME` / `SYS_SYSCONF` shape, with a new kernel handler.

| Action | v1 behavior |
|---|---|
| 2 `READ` (consuming) | implement; shares the cursor logic |
| 3 `READ_ALL` | implement — the surface `dmesg -S` uses |
| 4 `READ_CLEAR`, 5 `CLEAR` | implement, **root only** |
| 9 `SIZE_UNREAD`, 10 `SIZE_BUFFER` | implement |
| 6 `CONSOLE_OFF`, 7 `CONSOLE_ON`, 8 `CONSOLE_LEVEL` | **`EINVAL`** — there is no console log level to set. An honest refusal, not a silent no-op |

**Access posture:** reads unrestricted; clear requires root. A Kandelo machine has no multi-tenant threat model, and gating reads behind root would make `dmesg` useless to the demo audience that most needs it. Clearing stays privileged because it destroys state shared with every other reader.

### `/dev/kmsg` (step 2)

A new `VirtualDevice::Kmsg` with `host_handle` sentinel **−13** (−12 is taken by `VirtualDevice::Clipboard`; see `crates/runtime-core/src/syscalls.rs:178`).

**Per-open cursors are the one genuinely new mechanism.** No existing `VirtualDevice` carries mutable per-open state — the enum is the whole identity, and `InputEvent { device }`'s discriminator is static.

**The cursor is stored as the OFD file position.** This is semantically correct rather than a convenience: on Linux the `/dev/kmsg` cursor is reached *through* `lseek` (`SEEK_SET` → oldest record, `SEEK_END` → tail, `SEEK_DATA` → after last clear), so file position *is* the cursor. Fork and `dup` inheritance then fall out correctly with no bespoke code: a child sharing the OFD shares the cursor, and one that opens its own `/dev/kmsg` gets an independent cursor. Planning must confirm CharDevice OFDs do not currently discard the offset field.

**Blocking tail costs no new machinery.** `BlockingRetryOperation::Read` with `BlockingRetryTarget::Ofd(StableOfdTarget)` is already an admitted combination (`crates/runtime-core/src/blocked_retry.rs:153` and the `supports()` arm at `:227`). No new target variant.

**`poll` follows the established per-device pattern.** `POLLIN` is gated on `cursor < head_seq`, alongside the existing gates — `/dev/input/mice` on `crate::mouse::has_data()` (`crates/runtime-core/src/syscalls.rs:15640`), and the DRI and input-event rings beside it.

**Line format** — the committed contract, since the record struct is not ABI:

```
<pri>,<seq>,<ts_usec>,<flag>;<text>
```

Microseconds in the rendered line, converted from the nanoseconds stored internally.

**Overrun is reported, never hidden.** If a reader's cursor points at a record already evicted by wraparound, the read returns **`EPIPE`** and the cursor resets to the oldest surviving record. A daemon that silently skipped records while the ring wrapped would be producing a quietly false log.

**Writes return `EACCES`.** No userspace injection in v1, keeping the ring strictly kernel-sourced, as on the BSDs. An honest refusal rather than accepting and discarding.

## 3. The syslog layer

### `/dev/log`

A pathname AF_UNIX `SOCK_DGRAM` socket. The endpoint machinery already exists and is mature: `crates/runtime-core/src/unix_socket.rs` holds a global path → `(pid, sock_idx)` registry with fork inheritance (`add_inherited_owner`, keyed on the stable parent owner tuple rather than the retained sockaddr), `rename_path` re-keying after VFS rename, correct abstract-versus-pathname lifetimes, and `ENOMEM` on reserve failure.

**The namespace, however, is not writable, and this requires a kernel change.** `devfs::is_delegated_path` (`crates/runtime-core/src/devfs.rs:54`) delegates only `/dev/shm`, so `/dev` is wholly kernel-owned: a `bind()` of a name that does not already exist under `/dev` fails resolution with `EROFS`, and an existing name yields `EADDRINUSE` — see the comment in `sys_bind` at `crates/runtime-core/src/syscalls.rs:14238`, which records that behavior deliberately. **A daemon therefore cannot create `/dev/log` today**, and the syslog half of this facility does not work without fixing that.

The path is not negotiable. musl hardcodes `/dev/log` in `src/misc/syslog.c`, so relocating the socket — to FreeBSD's `/var/run/log`, for instance — would break `syslog(3)`, which is the POSIX part of this work and the reason the facility exists.

The fix is narrow: devfs recognizes `/dev/log` as a socket name that `bind()` may create, owning only the name's existence, `stat` and `unlink`, while the endpoint lives in the path-keyed registry like any other pathname socket. Every other new name under `/dev` keeps returning `EROFS`; this permits one name, not a writable `/dev`. The implementation plan carries this as its own task.

With that in place, musl's `syslog(3)` starts working with no libc change.

### Daemon: sysklogd

**sysklogd v2.8.0** (released 2026-10-15), BSD-3-Clause, GNU autotools.

Chosen over writing one. A Kandelo-authored daemon would be a new in-repo implementation of exactly the kind the posix-utils-lite campaign is currently undoing, and the standing rule is to replace fakes with canonical upstream per utility.

Three properties make it a good fit:

1. It **already reads `/dev/kmsg`** natively, keeping a `syslogd.cache` of the last kernel message consumed — so it exercises the chosen read surface as upstream intends, with no Kandelo-specific adaptation.
2. It has **built-in log rotation with compression**, specifically for embedded systems, removing any need for cron or a separate rotate daemon.
3. It **ships its own `logger(1)`**, so one package can supply both halves of the userspace story.

Packaging constraints and unknowns, to be settled at packaging time rather than assumed:

- sysklogd also ships `libsyslog` and a **`syslog.h` replacement**. That header must **not** be installed over musl's. Kandelo's `syslog(3)` is musl's, and the whole point is that unmodified programs linking musl begin working. Install the daemon and `logger` only.
- The README does not state whether `/dev/log` is the default listen path or whether it is configurable. Expected to be the default by convention, but unverified.
- The README claims musl compatibility only for the **client-side `syslog()` API**, not for building `syslogd` itself against musl. Treat musl buildability as unproven until built.
- Rotation option names are not in the README; `syslog.conf(5)` is the authority.
- The project banner reads "syslogd for Linux" and the code base is NetBSD-derived. Any demand for `__linux__` is a hard boundary, not something to satisfy — see [Kandelo is not Linux](#kandelo-is-not-linux).

### Service supervision

A dinit service, which needs no new mechanism: dinit already supervises services across the product images, declared per product under `images/vfs/products/`.

Residency: the daemon is started at boot by dinit, so lazy-fetching it on every machine start would move cost rather than remove it. It is **eager** in images that include it. `dmesg` and `logger` are **lazy file references** via `SHELL_LAZY_BINARY_SPECS` (`images/vfs/lib/init/shell-binaries.ts:61`), fetched on first exec.

### Replacing the `logger` fake

`util_logger` (`packages/registry/posix-utils-lite/src/posix-utils-lite.c:392`) is removed and the `logger` output dropped from that package's manifest, replaced by the canonical `logger` from sysklogd. This discharges the item the posix-utils-lite campaign parked on this work.

The end-to-end integration test for the whole syslog layer is then: `logger -t test hello` → `/dev/log` → sysklogd → `/var/log/messages` contains the message with the right tag and priority.

## 4. `/dev/console`

`/dev/console` is currently aliased to `/dev/null` (`crates/runtime-core/src/syscalls.rs:267`), so console writes are discarded. It is in scope here because it is musl's `LOG_CONS` fallback: with no daemon running, musl's documented escape hatch currently leads to the bit bucket.

It becomes a real device that writes to the machine's console. This is a new `VirtualDevice` variant and therefore rides the same ABI bump.

**Flow is one-way, console-ward.** Kernel ring records are echoed *to* the console, the way `printk` writes both the ring and the console. Writes arriving *at* `/dev/console` from userspace reach the console only and never enter the ring — routing them into it would be userspace injection by a second path, contradicting the `EACCES` rule above and ending the guarantee that every ring record is kernel-sourced. This also matches Linux, where `/dev/console` writes do not appear in `dmesg`.

## 5. `/var/log` persistence, rotation, and caps

`/var/log` is **today** a volatile tmpfs scratch mount — `crates/runtime-core/src/tmpfs.rs:119` in the `SCRATCH_MOUNTS` table, and `host/src/vfs/default-mounts.ts:77` as `source: "scratch"` — and documented as such in `docs/browser-support.md`, which lists it alongside `/tmp`, `/var/tmp`, `/var/run` and `/dev/shm` as remaining volatile even on persistent computers, while homes, `/root` and `/srv` were deliberately moved onto the rootfs journal.

**Decision: `/var/log` moves onto the rootfs journal and becomes durable on saved computers.** Logs are precisely what has value after a problem or a crash, which is the case for durability rather than against it.

Two consequences follow and are in scope:

**Blast radius is intended.** `/var/log` already holds dinit service logs for nginx, mariadb, php-fpm and ruby-todo (for example `images/vfs/scripts/build-nginx-php-vfs-image.ts:437` and `build-lamp-vfs-image.ts:354`). Persisting the directory persists those too. That is the point — those are exactly the logs wanted after a crash — but it must be stated, because it changes those products' behavior.

**Growth must be bounded, two ways.** Every scratch mount is `byte_limit: None` today (`crates/runtime-core/src/tmpfs.rs:116`), so `/var/log` is presently bounded only by the machine memory budget the kernel enforces. Once durable it would instead spend the user's OPFS quota, uncapped, and the release already warns that saved computers do not survive the next release.

- sysklogd's built-in rotation, configured in `syslog.conf`, bounds the files it owns.
- A **per-mount byte limit** on `/var/log` bounds the unrotated dinit service logs, which sysklogd does not manage.

Both are required; rotation alone leaves the service logs unbounded, and a cap alone turns lost history into write failures instead of rotated-out history.

## 6. Optionality: bare-bones machines

An image must be able to omit logging entirely and work without error. The split falls out of where each piece lives.

**The kernel half is unconditional:** the ring, `/dev/kmsg`, `klogctl` and `/dev/console`. These are kernel code, not image content — one kernel artifact serves every image, so there is nothing to omit and nothing that can fail to be present. This is deliberate as well as convenient: the ring is *most* valuable on a minimal machine, because `ENOSYS` reporting is how someone assembling one finds out what their image is missing. `dmesg` on a bare machine still prints the boot records.

**The userspace half is opt-in image content:** sysklogd, `/dev/log`, `/var/log/messages`, `logger`, `dmesg`. Omit the package and none of it exists.

**Nothing errors when omitted:**

| Situation | Behavior | Why it is correct |
|---|---|---|
| `syslog(3)` with no `/dev/log` | musl's connect fails; message dropped | POSIX-conformant. `syslog()` returns `void` and the standard specifies no delivery-failure reporting. This is the standard's contract, not a Kandelo workaround |
| `logger` not installed | command not found | as for any uninstalled utility |
| `logger` installed, no daemon | diagnostic on stderr, non-zero exit | correct Unix behavior, identical to a real machine with syslogd stopped. Honest failure, not silent success |
| no syslogd service | no dinit service exists | services are declared per product, so an image without the package declares none |
| image with no `/var/log` content | mount tolerates an empty or absent directory | required of the persistence change |

**Explicitly not built:** a kernel build flag to compile the ring out. Per the standing rule against abstract infrastructure for temporary conditions, that flag is added when a real requirement for a ringless kernel appears, not speculatively.

## Packaging

| Artifact | Source | Residency |
|---|---|---|
| `syslogd` | sysklogd 2.8.0 (new package) | eager, dinit-supervised, in images that opt in |
| `logger` | sysklogd 2.8.0 | lazy file reference |
| `dmesg` | util-linux (new package) | lazy file reference |

`dmesg` needs a second upstream because sysklogd does not provide one. util-linux is acceptable for the binary **provided the Kandelo-is-not-Linux framing above is honored in documentation**, and carries a known porting risk: util-linux assumes Linux throughout and its configure will probe for Linux headers. Building only `dmesg` and nothing else from it is the narrowest possible target. If it proves infeasible without `__linux__`, that is a boundary to surface, and the fallback is a different canonical `dmesg` upstream — not a Kandelo-written one, and not defining `__linux__`.

Coordination check before creating the package: a util-linux session was noted as owning `renice`. If a `util-linux` package already exists there, join it rather than creating a second.

## ABI impact

**One bump, program ABI 55 → 56** (`crates/program-abi/src/lib.rs:227`; `crates/shared/src/lib.rs` re-exports it), with a regenerated `abi/snapshot.json` in the same change.

Two independent reasons, which is the natural shape rather than a batching contrivance:

1. New `VirtualDevice` sentinels (`Kmsg` at −13, and a real console device), which are OFD backing identities that `fork` serializes.
2. `SYS_SYSLOG` newly routed to the kernel — new marshalling for a previously unrouted syscall number, which is explicitly ABI surface.

A bump invalidates every built artifact under strict `__abi_version` equality, so every program, package archive and ABI-bound VFS image must be rebuilt.

## Validation plan

Claims will be scoped to the evidence actually run, per the validation contract. Known-gap-first: no conformance or browser runs while a known API gap in this facility is still open.

- **Rust unit tests** in `kmsg.rs` for ring wraparound, sequence monotonicity across eviction, rate-limit suppression counting, record truncation, and `klogctl` action semantics including the root gate.
- **Rust unit tests** for cursor behavior: independent cursors per open, `EPIPE` on overrun with cursor reset, `lseek` positions, fork and `dup` inheritance.
- **Vitest / host tests** for `/dev/kmsg` read, blocking tail, and `poll` readiness, plus `/dev/log` datagram delivery and the mount-layout change.
- **Conformance suites** — this touches syscall behavior, fd semantics, VFS semantics, device behavior and libc glue, so unit tests and Vitest are not sufficient on their own.
- **Node and browser parity** for every host-visible behavior, with no Node-first landing.
- **Browser verification** with `./run.sh browser` for the user-visible path: boot a machine, run `dmesg`, confirm boot records; run `logger` and confirm `/var/log/messages`; confirm persistence across reload on a saved computer and loss on a temporary one.
- **Bare-bones image** test: an image with no sysklogd, asserting `syslog(3)` drops without error, `logger` fails honestly if present, no dinit service is declared, and `dmesg` still works.
- `scripts/build-musl.sh` after any `libc/glue` edit, before relying on `./run.sh setup`, Vitest or conformance results.

## Follow-ups, explicitly out of scope

- **Dynamic scratch-mount registration**, so temporary mount points can be declared under `/var/log` or anywhere else. Not supported today: the kernel tmpfs is a fixed compile-time table (`crates/runtime-core/src/tmpfs.rs:116`) whose `mount_roots`, `mount_bytes` and `byte_limits` all index into it, and the browser host throws for any scratch mount outside that set (`host/src/vfs/default-mounts.ts:182`), while boot descriptors do accept `source: "scratch"` in their type (`web-libs/kandelo-session/src/boot-descriptor.ts:68`). This is a loud honest refusal rather than silent breakage, so persisting `/var/log` can land first; the escape hatch is its own kernel change.
- Userspace writes to `/dev/kmsg` (message injection).
- `klogctl` console-level actions 6, 7 and 8.
- A kernel build flag to omit the ring.
- Reconciling the browser UI's boot-log pane, which currently calls itself `syslog` (`PrimarySurface` in `web-libs/kandelo-session/src/kernel-host.ts`) while being fed host-synthesized `facility: "kandelo"` progress lines from the demo's own setup code rather than any kernel or syslog state. Now that a real facility exists, that pane's name and its source should be revisited — a browser-contract question of its own.

## Decision log

Maintainer decisions from the 2026-11-05 brainstorming session:

| # | Decision |
|---|---|
| 1 | Build both halves — kernel ring and syslog — not the ring alone |
| 2 | Linux-shaped read mechanism, chosen on concurrent-reader grounds, with the not-Linux framing documented |
| 3 | `logger` is delivered by this series, not handed back to the posix-utils campaign |
| 4 | util-linux acceptable for binaries, provided it is made very clear Kandelo is not Linux and intends no Linux compatibility |
| 5 | sysklogd as the daemon |
| 6 | `/var/log` is persisted; deliberately temporary mounts beneath it are a follow-up |
| 7 | Rotation **and** a per-mount byte cap |
| 8 | `/dev/kmsg` cursor stored as the OFD file position |
| 9 | Unrestricted ring reads; root-only clear |
| 10 | `ENOSYS` reporting included in v1 |
| 11 | Ring size 128 KiB |
| 12 | Logging must be optional for an image, with no error when omitted |
