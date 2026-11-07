# Reactive backing-read wake ownership

The actual managed FsNotify/eventfd blocking read now owns a typed backing source
beside its exact OFD/task/channel-generation retry binding. Actual producer
mutation publishes only interested live retries into pre-admitted deduplicated
storage. Settlement re-runs real sys_read and retains EAGAIN or publishes the real
result through existing completion ownership. No surrogate pipe, polling timer,
fabricated event, new wire flag/export or ABI pin is used.

Independent review corrected bounded admission: an otherwise exact new backing
request above kernel retry capacity retains its original host retry. All fd/count
snapshot mismatches remain corruption errors; no clipping is inferred. Current
host large reads use a separate reserved transfer owner, so no current oversized
end-to-end regression is claimed. The rejected permissive clipping assumption,
its successful scalar controls and source/binary remain explicitly superseded.

Native runtime production compilation and the actual Wasm kernel typecheck pass.
The latter does not link a kernel or prove dynamic ABI baseline behavior. Current
identified native artifacts pass37distinct cases:2actual producer/park/binding/
read/completion cases (including fd reuse),5existing retry,26park and4helper cases.
The helper includes expected invariant rejection; these are not37public APIs.
Six final exact scalar admission cases are reused with matching production text.
Original helper4 and superseded6passes are not added again. Caller-memory fixture
does not provide readiness or data. Host task/channel/direct publication/drain and
actual guest behavior are not executed by these native controls.

Seven compiler/build/check invocations are counted once, with no compiler failure:
1producer helper,2review policies,1native production,1Wasm kernel typecheck and
2targeted native test compilations. The first test compile succeeded, then its
park kind was aligned to real transfer admission before any runtime execution;
both exact sources/receipts are preserved. No full product/engine build or overall
suite ran. Package checks reuse the same885declared Node inputs, bootstrap and
native unity bytes. Original seals remain immutable.

Timerfd requires real clock/deadline refresh; host poll/select/epoll ownership,
metadata/SIGIO/watch policy/providers/order/new-kind fork/ABI/public activation
remain missing. Shared settlement/copyback allocation, EFAULT/partial-copy and
peer-memory retirement/liveness are unvalidated. Public inotify stays ENOSYS.
No audit finding/family closes and no concrete engine exclusion is claimed.
The current combined guest candidate remains uncompiled/unvalidated across all
four hosts. Nested Wasm execution remains in scope for the final phase.

The final staged whitespace gate found one extra blank line at EOF in the new
ReadySources helper. It was removed without changing any token or behavior;
compiled source bytes and the exact terminal-whitespace transformation remain
recorded. All37native cases and the kernel typecheck used that pre-normalization
input;705other repository inputs match byte-for-byte. No recompilation or runtime
rerun is claimed for this whitespace-only correction. The prepared snapshot from
the rejected whitespace gate is preserved; recording was not replayed blindly.
