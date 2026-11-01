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
