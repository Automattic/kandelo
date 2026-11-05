# Native embedding headers and SEA packaging contracts

Source-only reconciliation of the remaining native-integration requirements.
Target Node 26.13.0, commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. No compilation, execution,
runtime probe or new validation capture occurred. This supplements the
Node-API/addon and FFI/SQLite/WASI/SEA reports; their definite missing
guest factories/bridges and concrete lower-library gaps remain unchanged.

## Header scope and actual boundary

Target tools/install.py:337–379 installs node.h, node_api.h,
js_native_api.h/types, node_api_types.h, node_buffer.h, node_object_wrap.h
and node_version.h. The Node-API/version headers have their separate
requirements artifact. This review reads the entire node.h and the Buffer
and ObjectWrap headers, including inline methods, public/protected
contracts, macros, overloads, flags, callbacks and ownership comments.
The new metadata preserves every reviewed source range, named public
member and relevant conditional branch. Private class layout and the
explicitly internal async-cleanup ABI helpers are not independent public
APIs. Declaration discovery is not counted as implemented behavior.

**NI-012 — embedding bridge and exact V8 interfaces:** Candidate has no
node::Environment/IsolateData/MultiIsolatePlatform/public libnode bridge.
It runs a packaged SpiderMonkey shell, with actual JSContext/native task,
fd, clone and process owners. Those owners do not supply V8's Local/Global/
Maybe handles, Isolate, context, virtual platform ABI, CppHeap or libuv loop
pointer. Unchanged V8 C++ addons and V8 snapshot/cache bytes cannot be
directly consumed by those SpiderMonkey interfaces. This is a concrete
source/engine/artifact boundary, separate from the missing portable Node-API
bridge and required JS core behavior. A generic Environment-like struct
or host loop address would not satisfy the original C++ ABI.

Installed V8/cppgc/libplatform headers describe that direct engine ABI;
conditionally installed libuv/OpenSSL/zlib/zoslib headers describe linked
dependencies, not additional node: module namespaces. This audit does not
claim Kandelo supplies those exact external ABIs or use their absence to
exclude engine-independent guest behavior. CPU-native PE/Mach-O/ELF
libraries remain separate from rebuilt Wasm guest libraries.

## Public C++ contracts and dependencies

