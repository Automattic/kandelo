# FFI, SQLite, WASI and SEA public-contract reconciliation

Source audit only. The four guest public modules are absent. Their member
requirements and actual lower-layer prerequisites are reviewed here;
**none of these APIs is implemented or runtime-conformant**. No test,
probe, compilation or build was run. The separate
[Node-API/addon review](native-addon-contracts.md) and
[header/packaging review](native-packaging-embedding-contracts.md) now
complete those source requirements, with missing implementation and
runtime conformance preserved as distinct dimensions.

The API matrix links exact target documentation sections, public wrapper
and native-binding source, saved reference descriptors and later unchanged
test candidates. Missing entry points are negative evidence; lower-library
presence is not positive evidence for their unreachable methods.

## FFI: wrappers, signatures, pointers and lifetime

Target ownership: lib/ffi.js; internal/ffi shared-buffer/fast wrappers;
src/node_ffi.cc; guest data storage and native library/event-loop owners.
Current candidate: no factory/binding in bootstrap:5771–6110, despite
policy entries. Real Wasm dlopen and in-tree libffi are separate layers.

| API group | Required behavior at the exact target |
|---|---|
| DynamicLibrary / dlopen | String path or null current-image scope on applicable POSIX targets; VFS paths supported; real library handle, original path and symbol/function dictionaries. dlopen returns lib/functions plus a disposal method; failed eager resolution closes the opened library |
| path/functions/symbols | Actual path, resolved function wrappers and bigint addresses. functions/getFunctions produce wrapper dictionaries while repeated resolution of the same signature preserves function identity. Different signatures for the same symbol reject |
| getFunction/getFunctions/getSymbol/getSymbols/dlsym | Validate real owner/name/signatures and symbol existence; return actual callable/pointer/dictionary. Returned functions expose a bigint pointer; unresolved names and closed owners cannot silently succeed |
| close/dlclose/Symbol.dispose | Close once, invalidate further wrapper use/resolution and registered callbacks. Repeated close/dispose is a no-op. DynamicLibrary.prototype[Symbol.dispose] is the same close wrapper; dlopen's returned disposal method is a separate function that closes its lib |
| registerCallback/unregisterCallback/refCallback/unrefCallback | Default void() or declared signature, actual same-thread callback pointer and strong/weak JS lifetime. Collected weak callback invocations return zero/no-op; trying to ref an already collected callback throws ERR_INVALID_ARG_VALUE. Callback restrictions and invalidated raw pointers retain target-defined unsupported behavior |
| get/set Int8/Uint8/Int16/Uint16/Int32/Uint32/Int64/Uint64/Float32/Float64 | Real native memory access at bigint pointer plus byte offset; number versus bigint conversion/range rules. Setters require offset and validate values. 64-bit numeric inputs must be safe integers; 64-bit results are bigint |
| toString | NUL-terminated UTF-8 read; 0n returns null |
| toBuffer/toArrayBuffer | Copy by default; copy:false exposes the actual foreign storage with caller-owned lifetime. This is not permission to return a detached copy and label it zero-copy |
| exportString | String/encoding validation, encoded bytes plus one-byte or UTF-16 two-byte NUL, destination-size validation before write |
| exportBuffer/exportArrayBuffer/exportArrayBufferView | Required brands, byte offset/length, length validation, detached/shared view handling and actual destination bytes; no implicit allocation of foreign storage |
| getRawPointer | Actual address of supported JS-managed storage; lifetime is not extended merely by returning a bigint |
| getCurrentEventLoop | Actual current environment/thread uv_loop_t pointer and lifetime, not an address-shaped placeholder for an unrelated poll queue |
| types/suffix | Frozen null-prototype 20-entry type table, aliases and exact string values; suffix is so/dylib/dll **without** a leading dot and follows the guest platform |

Type/signature details are part of the requirement: bool is numeric uint8
(true/false are rejected); char follows the actual C ABI; signatures
default return void and arguments []. Pointer-like values have the target
null/string/view/raw-address conversion and borrowed-storage lifetime.
Raw unsafe pointer operations do not promise that every invalid/stale
address produces a checked JavaScript error. Caller-invalidated foreign
storage is not passing supported behavior or an implementation workaround.

