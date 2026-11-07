# SpiderMonkey Patches

These patches apply to the Firefox ESR 140.11.0esr source tarball and cover the
Kandelo wasm32 integration points needed by the standalone SpiderMonkey shell.

- `0001-allow-static-cxx-runtime-for-wasm-linux.patch`: allows a
  static C++ runtime without requiring the host libstdc++ include layout.
- `0002-map-kandelo-wasm-linux-rust-target.patch`: maps the Kandelo wasm Linux
  target to Rust's wasm32-unknown-unknown target where Mozilla's configure
  logic requires one.
- `0003-jsonprinter-size-t-wasm32.patch`: fixes format-string validation for
  wasm32 `size_t` output.
- `0004-disable-wasm32-return-address-stackwalk.patch`: disables return-address
  based stack walking that is unavailable for this wasm target.
- `0005-getrandom-custom-backend-wasm32.patch`: selects a custom getrandom backend
  for the wasm32 build.
- `0006-randomnum-use-sys-random-on-wasm32.patch`: routes JS randomness through
  the Kandelo-supported `mozilla::RandomBytes` path.
- `0007-skip-elf-network-check-for-wasm-target.patch`: disables an ELF-only network
  configure check for wasm.
- `0008-use-wasm-trap-for-moz-crash.patch`: lowers the Mozilla crash
  path to a wasm trap instead of unsupported host crash machinery.
- `0009-use-wasm-frame-address-for-native-stack-base.patch`: records the native
  stack base using wasm frame-address support.
- `0010-use-wasm-icu-data-section-syntax.patch`: uses Mozilla's wasm-compatible
  ICU data assembly section syntax for the Kandelo wasm32 target.
- `0011-heap-autorunparallel-task-on-wasm32.patch`: stores transient GC helper
  tasks on the heap for wasm32 to avoid stack-allocated multiple-inheritance
  task layout corruption in Kandelo worker threads.
- `0012-kandelo-node-compat-shell-entry.patch`: adds the Kandelo SpiderMonkey
  Node-mode shell entry point, POSIX file/fd helpers, native crypto/zlib/TCP/TLS
  hooks, and the shell job-loop integration needed by the shared JavaScript
  CommonJS bootstrap.
- `0014-disable-mozglue-interposers-on-wasm32.patch`: skips Mozilla's Linux
  `mozglue/interposers` directory for wasm32 because those wrappers require ELF
  `dlsym(RTLD_NEXT, ...)` semantics and abort `setenv()` / `unsetenv()` calls in
  the static Kandelo POSIX environment.

Revisit this set when bumping ESR versions. Most patches are
Kandelo-specific integration glue, but any general wasm32 or POSIX portability
fixes should be considered for upstreaming.

- `0029-kandelo-node-network-attempts.patch`: exposes real libc address lookup,
  IPv4/IPv6 nonblocking connects, local binding and actual socket endpoints.
  Pending connects are cancelled by promise identity, and failure/cancellation
  closes the owned descriptor. Shared JavaScript owns family alternation and
  per-attempt deadlines; kernel and host networking remain authoritative.

- `0030-kandelo-node-module-entrypoints.patch`: registers wrapped script paths
  with the native module loader, applies Node format dispatch to file imports,
  and separates import.meta.resolve from CommonJS execution. Node file mains
  return to the normal job/timer/I/O loop without a second raw evaluation.

- `0031-kandelo-node-wrapper-source-origin.patch`: lets the adapter specify
  the compilation origin of a wrapped script, keeping its first user line
  at line one, and uses the existing Node module metadata for ESM source
  URLs. Module registry keys retain their underlying filesystem paths.

- `0032-kandelo-node-fatal-event-loop.patch`: exits Node's default fatal
  path without draining active timers or I/O, checks unhandled rejections
  after each microtask checkpoint, and reports timer callback exceptions.
  The standalone engine shell keeps its existing drain policy.

- `0033-kandelo-node-tcp-listeners.patch`: adds real nonblocking POSIX
  bind/listen/accept, write-half shutdown and native operation reference
  control. Listener and accepted descriptors are close-on-exec; failures
  close untransferred descriptors. The shared net module owns overloads,
  DNS, public errors and server/socket lifetime. Existing kernel calls and
  ABI are used without a host or demo-specific networking path.

