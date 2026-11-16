# Process-Shared Synchronization: Design

Date: 2026-11-15
Status: Draft for review. No implementation is proposed for merge here.
Contracts touched: POSIX and process semantics, ABI, host runtime (no
change expected), package (CPython).

## Summary

POSIX process-shared synchronization does not work across Kandelo
processes today. Semaphores, mutexes, condition variables and
read-write locks placed in shared memory lose wakeups, fail to exclude,
or report the wrong error (measured below). Barriers and spin locks have
the same problems by code reading. Kandelo nonetheless
advertises `_POSIX_THREAD_PROCESS_SHARED`. CPython therefore builds
`multiprocessing` without `SemLock`.

Two things are broken, not one:

1. **Wait queues are keyed by process.** The kernel parks a futex waiter
   under `(pid, guest address)`, so a wake from another process cannot
   reach it.
2. **Shared words are not atomic across processes.** Each process has
   its own `WebAssembly.Memory`. `MAP_SHARED` bytes converge only at
   syscall boundaries, by merging changed byte runs. A user-space
   compare-and-swap in one process does not see a peer's store made
   since its last syscall. Two processes can both take a binary semaphore
   (measured below).

Fixing the keying alone (Linux's model: shared futexes keyed by the
backing object) would deliver wakeups but would leave mutual exclusion
broken under the default memory model. **Recommendation:** make every
state transition of a process-shared object a kernel operation. Keep the
object's state in a kernel table keyed by the identity of the memory
object that holds it: a file's device and inode plus offset, an
anonymous `MAP_SHARED` object plus offset, a SysV segment plus offset,
or the private address space plus address. Park blocked callers in the
existing kernel wait queue (`runtime_core::wait_park`) under that key.
libc keeps musl's user-space paths for process-private objects and
routes `PTHREAD_PROCESS_SHARED` and `pshared` semaphore operations to
the kernel.

This replaces the existing ID-based pshared table. It needs no new host
wake mechanism, no new `SharedArrayBuffer` and no memory ceiling, on
either host. It costs one syscall per operation on a process-shared
object (about 35–50 µs per operation in the prototype on Node). It
changes the program ABI. It is compatible with the common-memory
process groups of draft PR #1720 and does not depend on them.

A throwaway prototype of the recommended mechanism for semaphores
passes the cross-process cases that fail today, including a
three-process lock-protected counter. See [Prototype evidence](#prototype-evidence).

## Current state

### Process memories

Each process owns one shared `WebAssembly.Memory`
(`createProcessMemory` in `host/src/process-memory.ts`). Threads
created with `CLONE_VM` are Workers over that same memory, so atomics
and futexes between threads of one process behave as on a native
system. `fork` copies the parent's address space into a new memory for
the child (`copyProcessAddressSpace`, `acquireForkMemoryClone`). After
fork, two processes never address the same bytes.

A blocked syscall parks the calling thread in the syscall glue: it
waits with `memory.atomic.wait32` on its channel status word
(`libc/glue/channel_syscall.c`). The kernel worker publishes a result
into that channel and calls `Atomics.notify` on it. One kernel worker
serves every process on both hosts.

### Shared mappings converge at syscall boundaries

Anonymous `MAP_SHARED`, SysV segments and regular-file `MAP_SHARED`
mappings (including `/dev/shm` objects from `shm_open`, memfds,
tmpfs and rootfs files, and host-mounted files) are coordinated at
guest-to-kernel boundaries (`docs/architecture.md`, "Different
processes have different WebAssembly memories"; `docs/wasm-limitations.md`
section 7). At each boundary, the owner of the bytes compares the
process copy with the snapshot that process last observed, merges the
changed byte runs into one authoritative backing, and imports peer
updates into the process.

- The host owns anonymous backings and host-mounted files
  (`synchronizeSharedMemoryForBoundary` and
  `syncAnonymousSharedMappingsFromProcess` in `host/src/kernel-worker.ts`).
  It syncs at both entry and completion.
- The kernel owns SysV segments and every file it serves, in
  `SharedMappingTable` (`crates/runtime-core/src/memory.rs`). It pulls
  other mappers and refreshes the caller at completion.

The kernel knows each file mapping's object (`MappedRegion::file`, with
`st_dev`/`st_ino`). It has no identity for an anonymous `MAP_SHARED`
object; only the host names it (`anon:<pid>:<addr>:<n>` in
`trackAnonymousSharedMapping`).

