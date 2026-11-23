# D on Kandelo

The development SDK uses host-side LDC 1.43.0 and statically links DRuntime
and Phobos against Kandelo's wasm32 musl sysroot. The target is
`wasm32-unknown-kandelo-musl`. Guest binaries use the native Kandelo ABI.

Build in the repository dev shell on ARM64 Linux with `ldmd2` from the
official LDC 1.43.0 ARM64 Linux release. The script downloads and verifies
the pinned source archive and prints the new SDK directory. It checks
that LDC preserves the guest's binary128 `real` during compile-time
evaluation before building the libraries. LDC uses host `real` precision
for this evaluation. On ARM64 macOS that rounds away valid guest values.
An ARM64 Linux VM can build the guest binaries for a macOS development host.

Realize the optional LLVM 21 compiler libraries once. The Kandelo C/C++
SDK continues to use the LLVM toolchain from the default dev shell.

```sh
mkdir -p .scratch
nix build --out-link .scratch/d-llvm .#d-llvm
d_llvm=$(realpath .scratch/d-llvm)
scripts/dev-shell.sh env KANDELO_D_LLVM_PREFIX="$d_llvm" sdk/d/build.sh .scratch/d-sdk /path/to/ldmd2
```

Use the printed directory to build a D executable. The compiler driver
links through `wasm32posix-cc`, then the script applies Kandelo's fork
instrumentation and stamps the current guest ABI contract.

```sh
scripts/dev-shell.sh sdk/d/build-program.sh /path/to/kandelo-d-build \
    .scratch/d-posix.wasm sdk/d/test/posix.d
scripts/dev-shell.sh env KANDELO_RUNNER_BUILTINS=explicit \
    ./node_modules/.bin/tsx examples/run-example.ts .scratch/d-posix.wasm runtime </dev/null
```

Use `file`, `process`, `descriptors`, `thread`, `socket` and `unix` as
separate arguments in place of `runtime` to exercise filesystem operations,
subprocesses and pipes, descriptor inheritance, TLS and threads, loopback TCP
and Unix socket pairs.
`test/gc_safepoint.d` exercises live TLS and stack roots during a concurrent
collection. The Node runner expects the kernel artifact from
`./run.sh build kernel`.

Use `external /bin/echo` to exercise a piped subprocess with a separate
guest executable. Pass the path where `echo` is installed in the guest.

Build the upstream DRuntime and Phobos test runners with the same SDK.
Use the printed SDK directory and run the resulting guests on a Kandelo
host. Pass `druntime` or `phobos2` as a third build argument to build one
runner. Each upstream runner accepts module names as arguments. The
combined Phobos runner exceeded 16 GiB of resident memory during Binaryen
post-optimization. Allow for that when selecting a test builder.

```sh
scripts/dev-shell.sh sdk/d/build-tests.sh /path/to/kandelo-d-build .scratch/d-tests
scripts/dev-shell.sh env KANDELO_RUNNER_BUILTINS=explicit \
    ./node_modules/.bin/tsx examples/run-example.ts .scratch/d-tests/druntime-test-runner.wasm core.math </dev/null
scripts/dev-shell.sh env KANDELO_RUNNER_BUILTINS=explicit \
    ./node_modules/.bin/tsx examples/run-example.ts .scratch/d-tests/phobos2-test-runner.wasm std.math.operations </dev/null
```