Fast-call eligibility is architecture/signature-specific. The target's
32-bit paths do not require V8 Fast API generation. Little-endian shared
buffer calls and the generic path support all accepted types with **no
argument-count limit**. Reentrant shared-buffer calls copy arguments before
entering native code. Closure callbacks are independent of that call path;
static platform closures are expressly allowed by the target.

**NI-008 — lower libffi is insufficient for this contract.**
`packages/registry/libffi/gen-dispatch.sh`:124–178 emits scalar calls
through arity 8 with at most two non-i32 arguments, then all-i32 calls
through 22. Closures have narrower signature families and finite pools
(24, 4 or 2 slots depending on class). ffi_core.c:260–291 aborts on an
unemitted call signature; closure preparation returns FFI_BAD_ARGTYPE for
a missing class and aborts when its pool is exhausted (373–406). These
are implementation bounds and error-policy gaps, not a Wasm-wide FFI
impossibility. A JS wrapper over this library would not by itself satisfy
the target's arbitrary accepted signatures or closure-allocation errors.

Real library ownership: libc/glue/dlopen.c reads guest bytes, advances a
host preparation transaction, invokes guest initializers, commits a
handle, resolves function table indices/data addresses, and closes via
host/src/worker-main.ts:2027–2282. A bridge must distinguish guest data
addresses and function table entries, root JS callbacks, honor reentry and
connect cleanup to that loader. No active guest uv_loop_t owner was found
in the inspected SpiderMonkey/core paths. Returning a kernel queue pointer
as though it were that C ABI would manufacture support.

The module is scheme-only, available in native builds with FFI support
and disableable with --no-experimental-ffi. Permission enforcement/audit
and module ExperimentalWarning are real target requirements. No such
guest activation/permission/bridge exists. CPU-native library binaries
cannot directly run as Wasm; rebuilt Wasm libraries are a different case.

## SQLite: complete missing member surface and backend differences

Target lib/sqlite.js exports Database, DatabaseSync, Statement,
StatementSync, Session, constants and backup. Sync names are **identical
doc-only-deprecated aliases**, not different async/sync implementations.
SQLTagStore is returned by createTagStore; it is not an extra top-level
export. Statement instances come from prepare, not public construction.

Database is synchronous and owns the connection. Defaults include open,
foreign-key constraints, defensive mode and bare named parameters enabled;
readOnly, extensions, bigint reads, returnArrays, unknown parameters and
double-quoted strings disabled; busy timeout zero. Per-statement options
inherit the corresponding database defaults. All getter/instance/symbol
and alias descriptors are missing with the entire candidate module.

| Surface | Required behavior and ownership |
|---|---|
| aggregate/function | Real scalar/aggregate/window callback registration, argument conversion, arity/varargs, deterministic/directOnly and bigint options; rooted callbacks and exception/reentry state |
| close/open/isOpen/isTransaction/location | Actual connection/transaction/path state; close on a closed connection throws; dispose of an already closed connection does not. Closing while a statement/callback uses the connection rejects |
| loadExtension/enableLoadExtension | Real optional entry-point loading, initial allowExtension gate that cannot later be bypassed, permission checks and library cleanup |
| enableDefensive/limits | Real SQLite controls; eleven read/write runtime limit properties, including Infinity reset to compile-time maxima |
| exec/prepare | Actual SQL execution/prepare_v3, persistent hint, exact errors including empty SQL rejection; returned statement owner, not source text or a dummy object |
| serialize/deserialize | Uint8Array database image and dbName; deserialize replaces writable data and finalizes existing statements **before** attempting the replacement, including on failure. Reject forbidden callback/reentrant mutation |
| createTagStore | Actual bounded LRU of prepared statements; default capacity 1000, bound tagged parameters rather than interpolated SQL |
| createModule | Registered virtual-table module with columns/hidden arguments, iterable row callbacks, directOnly and bigint options. Both eponymous and named tables; yielded number remains REAL, bigint INTEGER without ordinary column-affinity conversion |
| createSession/applyChangeset | Real attached session/change tracking, Uint8Array changeset/patchset, table/db selection and filter/conflict callback result/error rules |
| Session changeset/patchset/close/dispose | Actual binary output and database/session lifetime; repeated close rejects but dispose is idempotent. Reject close while generating a changeset or from prohibited callbacks |
| Statement all/get/iterate/run | Named/anonymous/numbered parameter binding and actual stepping/reset. all returns array; get returns first row or undefined; run returns changes/lastInsertRowid as number or bigint according to statement policy |
| Statement close/dispose | Finalize real statement once, with close versus idempotent dispose distinction; reject closing the statement that is executing, while permitting eligible idle statements on that connection |
| Statement columns/expandedSQL/sourceSQL | Real origin metadata and original/expanded SQL; requires actual metadata-enabled backend |
| Statement binding/result controls | Bare-name ambiguity, unknown names, arrays versus objects, bigint reads and exact range/brand errors |
| Statement stat/resetStats | Real nine named sqlite3_stmt_status counters; reset except memused; never fixed zero counters |
| SQLTagStore all/get/iterate/run/size/capacity/db/clear | Bound tagged operations, real cached statement lifecycle, read-only getters (size is a getter at this target), associated database identity and cache release |
| backup | Promise for real batched sqlite3_backup work, positive rate, progress records, source/target names, destination path types, page-count result and actual restart/error/connection lifetime |
| constants / instance symbol | Actual conflict-resolution/authorization constants and descriptors. Native Database instances also carry Symbol.for('sqlite-type') = node:sqlite; this source-discovered stable-symbol observation is retained separately from documented methods |