- `0034-kandelo-node-exit-listener-status.patch`: preserves the validated
  Node exit status after reporting an exit-listener exception, including
  explicitly assigned zero. The original exception stack is saved during
  the side-effect-free status query; standalone shell status is unchanged.

- `0035-kandelo-node-timer-references.patch`: supplies the engine's actual
  monotonic clock to the private timer scheduler and checks referenced
  work before entering another Node event-loop turn. Timer deadlines can
  wake live work without keeping an otherwise idle process alive. The
  shared callback batches retain their ordering across microtask
  checkpoints. Raw standalone shell behavior is unchanged.

- `0036-kandelo-node-sync-processes.patch`: interleaves real POSIX pipe
  reads/writes with child wait/reap, monotonic deadlines and output limits
  without running parent JavaScript jobs. Only parent pipe endpoints are
  nonblocking; temporary endpoints are close-on-exec and cannot alias child
  stdio targets. Node eval arguments are bound as arguments rather than
  mistaken for an entry file or used to suppress eval execution. Credential
  getters read real libc identities; detached children use the existing
  POSIX spawn setsid attribute.

- `0037-kandelo-socket-write-progress.patch`: exposes remaining bytes from
  actual native write operations. Socket inactivity deadlines distinguish
  write progress from a stalled write without inventing activity or
  suppressing timeouts merely because a write remains pending.

- `0038-kandelo-node-warning-option.patch`: parses Node's `--no-warnings`
  option and carries the actual supported execution arguments into private
  bootstrap metadata. Only the default warning printer is disabled; warning
  events still reach listeners. Positional user arguments remain distinct.

- `0039-kandelo-node-inspection-state.patch`: adds private engine metadata
  for Node-compatible inspection. Promise state/result reads do not install
  reactions or mark rejections handled. Scripted proxy target/handler reads
  avoid traps, and Map/Set iterator previews snapshot actual remaining
  entries without advancing the original iterator. Weak collection previews
  retain rooted keys/values. Native class checks distinguish module namespace,
  arguments, generator, iterator and async-function objects without trusting
  user-controlled tags. These changes are pending build/runtime validation.

- `0040-kandelo-node-async-context.patch`: roots private async-context state
  per engine context and snapshots it through the existing promise job
  host-data hook. Even an undefined registration snapshot is retained so a
  later resolver cannot supply its own scope. Queued jobs trace their context
  alongside the original function; execution restores the prior context on
  normal and exceptional exits. Saved queues retain both fields, and shell
  job inspection still returns original functions. Private getters/setters
  and the actual job-active state are exposed to the shared bootstrap.
  This integration is pending compilation and runtime validation.

- `0041-kandelo-node-async-lifecycle.patch`: stores owned lifecycle metadata
  on actual promises, traces queued resource identities and notifies the
  private Node adapter at creation, resolution and job execution. Observable
  result promises are retained instead of elided. The shared ID allocator
  also owns JavaScript timer/tick records. Native microtasks and dedicated
  nextTick/destroy queue checkpoints replace Promise-based tick routing.
  Hook failures request fatal process termination. This source integration
  is uncompiled; custom-species/await lineage, native I/O resources and
  complete lifecycle conformance remain explicit implementation work in the
  core outline ledger. It does not claim complete async-hooks support.

- `0042-kandelo-node-clone-boundary.patch`: roots private Node clone metadata
  and hooks. The native serializer retains one identity map across the main
  graph and deferred host payloads; the reader allocates official host
  objects before filling their data. Real ArrayBuffer detachment precedes
  host clone hooks. A versioned SameProcess envelope stores constructor
  strings separately from graph object IDs and checks resizable-buffer tail
  boundaries. It is embedding-private, not a persistent SpiderMonkey/V8
  format. Registered transfer-only hosts still fail explicitly; MessagePort
  transport is not implemented. DOMException/QuotaExceededError and Blob
  payload hooks are wired in the guest library. Exact diagnostics, GC/OOM,
  realm/context lifecycle, malformed data and all four hosts require further
  evidence. This patch is source-only and uncompiled.


