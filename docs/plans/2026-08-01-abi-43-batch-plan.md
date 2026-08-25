# ABI 43 integration batch plan

Recorded: 2026-08-01 (America/Indiana/Indianapolis)

## Status and authority

This document records the local ABI 43 integration branch after the selected
open pull requests were forward-ported and composed. It does not authorize a
push, merge, ABI release, package publication, or removal of
the temporary CRuby patch in pull request (PR) #1166.

The linear handoff branch is
`integration/abi43-batch-linear-20260801`, based on `origin/main` at
`8a0ed31a5`. The pre-linearization recovery branch remains
`integration/abi43-batch-20260731`. Kernel, ABI, libc, host-runtime, and
fork-instrument changes still require Brandon's explicit approval before
merge.

## History contract

The umbrella PR must preserve the purpose-scoped commits in this train. It
must be rebase-merged and must not be squash-merged. Forward-ported commits
retain original authorship; integration repairs remain separate commits with
their own purpose.

At post-rebase projection checkpoint `554bdf542`, the local range has 171
commits above `origin/main` at `8a0ed31a5`: 170 selected payload commits and
one separate generated-projection repair. Its authors are:

- 167 Brandon Payton commits;
- three Dependabot-authored dependency commits; and
- one `mho22`-authored Windows VFS commit.

The range contains no merge commits. The old integration merge `d850197a8`
remains only on the recovery branch. `git range-diff` mapped 163 of the 170
replayed commits unchanged and seven with newer-main context adjustments. The
two upstream entries omitted by the mapping are `ce9b36a82` and `8a0ed31a5`;
they are already in the new base rather than duplicated in the payload.

The adjusted commits preserve both sides of each overlap: current CI fixture
routing, staging-shell handoff metadata, browser memory64 fixtures, and the
generic shell-release finalizer remain intact while the selected changes are
applied. The image-ingest commit advances the changed shell inputs to revision
23 and pending state without restoring stale revision-specific finalizer
logic. `git log --format=fuller` confirms the three Dependabot authors and
`mho22` author, with the restacker recorded only as committer. The umbrella PR
must retain this linear topology and must not squash it.

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

The train also carries the Kandelo-owned implementation developed in the
dedicated fork worktree:

- ordinary fork admission rejects retired-memory saturation before allocating
  or copying child memory;
- process-memory aliases retain exact backing ownership;
- a child can replay a borrowed parent continuation through private mutable
  prefix storage without consuming the parent's frames;
- active side-module state can be reconstructed without writing parent memory;
- one exact-generation shared-memory lifetime coordinator prevents overlapping
  borrowers and requires terminal evidence before parent resumption;
- ABI 43 carries an explicit ordinary/vfork mode through libc,
  fork-instrumentation, the host channel, and the kernel;
- production Node and browser vfork launch a separate child Worker over an
  exact alias to the parent's Memory with private channel, replay, loader, and
  continuation-control state;
- only the calling parent thread remains parked through failed exec and until
  successful exec commit or exact `_exit()`/signal/trap teardown; and
- inherited open file descriptions share mutable offset, status flags, and
  async owner while descriptor tables and directory host iterators remain
  process-local.

Ordinary fork remains independent and copied. The connected vfork path
has passed the locally runnable broad conformance gates and component
resident set size (RSS) measurements. It is not yet a release claim:
published upstream CRuby artifacts, application RSS, and the complete
application benchmark matrix remain explicit
gates. A fatal signal against a compute-running borrower is covered on
every host: absent an exact Worker fence, Kandelo contains the whole
shared address space rather than resuming the parent unsafely.

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

- ABI snapshot, generated C/TypeScript bindings, native and
  wasm32/wasm64 layouts, and version checks passed.
- The complete CI-shaped host run passed 339 files and skipped 28. It
  recorded 4,131 passing tests, two expected failures, and 129 skips;
  the Bun and JavaScriptCore supplement passed three tests in two files.
- The exact 4,096-child `posix_spawn`/`waitpid` churn passed alone and
  in the broad concurrent suite after installed-package build
  isolation.
