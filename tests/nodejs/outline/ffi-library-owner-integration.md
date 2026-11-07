# Actual FFI library and symbol owner

Source184 consumes libc dlopen/dlsym/dlclose through the existing outer guest
Wasm dynamic loader. DynamicLibrary owns actual handle/path/symbol state.
A per-context native registry retains open images. GC marks an owner only;
loader retirement runs on its owning thread before idle. Explicit context
shutdown follows exit listeners and precedes main/worker status capture;
destructor cleanup is an idempotent fallback. Failed admissions and actual
unload errors remain visible; consumed numeric handles are never retried.

Complete unchanged selected pinned constructor/disposal/dlclose/dlsym algorithms
use those real native owners. The actual CLI parser/builtin gate publishes the
experimental FFI option and consumes default/negated/underscore/NODE_OPTIONS
semantics. The recipe declares and stages the real sources, links existing
libdl and registers0136over the current engine source with zero-fuzz replay.
No target, kernel-host/program ABI or syscall contract changes.

The original public module is not complete. No dummy call/callback/memory/loop
exports or empty type maps were added. Permission admission, generic signatures,
libffi calls/closures, mounted private-image loading and full Node-API/addon
ownership remain missing. The existing outer program loader does not supply the
separate nested guest WebAssembly backend; that backend stays in scope for the
final phase. See original NI-001/NI-005/NI-008 and the immutable handoff report.

## Review corrections

Checked receiver-unwrapping failures now preserve an existing exception or
report actual access denial rather than overwriting it with an incompatible
receiver error. Actual guest security-wrapper/realm execution remains unvalidated.
The mounted-VFS reader is only invoked for string paths, matching the pinned
public constructor. Null/main-library and invalid nonstring arguments therefore
reach the genuine native owner/type checks. Actual mounted image loading still
fails honestly until its private-image owner exists; it is not a platform limit.

A proposed early closed-state check was rejected before any edit: pinned
node_ffi.cc:993-1011 and identified native controls establish string/NUL admission
before ResolveSymbol:123-142 checks closed state. That original order remains.
This was a source-review mistake, not a runtime failure or a compatibility fix.
The initial source/control outputs before the separate VFS correction are
retained under .context/node26-ffi184-before-vfs-review.

## Bounded evidence

Fresh parent controls exercise the actual portable header over the exact sealed
host-libc executable, eight labeled semantic groups; those labels are not test
framework-discovered cases. The selected unchanged public frontend uses the
explicit pinned native DynamicLibrary seam, retaining eleven recorded error
observations and positive cache/subclass/path/descriptor/disposal assertions.
The printed checks18is a legacy manual annotation, not eighteen discovered tests
or a counted assertion denominator. It does not execute the new guest JSAPI.

Fourteen actual extracted CLI-parser comparisons reuse the exact matching
compiler producer and compare against the pinned native executable. Four exact
production getter/public constructor groups use actual native main-library
open/symbol/close and original nonstring errors with and without mounted handlers;
missing string image loading remains asserted as unimplemented. Normal current
bundle/bootstrap/unity/input closure, unchanged Mozilla style and fourteen package
checks pass. Six prior successful tiny compiler commands (four native executables,
two SDK objects) are accounted for; root compiles nothing new.

The original disposal-alias assertion, standalone open-prefix SyntaxError and
incomplete unchanged shell checker context failures remain immutable. Guest
JSAPI/linkage/GC/realm/dynamic-loader/shutdown/fork and all-four-host execution
are unestablished. The accepted173engine predates184. Node ignores uv_dlclose
errors whereas this consumed-handle owner reports real guest unload failure;
that remains a documented implementation deviation, not an accepted boundary.
Native error field/setter/stack precision and physical memory accounting remain
incomplete. No finding/family closes; no overall suites or full product rebuild
ran. No source contribution is counted as passing complete compatibility.
