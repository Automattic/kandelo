# Retained native codec capacity

The actual private codec handle reports committed native-state allocation,
concrete codec-context allocation, retained vector storage and external string
storage, plus the existing codec-library custom-allocator ledger. Vector
capacity uses element size. Short strings residing inside their string object
add no storage beyond context sizeof; external string allocation includes its
terminator. Current declared libc++21.1.7 source stores short data inside the
object, reports long capacity excluding the terminator and deallocates its
long storage by capacity+1. Native component libc++19.1.2 is separately bound.
This is requested live owned capacity, not allocator overhead, RSS, public
process-memory schema or heap-snapshot visitation.

The pinned source declarations/methods remain unchanged. The existing generator
adds one actual capacity accessor to each of five concrete context classes;
Brotli/Zstd base subobjects are included in concrete sizeof and never added
twice. Dictionaries/params/error strings use the real stored containers.
Library custom blocks/prepared dictionaries retain their existing allocation
prefix accounting. JS byte backing spans have separate owners and are not
re-added here. Temporary local copies during reset or error construction are
outside this retained-owner slice, not claimed fully accounted process memory.

All container sampling is on the JS owner thread while not writing. Actual
work completes and publishes through the queue mutex before Complete marks the
handle idle and reports. Error strings can mutate on workers, so submission
never samples them. Reentrant callbacks may enqueue new work; quiet-exit error
report guards skip sampling then, with the real completion retaining authority.
The native object is charged after real reserved-slot ownership commit before
method allocation/init hooks can fail or force collection. Mutation scopes
refresh retained capacity on initialization/params/reset errors without losing
original JS/C++ errors; ordinary reporting still occurs before error callbacks.

Close frees real codec-library blocks but clear() can retain dictionary/params
and error-string storage in the still-owned context. Those bytes remain charged
until actual context destruction. Foreground GC removes the last reported amount
once before deleting the actual state/context; no close-to-zero fiction is added.

Focused control compiles actual generated five-context algorithms over exact
Node26.13 bundled codec headers/exported native C symbols. Only the native test
boundary replaces SpiderMonkey mutex headers with genuine std::mutex/release
abort assertions. Seven groups exercise real codecs/worker threads, retained
capacity and cleanup. These are component observations; production JSAPI/GC
report deltas, pending exceptions, finalizer/realm/fatal/worker/process lifecycle
and four-host behavior remain uncompiled/unvalidated in this slice. No heap
snapshot or full ZIP-010 closure follows.

Pinned Node MemoryRetainer/MemoryTracker is a V8 heap graph, not this GC-pressure
counter. The original vector visitor traverses live elements and the string
visitor uses size(), shifting inline sizes out of parent nodes where applicable.
This slice does not reproduce that graph or call capacity estimates heap-snapshot
parity. Actual retained-capacity accounting is a distinct owning prerequisite;
the audited heap-visitation/whole-process metrics requirements remain open.
