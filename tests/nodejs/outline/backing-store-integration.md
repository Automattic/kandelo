# Actual backing-store ownership prerequisite

Checkpoint source140 installs the real native allocation/controller/span
primitive and twelve-file engine ownership delta. It preserves the original
allocation through detach/transfer/resize/clone rather than keeping a stale JS
view or copying send bytes. No public native-work/FS/codec/UDP path is switched
by this prerequisite; their old strict Pin/queued-copy gaps remain open.

The VM-facing capability and transfer headers stay C++17. Only the existing
C++20 shell consumes the existing process retained-memory ledger. Its immutable
provider resolves the real owning-thread primary environment and returns no
account after retirement; no VM account/global/anchor is created. Owned handles
contain native state, not JS roots or context pointers. Provider code lifetime
must cover all retained capabilities.

Source paths append native slots without changing existing public/JIT slot
expressions; promote inline data into real maximum-capacity allocation while
updating actual views; keep RAB suffix zeroing; and preserve actual allocator
policies for malloc/mapped/external/Wasm storage. Transfer uses the actual fixed
same-allocation or RAB/length-change destination. Shared raw references/native
controller reconstruction and JS-owner pressure roles are distinct. Same-process
clone packets own indexed transfer sidecars with read/commit/retry/abort cleanup;
different-process byte serialization is unchanged. A coherent new engine is
required; no old artifact is restamped or mixed with the new internal tag.

Nonempty USER_OWNED storage still requires an actual embedder deallocation
capability. A borrowed pointer or a JS root does not establish that authority.
The implemented InstallUserOwned transaction must be attached to relevant real
allocators before full admitted-kind routing can be claimed. Wasm logical max
capacity is not exact committed/mapped/guard pressure. Requested payload/object
capacities exclude allocator/shared_ptr/ledger overhead and are not RSS.

## Root review and correction

The portable known-owner probe reproduced136 controller bytes in the process
fallback pool and an unrelated account's credit. The controller record existed;
it lacked the actual owner/span claims. Both real owners now claim that same
record alongside store/self records. The identical assertion passes after the
fix, including retirement of the JS owner while a native span remains, exact
last free and the existing packet/shared-reference controls. Truly contextless
packet/raw-only retention remains pending; no second record/ledger is invented.

Other source review checks retained their original requirements: typed-data
APIs already return zero length/offset for detached/OOB views; inline promotion
uses the existing calloc owner, preserving zeroed RAB growth; default move of
clone data moves its shared sidecar. These are source traces, not VM/GC/runtime
proof. Actual clone append/failure/malformed/pressure/realm paths still need
identified-artifact execution.

## Evidence and remaining work

All twelve engine pre/postimages roundtrip exactly from pinned Mozilla source
and the five applicable existing recipe patches. New0112 retains their exact
postimages with empty diff context normalized. Native staging preserves prior
VM/target/ELD/HTTP/worker/lock owners and supplies the actual patched capability
header before the native factory/memory fragments. Source closure covers687
Node inputs; generated bundle is unchanged, staging/unity and shell syntax pass.
No source pin, external program/kernel/host ABI, memory ceiling or accepted
engine artifact changes. The new tag is private ephemeral same-process data.

Root native evidence uses four standalone compile commands: the before/after
actual factory controls, unchanged primitive and C++17 boundary object. The
initial projection failure remains a nonpass. Corrected control executes real
factory/ledger/span/packet ownership and eight native threads x1000 shared raw
reference operations; VM raw destruction and account resolver are explicit test
dependencies. The primitive covers six OOM rollback points, zero bytes, live
prefix/suffix behavior, aliases, retirement and eight-thread release. Fourteen
package source checks pass. Earlier sealed V8 backing/UDP initial-span baselines
remain native-reference observations, not new candidate or guest passes.

Actual VM/JSAPI C++ compilation, generated JIT/GC layout, zone accounting,
reentry/OOM, Wasm/external/user-owned behavior, zero-length clone/abort and real
worker/realm/transport/four-host execution are pending. Public consumer routing
must capture original spans before async-init reentry, read each source-list
entry once, preserve JS identities required for results and retire roots on
the owning thread. No accepted kind may be silently narrowed. Prior sanitizer
nonpasses remain open. All19 families remain partial; overall suites and full
product rebuilds remain deferred. See the exact source/control ledger:
[backing-store-finding-progress.json](backing-store-finding-progress.json).