- `0043-kandelo-node-stream-iter.patch`: marks actual native promises handled
  without adding reactions and owns the guest iterator activation option.
  It uses Node's unchanged environment tokenizer, preserves environment/CLI
  precedence and CLI-only execution arguments, and keeps Node version output
  on its own path after option validation. Only warning/iterator boolean
  options are implemented in `NODE_OPTIONS`; other options fail explicitly.
  The library shares the pinned public builtin exposure policy and lazy
  iterator sources. Native compression iterator bindings remain missing.
  This patch is uncompiled and has no native/four-host runtime evidence.


- `0044-kandelo-node-codec-backend.patch`: reports versions through actual
  linked zlib/Brotli/Zstd functions and defines the pinned Node constant
  names/expressions using SpiderMonkey numeric properties with Node's
  readonly/nonconfigurable/enumerable descriptors. Unzip owns a real auto-
  detect inflater while Gunzip stays gzip-only. Node-owned defaults and
  mode definitions are unchanged excerpts; library constants come from the
  exact codec headers. The consumer uses a resolver-built `node-codecs`
  dependency with a matching Node source pin. Native handle/async integration
  is still missing; metadata is not a conformance claim. This patch is
  uncompiled and unverified on every host.
- `0045-kandelo-node-codec-handles.patch`: includes generated pinned Node
  codec contexts and the owned private native-handle adapter. The recipe
  verifies/generates the contexts and copies the adapter into its work
  source tree. Persistent synchronous handle paths, offsets, error callbacks
  and close are source candidates only. Actual async work, public binding
  integration, complete memory accounting and all-host validation remain
  missing. Async writes and shared/resizable buffers fail explicitly; those
  are implementation gaps, not justified engine limits. Revision 45 remains
  unbuilt; this patch is not a conformance result.
- `0046-kandelo-node-native-work.patch`: integrates a process-shared guest
  pthread pool and context-owned native completion/root/pin lifecycle. Native
  work owns event-loop liveness and shutdown before JS context destruction.
  The separate codec adapter connects asynchronous writes to actual native
  jobs, counted stable buffer leases and pending close. AsyncWrap/provider/
  callback-scope integration and full public zlib behavior remain missing.
  Source-only, uncompiled and unverified on every host; this does not claim
  complete scheduling, memory, cancellation or process-exit conformance.
- `0047-kandelo-node-codec-async-resource.patch`: connects actual native
  compression resource IDs and captured frames to the async lifecycle
  registry; includes a shared native destroy queue whose numeric records
  can outlive shell teardown. JS hooks never run in native GC finalizers.
  Codec callbacks and onerror use the handle's before/after scope, and
  prototype assignment precedes init notification. Native CRC32 preserves
  actual UTF-8 byte lengths. Private iterator constructors use these
  handles; full public zlib/ZIP and AsyncWrap metadata/reset/alias behavior
  remain incomplete. Source-only, unbuilt and unverified on every host.

- `0048-kandelo-node-buffer-limits.patch`: exposes actual guest engine typed-array
  byte and string length limits for the shared Buffer module and pinned
  compression dependencies. Does not allocate maximum-sized buffers, copy
  V8/host values or promise available memory. Unbuilt revision 45 source only;
  size/architecture/error boundaries and four-host behavior remain unverified.
- `0049-kandelo-node-fs-truncate.patch`: connects actual guest libc ftruncate,
  native filesystem request IDs/frames and fast-I/O work/completion ownership.
  Uses the existing kernel syscall and shared native pool/destroy queue;
  does not add a syscall or ABI export. Unbuilt revision 45 source only;
  full filesystem resource/metadata/error/accounting/exit parity is pending.
- `0050-kandelo-node-file-handle-owner.patch`: stages the native descriptor
  owner, close bridge and GC-close diagnostic check-phase/liveness hooks.
  Actual owner/request state and jobs live in declared native sources; no
  syscall/ABI export is added. Public FileHandle/stream integration remains
  pending. Unbuilt revision 45 source only; no conformance claim.

- `0051-kandelo-node-fs-promise-io.patch`: stages actual filesystem promise
  requests/jobs, descriptor I/O/stat/control/open bindings, SDK-derived pinned
  filesystem constants and engine-owned unpooled Buffer storage/alignment.
  The shared source candidate connects public FileHandle/streams to those
  owners. No syscall or ABI export is added. Transfer, native buffer leases,
  path jobs, metadata/error/lifecycle/accounting and complete filesystem API
  coverage remain unfinished. Unbuilt revision 45 source only; no compiler
  or native/four-host conformance result.

