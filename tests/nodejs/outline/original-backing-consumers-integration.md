# Original backing allocations in queued native operations

Source checkpoint 146 routes scalar and vector filesystem I/O, whole-file
write jobs and codec work through the real allocation capability added at
checkpoint 140. The former queue pin rooted a JavaScript buffer and blocked
some transfers or resizes. The new native spans retain allocation ownership
and the initially selected offset and length without retaining a JavaScript
context or preventing the original view from changing.

Scalar filesystem operations capture their span before Promise creation and
async initialization. Both vector paths read each array entry once and retain
that entry's span before evaluating the next getter. Vector capacity has a
real metadata charge. The existing callback/result identity roots remain
separate from allocation ownership. Cancellation, completion and shutdown use
the existing pthread work queue and retire their actual span owners.

WriteFileJob follows its different upstream order: async initialization runs
first, then the job captures the current span. Resizable ArrayBuffer and
growable SharedArrayBuffer inputs receive an owned native copy at that point;
fixed inputs retain live allocation ownership. An initialized, unrun job owns
its span, and dispatch moves that owner into the worker. No JavaScript snapshot
serves as native allocation ownership.

Codecs retain original input/output spans for write and params operations and
retain write-state storage until close. Zlib's result words use the buffer's
base address; Brotli and Zstd use the view offset, matching the pinned native
implementations. Shared result writes and dictionary/parameter copies use
atomic accesses. This does not establish race or byte-consistency conformance
for codec libraries directly accessing shared input/output.

The actual shell USER_OWNED producer now prepares a matching js_free
deallocator. Its original UniquePtr or GC cell keeps deallocation authority
until the private ArrayBuffer link and InstallUserOwned commit succeed.
Before commit, ordinary cleanup frees the allocation. After commit, GC removes
its cell charge before releasing its owner; the last native span can then free
the allocation on a worker without calling JSAPI. A shell without the Node
provider keeps its original GC ownership. Borrowed producers do not gain a
fabricated deallocator or a rooting fallback.

The six production fragments exactly match the reviewed private proposal.
Engine patch 0116 rebases only the USER_OWNED changes over checkpoint 145,
preserving the watcher, clock, TLS, lazy-property and VM hooks. Four complete
Node reference files match the audited 26.13.0 archive. No target pin, public
assertion, platform identity, kernel/host ABI or shared-memory ceiling changes.
The normal package recipe advances to revision 146; no artifact is restamped.

Focused verification passed:

- One strict C++20 component build and bounded execution over the actual
  integrated native factory, ledger, pthread queue, scalar worker body and
  USER_OWNED create/finalize body. Fake GC/accounting and installation are
  explicit dependencies; this does not execute SpiderMonkey GC or JSAPI.
- Existing native-reference evidence for eleven capture/order/copy/result
  cases, retained under its exact binary identity and not rerun in this slice.
- Thirty-six affected checks: 22 filesystem/codec frontend controls using
  native dependencies and 14 package-source checks, with zero skips.
- Normal source/input/unity checks and exact engine-patch round trip.

The original fixture compile and static-check failures remain in the sealed
evidence. Their corrections changed fixture declarations or check scope,
without weakening compiler diagnostics or public assertions.

FS-011 and the public filesystem, codec and backing-store contracts remain
open. The combined engine is uncompiled; actual GC, realms, wrappers, OOM,
detached/out-of-bounds/shared/resizable cases and callback integration require
targeted engine and guest validation. UDP and socket consumers remain separate
work. ReadFileJob allocation-capacity accounting is also outside this slice.
All 19 families remain partial. Current conformance across the Node, Chromium,
Firefox and WebKit hosts is unestablished. No overall suite, package/engine
build or full product rebuild ran.

Exact source and evidence identities:
[original-backing-consumers-finding-progress.json](original-backing-consumers-finding-progress.json).
