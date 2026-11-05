# Native integration source review

State: **source review complete with gaps**. Public modules node:ffi, node:sqlite, node:sea and
node:wasi have no factory in the candidate builtin registry. This is a
missing implementation, independent of their policy-list entries or
underlying libraries. No new tests, probes, builds or compilation ran.

## Requirements, source owners and gaps

| ID | Public requirement | Candidate and owning layer |
|---|---|---|
| NI-001 | FFI DynamicLibrary/dlopen/dlclose/dlsym, typed memory access, buffer/string export, conversion, type signatures and callback/handle lifetime | Entire public module missing. Pinned `lib/ffi.js`:376–415 lists the exports; native internals and permission checks are not implemented by merely exposing Wasm symbols |
| NI-002 | SQLite Database/Statement/Session/constants/backup and their actual behavior | Entire module missing. DatabaseSync and StatementSync are retained aliases of the renamed classes, not the only target constructors (`lib/sqlite.js`:1–20). Native bridge must own connection/statement/session lifetime, errors, transactions, authorizers, extension policy, typed values, iterators, callbacks, tag stores, modules, serialization and disposal |
| NI-003 | WASI construction/imports/start/initialize/finalizeBindings | Entire module missing. Pinned `lib/wasi.js` validates version, args/env/preopens/fds and tracks instance/start/exit state. Kernel POSIX support does not automatically implement the WASI import namespace or capability/preopen model |
| NI-004 | SEA isSea/assets and build/runtime format | Entire module missing. Outside SEA, isSea should report false and asset APIs produce the specific non-SEA error. Target SEA supports --build-sea, assets/VFS and ESM; it is not the older CommonJS-only model. Preserved Bun artifact extraction is not Node SEA support |
| NI-005 | Node-API/addon admission and embedding contracts | No reviewed Node-API bridge or full Node embedding lifecycle. Wasm dlopen is real but does not establish Node addon registration, opaque handles, async work, callbacks, finalizers, thread-safe functions or ABI compatibility |
| NI-006 | Backend identity matches the exact target or divergence is explicit | Kandelo SQLite package is 3.49.1; pinned Node `deps/sqlite/sqlite3.h`:149–150 is 3.54.0. Version and feature/error differences remain separate from the absent public bridge |
| NI-007 | Distinguish existing host WASI execution from Node WASI API | host/src/wasi-shim.ts provides real preview1 syscall translation, but worker-main's program path is not the absent guest node:wasi factory. It fixes preopen setup to root, supports imported-memory modules, and does not implement Node's per-instance options/lifecycle/import/error contract |
| NI-012 | Public own C++ headers and embedding API | No public libnode/Environment/V8-handle bridge. Full own-header contracts, overloads, flags, Buffer/ObjectWrap and actual target ownership reviewed; direct V8 ABI/artifact boundary is separate from portable missing APIs |
| NI-013 | SEA packaging target questions | Parser permits empty assets with vfsArchive and reserved archive key remains an actual raw asset; preserve exact source/prose distinctions and NI-011 addon discrepancy |
| NI-014 | C++ async ID target question | Header describes zero for no execution; implementation returns -1 without an Environment, distinct from root execution ID zero; later native control required |

## Real lower-level capabilities

`libc/glue/dlopen.c`:1–200 implements a Wasm-native loader: normal guest
file reads, host preparation transaction, guest-side initializer calls,
commit, symbol lookup and close/error state. `host/src/worker-main.ts`:
2027–2086,2240–2282 delegates to the process dynamic linker with loader
ownership and checked guest-memory ranges. This is a real dynamic loader,
not musl's unsupported weak ELF stub. Its transaction/reentry and cleanup
contracts must be preserved by future Node FFI or addon support.

`packages/registry/libffi/package.toml`, `include/ffi.h` and `ffi_core.c`
provide an in-tree Wasm32 ABI implementation using generated call_indirect
shapes and static closure trampolines. The declared maximum is 22
arguments; long-double/complex/raw/Java and deprecated closure surfaces
are absent. This is neither all upstream libffi nor a Node FFI binding.
Pointer validation, callback roots, foreign memory lifetime, permission
checks, reentry and library-close semantics remain integration work.

