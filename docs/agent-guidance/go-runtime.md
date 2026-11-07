# Go Runtime Port Guidance

Use this guide when changing Kandelo's Go toolchain, runtime, linker or
standard-library platform code. Registry recipes follow
`porting-software-to-kandelo` and the package-build guide.

## Ownership and build

Go source lives in [kandelo-dev/go](https://github.com/kandelo-dev/go).
The active migration uses branch `kandelo-wasm32-prototype`, based on Go
1.28 development and upstream's wasm32 review stack. The adjacent
`../go-kandelo` checkout can still be on the legacy `kandelo-port` branch
(Go 1.25.6, pin `5834adc`). Never assume that path has the new compiler or
replace another checkout's untracked artifacts. Inspect its branch/version
and each package's `go_toolchain` pin first.

All four Go recipes and the SDK wrapper select `kandelo/wasm32`; the
prototype branch and normal pins now include approved regexp improvement
`f6053060`. Its fresh compiler passes five standard-library modes, 18 Node
runtime/cgo checks and all 297 expanded browser cases without skips/flakes.
Private unmodified FrankenPHP 1.13.5/Caddy 2.11.9 passes real request/GC/
shutdown on Node and three browsers. Normal consumer/image rebuilds and
final WordPress validation remain pending. Deep regexp compilation is
slower on tested Wasm hosts; retain that measured tradeoff. The authoritative
record is `docs/plans/2026-09-05-go-gc-port-milestone1-plan.md`; `docs/go.md`
maps consumers to targets. Historical legacy service evidence does not
validate replacement artifacts.

Normal builds declare `go-bootstrap-source@1.26.10` and use the shared
`scripts/build-kandelo-go-toolchain.sh` helper. The declared host Go builds
that verified source release, which then builds the pinned Go 1.28 source.
The helper uses private work roots, preserves the sealed input's Git
metadata for Go's own commit/version generation. It selects upstream's
`GO_BUILDER_NAME` builder mode so development `cmd/dist` trims paths in its
own tools; ambient `GOFLAGS=-trimpath` alone is discarded by that bootstrap.
Development tool content IDs affect target build IDs, so independently
built compilers must also be reproducible. Preserve those IDs and verify
an independent same-key resolver rebuild; do not suppress them to mask
divergence. Target builds separately use `-trimpath`.
Keep both native compilers out of target package outputs. A direct developer
build also needs Go 1.26 or newer as `GOROOT_BOOTSTRAP`; the dev shell's
Go 1.25.8 cannot bootstrap Go 1.28 directly.

Set `GO_KANDELO_BIN` to the selected wasm32 compiler *inside* the declared
dev shell when running fixture builders. The old adjacent checkout is a
fallback path, not proof that its compiler implements wasm32. Runtime,
syscall and linker fixes belong in the Go fork; OS and host fixes belong
in Kandelo. Do not hide a platform defect in a probe or package shim.

The upstream architecture has four-byte pointers/integers but eight-byte
registers, stack alignment and `int64` alignment. Copying `386` layout or
conditionally changing legacy `GOARCH=wasm` by OS is incorrect. Preserve
Go's collector and upstream code generation. Validate the complete standard
library for Kandelo32 (plain/cgo), WASI32, legacy WASI and legacy JS after
runtime/linker changes. The prototype inventory is
`tests/go/wasm32-prototype` and `go-wasm32.spec.ts`; archive exports, signals,
PHP lifetimes and final application gates are separate requirements.

Preserve eight-byte continuation slots when porting four-byte ABI0
arguments. Convert logical PCs to table handles for clone/signal dispatch;
never retain the old `PC >> 16` shortcut on wasm32. This also applies to
handwritten assembly fixtures: use four-byte ABI0 value/result slots and
direct C table handles. Rebuild every enabled fixture from the selected
compiler; an ABI-contract stamp and an existing file do not prove compiler
source/version provenance. Use fresh builder receipts and Wasm `producers`
metadata to bind compiler versions; this native Go tool's `version -m`
cannot inspect the Wasm file format. The C spawn helper is a separate SDK
artifact, not a Go module. Keep historical `*-before` files out of the
selected test cohort without deleting their evidence. C bindings use table
handles directly. Wasm indirect calls require exact types: ordinary cgo
frame wrappers return void, while errno wrappers return i32. Record that
distinction in linker metadata instead of rewriting frontend frame layouts.
Keep unused C call edges out of link roots while preserving live edges and
constructor/vtable roots. Passive data has no address until initialized.

Cgo scalar alignment is distinct from pointer size: an `int32, int64,
int32` argument sequence followed by an `int64` result needs a 32-byte
frame. C function pointers index a table rather than linear memory. Use
cgo's existing `runtime/cgo.Incomplete` non-heap pointer semantics for them
so stack copying cannot reject or relocate low handles. Keep ordinary C
data pointers as GC roots; prove escaping field aliases across collection.
Do not weaken pointer checks or reintroduce the mixed-width field/export
adaptations for this homogeneous target. Compile-only FrankenPHP evidence
is not proof of safe Go-backed bulk strings or running requests.

Kandelo is a Unix target for Go build constraints. Register it in both
`src/internal/syslist/syslist.go` and `src/cmd/dist/build.go`; changing only
one leaves `go/build` and the toolchain disagreeing. Then inspect files newly
selected by `unix` in `runtime`, `syscall`, `os`, and other standard-library
packages. Keep Kandelo-specific implementations where upstream Unix code
assumes native threads, signals, or syscalls by excluding `kandelo` from those
files explicitly. Conversely, retain needed `!unix` Wasm fallbacks with an
explicit `|| kandelo` when no native equivalent exists. Cross-build the full
standard library for Kandelo, `js`, and `wasip1`, and run the upstream tests
that newly enter the Kandelo build; successful compilation alone does not
validate their behavior. The expanded `os` and `os/exec` suites and
`archive/tar` metadata test cover concrete fallout from this classification.
Repeat the full standard-library build with `CGO_ENABLED=1`: that mode
selects additional Unix `net` and `os/user` implementations. Kandelo uses
Go's VFS-backed DNS and account-file paths in both modes for now. The native
Unix cgo resolver expects unavailable `res_n*` libc entry points, and account lookup still uses the existing VFS-backed implementation.
The legacy mixed-width `struct passwd` concern no longer establishes a
reason to exclude a homogeneous wasm32 binding; revalidate the complete
native resolver/account API contract before changing those selections. Exclude those implementations in the fork, not by
adding package-only `netgo` or `osusergo` flags to FrankenPHP.

Before diagnosing reflection as a wasm32 layout bug, compare upstream
targets and the selected Go experiments. Go 1.28 enables JSONv2 by default;
`encoding/json.RawMessage` aliases `encoding/json/jsontext.Value`. Caddy
2.10.2's package/name comparison rejects this on every target. Upstream
Caddy fixed the comparison using `reflect.TypeFor`; consume a released fix
rather than patching reflection, disabling JSONv2 or adapting the app.

The earlier A0 browser inventory retains a WebKit native-stack failure
in unchanged `regexp/syntax` compilation. Both upstream WASI architectures
reproduce it without Kandelo imports. The maintainer approved one shared
iterative upstream improvement; f605 now passes all 297 expanded browser
cases and is selected in normal pins. Deep Wasm compilation is slower;
keep the [measured evaluation](../plans/2026-11-07-go-regexp-upstream-evaluation.md)
explicit. Do not restore the legacy hybrid fallback or make further
algorithm/code-generation changes without the required discussion. Keep
finite native depth separate from GC, linear memory, shadow stacks and
POSIX behavior. Consumer/image rebuilds and final WordPress gates remain.

## Memory, threads, and syscalls

- Runtime clock functions participate in scheduler state transitions.
  `casgstatus` can call `nanotime1` while cgo's `exitsyscall` forbids stack
  growth. Keep Kandelo's monotonic clock path nosplit while preserving its
  existing channel signal checkpoint. A clock-polling M can otherwise own
  a pending signal indefinitely. The established delivery path queues Go
  notifications on g0. Removing that checkpoint stalled an HTTP drain;
  merely making the clock nosplit retains signal behavior.
  The signal/GC and blocked-wait fixtures exercise this path. Do not fix a
  `stack split at bad time` failure by changing the collector or suppressing
  stack guards.
- For Wasm C libraries, preserve valid empty compatibility archives and
  their normal `-lm`/`-lutil` flags. GNU archives can contain only the magic;
  Darwin ranlib can add an empty BSD32 index. The linker accepts strictly
  object-free versions of those forms, not arbitrary unindexed libraries.
  Nonempty BSD indexes remain unsupported. `CGO_LDFLAGS` search paths work
  on the new target; do not copy the legacy link-path application patch.
- Cooperative-preemption probes need a real split-stack checkpoint. A small
  leaf can legitimately be NOSPLIT, as the scheduler clock must be. Give a
  CPU-work fixture a materialized frame; do not insert manual yielding or
  infer asynchronous preemption from a cooperative test.
- Base architecture extensions of a direct dependency port on the current
  consumer pin. Extending an earlier x/sys CPU file while omitting newer
  Unix APIs can compile FrankenPHP's archive but fail Caddy's dependencies.
  Preserve existing target API coverage, then validate the actual consumers.

- For large Go/cgo browser workloads, retain native browser stderr alongside
  guest service logs. A same-URL page reload and a lost evaluation context
  can result from the content process exceeding its memory limit. Capture
  navigation events and workload phases outside the page so they survive
  that reload. Report the engine's footprint measurement separately from
  RSS, shared memory reservations, and guest linear-memory size; none is a
  substitute for the others. Use the actual limit and worker ownership
  evidence to investigate memory use before choosing a runtime change.
  Align native samples with kernel/process linear bytes, guest thread
  counts and module-cache counters at the same workload stages; retain the
  timestamp skew. A macOS WebKit content process can be launched through
  XPC rather than as a child of the driver, so a descendant-only RSS sum
  can miss it. Read-only inspector categories are useful diagnostics, but
  its JavaScript heap category describes the observed VM and its direct
  worker events need not include nested guest workers. Keep guest thread
  counts authoritative and native buckets separate from RSS and the
  process-kill footprint. A navigation can replace the inspector target
  while preserving the Page; verify that observation survives it. Keep
  the same page alive after machine destruction to observe later native
  reclamation separately from retirement, without forced GC or a reload.
- Validate descriptor pollability in `netpollopen`, even when readiness
  interests are armed lazily. Go's ordinary `os.File` code needs the epoll
  registration error to clear `O_NONBLOCK` and disable deadlines on regular
  files. Reporting success first can turn a deferred VFS file read into
  EAGAIN followed by a fatal EPERM at `netpollarm`. A temporary registration
  probe must remove successful interests so idle HUP notifications cannot
  spin the lazy poller. Keep the kernel's correct rejection of non-epoll
  descriptors; do not special-case certificate paths or Caddy.
  `tests/go/netpoll-basic` checks regular-file deadline rejection and I/O,
  socket deadlines/readiness/close, and blocking-pipe scheduler release in
  plain Go and cgo. A supervisor restart can hide the initial fatal exit,
  so application validation must inspect service logs too.
- Go's public `syscall.Mmap`, `Munmap`, and `Msync` now use the same
  Kandelo channel and mapping manager as the C SDK and Go runtime.
  The `syscall` test covers anonymous, file-backed private, file-backed
  shared, and explicit writeback mappings in Node and all three browsers.
  Kandelo's file-backed `MAP_SHARED` coherence and `msync` remain partial
  as described in `docs/posix-status.md`; do not infer database durability
  or immediate cross-process visibility from this API gate.
- The direct `kandelo-dev/sys` fork provides a `golang.org/x/sys/unix`
  Kandelo target rather than a package-local FrankenPHP copy and patch.
  Its memory, file-lock, access, and socket-option wrappers delegate to
  the Go fork's real syscall channel. `Madvise` is a validated no-op hint
  in the kernel; `SO_REUSEPORT` get/set round-trips, but duplicate-listener
  semantics are not established. The x/sys CPU target selection also lives
  in that fork. Pin both forks in package recipes and test the API in Node
  and browsers before extending it for a consumer. Do not mistake the
  currently small unix surface for general Linux compatibility.
- Caddy's terminal consumers require real PTY state, not a constant
  `isTerminal` answer. The Go fork exposes Kandelo's 60-byte musl
  `termios` layout, `tcgetattr`/`tcsetattr`, `TIOCGWINSZ`, and
  `getrlimit` through typed channel calls. The direct readline and
  logrus ports select those APIs; tests exercise raw-mode restoration,
  window-size reads, and positive/negative terminal detection in Node
  and all three browsers. `RLIMIT_NOFILE` is resource 7 and
  `RLIMIT_MEMLOCK` is resource 8, matching the kernel. The direct
  bbolt port adds conservative Wasm mapping bounds; the direct
  certificate-transparency-go port loads roots from the VFS rather
  than assuming a host trust store. A small bbolt reopen test passes,
  but it does not establish durable `MAP_SHARED` persistence.
- Kandelo's kernel currently treats `mlock`/`munlock` as resident-Wasm
  hints, with an existing fixed 1 GiB bounds check. Go and x/sys
  expose that existing behavior; do not claim full POSIX memory-lock
  semantics or use the bbolt smoke test as proof of durability.
- The source-built Caddy v2.10.2 package pins six direct forks and
  serves static HTTP from the VFS on Node, Chromium, Firefox, and WebKit
  with recipe revision 4 and Go fork `c925e9c`.
  The earlier WebKit build failed before listener readiness with a native
  Wasm call-stack overflow in `regexp_syntax.__compiler_.compile`. Do not
  silently skip that engine or patch Caddy's dependency to make it appear
  portable. This standalone Caddy binary does
  not include FrankenPHP or PHP execution.
  A temporary `--keep-names` FrankenPHP+Caddy build reproduces the same
  recursive frame in WebKit. Caddy's file server imports templates and
  Goldmark even when template handling is not configured; Goldmark's
  linkify URL regex contains `{1,256}`; a representative prefix of that
  pattern reaches AST depth 512 after Go's `regexp/syntax.Simplify`.
  An exact Goldmark linkify expression reproduces the failure in WebKit,
  while a shorter prefix passes. This is a Go regexp compiler stack-depth
  issue, not evidence of a PHP or POSIX failure. A general iterative
  compiler fallback in the Kandelo Go fork preserves regexp bytecode and
  lazy-capture behavior and passes the exact expression in three browsers.
  A freshly rebuilt WordPress image then passed both FrankenPHP classic and
  FrankenPHP+Caddy site-editor soaks and authenticated post edits in Chromium,
  Firefox, and WebKit (12/12 browser cases). This validates those workflows,
  not long-uptime or production performance.
  Cgo also crosses into C code with its own native Wasm call frames. These
  frames have an engine/worker limit independent of Go's growing goroutine
  stacks, the C shadow stack in linear memory and `GOMEMLIMIT`. Match a
  trapped C function against its archive-object disassembly when the final
  module has no names. Reproduce the unchanged function in a cold dedicated
  worker with no Kandelo imports; a main-page probe can have a different
  stack limit. PHP's recursive CFG postorder traversal passes depth 512 and
  overflows at 1024 in one such WebKit shape. Valid optimized PHP with 768
  conditionals reproduces its failure in the real Caddy service. A scoped
  iterative traversal must preserve numbering, optimizer configuration and
  cached/uncached results; do not treat a larger linear-memory reservation
  as a fix. The candidate PHP correction and its pending final validation
  are recorded in the implementation plan. Finite native call depth is a
  documented runtime boundary, not by itself evidence of an engine defect.
  Flattening counted repeats in `Simplify` changes lazy-capture semantics
  and is not an acceptable shortcut.
  Excluding only the top-level templates import does not remove the
  transitive file-server dependency. Preserve the real `php_server` path
  when evaluating a general stack-safe fix.
- The linker imports shared linear memory and declares a bounded pthread
  slot arena below the Go heap. The default is 32 slots; the per-program
  `-ldflags='-kandelothreadslots=N'` accepts 1–1024. Each slot reserves
  control memory, so increasing it is a memory-budget decision, especially
  for browser/WebKit. Go may start another M before `main`, so a one-slot
  program can hit the host limit during startup; the opt-in Node and
  three-browser ceiling probe requires a visible diagnostic and Go runtime
  failure, not a hang or silent arena overflow. See
  `src/cmd/link/internal/wasm/asm.go` in the fork and
  `host/src/process-memory.ts` in Kandelo.
- The main thread and each Go M need their own syscall channel. The host
  writes the channel offset through the linker's `__tls_base` receiver;
  `src/runtime/channel_kandelo.go` captures it into the M before syscalls.
  Channel layout comes from `crates/shared/src/lib.rs`, not a Go-local
  convention. Keep the Go heap above the channel/control region.
- Internal Go syscall waits must honor the same heap-safepoint contract as
  libc, even when cgo public syscalls already use libc. Start with a 100 ms
  atomic-wait bound; after a timeout call the existing
  `kernel.kernel_heap_safepoint` import and retain its next bound. JSC keeps
  bounded waits; V8 and SpiderMonkey return a negative, unbounded wait.
  Keep waiting on the original request and preserve its result and errno.
  The external-runtime explanation remains suspected under
  `JSC-BLOCKED-WAIT-GC-STARVATION`; adding the missing Go producer hook does
  not prove that it caused a particular WordPress stall. Reuse that registry
  entry and mark the fork's code site instead of claiming a new engine bug.
  Cover mutex contention, scheduler notes, clone acknowledgments and runtime
  sleeps through the same `kandeloWait32Step` primitive. Recheck each original
  wake predicate after an interval; a checkpoint timeout is not the caller's
  final timeout. Keep scheduler-note absolute deadlines and account for the
  entire finite sleep/bootstrap budget. Bootstrap and lock waits can run
  without a usable syscall channel, so do not introduce `nanotime` channel
  calls there merely to slice a wait. Keep the host import nosplit and free
  of Go allocation. The private-symbol sleep fixture verifies the policy and
  minimum duration in plain Go/cgo; upstream sync, scheduler and deadline
  cases exercise real wake behavior. Neither proves the suspected GC cause.
  Validate the production host bundle too: a module-local allocation whose
  only reader is a test export can disappear during tree shaking. The host
  retains only the newest eight-byte ordinary buffer on its disposable
  worker global; do not replace that observable root with a test-only
  reference. `heap-safepoint-production.spec.ts` checks actual allocations
  after Vite/Terser bundles only the runtime entry, across all three engines.
- Test a declared slot count with distinct live locked Ms, not only many
  sequential starts. The 48-live-M/64-slot probe exposed browser teardown
  latency after the guest had exited: a per-thread 250 ms settlement was
  serialized past the kernel-worker's two-second detach deadline. Settle
  independent thread terminations concurrently, but release each thread's
  exact exit ownership only after that thread's termination resolves.
  A 1,024-slot declaration reserves 256 MiB for slot pages. The separate
  maximum-declaration probe defaults to 48 live locked worker Ms and passes
  in Node and all three desktop browser engines; a selectable 256-worker run
  passes in Node and all three engines, and 512 workers pass in Node. Count
  the locked main M too: the browser run proves 257 simultaneously live Ms,
  not all 1,024 slots. The 512-worker Node run used a 30.4 GB peak memory
  footprint on a 36 GB host; do not double the count on that host without
  reducing per-worker overhead. This does not prove that the reservation
  fits the constrained browser memory profile.
- Repeat locked-M waves with goroutines returning while still locked to
  force thread retirement rather than merely parking and reusing Ms. Five
  48-worker waves pass in Node and Chromium, Firefox, and WebKit under both
  64-slot and 1,024-slot ceilings. The 64-slot run makes slot reuse observable:
  240 total worker Ms cannot fit without reclaim. This does not substitute
  for PHP-worker churn.
- In cgo builds, the shared Go `__tls_base` handoff word is unsafe when a C
  pthread and a Go M start concurrently. The Go runtime reads the C
  `__channel_base` mutable Wasm global through a typed C getter, so every
  instance captures its own channel. Non-cgo Go still uses the serialized
  shared handoff. A single callback pass does not detect this race; repeat
  the second-Go-M/C-pthread process probe.
- A cgo build must not grow a private contiguous Go `sbrk` heap beside C's
  `mmap` allocations. A C-created pthread can map directly above the break,
  blocking later Go growth despite unused process address space. Kandelo's Go
  runtime now allocates and reserves through the kernel's shared `mmap` and
  `munmap` manager. Test with both C-created pthreads and later Go scheduler
  allocations in Node and Chromium; success in one engine is insufficient.
- The exported `syscall` channel entry must release its scheduler P while a
  guest syscall blocks, then reacquire one before returning to Go. Keep
  runtime-internal channel calls separate: they also run from g0 and cannot
  unconditionally enter the user-g syscall transition. RoadRunner's
  concurrent HTTP assets exposed a deadlock that a one-request probe missed.
- A disconnected TCP client can make Kandelo `write` return `EPIPE` and raise
  `SIGPIPE`. Go's socket write path uses `Send` with `MSG_NOSIGNAL`, falling
  back to `write` for non-sockets. Exercise canceled browser requests as well
  as completed requests; a successful first page is not evidence that the
  server survives navigation or client disconnects.
- A foreign C pthread callback enters an extra Go goroutine through a
  synthetic frame, not a resumable Go caller. Mark that frame `TOPFRAME` in
  the Kandelo Wasm assembly; otherwise Go stack growth traces through the
  C callback argument address as a return PC and aborts. A small callback
  can pass despite this defect. Exercise deep recursion or a substantial
  PHP response from a C-created pthread on both Node and Chromium. Save the
  idle callback stack as an offset from its high bound, not an absolute
  pointer: Go may relocate the stack during the callback, and reentry must
  use the new high bound.
- FrankenPHP classic's Firefox WordPress editor exposed a Go compiler
  split-stack error in `net/http.(*chunkWriter).writeHeader`. The Wasm
  large-frame check added `framesize-StackSmall` to `g.stackguard0`; when
  preemption set that guard to `stackPreempt`, 32-bit addition wrapped and
  incorrectly skipped stack growth. The Go fork now uses an overflow-safe
  unsigned subtraction check. Keep the `http-preempt` browser fixture:
  it forces Go preemption in `net/http` and the old compiler deterministically
  fails the same HTTP frame in Node. A passing fixture does not establish
  WordPress editor stability; rebuild the demo with the fixed fork and
  repeat the real browser workflow. The browser VFS inspector can read the
  guest log after init exits. Preserve the **beginning** of that log:
  Go's fatal header precedes a long goroutine dump, so a tail alone hides
  the failure.
- Clone handoff needs an acknowledgment before reusing its shared words.
  A child must bootstrap its own stack and channel before entering the Go
  scheduler. Thread replicas must not replay active Wasm data segments over
  the live process's shared Go globals.
- An individual M exit is not process `EXIT_GROUP`. The `kernel_thread_exit`
  import reads Go's `freeWait` pointer while the g0 stack is still live,
  marks it reclaimable, exits that kernel thread, then traps out of the
  disposable worker. Do not clear or reclaim the stack before the Go Wasm
  import wrapper finishes reading it: the direct-call prototype trapped
  because generated wrapper code reread the stack. Process exit still uses
  the separate `kernel_exit` path.
- The channel's pending-signal area also carries the host's terminal
  retirement marker. After a Go syscall completes, a queued `SIGKILL`
  must enter the non-returning `kernel_exit` import directly, as libc does.
  This marker unwinds a blocked worker during machine shutdown, exec, or
  retirement after an already committed exit; it is not ordinary catchable
  signal delivery. Do not issue another Go channel syscall or call the
  process-wide Go `exit` wrapper first: that can repark the retired worker.
  The `tests/go/retirement` probes require pure-Go and cgo guests to finish
  the host's cooperative drain before forced termination on Node and all
  three browsers. Those probes do not establish ordinary signal notification.
- Cooperative Go signal notification uses the target runtime's
  `signal_kandelo.go`, with real kernel dispositions and Go's normal signal
  queue. Signal numbers must match the SDK, including the reserved
  `SIGSTKFLT` slot 16; omitting it shifts `SIGCHLD` and every later signal.
  Preserve Go's nonfatal asynchronous defaults and inherited ignores.
  `Reset` only promises to undo `Notify`, not to clear an explicit `Ignore`.
  Restore fatal defaults using a real kernel signal so wait status retains
  the signal identity, including the `Stop`/delivery race.
  Reuse the generic Go signal-policy table for Kandelo's matching numbers.
  Fatal asynchronous signals such as SIGQUIT use Go's existing fatal
  traceback at the cooperative checkpoint and exit 2; this reports actual
  goroutines without claiming native signal-context unwinding.
  In cgo, Go's public syscalls use the typed
  `<kandelo/syscall.h>` completion API through the ordinary cgo transition.
  libc owns C handler dispatch, `SA_SIGINFO`, alternate stacks, masks,
  restart classification, and timeout accounting; do not copy that state
  machine into Go. The API keeps a 64-bit result separate from errno,
  including valid negative results. Internal Go runtime syscalls still run
  without a scheduler P; the shared pending-signal dispatcher and C adapter
  collect notifications before queuing them on the Go system stack.
  An arbitrary Go callback must not enter through an invented active cgo
  call. C-created pthreads use their existing foreign callback transition.
  Go-owned signal notifications run on the system stack without the normal
  user-callback transition: libc can still hold pointers into the interrupted
  Go stack, including its syscall completion frame. Keep that goroutine in
  syscall state until C returns. The signal/GC fixture verifies completion
  after collections during blocked reads; it does not prove stack relocation
  or reproduce corruption in the preceding implementation.
  `tests/go/signal-basic` covers plain-Go/cgo notifications, SIGTERM defaults
  after Reset/Stop, real C handlers, an 8 GiB logical seek, and in-flight HTTP
  shutdown on Node and all three browsers. Its restart probe observes the
  blocked read dispatch and the retry, rather than guessing with a delay.
  These are cooperative asynchronous signals: native signal-context
  unwinding, preemption, and management of inherited blocked masks remain
  gaps. Rebuild consumers and validate actual Caddy/PHP shutdown before
  claiming the demo drains in-flight requests.
  Before implementing inherited-mask management, trace `runtime.needm` in
  `proc.go`: it calls `sigsave` and `sigblock` before obtaining an M or
  installing g. Kandelo's `doSyscall6Raw` reads `getg().m.channelBase`, so
  calling it from those hooks is invalid for an unattached C thread.
  The shared Wasm `sigset` is still empty and its mask/minit hooks are
  no-ops. A real port needs an early thread-channel path, runtime-thread
  mask initialization, and restoration of the foreign caller's mask.
  Unblocking only the thread running `Notify` does not cover that lifecycle.
  Test an inherited blocked signal, delivery after Notify, and mask
  restoration after foreign C callbacks in Node and browsers.
- Repeated upstream `os/exec` `TestWaitid` is a useful stop/continue probe.
  A child returning `EBUSY` from stdin after SIGCONT exposed the shared host
  re-arming a deferred blocked read as a fresh dispatch. Preserve the frozen
  request and its existing Rust target token through resume; retrying EBUSY
  in Go would hide the platform defect. The Node VFS harness accepts
  `KANDELO_GO_TEST_COUNT` to repeat upstream tests without modifying them.
- Go `syscall.StartProcess` uses non-forking `SYS_SPAWN`; descriptor
  inheritance must be serialized with `ForkLock`. The existing spawn
  attribute supports child-atomic process groups. Requested child
  credentials currently return `ENOSYS`; do not report a no-op as success.
  Rust's `SpawnAttrs` has flags, process group, and signal masks, but no
  requested uid, gid, or supplementary groups. `POSIX_SPAWN_RESETIDS` only
  resets inherited effective IDs to real IDs. Supporting Go's `Credential`
  needs an explicit spawn contract and child-side permission transitions
  before file actions and executable admission, with rollback on failure.
  Do not change the parent credentials or reuse the wire header's ignored
  padding without ABI review; neither implements child-atomic credentials.
- Go's generic `os/exec/lp_wasm.go` treats every executable as absent because
  upstream Wasm targets cannot spawn. Kandelo must select the Unix `LookPath`
  implementation and check effective execute permission through the real
  `faccessat2(AT_EACCESS)` syscall. Test PATH lookup with a VFS executable
  and both absolute and child-CWD-relative `os.StartProcess` paths. Spawn
  admission belongs in Rust. A kernel precheck may use the parent context
  only when there are no file actions or credential reset; otherwise the
  child's post-action target admission resolves the candidate. Checking a
  child-relative executable in the parent context rejects valid launches.
  Do not carry over the WASI-era `syscall` initializer that forces standard
  fds nonblocking: `posix_spawn` must preserve the parent's OFD status flags.
  Its presence made upstream `TestReadNonblockingFd` hang because Go attached
  a poller to a child stdin that was blocking before spawn. A C child
  confirmed the kernel transferred the flags correctly; removing the Go
  initializer makes the isolated test pass.
- Do not inherit WASI's `clock_time_get` ENOSYS stub for Kandelo. Its
  `CLOCK_REALTIME` channel syscall writes a two-word timespec; convert
  nanoseconds to microseconds for `syscall.Gettimeofday`. The upstream
  `syscall` test binary exercises this and the existing dirent/env/spawn
  cases in Node.
- Kandelo directory reads use the kernel's Linux-style `getdents64` records
  and fd-owned iteration position, not the WASI preview-1 dirent/cookie
  format. Match `syscall.Dirent` and `os` parsing to the kernel's byte layout;
  preserve zero-inode entries, and send directory `Seek` to the kernel so
  rewind and `seekdir` cookies affect the real iterator. The selected upstream
  `os` and `syscall` dirent tests exercise multi-buffer reads on Node and all
  three browser engines.
- Kernel `stat` already supplies real mode, uid, and gid. Map those values
  into Go `FileInfo`; do not substitute WASI-style default permissions or
  zero owners. `Chown`, `Fchown`, and `Lchown` route through Kandelo's
  existing ownership syscalls, including no-follow behavior for symlinks.
  The selected upstream `os` chmod/chown tests cover these paths.
- Compare Go's `syscall_kandelo.go` `O_*` values with Kandelo's
  `crates/shared/src/lib.rs` and the wasm32posix musl headers, not WASI
  constants. Wrong `O_DIRECTORY`/`O_NOFOLLOW` values let `Root.MkdirAll`
  open a regular file as an intermediate directory and report the wrong
  error path; the upstream `TestMkdirAll/InRoot` case catches this.
- A wider upstream `os.Root` sweep is a platform probe, not a license to
  patch around kernel defects in Go. `TestRootRemoveDot` exposed Kandelo's
  `unlinkat(..., AT_REMOVEDIR)` removal of `.`; exact `Chtimes` required
  matching inode metadata and the Wasm stat bridge. ABI 49 moved `/` and
  the scratch mounts to the kernel on both hosts; Node host-mounted
  directories remain a separate backend, so rerun both hosts. Browser
  `time.Now` has millisecond granularity and can pass `TestRootChtimes`
  without exercising sub-millisecond
  storage; use a fixed-nanosecond `os.Chtimes`/`syscall.Stat` probe too.
  Directory OFDs need live path state shared across processes: a successful
  kernel rename moves the open directory and its descendants, while an open
  descriptor to a replaced destination must not alias the new occupant.
  `TestRootRenameAfterOpen` catches the stale-opening-path error. Fix remaining
  gaps at their owning syscall/VFS/OFD layers, not in the Go test harness.
- `os.Executable` reads Kandelo's kernel-owned `/proc/self/exe` identity,
  never `argv[0]`. Initial VFS launches publish the canonical selected path;
  prepared exec/spawn commits replace it, fork inherits it, and direct byte
  launches retain an anonymous executable object with a diagnostic
  ` (deleted)` name, matching the current kernel contract. Check that
  `/proc/self/exe` actually opens its Wasm bytes. Test a forged
  `argv[0]`, post-`chdir` lookup, an actual child exec, and the upstream
  `TestExecutable` in Node and all three browser engines. An added kernel
  export changes the ABI snapshot and digest even if `ABI_VERSION` stays
  compatible: rebuild fixture and package binaries instead of restamping
  artifacts from the old digest.
- `linkat` without `AT_SYMLINK_FOLLOW` must link the source symlink inode.
  Kernel no-follow resolution alone does not ensure that behavior: Node's
  `fs.linkSync` follows a symlink source on macOS when targeting a host mount.
  The macOS HostFileSystem uses an exact native
  `linkat` helper with `AT_SYMLINK_NOFOLLOW_ANY` for this case. The helper
  compiles lazily from fixed source with the host C compiler; if unavailable,
  it reports `ENOSYS` instead of pretending that a copied symlink or link to
  the target is a hard link. `TestRootLinkFrom` catches this host mismatch.
- Kandelo's `lseek` channel has four argument slots: fd, 32-bit offset low,
  signed 32-bit offset high, and whence. Passing Go's `int64` offset in one
  slot shifts whence into the high half; `Seek(0, SEEK_CUR)` then returns
  `1<<32`. Keep the split at the syscall boundary and use upstream
  `TestRootDirFS` with its three empty-file fixtures to catch regressions.
- Keep logical file positions separate from writable file extents. The
  upstream `TestSeek` exercises offsets above 4 GiB. The in-kernel rootfs
  and tmpfs now own this behavior on both hosts: `lseek` and EOF reads may
  retain a logical position without allocating data, while a write beyond
  the storage limit fails.
- Root-relative rename consistency is a syscall/platform check. Kandelo's
  component walker canonicalizes `dir/.` to `dir`; `rename` and `renameat`
  must reject a final `.` before host mutation or the plain-path operation
  can move the directory while `os.Root.Rename` correctly fails.

Treat changes to memory declarations, Wasm imports/exports, channel layout,
or syscall semantics as ABI reviews. Follow `docs/agent-guidance/abi.md`:
incompatible changes require an `ABI_VERSION` bump and updated snapshot.
The fork's `src/cmd/link/internal/wasm/asm.go` currently hardcodes the
`__abi_version` marker. On an ABI bump, update that constant in the fork,
publish its commit, and repin all Go consumers (`go-hello`, Caddy, and both
FrankenPHP recipes)
before rebuilding packages; changing only their `kernel_abi` metadata
still emits the old marker. Check the marker in the freshly built Wasm
before starting an expensive WordPress image build.
Stamp newly built probe binaries with this checkout's ABI-contract digest;
do not validate against a stale or unstamped binary.

## Go/Wasm cgo and C linking

Use the homogeneous `kandelo/wasm32` target and the normal declared compiler
build. The older mixed-width `kandelo/wasm` accessor, callback-frame and
scalar-CGI adaptations are historical evidence in the implementation log;
do not copy them into new packages. Compiler/link success is one gate;
real C execution, callbacks, collection and application lifetime are others.

Trace the complete link path:

- `cmd/cgo` owns C type discovery, DWARF/constants and dynamic imports.
  Wasm is not ELF, Mach-O, PE or XCOFF. Recognizing its magic does not
  establish correct types, offsets, symbols or calls. Compare generated
  Go layouts with the SDK C target, including four-byte pointers and
  eight-byte `int64` alignment. Test ordinary C pointer fields, fixed
  pointer arrays, aggregate calls/returns, exported callback frames and
  escaping field aliases across collection. Preserve ordinary data-pointer
  GC roots. C function-table handles use the existing non-heap opaque
  pointer mechanism described above.
- `cmd/link/internal/loadwasm` reads Wasm objects and their linking,
  relocation, function, data, table, global, exception-tag and TLS metadata.
  The internal linker owns the final shared memory, function table, heap,
  exports and thread slots. A final Go module is not a relocatable object
  that can simply be passed to `wasm-ld`. Do not suppress unsupported
  relocations, accept arbitrary invalid archives or route calls through a
  JavaScript shim that changes the normal process model.
- Preserve object-local names, weak/strong symbol ownership, initialized
  data from objects with no functions, transitive archive reachability and
  constructor/vtable roots. Passive data needs initialization before use.
  Unused ordinary C call edges must not become link roots. Reject unsupported
  initializer/finalizer forms visibly. `INIT_FUNCS` defines constructor
  dispatch; do not reinterpret arbitrary `.init_array` bytes as callable
  pointers. A cgo-disabled mixed link must not silently discard constructors.
- Go's resumable call convention differs from the SDK C ABI. Go-to-C frame
  wrappers and C-to-Go exports need exactly typed Wasm adapters. Ordinary
  wrappers return void; errno wrappers return i32. C calls cannot directly
  invoke raw Go table entries with another signature. Test scalar alignment,
  pointer identity, `errno`, C TLS and both callback ownership paths.

Static archive search paths work through upstream `#cgo LDFLAGS` and
`CGO_LDFLAGS` on the current target. FrankenPHP's recipes use its documented
static closure through the latter, with no source patch. Keep upstream's
normal `-lm` and `-lutil` compatibility archives; the linker accepts strictly
object-free GNU and empty BSD32-index forms. A library-name exception or
blanket unsupported-archive bypass would conceal a general linker defect.
Run `tests/go/cgo/static-archive` for real multi-member and empty archive
execution on Node and browsers before relying on a larger archive.

A linked C function is not automatically a dynamic export. Explicit
`-Wl,--export-dynamic-symbol=<name>` requests through the Go linker's
`-extldflags` retain otherwise-unused archive members and export functions
or immutable data-address globals. This supported option does not make the
unsupported general external-link mode work. `tests/go/cgo/c-exports`
loads a real side module importing both kinds of symbol. `-ldl` selects
SDK dynamic-loading glue, not only an empty compatibility archive. The
`scripts/wasm-side-module-c-exports.mjs` helper derives a side module's
required exports from its imports; do not invent a partial closure.

C TLS and the Go channel handoff have separate ownership. The internal
mutable C `__tls_base` is instance-local and uses a copied TLS template;
the immutable exported handoff word identifies the Go channel receiver.
The host initializes C `__channel_base` too. Cgo obtains its channel through
the per-instance typed getter, avoiding the shared-word startup race.
Keep the TLS template within the host's actual thread-control capacity
and reject overflow or unsupported initializer relocations. Side-module
TLS also needs fork replay; a successful static TLS probe does not prove
cross-module TLS relocation support.

Go-created Ms use Kandelo's thread bootstrap even with cgo enabled. Each
needs a dedicated C stack and musl thread pointer, initialized before Go
scheduler entry. Do not use g0's live stack as C shadow-stack storage.
C-created pthreads instead enter a typed Go bootstrap with their own
channel, bootstrap stack, M and scheduler attachment. A Go-owned callback
must retain its C call while the Go scheduler yields; a foreign callback
must attach and detach through the proper runtime path. Reload resumed
runtime state rather than trusting Wasm locals across scheduler unwind.
Test second-Go-M calls, same-thread callbacks, simultaneous C-created
callbacks and repeated allocation/GC. Never satisfy missing thread or
callback APIs with no-op symbols.

Musl initialization and the C process entry are separate archive concerns.
Pass the process environment to `__init_libc`; synchronize Go environment
changes so C `getenv` observes them. All allocations must share Kandelo's
mapping manager rather than competing private sbrk regions. Check constructor
priority and explicit C exit handlers. Go main return and `os.Exit` use
process-wide raw exit and do not run C atexit handlers; C `exit` does and
C `_exit` does not. Preserve those distinctions in lifecycle tests.

A normal cgo executable is fork-instrumented and carries the exact current
`kandelo.abi.contract` digest. Unset target `CC`/`CXX`/`AR` before host Rust
instrumentation/stamping. Install through the package pipeline; do not
restamp stale artifacts or infer a running service from an archive build.
Run the focused linker and cgo probes first, then normal PHP embed and
FrankenPHP requests. Rebuild Kandelo pure/cgo, upstream WASI32, legacy WASI
and legacy JS standard libraries after toolchain changes.

PHP ZTS's static archive requires real dependency closure and Wasm
exception-tag/nonlocal-exit handling. Unsupported ucontext APIs must fail
honestly; compiled-but-unused PHP Fiber paths do not establish Fiber support.
PHP 8.5 uses built-in static OPcache in the current package. The historical
separate PHP 8.3 extension does not prove a PHP 8.5 side module: its external
TLS relocation remains unsupported. Do not duplicate TLS symbols to conceal
that error. The real FrankenPHP SAPI accepts OPcache acceleration; the
`embed` SAPI does not. Never rename a probe SAPI to bypass that check.

The maintained classic Node test verifies static OPcache registration,
compilation/cache-file creation, PHP/static HTTP, bulk CGI strings during
observed Go collection, and awaited SIGTERM exit. The shared verifier in
`tests/go/frankenphp/request-lifetime.ts` also runs in Chromium, Firefox and
WebKit. Keep these scoped claims separate from real Caddy, WordPress editor,
long-lived memory and performance gates. Current artifact identities and
remaining limits are in the implementation progress log.

## Shutting down embedded runtimes

Drain HTTP handlers before shutting down an embedded C runtime. With Go's
HTTP server, `Serve` returning `http.ErrServerClosed` only means the
listener has closed; wait for `Server.Shutdown` to finish before calling
`frankenphp.Shutdown`. Keep cleanup in a function that returns an error to
`main`, because `log.Fatal` and `os.Exit` skip deferred cleanup.

Check the generated service configuration as well as the Go handler.
The packaged dinit defaults to a 10-second stop timeout, after which it
sends SIGKILL. A longer HTTP drain needs an explicit service stop deadline
that also leaves time for PHP thread cleanup. Bound Caddy's `grace_period`
explicitly when running under a bounded supervisor; its upstream default
is unlimited. Use ordinary service/server settings rather than patching
the supervisor or changing target signal semantics.

Use the real held-PHP probe in
`host/test/support/frankenphp-graceful.ts` on Node and browser. It requires
actual listener removal before releasing PHP, the complete response, and
normal service exit. A small Go HTTP fixture, a SIGTERM trace, or cooperative
host destruction does not establish embedded-runtime request draining.

## Profiling large Go/Wasm services

Keep binary size, compiled-module bookkeeping, live guest linear memory,
and host physical memory separate. The module cache's `compiledBytes` is a
sum of Wasm input byte lengths, not V8 native-code allocation; a process
snapshot's `memoryBytes` is guest linear memory, not the whole Node or
browser process. Neither number bounds host RSS. Compare fresh processes
at image read/load/save, service spawn, listener readiness, sustained
requests, and restart. A compile or instantiation probe that never calls
the program entry point cannot establish the cost of executing Go code or
starting its C pthreads. Do not subtract samples from different binaries
or VFS images and call the difference PHP or Caddy overhead.
The [paired stack benchmark](../profiling.md#wordpress-stack) now isolates
each Node round in a fresh child, records its PID, and waits for its exit
before the next profile. Use its optional sustained-load phase for native
RSS samples; an earlier round's retained pages must not be attributed to a
later stack. Chromium samples sum process RSS and can double-count shared
pages, so keep that quantity distinct from unique physical footprint.

Record `/proc/<pid>/status` thread counts alongside module-cache and guest
memory snapshots. Zero `threadCompiles` counts the host cache's compile
calls; it does not measure what an engine retains after transferring a
module to each thread. Preserve native process measurements outside the
page so a content-process kill does not erase the evidence. Inspect actual
Wasm section sizes before proposing debug stripping; do not assume a large
module contains DWARF or remove names needed for failure diagnostics.

Audit worker message payloads separately from compiled-module sharing. The
current Node and browser thread paths send the original program bytes as
well as the compiled module. Those bytes support reflection, typed import
routing, fork-template identity and legacy channel TLS detection; dropping
them without replacing those uses would weaken correctness. For a roughly
206-MB program, each ordinary structured clone is a material allocation
even when `threadCompiles` is zero. Do not attribute it to engine code or
promise that eliminating it solves the native footprint without measuring.

For WebKit inspector memory diagnostics, navigation replaces the page's
target. Reattach tracking to the committed target and retain UTC receipt
times outside the page; record pairing skew with guest snapshots. Keep
unknown guest values absent after destruction. Native allocation categories
are not whole-process footprint or per-worker JavaScript heap counts, and
direct page-worker events omit nested guest workers. Use guest `/proc`
thread counts alongside those events. Observe natural post-destroy behavior
in the same page without forced GC; one short reclamation interval does not
prove a sustained-memory bound.

For Node diagnostics, record process RSS and, on macOS, physical footprint;
V8's `--print-wasm-offheap-memory-size` is useful for an exit-time compiled
module sample, not a running-service memory plateau. Guard large runs against
actual unused system memory and stop when headroom is low. On the WordPress
probe, `memory_pressure -Q` looked healthy while `top` showed only a few
GiB unused, so it was not a sufficient safety guard. Measure the browser
renderer independently before claiming browser parity, and do not call a
short stable sample a leak fix or production memory bound. The current
FrankenPHP/Caddy measurements and caveats are in the implementation progress
log.

## Evidence and handoff

The reproducible probe commands and scope are in `tests/go/README.md`.
After building the kernel, run `tests/go/build-browser-fixtures.sh` under
`scripts/dev-shell.sh`; it stamps the outputs. Run the relevant Node probe
and opt-in Chromium Playwright case against those exact outputs. Check exit
status, expected output, stderr, host diagnostics, and where applicable
fork-count samples. A Node pass does not establish browser parity; a focused
probe does not establish Go or POSIX conformance. For package integration,
also rebuild `go-hello` through the source-only resolver and launch the
resolved artifact from a VFS child on both hosts.

Record the exact Go fork commit, Kandelo commit or PR, changed contract,
Node/browser commands and results, ABI decision, and remaining gaps in the
same implementation progress log. Update the Go package source pin when
publishing a fork revision used by the package. Keep the Kandelo draft PR's
description aligned with verified evidence, not planned behavior.