Node 26 binding conversions include undefined/null as NULL, booleans as
INTEGER 0/1, signed-64-bit bigint validation, integer read overflow errors,
and TypedArray/DataView/ArrayBuffer/SharedArrayBuffer BLOB inputs. Existing
prepared statements, callbacks and iterators are resource owners, not just
SQL strings. Returned iterators inherit Iterator.prototype; native next
and return use actual statement/reset-generation state. Done results are
null-prototype {done:true,value:null}; finalization checks precede the done
fast path. return resets and deliberately preserves a pending caller
exception instead of replacing it with a deferred reset error
(src/node_sqlite.cc:4199–4230,5029–5151).

**NI-009 — SQLite backend feature mismatch.** Kandelo's recipe at
packages/registry/sqlite/build-sqlite.sh:83–103 sets
SQLITE_OMIT_LOAD_EXTENSION and does not enable SESSION/PREUPDATE_HOOK.
The exact Node sqlite.gyp enables those features plus other SQL facilities.
The reviewed recipe's default build does not supply loadExtension or
session APIs; no current binary's compiled features were newly measured.
The existing real Wasm dynamic loader makes this a build/integration gap,
not an established universal platform exclusion. SQLite 3.49.1 also differs
from target 3.54.0 (NI-006).

**NI-010 — backend defaults need truthful treatment.** The recipe sets
synchronous=0 and reduced SQL recursion/compound/JSON limits. These are
source configuration choices. The target explicitly permits build-varying
limit maxima, so a different maximum is not automatically a failed Node
API; getters/setters must report and enforce the real values. Recipe
comments attributing limits to engines are not reviewed evidence for a
blanket engine exception. No upstream defect is asserted by this audit.

## WASI: instance state is not outer process execution

Target lib/wasi.js:39–185 exports WASI with class-method descriptors and
an own wasiImport object. The required constructor version is unstable or
preview1; args/env/preopens/default-empty behavior and stdio remapping are
per-instance options. getImportObject returns a new object whose correct
namespace points at the same wasiImport. Native imports bind their owner;
UVWASI owns its fd/memory state and is destroyed with its native owner
(src/node_wasi.cc:78–99,118–220,1282–1294).

finalizeBindings validates instance/exports and an actual WebAssembly.Memory
(optional explicit memory), records the instance and consumes the one-start
state. start and initialize call it before validating/invoking command or
reactor exports, so an invalid-export attempt can still consume that state.
start requires _start and no _initialize; initialize forbids _start and may
invoke _initialize. Repeated binding/start/initialization throws
ERR_WASI_ALREADY_STARTED. Default returnOnExit true records the code and
uses a private sentinel to unwind start; false requests process exit.
Do not add a stricter WebAssembly.Instance brand merely because docs name
that type: JS validates instance and exports as objects, while the native
binding specifically brands memory.

