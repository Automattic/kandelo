# Shared epoll readiness integration

This kernel source slice leaves SpiderMonkey recipe207, audited Node pins, ABI55,
fork-v20 tags and public inotify ENOSYS unchanged. It is a shared prerequisite
for actual committed descriptor producers, not FSWatcher/API closure.

Actual EpollInstance owns a private notification marker. Its existing backing
table lock serializes epoch assignment and the full direct/nested cascade. No
temporary heap container or provider callback occurs while that table is borrowed.
Wrap clears only scratch and reuses1, preserving pending events and waiters.
Existing mask/exclusive/edge/level/oneshot/delivery checks remain unchanged.

The old actual committed eventfd write allocated5 times across nested epolls.
That failing assertion, source and native binary remain preserved. Final source
has26 affected native cases, including23 unchanged and3 added cases for nesting
orders, diamond interests and wrap/stale pending ownership. Root verified698
frozen source/input identities and reran the exact final native artifact:26 pass,
0 fail/ignore,3138 filtered. This is component evidence, not guest conformance.

Three previous native test compiler attempts and one production native check are
accounted here. Root ran no new compiler. The reconstructed intermediate24-case
source limit and initial target-directory selection mistake remain explicit.
The final source/artifact is independently identified. Separate14 package checks
are reused from the unchanged engine source; no redundant engine test run.

No kernel Wasm, full product rebuild, overall suite or four-host run occurred.
Source reasoning leaves public syscall/fork/ABI metadata unchanged; full frozen
program/ABI semantic gates are unrun. Private Rust scratch is not guest/fork wire
identity. This is a commit-safety correction; performance was not measured.

Dormant notification queue/descriptor source still needs integration, real host
wake/dentry/rootfs/provider/metadata/fork owners and coherent public activation.
These are implementation gaps, not passing compatibility or accepted exclusions.
