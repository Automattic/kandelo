# Compression, archives and iterable transforms

Completed source review of the compression family: node:zlib,
node:zlib/iter, returned/inherited codec and archive objects, and scoped
CompressionStream/DecompressionStream owners. Target Node 26.13.0, source
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.
No runtime test, probe, compilation, package build or fixture ran.
Completion of this source review does not certify implementation or
runtime conformance; substantial binding and dependency gaps remain.

`compression-requirements.json` retains all 167 zlib document sections,
418 original saved descriptor observations, source-discovered contracts,
scoped Web compression sections and exact source identities. Constants,
aliases and prototype metadata are observations, not 585 distinct APIs.
Options/BrotliOptions/ZstdOptions describe option records; ZlibBase is a
documented inherited base, not an additional own public module export.

## Final factory and actual lower implementation

bootstrap:5797 resolves zlib through _nodeStreamPlatform.require. The
final factory uses pinned lib/zlib.js and internal/zip modules, rather
than the older simple native convenience functions retained in the shell.
stream-platform-adapter.js:3–112 supplies actual streams, Buffer, errors,
validators, filesystem, async state and the compression binding.
build.py:303–317 embeds source factories, while
compression-binding-adapter.js:3–35 creates actual engine handles.
There is a module cache with partial exports during cycles and removal on
failed loading; ZIP's lazy zlib reference avoids importing incomplete
public exports. Public CJS/ESM and warning/option identity still depend on
the separate loader/process owners.

The native path is codec-handle.cpp and native-work.cpp, included by
patches 0044–0047. generate-codec-contexts.py adapts pinned context
declarations/methods: V8 wrapper/inspection machinery becomes explicit
SpiderMonkey ownership, mutexes/assertions and custom allocator plumbing.
It initializes the z_stream record for safe pre-init destruction, keeps
bundled Zstd allocation and rejects unreviewed substitution counts. Those
adaptations are a review boundary; unchanged excerpts alone do not prove
their embedding correct. No generator or compiler was newly executed.

node-codecs/sources.json selects real Node-bundled zlib
1.3.2.1-motley (16 C files), Brotli 1.2.0 (35) and Zstd 1.5.7 (26).
The package pins the same source archive as target.json. Zstd enables
ZSTD_MULTITHREAD and uses pthreads; its ASM disable and zlib CPU_NO_SIMD
are implementation choices for this ISA, not exclusions of public codec
behavior. No performance comparison follows from that configuration.
The candidate remains unbuilt; these are source identities, not proof of
installed library bytes or four-host results.

## Public codec contracts and inherited behavior

| Surface | Requirements and source disposition |
|---|---|
| Deflate/Inflate/Gzip/Gunzip/DeflateRaw/InflateRaw/Unzip | Real pinned constructors and stream state; header/raw/autodetect, dictionaries, gzip members/padding, truncated input and trailing-input policy are codec state, not wrapper names. Calling legacy constructors without new uses target DEP0184 behavior. DeflateRaw windowBits 8 mutates options to 9. |
| BrotliCompress/BrotliDecompress | Actual parameter arrays/dictionary and library context; reset preserves both. Their prototype chain includes private Brotli/Zlib bases and inherited stream members. No blanket exclusion for absent caller-selected parameters. |
| ZstdCompress/ZstdDecompress | Classes requiring new; actual contexts, dictionaries, parameter arrays, pledged size, concatenated/skippable frames and reset. Incomplete frames that emitted output reject reset rather than silently producing invalid framing. |
| create* factories | Named one-argument functions returning the right constructors, enumerable/configurable readonly namespace descriptors; subtype, receiver and constructor metadata must remain observable. |
| Callback/Sync convenience methods | String/view/ArrayBuffer conversion, callback overload/error timing, actual codec work, info {buffer,engine}, maxOutputLength, output/error/close cleanup. Async work uses a real pool; Sync calls execute directly. Async zstdCompress pledges known UTF-8/view input length unless explicitly supplied or a different string encoding prevents inference. |
| bytesWritten | Actual consumed input count, including repeated output-buffer processing; not output length or accepted queued bytes. |
| close/flush/reset/params | Actual destroy/finished callbacks, ordered flush marker writes, pending/native close, reset rules and params-after-flush. Brotli/Zstd private Params are target no-ops; their inherited public method versus documentation is an explicit target question below. |
| _processChunk | Explicitly retained legacy sync/callback behavior, not a separate codec. Other underscore/private properties in captures are retained metadata rather than automatic new public promises. |
| Inherited streams/events/symbols | Transform/Duplex/Readable/Writable/Stream/EventEmitter and their static/instance APIs, iterators/disposal, callback-once, backpressure, final/error/close and receiver/state contracts apply. Stream/event findings remain dependencies; this review does not sign off the entire streams family. |

