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
