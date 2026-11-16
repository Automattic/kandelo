# Process-Shared Synchronization: Design

Date: 2026-11-15
Status: Reviewed design; the maintainer's decisions are recorded in
[Decisions](#decisions). No implementation is proposed for merge here.
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

For newly built programs this replaces the existing ID-based pshared
table. It needs no new host
wake mechanism, no new `SharedArrayBuffer` and no memory ceiling, on
either host. It costs one syscall per operation on a process-shared
object (about 35–50 µs per operation in the prototype on Node). The
new interface ships as the versioned program extension
`kandelo.psync.v1`. The ABI-56 base is unchanged. The existing
syscalls 400–414 keep serving ABI-56 programs, now with POSIX
semantics. Object state is kernel state and resets when the machine
restarts. It is compatible with the common-memory process groups of
draft PR #1720 and does not depend on them.

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
against that branch. Raw `futex(2)` stays process-local in #1720
groups too (decision 5). Process-shared POSIX objects use the same
kernel calls there as everywhere else.

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
interfaces. **Rejected.** Raw `futex(2)` stays process-local
(decision 5).

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
need real `Atomics` operations on the group backing. **Rejected**
(decision 3): kernel-held state is accepted, and state resets at a
machine restart.

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
- An entry is removed when the kernel observes that its memory object
  is destroyed. Anonymous objects are destroyed at the last unmap, exit
  or exec of any mapper. SysV segments are destroyed after `IPC_RMID`
  and the last detach. For kernel-owned files, entries are removed at
  inode release. Private-key entries are removed when the address
  space is replaced or destroyed. The kernel cannot observe the release
  of a host-mounted file. Its entries therefore last until `*_destroy`
  or machine stop, within the table's admission bound.
- An operation on a private, anonymous or SysV key with no entry fails
  with `EINVAL`. Such an object was never initialized, or it is a copy.
  POSIX leaves both undefined, and `EINVAL` is a permitted error.
- An operation on a file key with no entry treats the object as freshly
  initialized. See the next section.

### State across a machine restart

Object state is kernel state (decision 3). The kernel table starts
empty when a machine starts, so state resets at a restart. A process-shared
object found in a file after a restart behaves as freshly initialized:

- mutexes, read-write locks and spin locks are unlocked and consistent;
- condition variables have no waiters;
- barriers have no arrivals for the current round;
- semaphores hold the value given at their `sem_init` or creating
  `sem_open`.

The attributes come from the object's own bytes. libc records them at
init and passes them with every operation. The attributes are the mutex
type, robustness, condition clock, barrier count and semaphore initial
value. libc stores the semaphore's initial value in the spare word of
musl's `sem_t`. Only file keys can outlive the table, so this rule
applies only to them.

POSIX permits this:

- The `pthread_mutex_init` rationale says "an implementation may store
  the lock in the heap and merely store a pointer, handle, or unique ID
  in the mutex object". It deliberately defines no assignment or
  equality, so that portable code cannot depend on the lock living in
  the object.
- `shm_open` says: "It is unspecified whether the name and shared memory
  object state remain valid after a system reboot."
- Reinitializing an initialized object is undefined for each type:
  "Attempting to initialize an already initialized mutex results in
  undefined behavior" (likewise for `pthread_cond_init` and `sem_init`).
  The `pthread_rwlock_init`, `pthread_barrier_init` and
  `pthread_spin_init` pages say the results are undefined. A portable
  program cannot depend on an initialized object surviving
  reinitialization or a reboot. Programs that reinitialize their lock
  file's objects when they find no other user (LMDB does) behave the
  same on Kandelo.

Linux keeps such state in the file's bytes. A Linux program that
expects a lock held before a reboot to still be held, or owner-dead,
afterwards will see it unlocked on Kandelo. Named semaphores live on
the in-kernel tmpfs `/dev/shm`, which itself does not survive a
restart, as on Linux. The change that introduces the table records
this boundary in `docs/posix-status.md`.

libc still writes the process-shared marker bits into the struct at
init (musl's existing encodings), so later calls know to route to the
kernel. The kernel does not interpret libc's struct layout; libc passes
attributes as arguments. This keeps musl's layouts out of the kernel
ABI. musl's `pthread_spinlock_t` is a single `int` with no room for a
marker. A process-shared spin lock instead stores a sentinel value that
musl's private spin lock never uses, and the private path checks for
it.

### Operations

Each operation is one kernel request on the calling thread's channel
(see [ABI](#abi-impact) for how it is reached). It returns at once, or it parks in
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
The new request must join `futex`, `rt_sigtimedwait`, `flock` and
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
- A robust mutex reports owner death on process exit, thread exit and
  exec (decision 4). POSIX requires the first, permits the second ("may
  be notified") and is silent on the third. Linux reports all three, and
  reporting gives the next owner more information. The next acquirer
  receives `EOWNERDEAD` and owns the mutex. If it unlocks without
  `pthread_mutex_consistent`, the mutex becomes permanently
  `ENOTRECOVERABLE`.
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

#### The per-thread held-robust list

The kernel performs every lock of a process-shared robust mutex, so it
knows the holder without libc's user-space `robust_list`.
`set_robust_list` stays a no-op for this purpose. Each task record
holds the head of an intrusive, doubly linked list. The links live in
the mutex's own table entry (`held_prev`, `held_next`, as keys). A
mutex has at most one owner, so one pair of links per entry suffices.

- **lock or a successful `EOWNERDEAD` hand-off:** push onto the new
  owner's list. O(1), with no allocation, so a lock never fails for
  list space.
- **unlock:** unlink. O(1) plus the key lookups.
- **thread exit, process exit (every thread) or exec (every thread,
  including the caller):** walk the list. Each entry is marked
  owner-dead and handed to its oldest waiter with `EOWNERDEAD`, or left
  owner-dead for the next acquirer. The walk is O(held), done once per
  exiting task.
- **Memory:** two key-sized links (about 64 bytes) per robust entry,
  plus one head per task. Non-robust objects carry no links.
- **Cost on the lock path:** nothing beyond the table update the lock
  already does.

Process-private robust mutexes still use musl's user-space
`robust_list`. `set_robust_list` is a no-op today, so their owner
death is not reported either. That is a separate gap, recorded in
phase 0 and not part of this design.

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
  processes.

Raw `futex(2)` stays process-local on every memory model, including
#1720 groups (decision 5). It is musl's internal primitive, not a POSIX
interface. The POSIX interfaces get cross-process semantics through the
new kernel requests. `docs/posix-status.md` keeps saying that a futex
wait or wake reaches only the calling process.

## Cost

| Operation (prototype probe case K, Node, one machine, three runs) | Time |
|---|---|
| Private semaphore `sem_trywait`+`sem_post` pair, user space | 0.02–0.07 µs per pair |
| Process-shared semaphore pair through the kernel (prototype syscall) | 68–101 µs per pair |
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
  object, one wait entry per parked thread, and two held-list links in
  each robust entry, all through bounded admission. The legacy ID table
  gains the same bound.
- **Negotiation:** one worker-served import call per process image,
  with no channel round trip.
- **Hot paths:** `futex` and other syscall dispatch are untouched. The
  new request adds one mapping lookup per call.

## ABI impact

### The program extension `kandelo.psync.v1`

The new interface keeps the ABI-56 base unchanged (decision 1). It
follows the precedent of `kandelo.klog.v1` (`docs/program-extensions.md`).

**Declaration.** libc's process-shared paths import one function:

```text
module "kandelo.psync.v1", name "__kandelo_psync_v1"
(info: pointer, capacity: i32, flags: i32) -> i32
```

This is the extension family's `(pointer, i32, i32) -> i32` shape. A
program imports it only if it links a function that can create a
process-shared object: `pthread_mutexattr_setpshared`,
`pthread_condattr_setpshared`, `pthread_rwlockattr_setpshared`,
`pthread_barrierattr_setpshared`, `pthread_spin_init`, `sem_init` or
`sem_open`. Those reference the libc psync object strongly. The lock,
wait and post paths reference it weakly, through a symbol that only a
process-shared init can make non-null. A program that never creates a
process-shared object therefore keeps its base identity.

**Negotiation.** On first use in a process image, libc calls the
import. The process worker serves it synchronously, with no channel
round trip. It writes a small packet into `info`: magic, version 1, and
the kernel request number to use. It returns the packet length, or
`-105` if `capacity` is too small and `-22` for nonzero `flags`. libc
caches the packet in a static. A forked child inherits the cache,
which stays valid because the child runs on the same host. Exec
discards it with the image.

**Transport.** libc issues every operation through the ordinary syscall
glue: `__syscall`, or `__syscall_cp` for cancellation points. It uses
the negotiated request number, an operation code, the object address
and operation arguments. Using the glue rather than the import as the
transport matters. A worker-issued request
(`invokeChannelSyscall` in `host/src/worker-main.ts`) defers signal
delivery to the next guest syscall (`markDeferredSignalDelivery`). That
would break `EINTR` after a handler, `SA_RESTART` restarts and deferred
cancellation, all of which the glue already implements for blocking
calls.

**What is versioned where.**

- The operation codes, argument meanings, packet layout and errno
  results are the program contract of `kandelo.psync.v1`. They are
  declared in `crates/program-abi/src/program_extensions.rs`, generated
  into `abi/program-extensions.json` and documented in
  `docs/program-extensions.md`. They are immutable for v1. An
  incompatible change is `kandelo.psync.v2`.
- The request number (in `shared::extension_requests`, beside `KLOG_V1`
  = 600), its argument descriptors
  (`host_abi::EXTENSION_REQUEST_DESCRIPTORS`) and the host's
  final-`EAGAIN` entry are kernel-host surface, versioned by
  `HOST_ADAPTER_VERSION`. No program has the number compiled in; it
  comes from the packet.

**Checks.**

- **Build:** `cargo xtask program-extensions` adds the module to the
  SDK linker allowance. A plain `env` import of the same name is
  refused at link time.
- **Admission, on both hosts:** `wasm-artifact`'s extension admission
  (`IMPLEMENTED` in `crates/wasm-artifact/src/program_extensions.rs`)
  and the shared host policy accept `kandelo.psync.v1` with the exact
  signature. They refuse unknown versions, unknown names, wrong kinds
  and wrong signatures before execution. Dynamic loading checks a side
  module's imports against what the worker supplies.
- **Kernel gate:** the host registers each process image's admitted
  extension set with the kernel when it registers the image. Fork
  inherits the set, and exec replaces it with the new image's set. The
  kernel answers the psync request with `ENOSYS` from an image that did
  not declare `kandelo.psync.v1`. The request is therefore unreachable
  from undeclared programs, rather than merely unadvertised to them.
  The registration is a kernel-host wire change.
- **Generated files:** `cargo xtask program-extensions --check` and
  `xtask dump-abi --check` verify the manifest, host constants and
  linker allowance.

**How stale or mismatched artifacts fail.**

| Artifact | Result |
|---|---|
| Program importing `kandelo.psync.v1`, on a host or kernel without it | Admission refusal: "unsupported required program extension kandelo.psync.v1". Never runs with a missing interface. |
| Program importing `kandelo.psync.v2` on a v1 host | Admission refusal, as an unknown version |
| Import with the wrong name, kind or signature | Admission refusal |
| Image issuing the request without the import | `ENOSYS` from the kernel gate |
| Kernel and host from different `HOST_ADAPTER_VERSION`s | The existing kernel-host refusal |
| ABI-56 program built before this work | Admitted unchanged. It keeps using 400–414, which now behave as in the next section. |

### Syscalls 400–414 for ABI-56 programs

ABI-56 programs keep using the ID table. Its behavior changes to match
POSIX (decision 2). Each change is kernel-side unless noted.

- **Parking instead of polling:** blocked lock, condition and barrier
  calls park in `wait_park` under the object's ID token, instead of
  returning `EAGAIN` for the host to retry. A wake is a kernel decision,
  as for futex.
- **Thread ownership:** owners and waiter entries are TIDs, not PIDs.
  Threads of one process now exclude each other, and two threads can
  wait on one condition or barrier.
- **No silent release at exit:** a held mutex stays held, as
  `PTHREAD_MUTEX_STALLED`. Robust process-shared mutexes never used the
  table (the ABI-56 libc sends them to musl's futex path), so robust
  semantics need a rebuild.
- **Admission bound:** the table gets an admission bound. Init returns
  `EAGAIN` or `ENOMEM` when it is full; both are permitted errors.
- **Real timeouts, where the old libc passes one:** none of 400–414
  carries a timeout. ABI-56 `pthread_mutex_timedlock` passes only the
  ID, and ABI-56 `pthread_cond_timedwait` does not use the table at
  all. The kernel cannot recover a deadline those binaries never send.
  Bounded timed waits therefore need a rebuild against the new libc.
  `docs/posix-status.md` says so instead of implying a fix.

These are deliberate behavior changes for existing binaries. They are
listed as such in `docs/posix-status.md` and in the change that makes
them.

### Recording 400–414 in `abi/snapshot.json`

The ABI-56 programs that use 400–414 bind to them, but the snapshot does
not list them. Adding them to the program-surface `syscalls` section
would change the ABI-56 program digest. Every existing program would
then be refused, which is what decision 1 avoids. They are recorded
instead in a new snapshot section, `program_legacy_requests`. It lists
each number, name, argument meaning and result convention.

- It is checked by `xtask dump-abi --check` and by a kernel test that
  dispatch serves exactly these numbers.
- It is excluded from the ABI-56 digest. `docs/abi-versioning.md`
  gains a third surface classification, "frozen baseline record", for
  observable behavior that a frozen baseline already depends on but did
  not digest.
- At the next program baseline it merges into `syscalls`, or is removed
  together with the legacy table.

### Other surfaces

- `ABI_VERSION` stays at 56. The persistent-program baseline is
  unchanged.
- `HOST_ADAPTER_VERSION` increases once: for the new extension request
  number and descriptors, the per-image extension registration, and the
  final-`EAGAIN` entry. The legacy changes add no kernel-host wire.
- Completions use the existing `wait_completion_wire`.
- Fork instrumentation, channel layout and musl struct layouts are
  unchanged. Only the spare `sem_t` word and the spin-lock sentinel gain
  meaning, inside libc.

## Phased plan

Recommended sequencing. Each step is independently reviewable.

0. **Truthful state.**
   - Add `posix-status.md` rows for the process-shared functions with
     today's behavior, including the private robust-mutex gap.
   - Add the `program_legacy_requests` snapshot section and its surface
     classification.
   - Commit the probe as an `examples/` fixture with a host test that
     pins today's divergences, so later steps flip expectations visibly.
1. **Legacy 400–414 semantics.** Parking, TID ownership, no release at
   exit, and the admission bound. This is kernel-only and needs no
   extension. ABI-56 programs benefit at once. It also exercises the
   parking path that the new requests reuse.
2. **Object identity keys.** Anonymous object ids across mmap, fork,
   split, `mremap`, exit and exec, plus file and SysV keys with
   generations, all with Rust unit tests. These land on `develop` on
   their own merits, independent of #1720. Their semantics do not depend
   on the memory model. #1720 adopts them when it next rebases, by
   resolving its translated addresses through the same mapping
   metadata. #1720 does not need to land first, and nothing here waits
   for it.
3. **The extension and semaphores.**
   - The `kandelo.psync.v1` declarations, admission, kernel gate,
     request and `HOST_ADAPTER_VERSION` bump.
   - `PsyncTable` with lifetime hooks and the restart rule.
   - `sem_init(pshared)`, `sem_open` registration, `sem_wait`,
     `sem_timedwait`, `sem_clockwait` (today's override ignores its
     clock), `sem_trywait`, `sem_post` and `sem_getvalue`.
   - Flip CPython's `ac_cv_posix_semaphores_enabled` and update its
     README and `posix-modules.test.ts`.

   Semaphores come first because they unblock CPython and exercise
   every part of the mechanism with the simplest state machine.
4. **Mutexes, conditions, rwlocks, barriers and spin locks** on the new
   path, with robust owner death at process exit, thread exit and exec,
   and the held-robust list.
5. **Retire the legacy table** at the next program baseline. Fold or
   remove `program_legacy_requests` at the same time.

## Test strategy

- **Rust unit tests:** key resolution (private, anonymous across
  fork/split/`mremap`, file, SysV, generations), each primitive's state
  machine, hand-off order, deadlines, signal restart rules,
  cancellation, robust transitions and the held-robust list (lock,
  unlock, thread exit, exit, exec), admission failure, the
  freshly-initialized rule for file keys after a simulated table reset,
  and the legacy table's parking and TID ownership.
- **Extension admission, on both hosts:**
  - a program with `kandelo.psync.v1` runs;
  - the same program is refused by a host built without the extension;
  - wrong signatures and `v2` imports are refused;
  - a program without the import gets `ENOSYS` from a hand-issued
    request;
  - a program that never creates a process-shared object has no
    extension import.
- **ABI-56 cohort:** the frozen `abi/program-fixtures/v56/` programs
  still run, and a v56 program using a process-shared mutex shows the
  new legacy semantics.
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

## Decisions

Recorded from the maintainer's review of this draft.

1. **ABI vehicle:** ship as the versioned program extension
   `kandelo.psync.v1`, keeping the ABI-56 base. No `ABI_VERSION` bump.
   Mechanism: [The program extension](#the-program-extension-kandelopsyncv1).
2. **Legacy 400–414:** may change behavior for ABI-56 programs to match
   POSIX: TID ownership, no silent release at exit, real timeouts where
   the old libc passes one, and parking instead of polling. Also record
   them in `abi/snapshot.json`. See
   [Syscalls 400–414](#syscalls-400414-for-abi-56-programs) and
   [Recording 400–414](#recording-400414-in-abisnapshotjson).
3. **State location:** kernel-held state is accepted. State resets at a
   machine restart, and an object found in a file afterwards behaves as
   freshly initialized. See
   [State across a machine restart](#state-across-a-machine-restart).
4. **Robust owner death:** reported on process exit, thread exit and
   exec. See [the held-robust list](#the-per-thread-held-robust-list).
5. **Raw `futex(2)`:** stays process-local. It is musl's internal
   primitive, and POSIX interfaces get cross-process semantics through
   the new kernel requests.
6. **Sequencing:** recommended in [Phased plan](#phased-plan). Legacy
   fixes and identity keys land first on `develop`, independent of
   #1720, which adopts the keys when it rebases.

No questions remain open.
