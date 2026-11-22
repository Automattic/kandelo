# Native source adaptations

The immutable Node archive remains in `third_party/nodejs/upstream` with its
original hashes. Preparation copies complete verified files to the recipe work
directory and applies these maintained patches with zero fuzz or offsets. It
does not search for, extract or generate executable function bodies.

`0001-native-interrupt-transport.patch` relocates the two complete FIFO methods
from V8's `deps/v8/src/execution/isolate.cc` into an adapter include. It retains
enqueue/pop ordering, the mutex boundary, handle scope, and draining until empty,
including callbacks posted by callbacks. The changes select a real bridge mutex,
SpiderMonkey notification, an admission invariant and the actual bridge isolate
pointer. V8's CPU-profiler `VMState<EXTERNAL>` and private runtime-call counter
are omitted; this does not implement or remove required profiling APIs.

The same patch replaces only the original Environment destructor's empty-script
retirement mechanism with `DrainNativeInterruptsForCleanup`. Its tombstone,
debug delivery check, other cleanup and destruction order remain in `env.cc`.
That staged owner still needs the complete original Environment integration;
staging it does not activate it or establish startup support.

The bridge registers one native dispatcher for each JSContext and holds its
native engine owner until shutdown. Dispatch and explicit cleanup drain the
same FIFO. They preserve existing exception state without clearing it during
callbacks, leave the shared termination record alone, and forbid JavaScript
entry. Handle scopes retain roots without finding a principal realm through an
Environment. An explicit Context::Scope selects its real realm and restores the
prior bridge context on exit.

Only final engine disposal closes admission, after producer owners have stopped
and joined. Per-Environment destruction drains without closing sibling delivery.
The native dispatcher is detached after final draining; an additional engine
notification then has no native owner to access. A queue-empty assertion cannot
establish producer shutdown. Original Environment/worker/watchdog ownership,
microtask retirement, concurrency, GC and four-host behavior remain integration
and acceptance obligations. No source-only check establishes those properties.

`0002-kandelo-ffi-owner-retirement.patch` adds target-guarded CIF retirement to
the existing `FFIFunction` and `FFICallback` destructors. The generated-adapter
target introduces native signature leases; the original owners release them,
with callback closure cleanup preceding its borrowed CIF's retirement. Other
targets retain their original source behavior. This does not replace Node's
FFI argument, callback, permission, thread or fatal-error policy. The isolated
libffi target's standalone guest diagnostics are not proof that these Node
owners have been compiled, activated or qualified.

`0003-native-extras-tracing.patch` adapts the complete pinned
`deps/v8/src/builtins/builtins-trace.cc` for the native extras binding. Original
validation order, disabled-category handling, phase/id conversion, flags,
JSON conversion and boolean results remain in that source. The native adapter
uses the actual tracing controller, real UTF-8 conversion and native callback
error transport; V8-only fuzzing instrumentation is guarded out. The original
file is restored byte-for-byte by reversing the patch. Each real context eagerly
owns its extras functions, including continuation-data access; reading the
binding during cleanup does not lazily construct a replacement. This batch has
not yet been compiled or runtime-qualified.

`0004-native-cpu-profile-json.patch` retains four complete pinned profiler
source files. The portable `ProfileNode`, `ProfileTree`, tree traversal,
caller-position policy, line ticks, JSON serializer and chunk writer are adapted
to native engine metadata. V8 code maps, register sampling, optimizer
instrumentation and trace-chunk production remain preserved behind the native
source boundary. Native code entries belong to the profile, replacing the V8
code-entry store's references; the native constructor rejects a borrowed V8
store. A small buffer/container adapter supplies real C++ storage. No function
bodies are extracted. This source patch has exact forward/reverse proof, but
the adapter has not yet been compiled or runtime-qualified. Trace-chunk/native
frame coverage and integrated profiling acceptance remain unfinished work.

`0005-native-heap-profiler-registry.patch` preserves the complete pinned
`heap-profiler.cc`. Its portable graph-callback add/remove bodies remain
unchanged, including duplicate registration and first-match removal. The native
adapter owns the callback vector and profiler lifetime; V8 collector/object-map
algorithms remain in guarded source while their SpiderMonkey backends are
implemented. The new real object query collects before invoking Node's original
predicate, roots candidates across callback activity, and excludes transport
wrapper aliases and external API carriers. The complete source patch reverses
byte-for-byte. None of this new heap source is built or runtime-qualified yet.