- libc recorded 303 passes and zero failures out of 324; POSIX recorded
  174 passes and zero failures out of 179; Sortix recorded 5,037 passes
  and zero failures out of 5,113. Expected failures and documented skips
  remained classified rather than hidden.
- The Rust workspace gate completed, including 1,522 kernel tests, four
  pointer-contract tests, 13 root-spill tests, 48 shared-ABI tests,
  fork-instrument, and documentation tests.
- `xtask` passed 639 unit tests and its cache-root integration test.
- Five production vfork lifecycle cases passed in Node and in Chromium,
  Firefox, and WebKit, for 15 browser cases. The upstream Ruby browser
  proof recorded four passes and two intentional cross-engine skips.
- After the final linear rebase, the ABI snapshot, native and
  wasm32/wasm64 layouts, generated C and TypeScript bindings, and ABI 42 to
  43 bump classification passed again. The current-main package input
  changes made the program-package projection truthfully stale; it was
  regenerated in separate commit `554bdf542`, and the freshness check and
  standalone resolver-bundle check then passed.
- The post-rebase CI suite-routing contract passed, including exact staging
  shell handoff and browser-memory64 workspace fixture paths.

At the initial batch checkpoint, the full repository build was not a pass. It
reached external Bash source fallback and stopped on a GNU mirror HTTP 502.

After connecting vfork and shared OFD state, a later full production
build passed. ABI 43 had no release index, so the resolver truthfully
rebuilt its verified-source package closure and produced the
16,787,687-byte rootfs image.

The component RSS result remained decisive: a shared 256 MiB Memory
added about 11.1 MiB for its Worker, while an exact full clone added
496.344 MiB. Sparse cloning added about 262.65 MiB but took 79 to 95 ms
versus 35 ms for a full clone. All three self-contained benchmark suites
passed for three rounds on Node and Chromium.

The comparison also found a broad batch startup regression. A same-day
pre-batch build was 37 to 50 percent faster across the Node lifecycle
metrics. Empty-VFS phase measurements place nearly all of that
regression before the vfork stack: the pre-vfork ABI 43 checkpoint was
about 39 to 42 percent slower than the pre-batch baseline, while vfork
added about 2.3 to 2.4 percent. Keep that regression visible and
bisectable; no broad no-regression claim is made.

The full product browser and application benchmark gates still lack a
complete ABI 43 package closure. The release index returns HTTP 404, and
no ABI 42 fallback is valid. Those gates and application RSS remain
pending publication.

## Remaining implementation and release series

The mode ABI, libc split, kernel marker, borrowed Worker launch, private replay
state, caller suspension, exact cooperative/fatal teardown, inherited OFD
state, and Node/browser lifecycle fixtures are implemented as separate
purpose-scoped commits. Continue with these remaining gates:

1. Completed locally: run the complete libc, POSIX, Sortix, host, Rust
   workspace, `xtask`, ABI, and focused cross-engine vfork/Ruby suites.
2. Completed locally: repeat component RSS, ordinary-fork and
   sparse-clone comparison, repeated vfork lifetimes, and all
   self-contained Node and Chromium benchmarks. Preserve the measured
   broad startup regression as an explicit integration risk.
3. Completed locally: remove PR #1166, enable upstream CRuby's
   working-vfork branch, and prove uid 1000 selects vfork while the
   privileged path retains ordinary fork in Node and Chromium. The
   uid-1000 failed-exec proof also passes in Firefox and WebKit.
4. With publication authorization, publish the exact rebuilt ABI 43
   package closure, then run the full product browser and application
   benchmark matrices without stale ABI fallback.
5. Completed locally: rebase linearly onto `origin/main` at `8a0ed31a5`,
   remove the temporary merge, rerun attribution and ABI audits, and preserve
   the post-rebase projection repair as its own commit.
6. Open an umbrella PR only when Brandon authorizes that external action.
   Preserve every accepted PR and integration repair as an individual commit;
   do not squash.

## PR #1166 removal gate

The local recipe deletes PR #1166 without replacing it with another Ruby
command classifier. Do not merge or publish that removal until the exact
upstream-process-path artifacts are published and the real in-guest package
install lifecycle completes without renderer loss or
history-proportional memory growth. The local uid-1000 and privileged proofs
satisfy the selection gate, but not those release gates.