The target FFI docs:616–670 make Fast API eligibility architecture-specific:
32-bit targets use another call path. Its executable-memory error applies
after signature/platform eligibility, not indiscriminately to every FFI
function. Therefore wasm32 plus no JIT does not justify excluding the
whole public API or pretending an eligible 64-bit fast path exists.

`packages/registry/sqlite/package.toml` provides a real compiled SQLite
library for guest Wasm architectures. Its presence does not supply the
Node native methods, constants, option validation or ownership model.

## Boundaries and four hosts

CPU-native ELF/Mach-O/PE addons cannot be directly executed as Wasm
guest libraries. That concrete artifact/ISA distinction does not exclude
portable Node-API semantics implemented against SpiderMonkey or rebuilt
Wasm addons. Direct V8 C++ embedding/ABI, Node-API's opaque contract and
Node FFI's portable public behavior must be assessed independently.

Current SpiderMonkey no-JIT recipe has the nested guest WebAssembly
compiler restriction recorded in [engine.md](engine.md). This is relevant
to WASI instance execution; it does not exclude options validation,
import construction, lifecycle/error behavior or execution using a future
appropriate capability. The outer host Wasm linker remains a different
layer with real compilation/instantiation. No blanket browser or
non-V8 exemption has been accepted for these modules.

The outer program loader also has a real WASI implementation:
`host/src/worker-main.ts`:3040–3069 detects preview1 and instantiates
`host/src/wasi-shim.ts`; `wasi-detect.ts`:24–44 recognizes only preview1
and requires imported memory. WasiShim:442–490 opens root as a preopen;
path_open:1211 ignores rights parameters and chooses simplified POSIX
access modes. That is partial lower-layer capability, not Node WASI
conformance or proof all WASI is impossible. Node supports distinct
unstable/preview1 option states, supplied preopens/fds and instance
lifecycle; these are not connected to this outer process path.

The missing public factories apply to Node, Chromium, Firefox and WebKit.
Dynamic-linker memory/table and callback behavior still needs individual
host evidence later. Native artifacts and permissions/preopens must be
identified explicitly, without substituting embedding-host files or
credentials for guest state.

## Later validation and unresolved audit

The [public-contract reconciliation](native-public-contracts.md) reviews
the four missing module surfaces, including returned objects, disposal,
aliases, instance/import state and concrete lower-library differences
NI-008–NI-010. The [addon/embedding review](native-addon-contracts.md) records
Node-API requirements, public header/version gates, missing native bridge
and V8/artifact boundaries. The [header/packaging review](native-packaging-embedding-contracts.md)
completes public node.h/Buffer/ObjectWrap contracts, installed-header
applicability and all SEA packaging narratives. All 593 original family
obligations now have source dispositions. NI-011 preserves the target SEA
prose versus implemented VFS-addon path discrepancy. Source completion
does not implement any missing binding or establish runtime conformance.

Review unchanged upstream FFI, SQLite, WASI, SEA, addons and node-api
categories with their real toolchain/launcher/fixture requirements. SEA
tests include ESM/VFS and asset copy/raw identity; WASI tests need real
preview1 modules and start/reactor/exit states. Addon/native-reference
controls must use the proper artifact architecture, record compile
requirements as unexecuted for this phase, and preserve unsupported
statuses separately from API failure.

Native controls should cover FFI close/use-after-close and pinned memory,
callback reentry, pointer/bounds validation; SQLite transaction/error and
64-bit values, live iterators and disposal, callbacks/reentry, backup,
session/tag store/module APIs; WASI preopen/rights and repeated lifecycle;
ordinary non-SEA errors versus real packaged assets. No current-candidate
conformance evidence exists. Explicit questions remain in the matrix:
target Wasm Node-API admission; exact guest external/shared storage and
Float16 capability; real libuv integration; native format/snapshot/cache
policy and target source/prose disagreements. No missing bridge is counted
as a pass or excused by those questions. Other family audits remain open.