- `0052-kandelo-node-fs-callback-cancel.patch`: exports actual queued request
  cancellation and direct sync open/read/write/vector bindings. The shared
  native work and filesystem sources implement callback/value/path/stat,
  cancellation completion and buffer ownership; no kernel/host/syscall ABI
  export changes are added. Public pinned callbacks/sync methods and shared
  promisify metadata are source candidates only. Unbuilt revision 45; no
  native or four-host conformance evidence.
- `0053-kandelo-node-readfile-job.patch`: stages the real native read-file
  job and private constructor/run bindings. The declared source owns actual
  guest I/O, native read storage, callback resource lifetime and fd handoff.
  Shared JavaScript selects pinned read-file/context algorithms; common opens
  include libuv's close-on-exec default. No kernel/host/syscall ABI export is
  added. Unbuilt revision 45, with native/four-host conformance pending.
- `0054-kandelo-node-vm-owner.patch`: stages the native function compiler,
  script column metadata and inheritance of caller shared-memory policy.
  Private source compilation uses the actual engine compiler/scope chain and
  caller-realm result/exception marshalling. The shared pinned VM frontend
  owns sandbox identity and validates options; full context property hooks,
  deadline/import/cache/microtask/metadata and module behavior remain gaps.
  No kernel/host/syscall ABI entry changes. Source-only patch preflight and
  frontend controls do not validate the uncompiled guest engine path.

- `0055-kandelo-node-sqlite-owner.patch`: stages a private SQLite dispatcher
  and native connection/statement owners over the exact Node SQLite archive.
  The engine recipe declares node-sqlite, stages generated actual constants,
  validates provenance and links the archive through its private sysroot.
  No kernel/host/syscall ABI export changes. The native-host store fixture
  does not compile this engine bridge; guest and four-host evidence remain
  pending, with callback/session/iterator and remaining public APIs open.

- `0056-kandelo-node-port-owner.patch`: adds the local endpoint bridge,
  native loop reference accounting and a port dispatch phase, plus context
  shutdown retirement of rooted serialized packets. The queue has compiled
  native-host controls; this engine bridge remains uncompiled/unexecuted.
  Cross-worker/port transfer, full Worker lifecycle and native async/error/
  GC/realm/phase behavior remain implementation and conformance gaps. No
  kernel/host/syscall ABI export is added or changed.

- `0057-kandelo-node-monotonic-hrtime.patch`: binds actual guest POSIX
  CLOCK_MONOTONIC nanoseconds to the pinned shared process.hrtime owner.
  It removes the Date.now dependency from high-resolution time, including
  during virtual Date testing. The shared POSIX header has a compiled
  native-host control; this engine hook remains uncompiled/unexecuted.
  Existing libc/kernel/host clock calls are unchanged; no new wire ABI
  or host import is added. Browser clock resolution and guest behavior
  still require identified-artifact four-host validation.

- `0058-kandelo-node-process-state.patch`: binds the live libc environment
  store, actual umask query/update and live guest parent PID to shared
  process-state owners. Borrowed environment names/values are copied before
  JS allocation; bridge mutations are serialized. A standalone native-host
  helper has compiled controls, but the guest engine bridge remains
  uncompiled/unexecuted. Existing libc/kernel syscalls are reused without
  new host imports or wire ABI changes. Full worker/TZ/exotic/CLI behavior
  and four-host guest conformance remain open.


- `0059-kandelo-node-lookup-work-owner.patch`: moves actual libc hostname
  lookup onto the existing native SlowIo work pool, with native-only worker
  data and Promise/result creation on the owning JS thread. Shutdown joins
  running jobs before retiring roots. Real OS lookup remains distinct from
  c-ares record queries; full request-provider/phase/CLI and guest behavior
  remain open. The helper has native controls, but this engine bridge is
  uncompiled. No host import or wire ABI changes.


