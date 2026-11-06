# Public histogram binding source candidate

This source candidate consumes the separately sealed portable histogram
owner. It does not change or claim the current guest `perf_hooks` inventory.
Package/engine/bootstrap integration is supplied as private review patches;
no new guest binary or browser result has been produced.

`histogram-platform-adapter.js` embeds the complete, unchanged pinned
`upstream/histogram-reference/lib/internal/histogram.js`. Constructors,
public prototypes, validation, readonly snapshot classes, maps, bigint
accessors, confidence results, burn rate, JSON/inspect, clone descriptors,
window options, import validation and synchronous QRDE option errors come
from that actual wrapper. Only its private performance binding is supplied
by the adapter. The public namespace integration exposes the three factory/
import functions; the returned classes are not additional namespace exports.

`histogram-binding.h` translates operations into the real native owner and
typed transport results. It preserves int64 values until the binding chooses
Number or BigInt, collects map entries outside native locks, retains native
snapshot/diff errors, and does not approximate histogram distributions.
The source pin is unchanged; the public wrapper SHA-256 remains
`16c2c72f457397cb21048bf0e096117bbf03758b2dc964b47c91c90a79846a9c`.

## SpiderMonkey source path

`histogram-native.cpp` supplies actual Histogram and SlidingWindowHistogram
JS classes with reserved-slot owners and foreground finalizers. It checks
native brands through checked unwrapping. Each wrapper retains actual
`shared_ptr<Histogram>` or a unique native window; independent snapshots
allocate independently. Finalizers retire associated native HDR material
charges and delete the actual owners. Window charges follow lazy native
chunk allocations. Uint8Array/Buffer views use their actual byte spans and
offsets; imported shared bytes are copied with atomic reads.

Public maps use `JS::MapSet` after native iterator collection, without
calling mutable JS map methods. BigInt results are constructed directly
from signed or unsigned 64-bit values. CBOR is the unchanged owner's
serialization. Number conversion truncates and bounds values before
entering native int64 operations; it never invokes undefined floating
conversion. Pinned raw messages include `expected_interval`, with the
underscore preserved independently of the public argument spelling.

QRDE dispatch captures the native snapshot before submitting actual work to
`KandeloNativeWorkQueue`. Pool workers only build native snapshot/numerical
results. A plain resource object and the settlement callback are rooted on
the owning JS context; the parent histogram JS wrapper is not retained just
to keep the job alive. The native histogram is retained only on a requested
cache miss, until generation-checked insertion. Native allocations are
charged at preparation and reconciled on the owning JS thread at completion;
worker-side allocation changes do not call GC APIs. Native HDR charges and
job snapshot/results are accounted; cached snapshot accounting retained
after the job and allocator/vector overhead still need engine memory-report
integration and real-engine verification.

Delivery creates null-prototype results, real Float64Array backing buffers
and bigint count, then settles the real Promise. Queued cancellation can
produce the source's plain `Error("QRDE job was canceled")`; context shutdown
joins native workers and clears job roots without calling JS. The source
uses the existing native queue's admission/dispatch/shutdown policy. Callback
checkpoints, async-context behavior, OOM fault paths, and cancellation still
require actual engine execution before any conformance claim.

Native prototypes are registered per context/global and rooted until that
context's explicit histogram shutdown. The engine patch must call
`KandeloShutdownHistograms` before destroying its context/root lists.
Multi-realm creation and teardown are not established by the host addon
controls and remain real-engine validation requirements.

## Same-process clone material

`histogram-clone.cpp` provides native structured-clone read/write callbacks.
The proposed `native-ports.cpp` patch adds a packet-owned native sidecar of
`shared_ptr<Histogram>` values and passes it as the clone callback closure.
The byte stream contains only a native custom tag and checked sidecar index;
it contains no JS-visible pointer token or serialized imitation of reserved
slots. The callback marks the serialization as requiring SameProcess scope.
The recipient creates a fresh native JS wrapper using its configured native
prototype and retains the same actual histogram material.