Options are read/validated in actual source order. zlib-specific fields
include level/windowBits/memLevel/strategy/dictionary and mode-dependent
windowBits=0/8 handling. Common options include flush, finishFlush,
chunkSize, maxOutputLength, info and rejectGarbageAfterEnd; byte-stream
options override object mode/encoding/decodeStrings to the codec's byte
contract. Brotli/Zstd parameter keys and numeric/boolean values are packed
into typed arrays with target defaults/sentinel handling. Zstd pledged
size must be a nonnegative safe integer and match actual input.

Constants come from pinned native expressions and the actual bundled
headers. Patch 0044 uses enumerable/readonly/permanent native descriptors,
matching the target constant macro. The namespace constants property is
readonly/nonconfigurable, codes is a frozen bidirectional table, and
legacy non-Brotli direct constants are nonenumerable readonly aliases.
These remain requirements even where the default capture omitted values
or flag-enabled modules. Metadata consistency is not runtime validation.

crc32 validates string/view and uint32 seed, normalizes negative zero,
uses actual crc32_z and returns an unsigned number. Native string handling
uses explicit UTF-8 byte length, including NUL; views honor byte offsets.
Encoding, brands and storage behavior remain shared value-layer
dependencies. The same native CRC supports ZIP verification and Unicode
path extra-field checks.

## New binding findings

**ZIP-007 — buffer and lease support gap.** codec-handle.cpp:153–179
rejects all shared and resizable buffer views; native-work.cpp:327–376
also rejects shared/resizable buffers and unrelated pre-existing boolean
pins. Target native Buffer::HasInstance accepts ArrayBufferView and
node_buffer.cc:247–278 obtains its actual backing bytes/offset/length;
ArrayBufferViewContents also supports shared storage. Public convenience,
dictionary and CRC paths therefore encounter a narrower candidate binding.
Detached/out-of-bounds views need exact per-operation controls; do not
assume all storage categories share one outcome. Ordinary async leases
also pin detachment/length: later controls must compare transfer/resize
during work rather than assuming that storage safety establishes identical
observable behavior. This is missing ownership integration, not an
accepted SpiderMonkey/browser impossibility.

**ZIP-008 — numeric conversion mismatch.** The pinned public
checkRangesOrGetDefault validates finite range without requiring an
integer. Target node_zlib.cc:793–871 converts window/level/mem/strategy
through Uint32Value/Int32Value. Candidate KandeloCodecInteger at
codec-handle.cpp:142–151 rejects fractions. Inputs such as an in-range
fractional compression level therefore take different source paths.
Documented integer types do not establish identical observable validation;
exact native controls must resolve those edge cases. Private safe bounds
are necessary but cannot silently narrow public behavior.

**ZIP-009 — constructor error mismatch.** Public Brotli/Zstd constructors
call handle.init before ZlibBase installs handle.onerror. If init or
SetParams fails, candidate KandeloCodecInit calls KandeloCodecError, which
requires a callable onerror and produces ERR_INVALID_STATE when absent.
Target node_zlib.cc:907–1068 emits an optional callback, then throws
ERR_ZLIB_INITIALIZATION_FAILED. AsyncWrap::MakeCallback in
async_wrap-inl.h returns undefined for a nonfunction callback instead of
substituting the candidate error. Invalid library parameters/allocation
failures need native controls for error details and partial-init cleanup.

**ZIP-010 — shared lifecycle/accounting dependencies.** Actual native
write state, callback realm, async ID/trigger/frame, buffer roots and
codec allocations exist. Codec allocation deltas are reported on the JS
thread; dictionary/vector/context overhead and heap-snapshot visitation
are not complete accounting. Callback/fatal-error/async-hook semantics
inherit A-014 and the scoped async/observability findings. Do not
count raw live allocation reporting as complete process/engine memory
statistics or a successful shutdown test.

## Native work, cleanup and host differences

Each handle owns a context and reserved JS slots. Dictionary bytes are
copied into native ownership. Async jobs root their owner and lease
input/output/write-state backing buffers, then run codec code on real
guest pthreads without touching JS/GC. Completion enters the owner realm,
updates remaining counts, releases leases before user callbacks and
preserves a reentrant new write's buffers. close while writing is deferred;
sync writes reacquire spans without retaining movable pointers across JS.
Reset rejects a busy handle and clears old span state; params reacquires
validated remaining spans. Init failures remain owned for destruction.

