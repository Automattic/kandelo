# Guest WASI execution prerequisites

This is a source-level follow-up to NI-003 and NI-007 in the completed
native-integration audit. It does not change that audit, the Node target,
the engine configuration, or the compatibility scope. No exclusion has
been approved. The execution backend remains an implementation gap.

The existing outer host WASI loader and a native-host WebAssembly component
are separate from guest `node:wasi`. The latter needs a guest
WebAssembly instance, memory, imports, and execution engine. Successful
execution by the embedding host does not establish that prerequisite.

## Actual engine source path

The current SpiderMonkey recipe sets `--disable-jit` in
`packages/registry/spidermonkey/build-spidermonkey.sh:477`. In the pinned
Mozilla 140.11.0esr source:

| Source | Consequence |
| --- | --- |
| `js/moz.configure:307–310,327,337` | Disabling JIT selects and defines `JS_CODEGEN_NONE`. |
| `js/src/jit/JitOptions.h:181–187` | `HasJitBackend()` returns false under that define. |
| `js/src/wasm/WasmFeatures.cpp:245–273` | `HasPlatformSupport()` rejects an absent JIT backend, then requires a supported Baseline or Ion compiler. |
| `js/src/vm/GlobalObject.cpp:176–177` | The WebAssembly builtin is suppressed when `wasm::HasSupport()` is false. |
| `js/src/wasm/WasmBaselineCompile.cpp:12420–12441` | The supported compiler architectures do not include `JS_CODEGEN_WASM32`. |
| `js/src/wasm/WasmIonCompile.cpp:10842–10852` | The Ion architecture list also excludes `JS_CODEGEN_WASM32`. |
| `js/src/jit/wasm32/CodeGenerator-wasm32.cpp:124` | The existing wasm32 `visitWasmLoad` backend operation is a crash placeholder, not a working nested-Wasm compiler. |

Consequently, simply enabling a namespace, changing `HasSupport()`, or
removing the recipe flag would not implement guest WebAssembly execution.
The portable JavaScript interpreter is not a WebAssembly interpreter.
Compiled `WasmMemoryObject` types do not prove executable modules exist.

This is a limitation of the current implementation and selected engine
backend, not proof of a browser sandbox prohibition. All four hosts run
the guest engine; a native Node/V8 control must not substitute for it.

## Evidence identity and scope

The source is tied to the recipe's Mozilla archive SHA-256:
`1b034d2117356fda24807a151055132315c6ba58ad2bdf7ec71ee707fac5e028`.
The unchanged `js/moz.configure` SHA-256 is
`7bed9aebfa41bd922c2d92afa81b727a0df43774eb539b20e66fcf4bda535f2b`.
The raw source and archive identity record are preserved under
`.context/spidermonkey-target-agent/`. Additional source identities are
recorded in `wasi-execution-prerequisites.json` and the implementation
snapshot. This is source inspection, not a new guest runtime observation.

The accepted engine173 artifact predates later source slices. Neither its
successful compilation nor the pending portable WASI owner's host controls
establish a guest WebAssembly backend or four-host WASI conformance.

## Required work and unresolved decision

A real guest execution backend must preserve module validation, memory and
imports, invocation, traps, lifecycle, and public WebAssembly behavior. Its
integration also needs owning engine/host and resource accounting review.
An explicit API-specific exclusion would require user review; no answer
or elapsed time approves one. The existing goal keeps this work in scope.

Other WASI gaps remain independent, including the complete import surface,
rights/preopen enforcement, direct-Wasm numeric argument conversion,
shared-memory growth, native JSAPI/GC ownership and lifecycle. These are
implementation gaps even if a portable component passes selected controls.
No overall suite or full product rebuild was run for this investigation.