- `0060-kandelo-node-system-error-data.patch`: marshals real compiler-selected
  pinned libuv error data to the shared internal/errors/util owner. Native
  data constants come from actual guest errno definitions and portable
  libuv values; no host identity, libuv runtime or ABI is advertised.
  Rooted arrays/strings remain on the calling JS context. The standalone
  native table matches native Node, but the guest bridge is uncompiled.
  Existing kernel/host/syscall interfaces are unchanged.

- `0061-kandelo-node-dns-request-owner.patch`: stages real getaddrinfo and
  getnameinfo request objects with native async identities, rooted slow-I/O
  jobs, request-realm completion and deterministic retirement. It reuses
  existing native-work/lifetime and guest libc interfaces; no new host import
  or wire ABI is added. Shared pinned EAI mapping replaces the older Promise
  lookup's hardcoded subset. Reverse lookup/address conversion has a native
  helper control; the request bridge remains uncompiled and is not connected
  to the public pinned callback/promise frontend. All four-host, hook/GC/realm,
  frontend/Resolver and transport obligations remain open.


- `0062-kandelo-node-performance-clock.patch`: captures a real POSIX time
  origin at engine main entry and exposes monotonic elapsed milliseconds
  and its correlated wall timestamp to performance/process uptime source.
  Contexts share the actual process origin; Date/test clocks cannot move it.
  The standalone helper has native monotonic/concurrency controls. This
  engine patch remains uncompiled, with no new host import or wire ABI.
  Browser/Node guest timing and complete callback scopes remain unvalidated.

- `0063-kandelo-node-callback-scope.patch`: selects shared native callback
  depth/context/checkpoint ownership and real bootstrap/timer/tick/job
  entry guards. Native request cleanup follows successful outermost ticks/
  jobs; the loop preserves an explicit quit status before error reporting.
  The shared policy matches native Node-API/libuv controls, but this JSAPI
  adapter/engine remains uncompiled. No synthetic resource, host import or
  wire ABI is added. Full rejection/fatal/GC/realm/phase behavior remains open.

- `0064-kandelo-node-directory-operations.patch`: selects actual distinct
  guest mkdir/unlink/rmdir primitives and rooted pathname work. Recursive
  mkdir retains its first-created path and the pinned sync/async continuation
  decisions. The portable helper has host-libc/native-reference controls;
  the JSAPI bridge and engine remain uncompiled. No host import or wire ABI
  is added. Full FS/raw-path/retry/lifecycle and four-host evidence remain open.

- `0065-kandelo-node-safe-environment.patch`: adds a private safe environment
  query for loader HOME/NODE_PATH/pending-warning state, using actual guest
  credentials and libc secure startup state. Existing live environment
  mutation/query ownership remains shared. Ordinary native helper controls
  are separate from privileged guest/JSAPI validation; this engine path is
  uncompiled and adds no host/kernel wire ABI.

- `0066-kandelo-node-child-wait-owner.patch`: owns exact-pid wait results
  across JS allocation/delivery failures, retries EINTR, preserves errors
  and rejects duplicate initializing/different-context owners. Child roots
  retire with their context; successful owners share actual Promise tokens
  for reference controls. A portable native helper and focused frontend
  controls pass; this JSAPI path remains uncompiled. Exceptional wait-loss
  behavior differs from pinned libuv and remains an implementation gap.
  No host/kernel wire ABI changes or package/product builds.

- `0067-kandelo-node-dotenv-owner.patch`: registers the retained native dotenv
  parser and real guest file/environment owner APIs. Length-bearing string
  conversion and null-prototype records are owned by the engine bridge.
  Portable/native-reference controls do not validate this uncompiled JSAPI.
  CLI/permission/worker/startup and unexpected close-policy gaps remain open;
  no host/kernel wire ABI changes or package/product builds.

- `0068-kandelo-node-digest-owner.patch`: selects actual owned provider
  digest/XOF/comparison primitives, fixes incremental NUL truncation and
  private-slot initialization, and cleanses temporary HMAC key bytes.
  Scoped portable/native/reference controls do not validate this uncompiled
  JSAPI. Full incremental/crypto/error/byte/GC/realm and four-host contracts
  remain open. No kernel/host wire ABI changes or guest product rebuild.


## 0069: actual OS state owners