native-work.cpp has one process pool and per-context completion queues,
configured UV_THREADPOOL_SIZE and actual 8 MiB guest stacks. Queue
shutdown cancels queued work, waits for running native calls, silently
retires callbacks/roots/pins during context teardown and joins the pool
when the final queue releases it. Worker exceptions become completion
failures; they do not unwind through JS frames. This source path is real,
but source assertions and comments are not evidence that every OOM,
reentry or forced-exit path has executed successfully.

Guest pthread clone/TLS/CTID, kernel scheduling/channels and outer host
worker ownership follow the completed worker audit. Node can await outer
termination; Chromium, Firefox and WebKit require guest quiescence before
thread storage reuse. All four run the same guest codec implementation.
WebKit's configured reservation budget, other host memory ceilings and
Wasm address-space/size_t limits constrain real allocations; they do not
exclude all ZIP64 streaming or portable codec behavior. Exact counters,
maximum sizes and failure behavior remain per-operation obligations.

## ZIP data, archives and descriptor ownership

ZipEntry/ZipBuffer/ZipFile are real pinned implementations. Public ZIP
wrappers warn on use, not import/property access; Symbol.hasInstance
preserves recognition of raw internally produced entries. Static wrapper
factories forward with the raw constructor as this. Names/lengths,
accessor descriptors and prototype/symbol observations are preserved
separately from raw internal classes.

ZipBuffer keeps zero-copy input views, an insertion-ordered Map and raw
comment bytes. Edits change its index; toBuffer/Sync creates a fresh
archive. get/has/delete validate names; addEntry validates the internal
entry brand. Replacement, iteration/forEach thisArg, size/writable,
Symbol.iterator/toStringTag and dispose-clears-index behavior matter.
Mutation of retained archive/data memory remains caller-visible and is
documented, not a reason to pretend the implementation copied it.

ZipEntry handles central/local metadata, UTF-8/CP437/Unicode-path names,
Unix permissions/symlink bits and DOS/NTFS/extended timestamps. Local
header method/flags/size/CRC consistency and member bounds are checked;
the central name is authoritative. Archive names are returned verbatim,
including traversal-looking strings; these APIs do not extract entries
to those paths. Builders choose store/deflate/Zstd, fall back to store
when compression does not shrink data, and retain original memory on
the store path. Empty/directory data, modes, comment/name lengths and
invalid dates have actual validation. Source-backed entries are single
use, initially pending and expose CRC/sizes only after serialization.
ZipFile adoption can promote them to readable file-backed entries.

Receiver checks follow each actual method: private-field access checks
the instance, but compressed/isDirectory/isFile delegate through public
properties and do not impose a universal private brand. ZipBuffer and
ZipFile tag getters return literals. Invalid Date values can pass the creation-time Date
brand check and fail during DOS timestamp serialization; do not move that
error earlier while describing the source. content maxSize uses nullish
default/comparison and verify is enabled unless strictly false, rather
than one universal eager options validator. Preserve those invalid-input
and error-timing controls for the exact native reference.

Buffered content is a fresh result with declared-size/CRC verification
and a configurable default 256 MiB ceiling. Streaming content has no
default whole-buffer ceiling, checks size while yielding and verifies
final CRC/length at completion. Yielded bytes are provisional; stored
in-memory chunks may alias input. getMax/setMax change the shared module
default; setter validates a nonnegative integer. Unsupported encryption,
methods and multi-disk archives must reject with the target's errors;
that target behavior is not a missing public feature to implement.

Header readers/writers implement EOCD/ZIP64, prefixes/baseOffset, packed
or full extra fields, ambiguity/overlap checks, safe integer/range limits,
data descriptors, raw comments and timestamp round trips. Entry/header
counts and declared sizes must agree. ZIP64 streaming can process large
offsets without materializing a whole member; Buffer/address limits
must be assessed separately. These algorithms depend on correct Buffer
numeric/view/encoding semantics and native CRC, not just source presence.

ZipFile opens a numeric descriptor and keeps a shared closed/closing/read
record for every borrowed entry. It queues mutations, rejects conflicting
Sync operations, counts active reads and waits before closing. Streaming
reads release the active-read count while paused at yield and recheck
state before continuing. It reads the tail/directory and lazy member
chunks, loops on partial I/O, and rewrites/truncates the central directory.
Add failures attempt restoration; errors can still leave an on-disk
partial directory. Native target documentation explicitly disclaims
crash atomicity. compact snapshots entries into another archive stream;
it does not overwrite the source file.

