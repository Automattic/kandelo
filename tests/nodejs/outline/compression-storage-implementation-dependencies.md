# Compression storage ownership: source112

This slice addresses part of ZIP-007 in the completed compression audit. It
changes the shared guest codec/work owners, used by Node, Chromium, Firefox
and WebKit. The exact Node26.13.0 source/native-reference pins and frozen audit
remain unchanged. A source implementation or a native reference pass does not
establish four-host guest conformance.

## Actual ownership

`third_party/node-core/codec-handle.cpp` now admits shared/growable-shared and
ordinary resizable views to synchronous codec, dictionary and CRC operations.
Synchronous operations borrow current view bytes with JS/GC excluded; no raw
pointer survives that borrow. Detached ordinary buffers still fail explicitly.
Async operations must acquire a separate real queue lease before borrowing
pointers for a native worker.

`third_party/node-core/native-work.cpp` distinguishes two lease owners:

- Ordinary fixed buffers retain the existing canonical checked-unwrap,
  non-inline storage, counted root and length-pin protocol. Final release
  removes only the pin the queue actually owns.
- Shared buffers retain their canonical checked-unwrapped JS owner through
  native work, completion, cancellation and teardown. They need no length pin:
  shared storage cannot detach, and growth preserves existing bytes/addresses.
  Final release drops the root without changing a shared length/pin policy.

This uses actual pinned SpiderMonkey storage behavior, not guessed browser
identity. `SharedArrayRawBuffer::Allocate` reserves non-Wasm shared storage for
the requested maximum, `growJS` changes its atomic visible length without
moving storage, and the rooted SharedArrayBuffer object retains the raw
buffer's refcount. Shared Wasm growth commits pages at the same base address.
The selected source and public checked-unwrap APIs are retained under
`.context/node26-compression-storage-source/reference-inputs/` with hashes.
No maximum, reservation policy or host-memory budget is increased.

Codec operations keep the originally captured byte span when a length-tracking
shared view grows. They do not start processing newly appended bytes. As with
the pinned native raw-byte codec bindings, these APIs do not supply a protocol
that synchronizes concurrent changes to the bytes being processed. The growth
control mutates only the newly appended region, outside the captured span.

The queue is also the owner used by callback pathname writeFile/appendFile.
The shared-buffer lease therefore serves that actual filesystem consumer too;
there is no codec-specific forwarding or test-only native substitute.

## Evidence checkpoint

`tests/nodejs/controls/compression-storage.cjs` is one unchanged public-API
control source run against the pinned native reference and actual guest. Seven
named cases cover CRC view offsets/types/seeds, five synchronous codecs over
shared/growable/resizable input, four dictionary codec modes, asynchronous
shared codecs, growth during pending compression, overlapping shared-buffer
jobs with a reentrant follow-up and callback filesystem consumption.
Nested variants are not separately counted APIs.

The engine110 baseline records0pass/7fail, with all7same-source native
references passing. Codec controls encounter the former shared-storage refusal;
the shared filesystem consumer fails at the old native queue Pin boundary.
Those original artifact identities, sources and outputs remain in
`.context/node26-compression-storage-baseline/report.json`.

The source report records generation freshness, unchanged target/audit,
unchanged compatibility JS including the separate Claude/npm/Bun remainder,
exact Node reference files, selected SpiderMonkey ownership/API source and
recipe112's declared inputs. These are source checks, not C++ execution.
The first canonical112build failed because the new API calls lacked an
explicit `js/SharedArrayBuffer.h` include. Its original inputs, compiler errors
and logs remain in `.context/node26-compression-storage-r112-failed/`. Adding
the public header fixes our embedding error. The second canonical targeted
build succeeds, reusing all8library nodes. No outside-runtime defect is alleged.

Normal resolver admission accepts the49,714,250-byte stamped engine, SHA256
`ea59183de5c0d1b4f75081c5a9b4c41e5949c3c36a0b9d2933bd2b7aaec84459`,
with the same ABI55contract digest as the accepted kernel. The prebuild inputs
were checked unchanged after the build. Exact artifacts/projection/build logs
are retained in `.context/node26-engine-r112-accepted/`. This is one targeted
engine build, not a full immutable SDK/host/product closure.

The candidate report `.context/node26-compression-storage-candidate/report.json`
records3pass/4fail, zero skip/unsupported/timeout/harness-error. CRC, dictionaries
and the shared filesystem consumer match. All7native references pass, and
all7candidate executions exit0after their assertions/round trips complete.
The4failed classifications retain exact-marker differences in gzip output
checksums. They are not relabeled as passing cases.

## Concrete gzip metadata difference

The exact native reference is macOS; the guest is Kandelo. In the pinned
`deps/zlib/zutil.h`, `__APPLE__` selects OS_CODE19 and the unchanged generic
Unix default selects3. `deps/zlib/deflate.c` writes that value to the gzip
header. Both files were verified against the unchanged target archive.
[Zlib's official manual](https://zlib.net/manual.html) documents platform-based
default OS metadata. [RFC1952 section2.3.1](https://www.rfc-editor.org/info/rfc1952/)
defines the gzip OS field and Unix code3. This informational research does
not change the pinned Node/bundled-zlib versions.

The separate raw trace reproduces sync/async gzip for the small, partial and
large inputs used by the failed comparisons. All6outputs differ only at byte9:
19versus3. Their compressed bodies, trailers, decoded checksums and lengths
match. Every differing checksum/length pair in the original4failed cases is
reproduced by this trace. The diagnosis, exact reference files and comparisons
are retained in `.context/node26-compression-storage-gzip-boundary/report.json`.
The diagnostic marker also differs and stays a nonpass; it is not additional
API coverage.

Our exact cross-platform compressed-byte comparison is stricter than this
documented field permits. The record preserves that comparison and its4failed
statuses, adds the concrete metadata explanation, and changes neither public
assertions nor production bytes/platform identity. This is not an exclusion of
gzip or shared-buffer behavior. It does not resolve the remaining storage,
lifecycle or four-host obligations.

## Remaining work

- Ordinary **asynchronous resizable** storage still needs an ownership protocol
  that preserves Node's resize/transfer behavior. The existing rejection stays
  explicit; merely pinning length or silently substituting a different output
  store would not implement the required contract.
- Ordinary pending transfer, unrelated pre-existing boolean pins, cross-owner
  leases, detached/out-of-bounds errors and cross-realm/GC/cancellation/failure
  controls remain ZIP-007 obligations. Synchronous acceptance does not close
  those asynchronous or error cases.
- ZIP-010 allocation accounting and async-resource lifecycle, complete archive
  and iterable/Web contracts, shared stream/filesystem consumers, and the
  unresolved native-reference questions ZIP-011/012 remain open.
- Current identified artifacts must eventually be validated across all four
  hosts. A targeted Node-host result cannot establish browser parity.

The generic Error layout failure and all previous nonpasses remain preserved.
No compression finding or family is declared complete. Overall conformance
suites remain deferred until the breadth-first implementation pass is complete;
the full product rebuild deferral remains in effect.