| Header region / APIs | Required behavior and disposition |
|---|---|
| node.h:134–173 ErrnoException/UVException, legacy overloads | Actual coded error/path/syscall/destination data in V8 handles; no callable guest C++ bridge. Portable JS errors stay in values/process/I/O audits |
| 199–350 initialization flags, InitializationResult, Start/Stop/InitializeOncePerProcess/TearDown/ProcessGlobalArgs | Real once-per-process init and teardown, parsed argv/execArgv/warnings/errors/early exit, stdio/signal/ICU/OpenSSL/V8/cppgc/resource options, explicit no-op legacy bits; CLI/public guest state remain implementation gaps rather than a V8 exemption |
| 350–468 allocator, platform/delegate, IsolateSettings | Owned external/backing storage and real task runner/platform/isolate registration order; delegate registration forbids the other platform operations except unregister, delayed tasks discarded at unregister, completion callback after cleanup, CppHeap ownership; not an arbitrary kernel queue pointer |
| 469–608 snapshot/isolate/context/IsolateData/thread IDs | Actual V8 snapshot lifetime and exact version/flags, same snapshot supplied to isolate and data; invalid blob empty result, FromFile consumes but does not close FILE; Context/inspector/Promise-hook registration and environment association; custom per-isolate snapshot support actually false in the target |
| 609–777 Environment/Snapshot flags, code cache, CreateEnvironment/inspector parent | Process-state/inspector/ESM/FD/addon/global-search/browser-global/linked-permission ownership; cache shares entry buffers and replaces only on compatibility success; environment failure cleanup and worker overrides. Target CreateEnvironment accepts a named thread overload and shared isolate data; per-instance state must not be synthesized from outer host state |
| 778–896 callbacks, ModuleData, LoadEnvironment | Opaque/move-only startup metadata, borrowed string_view source/resource names, CJS/ESM format and overloads; preload before user loader/code and inherited by workers. Callback fields are real engine handles; internal require has no public stability promise |
| 897–1008 exit/abort/error/report/tracing/loop access | Actual process-global abort callback may precede any environment and cannot prevent eventual exit; per-environment process.exit handler, beforeExit/exit/AtExit ordering, real report output/trace controller and loop; SpinEventLoop repeats if beforeExit revives work, returns empty on Stop. Portable fatal/report/liveness remains missing or partial in other owners |
| 1010–1137 CommonEnvironmentSetup | RAII owns loop/allocator/isolate/context/data/env; creation errors return empty and populate errors. Snapshot setup has separate restrictions; destructor frees environments with JS disallowed, disposes isolate then waits for platform completion before closing loop |
| 1139–1307 date/constants/method macros, encoding, FatalException, TryEncode/Encode/Decode, Windows error | Inline V8 constructors/prototype signatures, constant flags, encoding aliases and exception propagation; deprecated Encode remains and can abort through ToLocalChecked, TryEncode returns Maybe. UTF-16 pointer overload retains target endianness warning; platform Windows overload conditional |
| 1308–1466 signo_string, addon callbacks/node_module/registration macros/AddLinkedBinding | Actual registration/version/context and linked binding inheritance into workers. signo_string is declared without NODE_EXTERN; linkage visibility is a separate question, not an invented JS API. Version defaults differ for direct addons versus Node-API. No candidate registration bridge |
| 1468–1660 AtExit/cleanup/RequestInterrupt/async IDs/init/destroy/CallbackScope/MakeCallback | LIFO lifetime, per-env hooks, async cleanup completion exactly once, no JS from interrupt, actual native callback context/frames/tick/jobs/domain/fatal behavior. Explicitly internal cleanup entry points preserved as implementation dependencies, not public supported calls |
| 1661–1708 C++ AsyncResource | Real persistent resource/frame capture, init at construction/destroy at destruction, callback scope and three callback overloads; not identical to a JS wrapper with the same class name |
| 1710–1749 signals/Cppgc/GetSSLCtx | POSIX handler reset/Node signal interaction with invalid SIGSEGV reset option; deprecated V8 wrapper association; borrowed SSL_CTX valid only while its actual SecureContext lives, null for invalid/no-OpenSSL. No fabricated pointer or candidate JS handle equivalence |
| node_buffer.h | HasInstance accepts actual ArrayBufferView (not only public Buffer), Data includes view offset and Length is bytes; constructors distinguish copy, uninitialized allocation, string encoding, adopted malloc storage, callback-owned storage and ArrayBuffer views. Bounds check avoids unsigned wrap. Actual V8 handles are a boundary; portable byte/lifetime APIs remain requirements |
| node_object_wrap.h | Internal-field association, persistent roots, weak collection, refcounted strong retention, subclass-safe Unwrap cast, destructor and environment cleanup ownership. Ref/Unref affect GC retention, not a proven uv_handle reference. Source queues a cleanup hook at construction; not GC-only cleanup |

Actual target ownership was traced through src/api/environment.cc:
409–590,628–724; embed_helpers.cc; hooks.cc; async_resource.cc; and
node_buffer.cc:96–209,247–560. FreeEnvironment stops workers, disables JS,
clears termination and runs cleanup/AtExit. AsyncResource captures/restores
the frame around native callbacks. Buffer's adopted callback is serialized
with a mutex and scheduled back to its environment, can run during teardown,
and is reset once so a later backing-store release does not touch a dead
environment. Invalid context/oversize paths release foreign storage too.
Sandbox builds may copy, while cleanup must still occur. These are real
requirements a future portable bridge must honor, not capabilities inferred
from existing native-buffer.cpp.

**NI-014 — C++ context documentation question:** node.h says execution ID
zero means no execution; hooks.cc returns -1 when there is no Node
Environment, while a valid environment can have execution ID zero.
Preserve the distinction in later native controls. JS startup IDs and the
missing public-resource/default-trigger integration are separately A-025.

## Complete SEA packaging narrative

No candidate node:sea factory, SEA resource/startup detector, builder CLI
or target SEA VFS integration exists. The separate Bun extraction path and
Kandelo's OS VFS do not implement this public Node feature. Ordinary
non-SEA isSea=false and exact asset errors remain straightforward missing
behavior, even when a native executable format is inapplicable.

