# Native exception boundary investigation after engine 116

The four original cipher guest failures and two diagnostic failures remain
unresolved. This bounded investigation changed no production runtime, SDK
flags, tests, assertions or target pin. It does not explain historical SQLite
failures or establish an outside engine/toolchain defect.

The repository uses both `-fexceptions` and `-fwasm-exceptions` in different
builds. A tiny no-header C++ throw/catch compiler control used the same target
and exception/SjLj feature flags as the SDK. The exact declared LLVM compiler
produces byte-identical LLVM IR with either language flag, including an
`invoke`, catchswitch/catchpad, `__gxx_wasm_personality_v0` and typed handler.
The flag distinction is therefore not evidence for changing the engine recipe.
Four compiler invocations were attempted: the first two used a Nix-wrapped
host compiler and failed on a host hardening option; the two corrected
invocations use the declared unwrapped compiler and succeed. No engine build
was performed.

Diagnostic preloads and logs live in
`.context/node26-native-error-boundary/`. The first preload invocation did not
reach the relevant worker realm. The second caused its own tag-brand failure
by replacing the Tag constructor with a subclass; this is a diagnostic harness
error, not another candidate defect. A Proxy-based constructor preserves the
native tag prototype and removes that instrumentation error.

The escaping exception still did not match tags registered by JavaScript or
existing exports. For inspection only, a derivative of the retained accepted
116 artifact re-exports its two existing tags. It preserves every other
section, including code, byte-for-byte, and is neither a normal admitted
candidate nor a product artifact. Parent, derivative and code hashes are in
`tag-exports.json`. This is not an ABI restamp or a capability addition to the
production engine.

The final instrumented failure identifies the private defined tag at index 1
with one i32 payload. Its symbol, throw site and missed-handler cause remain
unestablished. A pointer value from one run is not a durable resource identity.
The original five-case report remains one pass/four failures; instrumented
runs of the same failing case add diagnostic observations, not independent
API coverage or compatibility passes.

Further work should inspect actual generated handler/tag/type matching and
compare minimal native throwing/catching across the same normal compiler,
linker, instrumentation and host boundaries. Bound that investigation and
continue other independent audited gaps; no accepted platform limit follows
from the current failure.
