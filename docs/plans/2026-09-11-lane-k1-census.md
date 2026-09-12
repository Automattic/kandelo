# Lane K1 — census of `host/src/kernel-worker.ts`

**Date: 2026-09-11. Status: complete.**

Lane K is the largest in the campaign — 32,718 lines, estimated 30–60
agent-days at "unknown until K1". This is K1.

**Unlike the other censuses, this one largely confirms the lane's target
rather than overturning it.** The 12,000 figure was a guess; `host-native`
independently validates it.

## The shape: one class is 91.6% of the file

| | Lines |
|---|---|
| `export class CentralizedKernelWorker` | **29,975** |
| 37 other top-level functions | 2,743 |
| **Total** | **32,718** |

The class has **522 methods across 29,780 lines**. The largest:

| Method | Lines |
|---|---|
| `#handleSyscallInner` | **2,149** |
| `#createTestAuthority` | 1,459 |
| `handleBlockingRetry` | 763 |
| `#handleSpawnAfterResolve` | 402 |
| `handleClone` | 374 |
| `#handleSpawn` | 312 |
| `handleFork` | 299 |

**The file is not 32,718 lines of many things. It is one god class**, and
that is the property that makes every other lane contend for it.

## Why the host dispatches syscalls at all

85 distinct `SYS_` constants appear, at 86 `case SYS_` sites, out of
**233** syscalls in the ABI. So the host dispatches **roughly a third**,
and the question K1 had to answer is why any.

Reading the handlers answers it: `handleFork`, `handleClone`,
`handleSpawn`, `handleExecveat`, `handleSelect`, `handlePselect6`,
`handleFutex`, `handleThreadCancel`, `handleIpcShmat`,
`handleBlockingRetry`. **These are precisely the syscalls that need a
host service** — creating a worker, blocking on `Atomics.wait`, growing or
sharing memory. The kernel cannot create its own workers.

**This is not duplicated kernel knowledge**, and lane K's framing as "the
host's second syscall table" overstates it. `crates/host-native` drives
the same protocol through the same exports — `kernel_handle_channel`,
`kernel_blocking_retry_token`, `kernel_clone`,
`kernel_create_process_with_stdio`. **Both hosts must do this.**

The 34 `handle*` methods total **7,949 lines**.

## The number that makes the lane

`host-native`'s `guest.rs` — the equivalent job in Rust, including fork,
exec, clone and the blocking-retry pump — is **13,577 lines**.

`CentralizedKernelWorker` is **29,975**, for the same responsibility, in a
language that needs more ceremony for none of the safety.

**That ratio is lane K's whole argument**, and it validates the target the
lane guessed: 12,000 was picked as "roughly a third"; `host-native` does
it in 13,577. **The provisional target survives the census**, which is the
first time that has happened.

## Test scaffolding ships in the production class

`#createTestAuthority` is **1,459 lines**, and the three test-scaffolding
methods total **1,577**. It is a deliberate, structured pattern — a
`testAuthority` property exposing `initializeKernelForTest`,
`sendSignalForTest`, `dequeueSignalForDeliveryForTest` and others — and
`host/src/kernel.ts` carries the same pattern.

**It is not debris, and this census does not call it a defect.** It is a
design choice with a cost: 1,577 lines and a test-only API surface
shipping in every host. Whether that trade is right is a decision for the
maintainer, and it is recorded here so it is made deliberately rather than
inherited.

## What this changes about lane K

- **The lane is decomposition, not migration.** The syscalls the host
  dispatches genuinely need host services; what is wrong is that 522
  methods live in one class, so every lane touching the host contends for
  one file and no boundary can be enforced.
- **Lane K's "second syscall table" framing is wrong** and the plan is
  corrected.
- **A second gate is added**: `kernelWorkerClassMethods`, 522 → 150.
  Line count alone permits shuffling code between methods of the same god
  class; method count in the largest class does not.

## Revised increments

- **K1 — this census.** Done.
- **K2 — split the class along the boundaries the census found**: syscall
  dispatch, process/worker lifecycle, blocking and wakeup, channel and
  memory IO, virtual networking. These are already visible in the method
  names.
- **K3 — decide the test-authority question** and record it. If it stays,
  it moves behind its own boundary rather than living in the class.
- **K4 — `#handleSyscallInner` (2,149 lines) is the single densest unit**
  and should be table-driven rather than a switch, with the table
  generated from the same ABI source lane G and L-D2 point at.
- **K5 — measure against `guest.rs`** as each piece lands, since that is
  the only evidence available for what the job actually costs.

## Estimate

**30–60 agent-days, low** — unchanged. The census clarified the shape but
found nothing that makes it smaller, and a 522-method class split under a
passing test suite is exactly the work that resists estimation.

## What this census did not establish

- **Whether any of the 85 dispatched syscalls could be kernel-only.** They
  were classified by reading handler names and the blocking protocol, not
  by proving each one needs a host service.
- **What the 436 "other" methods (17,958 lines) do.** They did not fall
  into a name-based bucket and were not read. **That is the majority of
  the class and the largest unknown in this census.**
- **Whether `guest.rs` is a fair comparison.** It is the same
  responsibility in a different language, not a port, and it may omit
  behavior the browser host needs.
