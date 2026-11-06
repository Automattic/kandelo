# Go Runtime Port Guidance

Use this guide when changing the `GOOS=kandelo GOARCH=wasm` toolchain,
runtime, linker, or standard-library platform code. Registry package recipes
instead follow `porting-software-to-kandelo` and the package-build guide.

## Ownership and build

The Go source lives in the adjacent `../go-kandelo` checkout on its
`kandelo-port` branch, not in this repository. The pinned package input is
`packages/registry/go-hello/build.toml`; the implementation record is
`docs/plans/2026-09-05-go-gc-port-milestone1-plan.md`. Before changing code,
compare the fork's current commit with the package pin and progress log.
Runtime, syscall, and linker fixes belong in the Go fork. Kernel/host ABI and
POSIX fixes belong in Kandelo. Do not hide a platform defect in a probe or
package shim.

Build the fork with the dev shell's bootstrap Go:

```sh
scripts/dev-shell.sh bash -c 'cd ../go-kandelo/src && GOROOT_BOOTSTRAP="$(go env GOROOT)" ./make.bash'
```

The current fork is based on Go 1.25.6; cgo support remains partial for this
target. Confirm `GOOS=kandelo GOARCH=wasm` and cross-target `js`/`wasip1`
builds after runtime or linker changes. Do not assume Linux build tags or
APIs apply to Kandelo.

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
Unix cgo resolver expects unavailable `res_n*` libc entry points, and its
`struct passwd` pointer fields do not match Kandelo's mixed-width C/Go
interop representation. Exclude those implementations in the fork, not by
adding package-only `netgo` or `osusergo` flags to FrankenPHP.

## Memory, threads, and syscalls

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

FrankenPHP classic mode embeds a PHP ZTS SAPI through cgo. A working
`cmd/cgo` frontend is only one layer of that port. The `go-hello` package
pins the current fork revision, but remains a pure-Go hello program.
The adjacent fork runs focused Go/C calls and Go-owned and C-created-pthread
callbacks on Node and Chromium. The `php-zts` package and PHP embed lifecycle
probe pass on both hosts. The `frankenphp-classic` package now serves a PHP
request and a static asset through real HTTP on Node and Chromium. A
source-only WordPress VFS serves homepage and admin requests on Node and
Chromium, including the browser gallery profile. Do not infer full cgo,
POSIX conformance, or a WordPress performance advantage from these gates.
For a bounded same-process PHP request probe, set
`KANDELO_FRANKENPHP_CHURN_REQUESTS=40` in the Node-host counterpart and
Chromium kernel-host WordPress tests. They alternate homepage and login PHP
requests with distinct query strings on one server boot and pass on both
hosts; they do not establish sustained worker reuse, allocator stability,
or throughput.

Trace the whole link path before changing flags or package recipes:

- `src/cmd/cgo/main.go`, `gcc.go`, and `out.go` own C type discovery,
  DWARF/constant extraction, and dynamic-import handling. Wasm is not
  ELF, Mach-O, PE, or XCOFF. A magic-byte bypass of object parsing is
  insufficient: the generated constants, symbols, and imports still need
  correct interpretations. The WIP Wasm reader in the adjacent fork
  is not yet a reviewed implementation.
- Kandelo's C ABI uses 32-bit pointers while Go/Wasm pointers are 64-bit.
  Exported Go callbacks need a byte-exact C frame: the Go `struct` generated
  by stock cgo pads pointer fields and can return null even when the Go
  callback returns a valid pointer. The fork now marshals exported scalar
  and pointer fields through C-sized byte offsets. Test mixed scalar/pointer
  arguments and pointer results on C-created pthreads. This does not repair
  direct Go field access to C structs containing pointers: FrankenPHP's
  version, header-list, and request-info paths use C accessors at that
  explicit interop boundary. Audit every new C struct access by comparing
  C `sizeof`/`offsetof` with generated Go layout before trusting it.
  In particular, do not initialize a `C.go_string` with a Go pointer-typed
  struct literal or compare a raw `Bucket.key` field with `nil`: cgo exposes
  those C addresses as `uint32` on this target. Build the value with a typed
  C constructor and retrieve the hash key through a typed C accessor.