Includes and registers the checked native-os.cpp/os-operations.h owner after
the existing process-state/FS helpers. Actual POSIX uname/hostname/passwd/
home/temp/priority/endian calls retain owned bytes/status; frontend measurement
APIs have no preset-success backend. Recipe input copies are declared.
Native portable/header and source checks are separate from the uncompiled
guest JSAPI. No new host import, syscall or wire ABI. See the OS dependency
record under tests/nodejs/outline; constants/accounting and guest priority/
credential/scheduler semantics remain incomplete.

- `0078-kandelo-node-package-reader.patch`: registers the actual native
  package-file/parser/cache owner; exports/imports/maps and full resolution
  remain separate unfinished owners.
- `0079-kandelo-node-tls-state.patch`: exposes actual live OpenSSL metadata
  and verification results, with continued verification only when errors are
  explicitly allowed. Complete TLS contexts/sockets/servers remain open.

- `0080-kandelo-buffer-pool-storage.patch`: adds actual permanent ArrayBuffer
  detach restrictions to direct/clone transfer paths and native pool
  registration, with real process zero-fill option/allocator ownership.
  General public worker marks and four-host runtime validation remain open.

- `0081-kandelo-package-resolution-options.patch`: parses actual conditions,
  package-map paths and symlink policy into native startup state consumed by
  shared CJS/ESM resolution. Other CLI/execution modes remain incomplete.

- `0082-kandelo-dns-record-channels.patch`: registers private actual c-ares
  channel/query/configuration/version bindings. Shared native owners keep
  event-thread packets separate from owning-realm JS conversion/callbacks.
  Configuration refresh, permissions and four-host runtime integration remain
  open; this does not alter kernel/host wire ABI or advertise raw DNS egress.

- `0083-kandelo-owned-message-packets.patch`: registers private message
  serialization/deserialization over owned actual engine clone buffers.
  Endpoint movement, worker bootstrap and full lifecycle remain separate.

- `0084-kandelo-engine-heap-budget.patch`: registers a read-only private
  actual engine GC soft-budget query. It changes no ceiling or wire ABI;
  full process/heap/space measurements remain missing.

- `0085-kandelo-vm-plain-context.patch`: actual ordinary isolated globals for
  DONT_CONTEXTIFY and per-ShellContext security-callback installation/chaining/
  restoration. Ordinary sandbox exotic semantics and full guest/four-host
  behavior remain incomplete; see the VM plain-context dependency record.

The subsequent Worker source replaces minimal-prelude/JSON/shared-mailbox
launch with per-worker native context/thread/packet/endpoint ownership and
normal Node bootstrap/loader, ready/error/exit and independent stop/join/ref
state. Patch86/recipe79 remains a partial source candidate; unsupported option,
stdio/fd/transfer/lifecycle/resource and four-host obligations remain open.
See `tests/nodejs/outline/worker-owner-implementation-dependencies.md` for
exact source/evidence boundaries and retained native harness nonpasses.

- `0091-kandelo-node-kdf-jobs.patch` registers private native PBKDF2/scrypt
  construction/run bindings and actual native resource identities. The
  shared work queue owns asynchronous derivation; public validation and
  callbacks come from complete pinned Node modules. Recipe90 remains
  uncompiled, including its newly selected OpenSSL3.5.9 guest dependency.
  See the KDF implementation dependency record for scoped native evidence
  and outstanding guest/four-host validation.

- `0095-kandelo-openssl-version.patch` exposes the actual linked OpenSSL
  version through a private native query. Source97 uses it for truthful
  process dependency metadata; the new binding is not guest-compiled.
  Engine96 compiled the prior KDF/Argon2/file source with OpenSSL3.5.9;
  see `tests/nodejs/outline/engine96-integration.md` for exact scope.

`0098-kandelo-http-parser.patch` exposes an opaque GC-owned llhttp response
parser. The unchanged parser is supplied by the exact Node-pinned node-llhttp
library dependency. Header/body/trailer callbacks use pinned Node algorithms;
the native packet bridge still needs guest/four-host callback, reentry, memory
and lifecycle validation. It does not supply Agent, server or HTTP/2 owners.

