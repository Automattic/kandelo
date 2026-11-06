# Crypto byte-source and random allocation ownership

Source159 replaces direct raw IsBufferSource calls inside no-GC scopes with
checked, rooted actual byte-source admission and bounded native consumption.
The selected private overload can materialize storage and does not unwrap
cross-compartment wrappers; calling it inside no-GC was Kandelo's API misuse.
The new helper checks caller authority before actual-owner realm entry and
uses public nonallocating view/ArrayBuffer/shared-buffer accessors. It retains
real denied-wrapper errors and atomic shared-byte loads/stores. Multi-input
operations prepare owners before borrowing any pointer.

Async random-fill jobs now capture the real existing backing-allocation
capability before init hooks, move it to native work and write the original
range. Completion does not re-read a detached/resized current JS view. Scratch
capacity is allocated and accounted before publication; failure/retirement
paths release actual ownership. The independent X509 source-realm correction
and unchanged atomic copy helper are preserved. No engine API or wire ABI is
added. The package revision changes because native source output changes.

Current exact sealed postimages,740 guarded production inputs and normal
native unity/header staging pass, along with14 existing package-source checks.
The sealed twelve pinned-native reference groups specify foreign view/raw/
shared/detached/OOB ranges and transfer/growth during actual random init. Those
references do not execute Kandelo's new JSAPI, security wrappers, backing bridge
or worker. They are reused identified evidence, not new candidate test passes.
No new engine compilation or guest/four-host validation ran for this slice.

A separate sealed bounded layout review strengthens source158's alignment
reasoning and records13 tiny helper attempts with all6 failures preserved.
It does not replace the failed source157 production build or establish a
compiling current engine.

Actual allowed/denied/revoked wrappers, inline/pinned storage, OOM, GC/realm,
original allocation through transfer/shrink/grow/work/cancel/teardown and all
four hosts remain unvalidated. Existing sync-KDF init-stage semantics,
SQLite/TLS source questions and broader crypto requirements remain open.
All nineteen families remain partial; overall suites/full rebuild are deferred.

Exact evidence: [crypto-byte-source-finding-progress.json](crypto-byte-source-finding-progress.json).