Target node_sea.cc:375–656 parses JSON config with typed nonempty
main/output/optional executable, boolean flags, string asset map,
string-array execArgv, env/none/cli extension policy and commonjs/module
format. Relative paths use current working directory. Source ignores
unknown keys; asset map insertion and empty objects have their actual
parser behavior. It rejects ESM+snapshot, VFS+snapshot/code-cache,
vfsArchive without VFS and nonempty assets plus vfsArchive. Snapshot plus
code cache only emits a redundancy warning at this stage. These details
need target controls instead of imposing guessed schema rules.

node_sea.cc:659–918 builds actual source/snapshot/cache and guest-visible
assets. Snapshot main runs at build time and must install its deserialize
main; code cache is format-specific V8 output. Assets are file bytes;
vfsArchive is embedded under node:sea:vfs.zip after a signature sanity
check, with actual ZIP parsing deferred until startup. Serializer/deserializer
retain flags, format, source path, argument extension and byte ownership.
The blob is a private version/size/platform-sensitive representation,
not a portable promise that native V8 snapshots execute inside SpiderMonkey.

node_sea_bin.cc:45–75 locates the injected resource through postject and
the exact fuse. Its built-in builder is HAVE_LIEF-gated and dispatches
ELF note, PE resource and Mach-O section injection, rejects an existing
resource/marked fuse or unknown format, writes output and copies source
mode (chmod failure warns). The supported-format check is concrete:
it does not recognize a Wasm executable. Signing is a native platform
packaging concern; unchanged native executables are not guest Wasm code.
Portable packaging/asset/module behavior still requires implementation
and an explicit format decision later. No files were packaged or signed.

Startup node_sea.cc:925–1012 and lib/internal/main/embedding.js use actual
asset-backed data, environment and entry format. Without VFS, injected
require/import are builtin-only; createRequire explicitly opts into normal
filesystem resolution. require.main and execPath-relative filenames/meta
are real; injected ESM has no import.meta.resolve. With VFS, the main is
placed at the dynamically reserved mount root and goes through ordinary
CJS/ESM loading with mount-confined package lookup and read-only EROFS.
lib/internal/vfs/sea.js mounts a real SEA/ZIP provider and appends the main
to the in-memory ZIP index without mutating the embedded archive. These
contracts depend on fs/path/ZIP/module identity and ownership, not labels.

**NI-013 — remaining SEA target questions:** prose forbids vfsArchive with
assets, while parser only rejects a nonempty assets map. Prose says asset
APIs do not serve individual archived entries; the actual reserved archive
asset remains a raw map member and getAssetKeys enumerates map keys.
Keep those exact cases for later native controls. NI-011 retains the
stronger VFS-addon prose/source/test discrepancy. Source says VFS+code
cache is incomplete implementation; do not promote that restriction to
an inherent platform impossibility. Target CI's limited native platform
matrix is an evidence boundary, not proof all other implementations cannot
support portable SEA behavior.

## Four-host evidence and later plan

All four hosts share the missing guest bridge/factories. Dynamic linking,
native callbacks, external storage, worker teardown and packaging still
need exact host/artifact evidence later. Native V8 binary/handle/layout
boundaries are independent of outer browser capability. No native-header
or SEA control has been run by this audit; old evidence retains its exact
source/hash/status limitations.

Proposed unchanged embedding/addon/SEA sources require native reference
fixtures of the proper architecture and separately admissible guest
artifacts. Compare invalid config/type/error/output and permission cleanup,
ordinary versus packaged assets/copy/raw lifetime, argv extensions, relocated
entry metadata, builtins versus explicit filesystem loaders, mount/package
confinement, ZIP corruption, GC/adopted callbacks, multienvironment teardown,
beforeExit revival/Stop and hook ordering. Preserve unsupported build/ISA/
launcher status as nonpassing. Do not call a passing native test a guest pass.

Explicit unresolved questions: target Wasm Node-API header admission flow;
exact guest external/shared memory and Float16 capability; future real
libuv pointer integration; target C++ no-environment ID policy; SEA empty
assets/reserved archive/native-addon discrepancies; exact native format/
snapshot/cache admission policy. These do not obscure the definite missing
bridges. This report authorizes no implementation or runtime validation.
