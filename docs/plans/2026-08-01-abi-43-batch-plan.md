# ABI 43 integration batch plan

Recorded: 2026-08-01 (America/Indiana/Indianapolis)

## Status and authority

This document records the local ABI 43 integration branch after the selected
open pull requests were forward-ported and composed. It does not authorize a
push, merge, ABI release, package publication, Homebrew cutover, or removal of
the temporary CRuby patch in pull request (PR) #1166.

The working branch is `integration/abi43-batch-20260731`. Kernel, ABI, libc,
host-runtime, and fork-instrument changes still require Brandon's explicit
approval before merge.

## History contract

The umbrella PR must preserve the purpose-scoped commits in this train. It
must be rebase-merged and must not be squash-merged. Forward-ported commits
retain original authorship; integration repairs remain separate commits with
their own purpose.

The current local range has 145 commits above local `main` at
`c5a24dc148b2e69c0555d9e7802bee7cd48a18d7`. Its authors are:

- 141 Brandon Payton commits, including 12 whose original GitHub committer is
  retained in the source history;
- three Dependabot-authored dependency commits; and
- one `mho22`-authored Windows VFS commit.

There is one temporary integration merge, `d850197a8`, used to absorb the
then-current `origin/main`. Before an umbrella PR, rebase the train once onto
the selected final mainline and remove that merge topology. Do not squash the
result. Verify the rewritten mapping with `git range-diff` and
`git log --format=fuller`.

## Frozen selected sources

The source refs below were fetched before integration. A fresh GitHub audit on
2026-08-01 found every head unchanged, open, and non-draft except the two
explicit ABI foundations, PRs #1096 and #1098, which remain drafts.

| PR | Frozen head | Integrated purpose |
|---:|---|---|
| 841 | `a2b70da5d` | Correct fpcast-emulated pthread entry calls |
| 1104 | `3b470d3b2` | Distinguish terminals from character devices |
| 965 | `2e125f4c2` | Synthesize Windows host-mount POSIX permissions |
| 861 | `1e5d19ba0` | Record full-validation prerequisites |
| 1013 | `60fb395ec` | Require purpose-prefixed PR and commit text |
| 679 | `4cbaf2b3a` | Restrict reclaim handling to WebKit |
| 720 | `18a5aa3f7` | Avoid `munmap` mapping-vector churn |
| 761 | `076362bb6` | Reject late syscalls from reaped processes |
| 855 | `c413bd85e` | Deliver machine-local UDP between processes |
| 876 | `35f045507` | Preserve descriptor identity through devfs aliases |
| 899 | `915a84b6d` | Preserve executable linker input order |
| 1063 | `e96c38127` | Keep directory streams usable after rewind failure |
| 1129 | `997fc7ba1` | Deliver caught signals before retrying waits |
| 892 | `f678e098e` | Ignore debug names while patching thread modules |
| 886 | `b671aa687` | Finalize readiness timeouts through the kernel |
| 707 | `5af362833` | Use shared dinit images for Node service demos |
| 836 | `40f140846` | Repair xtask fixtures and gate xtask tests |
| 846 | `075e74ac2` | Gate the Rust workspace as one contract |
| 857 | `07c894621` | Reuse one bundled source Worker entry |
| 869 | `08c19c62c` | Add image-owned browser file ingest |
| 870 | `40cad977d` | Update the mkrootfs esbuild security release |
| 1031 | `7deb360be` | Refresh accepted minor and patch npm dependencies |
| 1030 | `abdc9f21a` | Adopt Node 26 type definitions |
| 592 | `0693b8479` | Move selected existing host metadata into Rust |
| 947 | `4fc2dd1cf` | Add OSS-compatible PCM audio across both hosts |
| 1096 | `320e2bc1b` | Make ABI 43 replay activation-state safe |
| 1098 | `74e761e35` | Bound and serialize kernel scratch transfers |

The PR #592 forward-port moves ownership of already-exposed Kandelo state. Its
SysV shared-memory slice records existing attachment identity in Rust; it does
not add a Linux or general System V compatibility goal. No new SysV API was
selected merely for Linux compatibility.

PR #947 remains seven authored commits in the train. PRs #1096 and #1098 also
retain their purpose ordering rather than becoming one ABI-shaped squash.
Generated projections and composition repairs follow the commits that make
them necessary.

## Affordable fork work in the batch

The train also carries the Kandelo-owned foundation developed in the dedicated
fork worktree:

- ordinary fork admission rejects retired-memory saturation before allocating
  or copying child memory;
- process-memory aliases retain exact backing ownership;
- a child can replay a borrowed parent continuation through private mutable
  prefix storage without consuming the parent's frames;
- active side-module state can be reconstructed without writing parent memory;
  and
- one exact-generation shared-memory lifetime coordinator prevents overlapping
  borrowers and requires terminal evidence before parent resumption.

These foundations remain intentionally disconnected from guest-visible
`vfork()`. Kandelo's libc still aliases `vfork()` to ordinary `fork()`,
`kernel_fork` still has no mode parameter, and the host still clones full
memory for `SYS_VFORK`. Documentation must continue to report that limitation
until the connected implementation and tests are complete.

## Composition repairs completed

The combined tree required additional reviewable repairs that did not belong
to any source PR in isolation:

- regenerate ABI 43 program projections and the standalone resolver bundle;
- preserve the gated process-memory accessor after authority narrowing;
- route process exit through the returning ABI 43 adapter;
- update host fixtures for Rust-owned signal, timer, SysV, and audio state;
- execute runtime-file metadata through one prepared, source-attested `xtask`;
  and
- build installed-host-package fixtures in private output trees so tsup cannot
  delete a live machine's Worker entry during parallel tests.

The last race had presented as a churn child terminated by signal 11. The
captured diagnostic proved that another test had removed
`host/dist/worker-entry.js`; it was not an out-of-memory event, fork admission,
or kernel stack loss.

## Validation evidence on the composed tree

All commands supporting claims below ran through `scripts/dev-shell.sh`.

- ABI snapshot, generated C/TypeScript bindings, and version checks passed.
- Rust workspace validation recorded 1,519 kernel tests and 48 shared tests
  passing; xtask recorded 638 unit tests plus its integration test passing.
- The focused authority and lifecycle cluster passed 13 files and 167 tests.
- PCM and audio interruption coverage passed seven files and 39 tests.
- Runtime-file metadata and PHP consumers passed 35 tests with five
  intentional skips.
- The exact 4,096-child `posix_spawn`/`waitpid` churn passed alone and in the
  broad concurrent suite after installed-package build isolation.
- The latest broad host run recorded 4,027 passed, five failed, and 130
  skipped tests out of 4,162. All five failures are missing complete ABI 43
  program-artifact closures in `run-example-credentials` and
  `run-example-resolver`; no source/runtime failure remains in that run.

The full repository build is not a pass. It reached external Bash source
fallback and stopped on a GNU mirror HTTP 502. Browser production assembly and
artifact-dependent runtime suites remain gated by the same missing complete
ABI 43 program generations. Performance, libc, POSIX, Sortix, and complete
browser claims must wait for their exact prerequisites and suites.

## Next implementation series

Keep the connected vfork work as small purpose-scoped commits above this
reviewed batch:

1. Add the explicit ordinary/vfork mode to the ABI 43 `kernel_fork` import,
   generated constants, snapshot, and fork-instrument propagation.
2. Make libc `_Fork()` and `fork()` pass ordinary mode and `vfork()` pass
   vfork mode without running `pthread_atfork` handlers.
3. Add authoritative kernel Process state for a vfork child, caller
   suspension, overlap/nesting rejection, and exact wait/reaping behavior.
4. Reserve a distinct child channel/control slot before launch and start a
   separate child Worker that aliases the parent's shared Memory without a
   `WebAssembly.Memory` construction or byte copy.
5. Connect borrowed main and active-side replay while keeping every child
   continuation cursor and mutable prefix private.
6. Resume only the calling parent thread after successful exec or exact
   `_exit`/signal/crash teardown. Failed exec must leave the lifetime coherent
   and the parent blocked.
7. Prove descriptors/open file descriptions, cwd, credentials, signals,
   process groups, main and pthread callers, runnable siblings, sequential
   calls, overlap rejection, traps, and rollback on Node and applicable
   browsers.
8. Rebase linearly, rerun attribution and ABI audits, then open an umbrella PR
   only when Brandon authorizes that external action.

## PR #1166 removal gate

Do not alter or broaden PR #1166 during this series. Remove it only after
pristine upstream CRuby is rebuilt with working vfork enabled, uid 1000 proves
the upstream vfork path with no full-memory allocation/copy, privileged Ruby
proves its intentional ordinary-fork fallback, the exact artifacts are
published, and the real in-guest Homebrew tap/install lifecycle completes
without renderer loss or history-proportional memory growth.