`std.file` checks the executable's path. Launch that test runner from a
file in the guest VFS. The `std.process` tests also use Bash at `/bin/sh`
and Coreutils commands on the guest's `PATH`. The `std.datetime` time-zone
tests use the IANA database in the guest at `/usr/share/zoneinfo`.
`std.net.curl` uses the guest dynamic loader and a Kandelo build of libcurl.
The standalone Phobos runner build leaves that external dependency to the
test image and linker setup. See [dynamic loader flags](../../docs/sdk-guide.md#with-dynamic-loading-dlopen).

The shared [binary128 C regression](../../tests/sortix/os-test-local/basic/math/binary128.c)
covers subnormal arithmetic, rounding during float conversion, and NaN
payloads and comparisons on both Wasm widths.

D fibers use Kandelo's guest-local continuation provider. A suspended fiber
resumes on the pthread that started it. Each pthread has a separate Wasm
instance with its own reference tables. `Fiber.allowMigration()` leaves
that restriction in place. The collector scans saved shadow stack and
activation ranges through DRuntime's stack context list.

Build `test/fibers.d` with the same driver to exercise fiber reset, TLS,
garbage collection while a fiber is suspended, exception propagation, and
Phobos `Generator`. `test/exception_chain.d` checks nested exception chains,
`Error` priority, loops in `scope(exit)` during unwinding, and collection
while two exceptions are in flight or after a suspended fiber is reset.
LDC keeps garbage collection safepoints inside the native Wasm cleanup
handlers where they run. DRuntime tracks in-flight exceptions in each
stack context.

The socket tests cover Kandelo's loopback TCP and Unix streams. The guest
resolver delegates IPv4 hostnames to the configured host network backend
and returns the queried hostname for `AI_CANONNAME`. The musl protocol
database reports `tcp` with an empty alias list. Phobos tests that expect
an external DNS alias or a `TCP` protocol alias can report a soft failure.

## DUB and LDC inside a guest

Build with the host-side D SDK above and the wasm32 resolver outputs for
`libcxx`, `libcurl`, `openssl` and `zlib`. Use the same checkout and ABI
contract for the D SDK, dependency builds and guest image. The guest
compiler script builds the WebAssembly backend of LLVM 21.1.8 and LDC
1.43.0. It prints a staged `/usr` tree with the compiler, imports, runtime
archives and linker entry point.

```sh
scripts/dev-shell.sh env KANDELO_D_LLVM_PREFIX="$d_llvm" BINARYEN_CORES=1 \
    sdk/d/build-guest.sh "$d_sdk" "$libcxx" .scratch/d-guest
scripts/dev-shell.sh sdk/d/build-dub.sh "$d_sdk" "$guest_usr/bin/dub" \
    "$libcurl" "$openssl" "$zlib"
```

Install the staged files under `/usr` in a guest with the Kandelo C/C++
SDK and `wasm-fork-instrument` on `PATH`. LDC reads its target configuration
beside the compiler. Its linker entry point calls `wasm32posix-cc`, links in
the program ABI digest, and prepares the executable for Kandelo's process
runtime. D and C++ use distinct WebAssembly exception personalities.

The [test project](test/dub-project) pins a public dependency. In its guest
project directory with registry egress enabled, run the first three
commands. The last command forces a rebuild from the installed package
cache with registry access disabled in DUB.

```sh
dub fetch taggedalgebraic@1.0.1
dub run
dub test
dub run --skip-registry=all --force
```

The Node acceptance runner creates a partial guest image with both SDKs. It
checks binary128 at compile time, fetches the dependency into an empty
cache, runs the project and its unit test, and verifies the ABI digest on
both generated executables. It then boots the saved guest filesystem with
network egress disabled and forces a rebuild from the cached source.

```sh
scripts/dev-shell.sh ./node_modules/.bin/tsx sdk/d/test/guest-dub.ts \
    "$kernel_wasm" "$kandelo_sdk_zip" "$fork_instrument_wasm" "$guest_usr"
```

The fetch, build, test and run sequence also passed in Chromium and
Firefox on a partial image. In WebKit, the registry fetch and binary128
check passed. The LDC worker reported `Maximum call stack size exceeded`
while compiling the application in both debug and release builds.

`test/mixed_exceptions.d` and `test/mixed_exceptions.cpp` exercise the two
exception handlers in one executable. With the C++ SDK libraries on the
sysroot, compile the C++ fixture with `wasm32posix-c++ -fwasm-exceptions -c`
and pass its object and `-L-lc++ -L-lc++abi` to `build-program.sh` with the D
fixture.

## Swift follow-on

Swift is the next native POSIX port. It can use the same musl sysroot,
linker driver, fork instrumentation and ABI stamp. The ARM64 Linux dev
shell provides the pinned host toolchain for cross-builds. The process
and pipe, pthreads and TLS, and socket tests define behavior to verify
through Swift's APIs. The shared
[Unix stream conformance test](../../tests/sortix/os-test-local/basic/sys_socket/unix-stream-capacity.c)
checks 768 live pairs, bidirectional I/O, backpressure, and descriptor reuse.
The shared [select conformance test](../../tests/sortix/os-test-local/basic/sys_socket/select-wide.c)
checks readiness, timeout, and signal-mask handling for descriptors above
the default bitmap size.
The SDK's continuation provider is independent of D and is available for
runtimes that need stackful suspension. DRuntime's stack context registry,
GC root handling, and exception integration are specific to D.
Swift needs its own compiler target, runtime and standard library builds,
and validation of ARC and Swift concurrency.