Merging is last-writer-wins per byte. Direct stores are invisible to a
peer until both cross a boundary. A user-space atomic read-modify-write
of a shared word is therefore not atomic between processes, whatever the
wait queue does.

### futex today

The kernel owns `futex` waits (`sys_futex` in
`crates/runtime-core/src/syscalls.rs`; `crates/runtime-core/src/wait_park.rs`).
`FUTEX_WAIT` reads the word through `HostIO::proc_read_bytes` from the
caller's own memory, compares it and parks the caller. The kernel later
decides the result (wake, deadline, signal, cancellation, exit) and
queues a completion record, which the host publishes into the waiting
thread's channel. The wait source is
`WakeSource::Futex { pid, addr }`. `FUTEX_PRIVATE_FLAG` is accepted and
ignored.

A cross-process wakeup is lost for three independent reasons:

1. The waker's `FUTEX_WAKE` looks up `(waker pid, addr)`; the waiter is
   parked under `(waiter pid, addr)`.
2. `FUTEX_WAIT` compares against the waiter's own copy of the word,
   which may be stale.
3. The libc algorithms around the futex (musl's `sem_post`,
   `pthread_rwlock_*`, robust mutexes) depend on user-space atomics that
   are not coherent between processes.

### The existing kernel pshared table

Kandelo already routes some process-shared pthread objects to the
kernel. `crates/runtime-core/src/pshared.rs` keeps mutexes, condition
variables and barriers in a global table. `pthread_*_init` with
`PTHREAD_PROCESS_SHARED` allocates a `u32` ID and stores it in the user
struct. Lock, unlock, wait and signal call syscalls 400–414
(`crates/kernel/src/wasm_api.rs`; the overrides in
`libc/musl-overlay/src/thread/wasm32posix/`). This made the Sortix
`pthread_condattr_setpshared` test pass (`docs/compromising-xfails.md`
section 3). It has these defects. The probe below exercises the ones
marked "observed"; the others come from reading the code.

| Defect | Evidence |
|---|---|
| A blocked lock polls: the kernel answers `EAGAIN` and the host retries. The module's own comment records this gap. | Observed 9–12 ms handoff latency after unlock. |
| Ownership is by PID, so a process-shared mutex does not exclude the threads of one process. | Observed: a second thread acquires a held recursive mutex. |
| Process exit silently releases held mutexes (`cleanup_process`). POSIX's default `PTHREAD_MUTEX_STALLED` leaves them held; releasing hides possibly inconsistent shared data. | Observed. |
| Robust process-shared mutexes fall back to musl's futex path. `set_robust_list` is a no-op, so the owner's death is never reported. | Observed `EBUSY` instead of `EOWNERDEAD`. |
| `pthread_cond_timedwait` and `pthread_cond_clockwait` are not overridden. They run musl's futex code against a kernel-signalled condition. | Observed: no wakeup, then `EINVAL` at the deadline. |
| `pthread_mutex_timedlock` ignores its timeout (stated in the override). | Code. |
| Condition and barrier waiters are deduplicated by PID. Two threads of one process waiting on one object collide. | Code. |
| `pthread_cond_wait` on the kernel path is not a cancellation point. | Code. |
| Read-write locks, spin locks and semaphores have no kernel path. | Observed for semaphores and read-write locks. |
| IDs are global and unauthenticated. Any process can name any ID, IDs wrap and are reused, and objects that are never destroyed are never freed. The table has no admission bound. | Code. |
| Syscall numbers 400–414 are not recorded in `abi/snapshot.json`, although ABI-56 programs use them. | `abi/snapshot.json` `syscalls`. |

`docs/posix-status.md` has no rows for these functions. Its `futex()`,
`shm_open()` and "No immediate cross-process shared-memory or futex
semantics" entries describe the futex boundary only.

### Observed behavior

`psync-probe.c` (on the prototype branch as `examples/psync_probe.c`)
runs each case with a bounded wait so a lost wakeup shows as a timeout.
Run on Node through `examples/run-example.ts` against the current
`develop` kernel and libc (768475048) on 2026-11-15:

| Case | POSIX expects | Observed today |
|---|---|---|
| A. `sem_init(pshared=1)` in anonymous `MAP_SHARED`; child posts after 0.2 s | `sem_timedwait` returns 0 at ~0.2 s | `ETIMEDOUT` at 3.00 s; value afterwards 1 |
| B. Same with `sem_open` + `sem_unlink` | 0 at ~0.2 s | `ETIMEDOUT` at 3.00 s; value afterwards 1 |
| C. Binary semaphore; parent `sem_trywait`s, child spins without syscalls, then `sem_trywait`s | exactly one succeeds | both succeed (an earlier variant without the spin admitted one, by timing) |
| D. Recursive pshared mutex, second thread `trylock` | `EBUSY` | 0 (acquired) |
| E. Non-robust pshared mutex, owner process exits | `trylock` `EBUSY` | 0 (acquired) |
| F. Robust pshared mutex, owner process exits | `EOWNERDEAD` | `EBUSY` |
| G. pshared `pthread_cond_timedwait`, signalled by child | 0 at ~0.2 s | `EINVAL` at 3.00 s |
| H. pshared mutex, blocked peer, unlock | prompt acquisition | 9.99 ms and 11.53 ms (two runs) |
| I. pshared `pthread_rwlock_timedrdlock`, writer unlocks | 0 at ~0.2 s | `ETIMEDOUT` at 3.00 s |
| J. Three processes, 200 iterations each, counter under a pshared semaphore | counter 600 | counter 284; 2 timed-out acquisitions |

### Relation to draft PR #1720

