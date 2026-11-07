# Focused Domain controls

Explicit no-global-setup: use the declared devshell. No script resolves or builds
an engine, kernel, fresh sysroot or product.

run-upstream.py takes exact native26 binary, pinned full Node source directory and
output directory. It retains declared case flags, executes the unchanged twelve
selected test bodies through native and candidate source-component modes, and
records every result/log/hash. Candidate preload changes only the Domain module
dependency: native EventEmitter/AsyncHook/process/VM/Promise dependencies remain
actual native Node, not guest conformance. Never alter their assertions.

async-fatal-control.cjs uses the sealed callback-recovery native component artifact
with exact SHA check. The current candidate Domain, async, unchanged fatal handler
and actual extracted production native forwarding execute over the real portable
execution owner/NAPI refs. Host EventEmitter/timers, metadata/destroy queue and
registration are explicit component dependencies, not native JSAPI/GC/job proof.
Throwing handler and unhandled cases assert actual failure rather than recovery.

The separate native-owner-forwarding-review-173 capsule fixes earlier fs.watch/TTY
argument forwarding; it is not part of this Domain slice and does not weaken their
remaining kernel, mode, public constructor or four-host limitations.