- FrankenPHP's CGI bulk registration passed a pointer-bearing C struct by
  value, another unsupported mixed-width case. Its Kandelo package patch
  uses the existing scalar/pointer `frankenphp_register_single` entry until
  a general packed-struct cgo bridge exists. This makes extra Go-to-C calls
  per request; measure the app before making performance claims.
- Static libraries must be declared through `#cgo LDFLAGS` with
  `-L${SRCDIR}/lib -l...`; environment-only `CGO_LDFLAGS` does not give the
  internal linker a search path and can force unsupported external linking.
  The internal linker selects archive members recursively for referenced C
  code, including PHP's dependency archives. The `static-archive` and
  `php-embed` probes cover this path on both hosts.
- A linked C archive does not imply its functions are exported from the Go
  executable. The pinned Go linker now accepts explicit
  `-Wl,--export-dynamic-symbol=<name>` requests through Go's `-ldflags`
  `-extldflags` value. It selects otherwise-unused archive members, keeps
  their functions and data live, and exports C functions or immutable data-
  address globals. `-ldl` also selects the SDK's real Wasm `dlopen` glue,
  rather than its empty compatibility archive. The `c-exports` probe loads
  a side module that imports both kinds of symbol on Node.js and all three
  browsers. On the earlier PHP 8.3 line, `php-zts` built an instrumented
  `opcache-zts.so` alongside `libphp.a`; it had 290 Wasm imports, including
  242 functions and 42 globals. The general
  `scripts/wasm-side-module-c-exports.mjs` utility derives required C
  exports from its imports. The earlier PHP embed fixture requested those
  exports and `dlopen`ed the real ZTS module on Node and three browser
  engines.
  ZTS side modules must export mutable `__tls_base` for fork replay. This
  proves import closure and loading, not Zend extension registration,
  accelerated PHP execution, FrankenPHP integration, or performance parity.
  Upstream OPcache rejects the PHP `embed` SAPI for acceleration even when
  an INI successfully registers the extension; it accepts the real
  FrankenPHP SAPI. Do not rename a probe SAPI to bypass that check.
  The current PHP 8.5 ZTS package uses upstream's built-in OPcache and
  publishes only the static embed archive. A separate PHP 8.5 ZTS OPcache
  Wasm side module fails to link because its external `_tsrm_ls_cache`
  reference uses a TLS relocation the Wasm linker cannot resolve across
  modules. Do not duplicate that TLS symbol or bypass the linker error.
  The PHP 8.5 embed archive and FrankenPHP classic package build. The
  current PHP embed fixture verifies static OPcache registration with a
  guest `PHPRC` INI in Node and all three browsers. Its C call to
  `zend_eval_string` passes an expression when requesting a return value;
  including a literal `return` made that API fail before the extension
  check. The standalone FrankenPHP SAPI tests verify file-cache-only
  OPcache behavior in Node and Chromium; the revision-31 WordPress
  browser-host tests verify it in Chromium. These bounded request gates do
  not establish long-lived stability or the visible WordPress editor's
  browser JavaScript.
- A Go cgo executable must be fork-instrumented and carry the exact current
  `kandelo.abi.contract` digest. `install_local_binary` can instrument but
  does not stamp by itself: instrument first, stamp that fresh artifact, then
  install it. Unset cross-compiler `CC`/`CXX`/`AR` variables before the
  host-side Rust instrumentation and stamping builds.
- `src/cmd/link/internal/ld/lib.go` loads cgo's C objects. Internal mode
  originally rejected their format; the adjacent fork now imports C functions,
  initialized data, active table elements, and the CODE relocations reached
  by `runtime/cgo`, including narrow `reloc.DATA` address references and a
  bounded per-instance C TLS template. Fork commit `acc452f`
  asks the SDK compiler for its libc archive and resolves C function-pointer
  table relocations needed by the selected members.
  External mode reaches unsupported PC-relative relocations.
  `src/cmd/link/internal/wasm/asm.go` emits a final Wasm module, not an
  object that `wasm-ld` can link with the SDK's C Wasm objects. A direct
  `wasm-ld` attempt on that output rejects it. Do not suppress relocation
  errors to make the build appear to advance.