zipFiles obtains actual stat/lstat/readlink and regular-file handles,
uses no-follow/nonblocking flags where required, verifies the opened
handle's type, captures its mode/mtime and gives the exact handle to a
ReadStream. Early return must release the actual descriptor/source.
Candidate bootstrap:2835 and :2850 replace close/truncate and selected
callback descriptor/stat methods with native owners; judging ZIP against
the earlier legacy definitions would be wrong. Other paths, such as
readlink, retain synchronous-wrapper timing. FS-008/FS-010, permissions,
short I/O/OFD identity and fs stream lifecycle remain real dependencies;
the whole filesystem family is not signed off here.

## Iterable and Web compression

zlib/iter exports 16 async/Sync compressor/decompressor factories only
with --experimental-stream-iter. Candidate policy records that gate;
lazy source registration alone does not authorize unflagged exposure.
Factories return transform descriptors, not classic codec streams. Their
64 KiB batching and zlib level 4/memLevel 9, Brotli quality 6/window 20
defaults intentionally differ from classic streams in the target.
Options are captured and per-invocation native handles/state are created;
the returned descriptors' validation, symbols and generator protocols
must remain distinct from own module function metadata.

Async transforms pre-read upstream work, own in-flight write promises,
yield bounded batches, handle null finalization, abort pending waits and
close handles in finally. They request upstream return without awaiting
a permanently pending next. Sync transforms process actual bytes and
close in finally. Their normal finalization relies on stream/iter's
normalized source/flush protocol, not direct arbitrary iterable execution.
Those protocol owners remain a streams dependency. No new iterator was run.

CompressionStream/DecompressionStream share stream/web/global identities,
WebIDL enum/brands, readonly readable/writable accessors and tags. They
accept deflate/deflate-raw/gzip/brotli, not Zstd. Their real Duplex/Web
adapter forwards bytes/backpressure/abort/close and destroys both sides
on a synchronous write error. Shared chunks are rejected intentionally
by the Web contract, distinct from the Node buffer support gap above.
Decompression sets rejectGarbageAfterEnd, so trailing-member behavior
must differ from permissive default classic decoders. Transfer of the
returned Web streams inherits STR-003/R-010's missing MessageChannel
transport; correct local codec work does not implement remote transfer.

## Target questions and later evidence

**ZIP-011:** zlib.md:1877–1880 describes system-level errors such as
EBADF after ZIP close. The actual pinned ZipFile/ZipEntry guard uses
ERR_INVALID_STATE and tracks descriptor invalidation. Compare methods,
borrowed entries and in-flight versus new reads on exact native 26.13.0.
The params prose excludes Brotli, while Brotli's actual prototype chain
inherits Zlib.prototype.params and its private Params is a no-op. Preserve
that difference rather than inventing a method absence or new algorithm.
The option prose's integer types versus finite-number/native conversion
also needs the ZIP-008 controls.

**ZIP-012:** archive cleanup prose promises disposal of the current
entry and all queued entries. Async generateZipArchive:225–259 explicitly
disposes queued entries on interruption, but has no current-entry dispose
slot like its Sync counterpart. ZipEntry's async serializer can pause at
its local-header yield before starting the source. Investigate that exact
early-return/source-owner edge with native controls later. This is an
unresolved reference contract/source question, not a newly observed
runtime failure or established engine defect. Callback/return getter
failures, lazy async sources and pending native writes need distinct
cleanup controls; do not alter the assertions or treat unrun as passing.

There is no identified current-candidate four-host compression conformance
result. Historical evidence retains its exact archive/index identities
and original statuses, including common-helper failures/unsupported flags
that prevented later codec assertions. The future catalog records source
files, Flags/Env and helper roles only. It executes no discovery scripts,
WPT wrappers or fixtures and is not a case/subtest/variant denominator.

Later native controls must cover known vectors, corruption/truncation,
dictionaries, concatenated/skippable/trailing data, params/reset/flush,
info/counters/output caps, CRC encodings/seeds, invalid receivers/options,
detached/resizable/shared/leased storage, OOM/error/reentry/shutdown,
ZIP64/prefix/duplicate/overlap/extra fields, byte aliasing, partial I/O,
fd reuse/close races, pending entry disposal, file type/no-follow rules,
iterable abort/return and Web error/transfer behavior on all four hosts.
Implementation and new runtime validation require separate authorization.
