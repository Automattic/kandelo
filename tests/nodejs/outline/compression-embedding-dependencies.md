# Compression embedding implementation dependencies

Current follow-up: [source112 storage ownership](compression-storage-implementation-dependencies.md)
is compiled/admitted and has scoped actual Node-host evidence. Earlier source
checks remain scoped to their own identities; no whole-family completion follows.

Target: unchanged Node 26.13.0 source/reference pin in target.json and the
completed audit. This is a post-audit implementation plan; the audit remains
historical. Compression is started, not complete. Source checks and native
reference controls do not establish guest conformance.

| Finding | Owning layer and current state | Next implementation/validation |
|---|---|---|
| ZIP-008 numeric conversion | codec-handle.cpp now uses actual JS::ToInt32/ToUint32 after pinned public validators, then checks converted bounds before native access. Init, params, flush and byte spans use the matching signedness. Primitive-only private arguments avoid conversion reentry while state is borrowed. Safe-integer pledges/mode/CRC checks stay separate. | Targeted native embedding compilation, then actual guest fractional option/chunk/params controls and unchanged upstream zlib cases. New source controls execute Node's backend, not this C++. |
| ZIP-009 initialization errors | KandeloCodecError follows AsyncWrap::MakeCallback(name): missing/noncallable onerror does not mask the library failure. Init still throws ERR_ZLIB_INITIALIZATION_FAILED; callback getters/calls can propagate exceptions. Failed partial contexts retain destruction ownership. | Actual guest invalid Brotli/Zstd parameter and allocation paths, optional/present/throwing callbacks, subsequent close/GC and resource-release accounting. |
| ZIP-007 shared/resizable/detached storage | Source112 admits shared/growable views through real lifetime roots and synchronous resizable spans. Ordinary async resizable stores and unrelated existing boolean pins still reject; transfer/GC/realm/lifecycle remains debt. | Trace engine backing-store identity/lifetime and safe racy access; define actual counted leases across consumers. Compare transfer/resize during pending reference work before choosing observable pin policy. Do not treat a permanent shared pin, lost lease or forced resize rejection as compatibility. |
| ZIP-010 lifecycle and memory | Existing native queue/context/allocator roots and completions remain the production owner. Source-only changes do not prove thread shutdown, callbacks, GC or all allocation counts. | Validate real queue cancellation/context retirement, finalization, before/after hooks, dictionaries/vectors/context overhead and heap accounting after those owners exist. |
| ZIP-001–006/011–012 broader codecs/archive/iterable/Web contracts | Pinned JS/context source is present; full guest stream/fs/native wiring and target questions remain. | Use unchanged catalog cases plus exact native controls for archive post-close behavior, inherited params, entry cancellation, malformed frames, storage variants, CRC and dictionaries. Preserve all nonpasses. |

`third_party/node-core/upstream/compression-reference/` retains full unchanged
node_zlib.cc and async_wrap-inl.h sources. Their hashes are checked through
sources.json. The engine build already declares codec-handle.cpp as an input;
no kernel/host wire format or POSIX ABI entry changed in this slice. Its
initial evidence was source-only; the112follow-up compiles this embedding.
No full product rebuild ran.

The focused fixture uses actual native Node streams, Buffer, ZIP/error/async
internals and codec handles as explicit boundaries. It preserves the actual
private constructor prototype/new.target route and checks public option
validation, real compressed bytes, asynchronous completion and init errors.
The native binding activation is local to bounded child processes. This
fixture does not substitute its V8 handle implementation into the product.

Observed fixture failures remain recorded: dropped native-test activation,
a reference close-before-init assertion caused by the fixture, and a wrong
expectation that Brotli quality 999 would fail initialization. Pinned Brotli
accepts that quality and clamps it during encoding; the corrected control
retains that fact and uses its boolean parameter value 2 for actual failure.
No outside-runtime defect or platform exclusion is claimed.

All four hosts share the changed guest C++ embedding. Actual host/thread
quiescence, memory reservations and process ownership still require their
own host evidence. Keep overall suites deferred until the breadth-first
pass is complete; complete the other independent families meanwhile.