`0099-kandelo-object-marks.patch` owns a GC-traced weak private-mark registry
and checks real clone/transfer admission. Public marking is not implemented by
observable JS properties. Buffer pool detach keys share the transfer mark;
clone denial follows the target's native built-in versus custom-host dispatch.
Marking does not supply endpoint or other native-host-object transfer.

`0100-kandelo-environment-object.patch` supplies the engine model required by
native virtual Object properties over a mutable external store. It preserves
non-Proxy branding, real property hooks and refused prevention of extensions,
and reuses the ordinary inherited-receiver setter. The Node environment owner
uses that model over its real process/worker store. Source/runtime/prototype/
constructor/warning/store and four-host obligations remain separately tracked.

`0101-kandelo-error-location-policy.patch` adds an embedding option for the
non-standard Error filename/line arguments and public location properties.
Context registration disables those extensions for Node root/worker contexts;
VM realms use the same context policy. Native location/report/stack reserved
metadata remains initialized. Standalone SpiderMonkey keeps its default
extensions. Own lazy stack descriptors and complete Node Error behavior remain
separate implementation requirements; this patch does not establish them.

`0102-kandelo-cipher-owner.patch` registers a private binding to GC-owned
ncrypto/OpenSSL cipher contexts. The unchanged pinned Node Cipheriv and
Decipheriv classes retain their public validation and Transform methods.
Algorithm discovery queries the linked provider. This registration does not
supply RSA cipher operations, signatures, key generation or WebCrypto, and
does not establish four-host conformance.

### 0103: shared warning startup options

Parse actual warning/deprecation booleans, redirect/diagnostic paths and
repeated warning filters through NODE_OPTIONS and the command line. Preserve
CLI-only execArgv and environment/CLI precedence. Publish real booleans,
strings and arrays to each guest bootstrap. This supplies the pinned warning
owner; native stack recapture/filtering and full CLI conformance remain open.

### 0104: actual per-context event-loop idle measurements

Each ShellContext owns monotonic loop-start and accumulated actual wait time.
RunShellJobs marks entry once and brackets its real provider wait; synchronous
JavaScript/native work stays active. A private snapshot feeds unchanged pinned
Node ELU arithmetic and the nodeTiming loopStart/idleTime getters. Clock errors
stay visible. Other milestones, loop counters, GC/profiler producers and the
parent-side Worker.performance contract remain separate implementation gaps.
No browser host clocks or fixed measurements are substituted.

### 0105: descriptor-owned filesystem copies

Register sync and queued copyFile operations over real source/destination fds,
bounded byte transfers and existing FSReq ownership. Exclusive creation uses
the destination open; inode identity precedes truncation and cleanup follows
the pinned libuv policy. Actual directory type rejects zero-sized directories.
Reflink force fails when the platform lacks the operation. This registration
does not establish guest or four-host conformance; directory errno and
concurrent-truncation differences remain unresolved.

### 0106: real worker locks and provider progress

Register a process-shared native lock manager with receiver-local Promise and
callback ownership. Grant/steal delivery commits only after the receiver owns
its packet and error roots. Context teardown retires held/pending ownership.
Rotate work,port,worker and lock providers after actual progress,preserving
tick/job checkpoints,GC-close fences and existing bounded idle measurements.
Only deliverable locks keep the loop alive;held/pending Promises do not. This
source does not establish descriptor,JSAPI,guest or four-host conformance.

### 0130: canonical native include and vendor boundaries

Preserve the unchanged Mozilla include-style gate. Sort includes in five
patched engine files and compile unchanged imported HDR code from its actual
third-party source directory. Libuv reference bytes also retain a real
third-party location; owned stat-poll glue remains under checked shell paths.
Generated native owners use canonical include paths and explicit inline
headers. No checker, expected failure, ignore list or algorithm is changed.
Source/component checks do not establish normal package or runtime acceptance.

### 0131: owned synchronous VM execution deadlines

Route validated script timeouts to a real joined native watchdog and
context-qualified invocation scope. Propagate uncatchable interruption
through nested VM boundaries and translate only the owning deadline after
execution unwinds, in its target realm. Preserve independent shell/worker
cancellation, OOM and forced-return ownership. This patch is a source slice;
actual engine interrupt races and the watchdog wait-failure reentry edge
remain unvalidated/incomplete. No guest or four-host closure is claimed.