Missing imports include the actual arguments/environment, fd/path/rights,
clock/random, poll, process and socket syscall namespace with its pointer,
integer, bounds/error and memory-growth rules. These are not supplied by
creating a property called wasiImport.

The source namespace comparison finds the same 46 import names in Node's
native binding and the outer host shim. This establishes name coverage
only, not equivalent behavior or a guest Node module. Before memory is
bound, Node's native wrapper reports ERR_WASI_NOT_STARTED for otherwise
valid calls; type checks and memory-bounds results also have their own
ordering (node_wasi.cc:386–412).

The existing **outer** host WasiShim is real but a different contract:
preview1 only, imported memory, process argv/env and hardcoded guest-root
preopen. path_open ignores rights and uses simplified access modes;
proc_exit sends the guest process exit syscall then throws WasiExit. It
does not provide independently configured Node WASI instances or default
return-on-exit behavior. Its additional env import fallback constructs
functions that throw Unimplemented WASI env import; these are not fulfilled
imports or silent no-ops. Both paths concern the
Kandelo guest filesystem, not arbitrary embedding-host files.

The current SpiderMonkey no-JIT nested-Wasm compilation restriction is
recorded with exact engine source evidence. It is relevant to instance
execution, but not proof that constructor/options/import/lifecycle APIs
are implemented or impossible. No whole-module exclusion is accepted.

## SEA: ordinary process APIs and packaged execution

All five methods are absent even in an ordinary non-SEA guest process.
Target isSea returns false there; asset methods throw the specific
ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION. Invalid key/encoding validation
has its own ordering: getAsset validates encoding before getRawAsset
validates key and checks SEA state. In a real SEA, absent keys produce
ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND.

getAsset copies into ArrayBuffer or decodes through TextDecoder;
getAssetAsBlob copies into a typed Blob; getRawAsset borrows actual asset
memory; getAssetKeys returns embedded key names or an empty array in a
SEA without assets. Raw asset lifetime is the executable's storage
lifetime. These are different ownership contracts.

The CLI/configuration path is also missing: --build-sea, version-matched
preparation/injection, CJS/ESM mainFormat, execArgv/extension policy,
assets and read-only VFS/ZIP asset mounting. Ordinary injected-main module
resolution/metadata differ from useVfs: the latter runs inside a runtime
chosen reserved mount and resolves modules there. vfsArchive serves file
entries through fs, not individual sea.getAsset keys. It requires useVfs
and cannot combine with assets. VFS write attempts fail EROFS.

Exact target restrictions include module+snapshot and VFS+snapshot/cache
combinations. The target explicitly describes the VFS code-cache limit as
incomplete implementation, not a technical impossibility. V8 snapshots/
code-cache bytes and CPU-native executable formats have concrete engine/
artifact constraints; portable assets/module methods are separate missing
implementation. Upstream's tested-platform list is CI coverage, expressly
limited by available injection tools, not a universal Wasm impossibility.
The preserved Bun/Claude executable asset loader is not a Node SEA store,
flag, preparation format or lifecycle owner and remains untouched.

## Host applicability, evidence and future validation

All four embedding hosts share the missing guest factories. Host Wasm
dynamic loading, worker/event-loop scheduling, memory limits and guest
filesystem persistence must be recorded separately. No host Node builtin
or browser API automatically substitutes for a missing guest binding.

Historical evidence retains exact artifacts/statuses. The initial
parallel/sequential selection is not coverage of FFI/WASI/SEA categories;
native addon/sqlite nested cases and returned-object/iterator APIs also
escape direct export capture. Candidate test links are future selections,
not evidence of execution or assertion coverage. There is no current
candidate native or four-host conformance result for these modules.

Later controls need actual owned libraries/callbacks and ABI signatures,
mixed/high arity and closure exhaustion, borrowed/copy memory and callback
GC; SQLite transactions, reentry, bindings/types, close/dispose/iterator
ordering, LRU/modules, session/backup and backend features; WASI options,
memory/import bounds and repeated/failing lifecycle; SEA ordinary errors,
asset copy/raw identity, actual packaging and VFS/ESM/ZIP fixtures. Use
unchanged upstream tests and matching native controls only after explicit
authorization. The roadmap remains unexecuted.