Write failure and aborted serialization release the sidecar with the packet.
Read failure is covered by the existing message-content cleanup. Broadcast
delivery retains immutable clone data and its sidecar for every actual
recipient. Distinct messages/reads reconstruct distinct wrappers over shared
material. Window handles have no native clone callback and the unchanged
public wrapper marks windows noncloneable/nontransferable. Public ELD clone
behavior remains dependent on the missing ELD owner/scheduler.

The bootstrap patch routes direct structuredClone through the same owned
native serialize/deserialize message path, so native data is not handed to
the unrelated shell serializer without its sidecar. The internal clone
deserializer receives the full histogram module, including the pinned
ClonedHistogram/ClonedRecordableHistogram constructors. No JS value or root
is shared across contexts. No cross-process or cross-host native-pointer
transport is implemented. Packet-sidecar HDR memory reporting and budget
accounting still require engine integration. These hooks have not been run
in SpiderMonkey.

## Host controls and remaining validation

`tests/histogram-binding/` is a host-only N-API transport over the same
engine-independent dispatch and the actual portable owner. It compiles in
the declared dev shell against the exact pinned Node headers, and loads in
the exact native Node 26.13.0 executable. It executes the full pinned public
wrapper and actual asynchronous native QRDE work. It is deliberately not a
mock statistics object and is not a substitute for compiling JSAPI source.

The differential fixture compares actual statistics, widths, Maps, CBOR,
inference, windows, snapshots and error results. A separate edge fixture
checks public invalid options/types/brands/ranges, Buffer view offsets,
readonly snapshots, raw error messages, QRDE synchronous throws and captured
snapshots/null-prototype/typed-array results. The control explicitly
substitutes a native shared-material alias for the reference structuredClone
step: N-API cannot test the proposed SpiderMonkey callback/packet facility.
Its reports label that substitution and leave engine transport unvalidated.

The host control currently uses Darwin dynamic-lookup shared-addon flags.
Native sanitizer evidence from the sealed backend remains nonpassing/
incomplete and is not superseded by this addon run. No sanitizer claim is
made for this public source candidate.

Run with exact paths through the development shell:

```bash
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh env \
  HISTOGRAM_BINDING_OUT=/absolute/private/evidence \
  HISTOGRAM_NATIVE_NODE=/absolute/node-v26.13.0-darwin-arm64/bin/node \
  HISTOGRAM_NODE_SOURCE=/absolute/node-v26.13.0 \
  bash third_party/node-core/tests/histogram-binding/run-controls.sh
```

Actual ELD interval and per-iteration producers, scheduler/provider/ref
ownership, start/stop/disposal and environment teardown remain missing.
There is no public setInterval/Timeout sampler or fabricated sample path.
Fresh wasm32/wasm64 products, unchanged upstream guest tests, engine clone
and worker teardown tests, memory/GC accounting, async-context conformance,
and Node/Chromium/Firefox/WebKit guest parity remain unrun. No ABI, VFS image
or package artifact changes were made here, and no performance claim is made.


Review corrections (separate followup to the sealed handoff): ordinary native
statistical result arrays define own enumerable elements. They do not invoke
inherited setters. QRDE completion enters the shared generic internal callback
scope with an actual plain execution resource, default frame and IDs 0/0,
without an invented AsyncWrap provider. Its callback root is retired before the
outer checkpoint. The N-API fixture remains a host transport control, not proof
of the SpiderMonkey callback or GC implementation.

Differential controls compare public integer-valued Number fields by exact
binary64 equality, and BigInt/CBOR strings losslessly. Only named floating
statistics and QRDE quantile/density fields use relative 2e-11/absolute 2e-12
tolerance for arithmetic rounding. The separate native-retained-memory owner now tracks real cache/work/source/
snapshot material independently of wrappers and packet sidecars. Its exact
tracked payload conservation and advisory context credits are distinct from
real GC/clone/pressure acceptance; see native-retained-memory.md. QRDE's fresh
zero-ID execution resource is created at completion in the primary environment
realm, with no submitter/VM account anchor.