- C objects carry Wasm `linking` and `reloc.*` sections. The pthread
  callback fixture's C object needs function-index, global-index,
  table-index, and debug relocations; it references `go_double`,
  `pthread_create`, `pthread_join`, `__stack_pointer`, and
  `__table_base`. A linker design must resolve these into one function
  table and one shared linear memory without colliding with Go's
  `funcValueOffset`, static data, heap, TLS, or Kandelo's thread slots.
- Go's Wasm functions use the runtime's resumable call convention, while
  the SDK's C functions use the Wasm C ABI. A final link also needs
  real Go-to-C and C-to-Go adapters. `asmcgocall` now makes a typed C call
  on Go-created Ms. A Wasm-exported `crosscall2` wrapper resumes
  Go-owned callback goroutines across scheduler yields; the generic
  `cgocallback` assembly entry remains `UNDEF`. A separate foreign-thread
  bootstrap now attaches C-created pthreads for the focused callback probe.
  FrankenPHP additionally
  starts PHP threads with C `pthread_create`, so callbacks from a thread
  Go did not create must attach to a valid M, scheduler P, and per-thread
  Kandelo syscall channel. A same-thread callback alone is insufficient.

Continue linker work from the internal Wasm host-object reader, because the
Go linker already owns Kandelo's final memory, table, exports, and ABI
marker. The narrow fixture now verifies Go-to-C calls, C static data,
function-pointer DATA relocation, and per-instance TLS on Node and Chromium.
The normal `C.abs` build now validates, fork-instruments, and runs through
an ABI-stamped Kandelo process on Node and Chromium, including scalar and
pointer argument frames and distinct musl state on a second Go M. The
Go-owned callback fixture runs on Node and Chromium, including a scheduler
yield, timer wait, nested Go-to-C call, and second Go M. The combined pthread
fixture also executes its C-created callback on Node and Chromium.
If the internal path cannot
preserve C function types, table slots, static data and TLS alongside Go's
layout, evaluate a
relocatable-Go-object/external-link design explicitly. Never feed a final
Go module to `wasm-ld` as though it were a relocatable object, implement
only the object parser and call the link complete, or route calls through a
host shim that changes Kandelo's normal program model.

`cmd/link/internal/loadwasm` in the adjacent fork decodes imports, symbols,
signatures, bodies, data and active element segments, and the CODE relocation
kinds exercised by the C-call, C-data, and runtime/cgo objects. The
Kandelo-only internal linker imports C functions and initialized data into
Go's static layout, resolves direct C-to-C calls and memory-relative C-data
addresses, and maps C function-pointer relocations to Go's existing table.
Fork commit `2fcbf8c` also resolves C data-address globals that refer to
symbols in another C object; the checked-in linker fixture verifies this
through Go assembly on both hosts.
Fork commit `686572e` records global data symbols even from C objects with
no function body and retains their static segments. This is required for
musl archive members that define only data.
The link-only fixture now makes a narrow Go assembly call to C, including
an initialized `_Thread_local` value, and executes as a Kandelo process on
Node and Chromium. Direct table tests also prove per-instance TLS isolation
on shared memory in both engines. It does not exercise `runtime/cgo` or the
standard Go/C adapters. The normal `C.abs` build discovers SDK libc and
executable glue without manual linker flags. Absent weak init/fini bounds
resolve to zero. The fork now parses standard Wasm `INIT_FUNCS` linking
metadata, orders C constructors by priority, and runs them after musl
initialization through a C-ABI function-pointer table. It accepts zero-filled,
unreferenced initializer-array storage only when its priority matches that
metadata. Nonzero, relocated, exported, or referenced initializer arrays
remain rejected; explicit nonempty `.fini_array` segments are also rejected.
The emitted module
passes the Node and Chromium process gate with empty stderr and no host
diagnostics. Use the separate cgo TLS, callback, and pthread suites to
validate musl/PHP TLS, C-to-Go adapters, and C-created-thread attachment.
Do not treat the C shim's `_cgo_topofstack` call as
a direct call to a Go-resumable function. The C-data path is only one link
layer.