[#1720](https://github.com/Automattic/kandelo/pull/1720) prototypes
opt-in common-memory process groups. A post-link tool translates trusted
memory32 programs so that each process uses its own virtual mapping root
inside one shared physical `WebAssembly.Memory` per kernel worker (512
MiB, pregrown). Fork preserves virtual pointers. Private pages are
copied, and inherited anonymous `MAP_SHARED` pages remain the same
physical pages. PHP-FPM workers can then share OPcache pointer graphs.

Within such a group, user-space atomics on an inherited anonymous shared
word are coherent. Several things are unchanged:

- `sys_futex` still keys waits by `(pid, virtual address)`, so a futex
  wake still does not cross processes in a group.
- SysV segments and independently mapped files are not directly shared.
- Group members must trust each other.
- An indefinite native `memory.atomic.wait32` cannot reach the
  execution-stop checks. Browsers contain the whole kernel instance
  instead of killing one blocked process.
- It is not the default memory model.

This design does not depend on #1720 and is compatible with it.
Identity keys name the memory object, which is the same whether its
pages are physically shared or merged at boundaries. Kernel-parked
waiters block in the ordinary syscall channel, and the host can end
that wait by publishing a completion. Whether that satisfies #1720's
browser execution-stop protocol for a parked process needs checking
against that branch. If #1720 becomes a supported memory model, its groups could
later use a user-space fast path: musl's ordinary algorithms with a
shared futex keyed the same way. That is phase 6 below.

## POSIX requirements

Sources: POSIX.1-2024 (Issue 8) function pages. Kandelo's
`<unistd.h>` defines `_POSIX_THREAD_PROCESS_SHARED` (the TSH option) and
`_POSIX_SEMAPHORES` (required). `_POSIX_THREAD_ROBUST_PRIO_INHERIT` and
`_PROTECT` are -1. Because the TSH option is advertised, the
process-shared attribute must work. Otherwise Kandelo should stop
advertising it.

| Interface | Status in POSIX | Requirement |
|---|---|---|
| `pthread_mutexattr_setpshared` | TSH option | "permit a mutex to be operated upon by any thread that has access to the memory where the mutex is allocated". This includes threads of one process. |
| `pthread_condattr_setpshared` | TSH | Same, for condition variables. The condition's clock attribute selects the timeout clock. |
| `pthread_rwlockattr_setpshared` | TSH | Same, for read-write locks. |
| `pthread_barrierattr_setpshared` | TSH | Same, for barriers. One waiter per round receives `PTHREAD_BARRIER_SERIAL_THREAD`. |
| `pthread_spin_init(pshared)` | TSH | Same, for spin locks. Spinning is observationally "does not return", so the kernel may park the caller. |
| `pthread_mutexattr_setrobust`, `pthread_mutex_consistent` | Base since Issue 7 | If "the process containing the owning thread of a robust mutex terminates while holding the mutex lock", the next acquirer gets `EOWNERDEAD`. Owner-thread termination "may" be reported. Unlocking without `pthread_mutex_consistent` makes the mutex permanently `ENOTRECOVERABLE`. The default `PTHREAD_MUTEX_STALLED` takes "no special actions"; the mutex stays locked. |
| `sem_init` | Base | Non-zero `pshared` shares the semaphore between processes that can access it. `value > SEM_VALUE_MAX` is `EINVAL`. Using copies is undefined. |
| `sem_open`, `sem_close`, `sem_unlink` | Base | A name with a leading slash names the same object in every process. Other names are implementation-defined. `O_CREAT\|O_EXCL` fails if the name exists. `value > SEM_VALUE_MAX` is `EINVAL`. Whether repeated opens return one handle is implementation-defined. After `sem_unlink`, new opens get a new semaphore and destruction is postponed until all references close. `sem_close` has no effect on the state of a linked semaphore. |

Lifecycle:

- **fork:** "Any semaphores that are open in the parent process shall
  also be open in the child process." Mappings are retained. "Any locks
  held by any thread in the calling process that have been set to be
  process-shared shall not be held by the child process."
- **exec:** open named semaphores are closed as if by `sem_close`.
  Unnamed semaphores "open in the calling process" are destroyed as if
  by `sem_destroy`. Mappings and SysV attachments are removed. The page
  does not mention robust mutexes.
- **exit:** the same semaphore rules as exec. Robust mutexes held by
  the process are reported to the next acquirer.

Timeouts, signals and cancellation:

- `sem_timedwait` and `pthread_mutex_timedlock` use `CLOCK_REALTIME`.
  `sem_clockwait` and `pthread_mutex_clocklock` take a clock.
  `pthread_cond_timedwait` uses the condition's clock attribute.
- Mutex, condition, rwlock and barrier functions "shall not return an
  error code of [EINTR]". A condition wait may return 0 spuriously.
  `sem_wait` and `sem_timedwait` may fail with `EINTR`.
- `sem_wait`, `sem_timedwait`, `sem_clockwait` and the three condition
  waits are required cancellation points (XSH 2.9.5). Mutex lock is not.
  A cancelled condition wait reacquires the mutex before cleanup
  handlers run.

Memory synchronization (XBD 4.15.2): successful mutex, condition,
rwlock, barrier, spin-lock and semaphore operations synchronize memory.
This makes boundary coherence sufficient for lock-protected data. If
every acquire and release is a kernel boundary, the releaser's stores
are merged before the release takes effect. The acquirer then imports
them before it resumes. Case J of the prototype demonstrates this.

Linux-observable choices where POSIX is silent:

- Treat exec like owner death for robust mutexes, as Linux does.
- Do not destroy a `pshared` unnamed semaphore in shared memory when one
  user execs or exits.
- Have `sem_wait` return `EINTR` only for a handler installed without
  `SA_RESTART`, as musl on Linux does.

## Options

### A. Shared futexes keyed by backing object (Linux's model)

Key futex queues by `(object, offset)` for shared mappings, and keep
musl's user-space algorithms. This fixes reason 1 above. Reasons 2 and
3 remain under the default memory model, as probe C shows. It is
correct only where memory is coherent, which today means #1720 groups.
It also targets Linux's `futex(2)` ABI rather than the POSIX
interfaces. **Not recommended as the general mechanism.** It is
retained as the optional coherent-memory fast path in phase 6.

### B. Repair the ID table

Keep IDs in user structs and fix ownership, parking, timeouts,
cancellation and the missing object kinds. The model stays wrong in
ways that cannot be repaired locally. An ID is an unauthenticated
global name, so processes can operate on objects they cannot access.
An ID survives in copied or persisted bytes and can alias a reused
object. An object's lifetime is tied to `destroy` calls rather than to
the memory that holds it. `sem_open` creates semaphores as file bytes,
with no `init` call at the mapped address. **Not recommended.**

### C. Kernel objects keyed by memory-object identity (recommended)

The kernel resolves the object's guest address to the identity of the
memory object that holds it. Object state and wait queues live in the
kernel under that key, and every operation is one syscall. Access
control follows memory access, which matches POSIX's "any thread that
has access to the memory". No IDs are stored in user memory. Identical
behavior under boundary-coherent memory and #1720's physical sharing.
Detailed below.

### D. Variant of C with state in the object's bytes

Keep state in the authoritative backing bytes, as Linux does, and have
the kernel perform the read-modify-write there. State then survives
with a file across machine restarts, and idle objects cost no kernel
memory. However, host-owned backings (anonymous and host-mounted files)
would need a new kernel→host import for atomic word access, which bumps
`HOST_ADAPTER_VERSION`. Every operation would also need a fresh import
of the word for kernel-owned files. In #1720 groups, the kernel would
need real `Atomics` operations on the group backing. **Possible later
refinement** if persistence across restarts is required. See the open
questions.

### E. Make shared memory coherent everywhere

Give every process that maps a shared object direct access to the same
bytes. In the general case WebAssembly cannot do this: one module
instance has one memory, and distinct processes need distinct memories
for isolation. #1720 achieves it for trusted, translated memory32
groups at a cost of address translation, a 512 MiB pregrown
reservation and no isolation. That is a different product decision,
and it would not by itself fix keying. **Out of scope.**

| | A | B | C | D |
|---|---|---|---|---|
| Correct under the default memory model | no | partly | yes | yes |
| Correct in #1720 groups | with shared keys | partly | yes | yes |
| Covers `sem_open` without libc init at the mapped address | yes | no | needs create-time registration | yes |
| New kernel→host import | no | no | no | yes |
| State persists in files across machine restart | yes | no | no | yes |
| Operation cost on a shared object | user-space when uncontended | syscall | syscall | syscall |

## Recommended design

### Object identity

`psync_key(process, address)` resolves the mapping that contains the
address:

| Mapping | Key |
|---|---|
| `MAP_SHARED` file (kernel-owned or host-mounted) | `(File, dev, ino, inode generation, file offset)` |
| Anonymous `MAP_SHARED` | `(Anon, object id, offset)`. The kernel assigns a new object id at `mmap` and inherits it at `fork`. Each fragment records its offset within the object, so `munmap` splits and `mremap` keep the key. |
| SysV attachment | `(Sysv, shmid, segment generation, offset)` |
| Anything else (private mapping, heap, stack, data) | `(Private, address-space id, address)` |

The address-space id is the memory's identity, not the PID. A vfork
child and its parent share it, and an exec replaces it. A fork child's
private copy has a different key, which is POSIX's fork semantics. The
generation fields prevent a reused inode or shmid from inheriting a
dead object's state. No key depends on where a process maps the object,
so two mappings of one file at different addresses agree. In #1720
groups the key is computed from the kernel's mapping metadata in the
same way.

The anonymous object id and fragment offset are new kernel state. File
and SysV identities already exist (`MappingFile`, `SharedMappingTable`).
The fork wire does not need them; like `MappedRegion::file`, they are
copied from the live parent (`MemoryManager::inherit_mapping_files`).

### Object table and lifetime

A kernel `PsyncTable` maps keys to typed objects (mutex, condition,
rwlock, barrier, spin lock, semaphore). Each object records the
attributes passed at init (mutex type, robustness, clock, barrier
count), its state (owner TID, recursion count, value, reader count) and
its wait-queue token. Entries are admitted through the kernel's
fallible allocation. Exhaustion is `ENOMEM`, or `EAGAIN` where the
function's error list prefers it, never an unbounded map.

- `*_init` creates or resets the entry. `*_destroy` removes it. `EBUSY`
  applies where POSIX allows: waiters present, or a held lock.
- An entry is removed when its memory object is destroyed. Anonymous
  objects are destroyed at the last unmap, exit or exec of any mapper.
  SysV segments are destroyed after `IPC_RMID` and the last detach. For
  kernel-owned files, entries are removed at inode release. The kernel
  cannot observe the release of a host-mounted file, so its entries are
  removed at the last mapping. Private-key entries are removed when the
  address space is replaced or destroyed.
- An operation on an address with no entry fails with `EINVAL`. POSIX
  allows this for uninitialized objects. Copying an initialized object
  does not copy its state, and POSIX says using a copy is undefined.

libc still writes the process-shared marker bits into the struct at
init (musl's existing encodings), so later calls know to route to the
kernel. The kernel does not interpret libc's struct layout; libc passes
attributes as syscall arguments. This keeps musl's layouts out of the
kernel ABI.

### Operations

Each operation is one syscall. It returns at once, or it parks in
`wait_park` under a new wake source `PSync { token }` with a
`Resume::PSync` decision, the way `futex` parks today.

- **Mutex:** lock, trylock, timed lock or clocklock, unlock, consistent.
  Ownership is by TID. An unlock hands the mutex directly to the oldest
  waiter, so a woken waiter never races a newcomer. `ERRORCHECK` and
  `RECURSIVE` semantics follow musl.
- **Condition:** wait (release mutex, park), timed/clock wait, signal,
  broadcast. Signal and broadcast move waiters to the mutex's queue,
  like `FUTEX_CMP_REQUEUE`. A waiter completes only after it owns the
  mutex.
- **Read-write lock:** rdlock, wrlock, try forms, timed forms, unlock.
  Writer preference matches musl.
- **Barrier:** wait. The last arriver releases the round and receives
  `PTHREAD_BARRIER_SERIAL_THREAD`.
- **Spin lock:** lock (parks), trylock, unlock.
- **Semaphore:** post (hand off to the oldest waiter, otherwise
  increment, with `EOVERFLOW` at `SEM_VALUE_MAX`), trywait, timed/clock
  wait, getvalue.

### Delivering wakeups on Node and in browsers

The kernel decides each completion for an exact `(pid, tid)` and the
host publishes it. The host's existing path does this the same way for
every process (`#settleKernelWaitsWithinKernelEntry` in
`host/src/kernel-worker.ts`). The waker and the waiter can be in
different processes because both are tasks of the one kernel. Node and
browsers share this code. The design adds no `Atomics.waitAsync` on
guest memory, no host-side wait list and no per-object buffer.

One host change is required. The host treats `EAGAIN` from most
syscalls as "block and retry" (`isRetryResult` in `kernel-worker.ts`).
The new syscall must join `futex`, `rt_sigtimedwait`, `flock` and
`fcntl` in the list whose `EAGAIN` is final, because `sem_trywait` and
the try-lock forms return `EAGAIN`/`EBUSY` as answers. The prototype
hung until this was added.

### Timeouts, signals and cancellation

- **Deadlines** are converted once at park time to the kernel's
  `CLOCK_MONOTONIC` deadline from the requested clock, as
  `FUTEX_WAIT_BITSET` does. A `CLOCK_REALTIME` step during the wait is
  not tracked; this is the gap `futex` already documents. Fixing it for
  both means re-arming realtime parks on a clock step.
- **Signals:** mutex, condition, rwlock, barrier and spin waits never
  surface `EINTR`. After a handler runs, the park is restarted, and a
  condition wait may instead return 0 (a permitted spurious wakeup).
  Semaphore waits return `EINTR` under the same `SA_RESTART` rule the
  futex resume already applies.
- **Cancellation:** semaphore and condition waits are cancellation
  points (`__syscall_cp`). For a cancelled condition wait, the kernel
  turns the waiter into a mutex waiter. It reports the cancellation only
  once the mutex is owned, so cleanup handlers run with the mutex
  locked. Parks end through the existing `cancel_task`, `retire_task`
  and `retire_process`.

### Ownership, robustness, fork, exec and exit

- Owners are kernel TIDs. Task IDs are never reused (`ProcessTable`
  allocates them monotonically), so a dead owner cannot be confused
  with a live task.
- The kernel records which robust mutexes each task holds; it performed
  every lock, so libc's robust list is not needed for process-shared
  mutexes. At thread exit, process exit or exec, each held robust mutex
  is marked owner-dead and one waiter is woken with `EOWNERDEAD`.
  Linux also reports thread exit. POSIX "may" report it.
- A non-robust (`STALLED`) mutex held at exit stays held. A later lock
  blocks, `trylock` returns `EBUSY` and a timed lock times out. This
  removes the current silent release.
- **fork:** locks held by the parent's threads are not held by the
  child, because owners are parent TIDs. Mappings are inherited, so
  keys are shared. Objects in private memory get the child's key.
- **exec and exit:** shared mappings are dropped, which closes named
  semaphores. Waiters of the exiting process retire. Owned robust
  mutexes become owner-dead. Semaphores in shared memory keep their
  state while any mapper or the object exists. Private-key entries go
  with the address space.

### Named semaphores

musl's `sem_open` creates `/dev/shm/sem.<name>`. It writes an
initialized `sem_t` to a temporary file, maps it and publishes it with
`link`. Kandelo's `sem_open` registers the semaphore with the kernel at
the temporary file's mapped address after mapping and before `link`.
That keys it by the temporary file's inode, which becomes the named
file. Nobody can open the name before `link`, so creation needs no
other synchronization. If `link` reports `EEXIST`, the registration is
discarded with the temporary file. Opens then map the file and use its
key. `sem_close` is `munmap`, and `sem_unlink` is `unlink`. The entry
is freed when the inode is released (unlinked and unmapped). No kernel
handle table is needed, and fork, exec and exit follow from the mapping
rules.

The prototype instead materialized a semaphore from its file bytes on
first use. That is simpler, but it trusts guest bytes as kernel state
and is not proposed.

### Coherence of lock-protected data

No change to shared-mapping coherence is needed. An acquiring call
completes only after the host or kernel imports peers' published bytes
at completion. A releasing call merges the caller's stores at entry, for
host-owned mappings. For kernel-owned files, the releaser's stores are
pulled when the next acquirer's completion pulls every mapper. Data
written outside any lock still becomes visible only at boundaries, as
documented today.

### What remains unsupported

These remain the boundary documented in `docs/wasm-limitations.md`
section 7, unless coherent memory such as #1720 is in use:

- user-space lock-free algorithms (C11 atomics) on memory shared between
  processes;
- raw `futex(2)` without `FUTEX_PRIVATE_FLAG` across processes.

Phase 6 can key shared raw futexes by object identity, but only with
maintainer approval, because it is Linux ABI behavior.

## Cost

| Operation (prototype probe case K, Node, one machine, three runs) | Time |
|---|---|
| Private semaphore `sem_trywait`+`sem_post` pair, user space | 0.02–0.07 µs per pair |
| Process-shared semaphore pair through the kernel | 68–101 µs per pair |
| Existing pshared mutex lock+unlock pair (IDs, kernel) | 58–109 µs per pair |
| `getppid()` | 28–29 µs per call |

These are single-machine screens, not a benchmark claim. A
process-shared operation costs about one ordinary syscall plus a small
table lookup. Process-private objects are unaffected. Contended waits
park instead of polling. In the prototype, cross-process semaphore
wakeup took 0.19–0.20 s against a 0.2 s post delay.

Memory:

- **Host:** none. No new `SharedArrayBuffer`, `WebAssembly.Memory` or
  ceiling, so the WebKit reservation budget (`host/src/runtime-memory-profile.ts`)
  is unchanged.
- **Kernel:** one table entry (tens of bytes) per live process-shared
  object, one wait entry per parked thread, and one held-robust record
  per held robust mutex, all through bounded admission. This replaces
  the current unbounded ID table.
- **Hot paths:** `futex` and other syscall dispatch are untouched. The
  new syscall adds one mapping lookup per call.

## ABI impact

- **Program surface.** A new process-shared synchronization syscall
  family with operation codes and argument descriptors. libc changes
  the routing and behavior of existing functions, so already-built
  programs keep their linked behavior until rebuilt. Two ways to ship
  it, for the maintainer to choose:
  1. Bump `ABI_VERSION` (56 → 57) and declare a new supported program
     baseline. Every program and package is rebuilt and republished
     under `binaries-abi-v57`.
  2. Keep the ABI-56 base and add an independently versioned program
     extension (for example `kandelo.psync.v1`;
     `docs/program-extensions.md`). Programs linked against the new libc
     import it. Extensions are currently Wasm imports supplied by the
     process worker, so carrying a syscall this way needs its own design
     review.

  Either way, syscalls 400–414 keep their meaning for ABI-56 programs,
  as `docs/persistent-program-compatibility.md` requires. They should
  also be recorded in `abi/snapshot.json` now. A kernel-only improvement
  that preserves their results, such as parking instead of polling,
  needs no program bump. Changing their results, such as TID ownership,
  is a behavior change for old binaries and needs an explicit decision.
- **Kernel–host surface.** No new imports or exports, and no wire format
  change. Completions use `wait_completion_wire`. The host's final-`EAGAIN`
  list changes together with the kernel. `HOST_ADAPTER_VERSION` stays at
  7 unless option D is adopted.
- **Fork instrumentation, channel layout, struct layouts:** unchanged.

## Phased plan

0. **Truthful state (docs and ABI hygiene).** Add `posix-status.md` rows
   for the process-shared functions with today's behavior. Record
   syscalls 400–414 in the ABI snapshot. Commit the probe as an
   `examples/` fixture with a host test that pins the current
   divergences, so later phases flip expectations visibly.
1. **Kernel infrastructure.** Object identity (anonymous object ids
   across mmap, fork, split, `mremap`, exit and exec), `PsyncTable` with
   bounded admission and lifetime hooks, the `PSync` wake source and
   resume, and the syscall and the host's final-`EAGAIN` entry. Rust
   unit tests.
2. **Semaphores.** `sem_init(pshared)`, `sem_open` registration,
   `sem_wait`, `sem_timedwait`, `sem_clockwait` (today's override
   ignores its clock), `sem_trywait`, `sem_post` and `sem_getvalue`.
   Flip CPython's `ac_cv_posix_semaphores_enabled` and update its README
   and `posix-modules.test.ts`.
3. **Mutexes, conditions, rwlocks, barriers and spin locks** on the new
   path for programs built with the new libc. The ID table remains for
   ABI-56 programs only.
4. **Robust and lifecycle semantics.** Owner-dead reporting at thread
   exit, exit and exec. `ENOTRECOVERABLE`. `STALLED` held at exit.
   Decide whether the legacy path stops releasing at exit.
5. **Retire the legacy table** at the next program baseline.
6. **Optional, needs approval:** shared futex keys for coherent memory
   (#1720 groups) and a user-space fast path there, only if measurements
   justify it.

## Test strategy

- **Rust unit tests:** key resolution (private, anonymous across
  fork/split/`mremap`, file, SysV, generations), each primitive's state
  machine, hand-off order, deadlines, signal restart rules,
  cancellation, robust transitions and admission failure.
- **Guest fixture:** the probe cases plus spin lock, barrier, clock
  attributes, `sem_unlink` lifetime, exec and robust thread exit. Run on
  Node through Vitest and in Chromium, Firefox and WebKit through the
  Playwright fixture. Node and browser behavior must match.
- **Conformance:** the vendored Open POSIX suite has none of these
  interfaces. Vendor its `sem_*`, `pthread_*attr_setpshared`,
  `pthread_mutexattr_setrobust` and `pthread_mutex_consistent`
  directories. Run libc-test's `sem_init`, `sem_open`, `pthread_robust`
  and `pthread_cond` tests on Node and browser. Keep the Sortix
  `pthread_condattr_setpshared` result.
- **CPython:** after phase 2, rebuild `cpython` in a partial image and
  require `multiprocessing.Lock`, `Semaphore`, `Queue` and `Pool` across
  three or more processes in `posix-modules.test.ts`. Run CPython's
  `test_multiprocessing_fork` subset on Node.
- **Regression:** `host/test/futex-kernel-wait.test.ts`, the
  shared-memory coherence tests and the browser fork/exec fixtures. Run
  `./run.sh test browser-memory` only if host lifecycle code changes;
  none is planned.

## Prototype evidence

Branch `brandonpayton/process-shared-sync-prototype` (not for merge):

- Kernel: an anonymous `MAP_SHARED` object id assigned at `mmap` and
  inherited at fork. A semaphore table keyed by
  `(kind, object, offset)`. Parking through `wait_park` under a token
  (reusing `WakeSource::Futex` with PID 0, which no task has).
- libc: `sem_init`, `sem_post`, `sem_trywait`, `sem_timedwait` and
  `sem_getvalue` route `pshared` semaphores to prototype syscall 440.
- Host: syscall 440 added to the final-`EAGAIN` list.

With the same probe binary source, built against the prototype libc and
run on Node against the prototype kernel:

| Case | Today | Prototype |
|---|---|---|
| A. unnamed pshared semaphore wakeup | `ETIMEDOUT` at 3.00 s | 0 at 0.19–0.20 s |
| B. `sem_open` semaphore wakeup | `ETIMEDOUT` at 3.00 s | 0 at 0.20 s |
| C. binary semaphore admits one | both admitted | one admitted |
| J. three-process counter under a semaphore | 284 of 600, 2 timeouts | 600 of 600, no timeouts |

Mutex, condition and rwlock cases are outside the prototype and are
unchanged. Not run: browsers, Rust unit tests and conformance suites on
the prototype, and wasm64. The prototype has no cleanup, no admission
bound and no split or `mremap` identity, and it trusts file bytes. It
demonstrates three things:

- identity keys resolve across fork and for `/dev/shm` files;
- the existing park and completion path delivers a wake to another
  process's thread with no host change beyond the `EAGAIN` list;
- kernel-serialized operations restore mutual exclusion and
  lock-protected data coherence under boundary-coherent memory.

## Open questions for the maintainer

1. **ABI vehicle:** a new baseline (ABI 57), or a versioned program
   extension that keeps the ABI-56 base?
2. **Legacy 400–414:** may their results change for ABI-56 programs?
   This would fix TID ownership, stop the silent release at exit and use
   real timeouts. Or should they stay frozen apart from kernel-only
   parking?
3. **State location:** kernel-held state (C) loses process-shared object
   state in persistent regular files across a machine restart, where
   Linux keeps it in the bytes. Is that acceptable for now, or should D
   be planned?
4. **Robust thread exit and exec:** report owner death for thread exit
   (POSIX "may") and exec (POSIX silent), as Linux does?
5. **Raw shared futexes:** is keying non-private `futex(2)` by object
   identity (Linux-specific) wanted, at least inside #1720 groups?
6. **#1720 coordination:** should identity keys land first so #1720's
   group can rely on them, or should #1720 stay independent until it
   leaves prototype status?