Musl C objects use a mutable per-instance TLS base for `_Thread_local` data.
The Go linker now gives C a distinct internal mutable global, reserves a main
TLS block, copies its template before `_start`, and exports `__wasm_init_tls`
for the host's pthread bootstrap. The exported immutable `__tls_base` remains
the Go channel handoff address; do not conflate it with C TLS. Keep the
template within the host's 64 KiB thread-control page, and reject overflow
or unsupported TLS initializer relocations explicitly. Validate musl/PHP TLS,
C-created threads, fork replay, and both hosts before claiming general TLS
support. The link-only fixture proves only a simple initialized TLS variable.

Kandelo-owned Go Ms use the native `newosprocKandelo` path even when cgo is
enabled, avoiding the `_cgo_sys_thread_start` gate for those Ms. Each
Go-created M now gets a separate 8 MiB C stack, reclaimed with the retired
M, and a 256-byte musl thread-pointer backing store. The host installs its C
stack pointer and musl thread pointer before the child entry, and the child
calls `__init_tp` before joining the Go scheduler. The scalar/pointer cgo
probe checks four worker rounds, including distinct `pthread_self()` and
thread-local `errno`, on Node and Chromium. C-created pthreads use a separate
typed Go bootstrap export, musl's `__wasm_thread_init`, an extra Go M/P, and
the per-instance Kandelo channel. C function pointers cannot call raw Go table
entries with the wrong Wasm signature. Do not add no-op thread or callback
symbols to satisfy the linker. The new per-instance C `__channel_base` global
and Go handoff word must both be initialized by the host; do not conflate
either with C TLS. The SDK's normal executable glue (syscall, compiler-rt,
and C++ runtime) is loaded by the Go linker through SDK source queries.
The shared host assigns a new instance's `__stack_pointer` from the
`kernel_clone` stack argument. Go passes the dedicated C stack top for cgo
Ms, not the g0 stack top; reusing g0 here would overwrite live Go frames.
The musl thread pointer and C TLS block are per-instance, not Go goroutine
state. Fork commit `8aec831` passes Go's process environment to musl
`__init_libc` in Go-owned storage; `os.Setenv`/`os.Unsetenv` use C-width
pointer frames so C `getenv` observes changes. Keep the libc initializer
separate from the C process entry archive member, and do not allocate its
environment table with independent C `mmap` while Go still uses a private
contiguous `sbrk` heap: that collided in the combined process. A Node/Chromium cgo probe verifies this
narrow environment path. Fork commit `dbec8a7` adds the Wasm constructor
table and a static `__dso_handle` for C destructor registration. The
constructor fixture verifies priority order, metadata-only
`.init_array.150` dispatch, and explicit C `exit(0)` destructor dispatch on
Node and Chromium. Go-led secure-exec startup passes focused set-ID and
`POSIX_SPAWN_RESETIDS` transitions on both hosts. The linker accepts only
zero-filled initializer arrays whose priorities match `INIT_FUNCS` metadata;
it rejects nonzero, relocated, exported, or referenced arrays rather than
treating their bytes as callable pointers. LLVM currently rejects
`.fini_array` sections. Go main return and `os.Exit` use Kandelo's
process-wide `exit_group` path and do not dispatch registered C exit handlers;
explicit C `exit(0)` does, and C `_exit(0)` does not. The constructor
fixture verifies all four paths on Node, Chromium, Firefox, and WebKit.
This matches the Linux Go runtime's raw `exit_group`
shutdown, not native macOS Go/cgo's observed C-handler behavior. Broader Go
security and shutdown semantics remain unproven. A cgo-disabled mixed C/Go
link must reject C constructor
metadata rather than silently discard it.
For Go-owned callbacks, a typed Wasm export wrapper keeps the C call stack
while Go's resumable scheduler completes the callback. Its linker root must
traverse Go dependencies even when C relocations eagerly marked the wrapper
reachable. C-created pthreads need a distinct typed bootstrap export. The
host invokes it with the kernel thread-slot index before the C start
function, giving the thread a reserved Go bootstrap stack. The callback
adapter then uses `needm`/`cgocallbackg`/`dropm`; after a yield it reloads
g0 from the resumed Go M rather than trusting Wasm locals across the
scheduler unwind. The focused callback probe exercises two callbacks per C
thread and a second Go M on Node and Chromium. Its stress mode runs three
simultaneous C pthread callbacks across eight rounds, with C malloc/free and
Go allocation/GC between rounds, on both hosts. This is bounded contention
and reclaim evidence, not general foreign-thread or PHP conformance.

For a repeatable C function-and-data link proof, run
`scripts/dev-shell.sh bash tests/go/cgo/link-only/test-link.sh`. It appends
small SDK C objects to a cgo-free Go archive and verifies C-to-C and C-data
relocations in the final Wasm module on Node and Chromium. After stamping,
`tests/go/cgo/link-only/run.ts` and the opt-in Chromium case verify the
assembly Go-to-C call inside a process. This is not the normal cgo build. The
standard `C.abs`, Go-owned callback, and focused C-created-pthread callback
gates pass; broader cgo and PHP lifecycle remain required runtime gates.

The Kandelo internal linker now reads cgo `-L` and `-l` flags and explicit
absolute `.a` paths, then selects referenced SDK C archive members, including
members reached through another archive member's C relocation. A cgo package
must declare its library search path with `#cgo LDFLAGS` pointing at a
resolver-owned archive directory. Setting `CGO_LDFLAGS` alone does not put
`-L` on this internal-link path, while `-extldflags` selects an external
link mode that the Kandelo Go/C linker does not support. Run
`bash tests/go/cgo/static-archive/build.sh`, its Node
runner, and the opt-in Chromium case before relying on a large archive such as
`libphp.a`. That fixture proves a small two-member C archive, not general PHP
linkability or archive relocation coverage.

PHP ZTS's larger archive additionally requires imported Wasm exception tags
for `__c_longjmp`, target-owned weak/strong C data symbols, object-local
function names, transitive static archives, and the documented unsupported
ucontext stubs for PHP Fibers that are compiled but not used. The
`tests/go/cgo/php-embed` probe now initializes, evaluates, and shuts down PHP
through the normal Kandelo process path on Node and Chromium. It does not
establish that upstream FrankenPHP requests work. In mixed-width cgo, Go's
8-byte `unsafe.Pointer` must not read a 4-byte C data pointer and adjacent
bytes; Kandelo's non-TSAN `_cgo_yield` storage is widened so Go observes a
real nil value. C struct pointer fields and fixed arrays of pointers use
4-byte `uint32` fields in generated Go types, not native 8-byte Go pointers.
Convert a C-owned address explicitly through `uintptr` when needed; do not
store a Go-managed pointer in one of these fields. The mixed-struct probe
checks field offsets, pointer identity, C struct return, and a by-value C
call on Node and all three browser engines. Other aggregate shapes and Go
pointer retention across this boundary still need separate validation.

Use the staged probes in `tests/go/README.md`:
first a C call, then Go-to-C-to-Go on the calling thread, then a C-created
pthread callback. For the scratch frontend, run `../bin/go test cmd/cgo`
from `../go-kandelo/src` under `scripts/dev-shell.sh`. Use `go build -x -work`
and `llvm-readobj --sections --symbols --relocations` on its generated C
object to locate the exact build boundary. A successful native-host probe
checks the fixture only; a successful cgo frontend or link is not proof of
runtime behavior. Require a process that executes both callback paths on
Node and Chromium with the normal ABI stamp, matching memory/table layout,
expected output, empty stderr, and no host diagnostics before building a
PHP embed library or FrankenPHP. Re-run `js` and `wasip1` builds after
compiler, linker, or runtime changes.

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
