# Zig validation on Kandelo

The [SDK guide](../../docs/sdk-guide.md#zig-programs) describes the target,
delegated link and fork instrumentation. This directory also builds and runs
the OS-facing tests from the Zig 0.17.1 release source. Use the original release
source tree because the installed Zig standard library omits test bodies.
[Zig 0.17.1 source archive](https://ziglang.org/download/0.17.1/zig-0.17.1.tar.xz)

With the wasm32 SDK and the Node and browser test artifacts built, run these
commands from the repository root, inside the Kandelo dev shell.

```bash
sdk/zig/build-stdlib-tests.sh /path/to/zig-0.17.1 .scratch/zig-stdlib
KANDELO_ZIG_TEST_ARTIFACTS="$PWD/.scratch/zig-stdlib" \
  npx --prefix apps/browser-demos playwright test \
  -c sdk/zig/playwright.config.ts --project=chromium
```

The suite runs each group on Node and in Chromium and attaches the guest's
test output to the Playwright result. Build artifacts are linked through the
SDK and fork-instrumented before execution. The upstream child-process test
checks piped input and output, a child exit status of 42, and the error for a
missing executable. It runs with both an absolute path and one starting with
`..`. The SDK smoke also checks the musl ABI layouts and performs a `termios`
round trip on a pseudoterminal. It exercises libc allocation, independent TLS
across three pthreads, `fork` and `waitpid`, and wide-integer and floating-point
operations with Zig's compiler runtime.

## Observed results

Node 24.22.1 and Chromium 153.0.8010.12 produced the same results on 2026-11-22.
The 2026-11-23 rerun on the `5f5e3dd9e` develop base reproduced these counts.

| Zig 0.17.1 tests | Passed per host | Skipped per host | Failed per host |
| --- | ---: | ---: | ---: |
| `std.fs` | 173 | 3 | 0 |
| `std.Thread` | 73 | 1 | 1 |
| `std.process` | 82 | 0 | 0 |
| `std.Io.Threaded` | 82 | 2 | 0 |
| `std.posix` | 85 | 4 | 0 |

The smoke and both child-process cases passed on each host. The upstream
`sigaltstack` test also passed on each host, querying the alternate stack
and checking that libc rejects undersized storage. The failing
`Thread.test.setName, getName` case changes another thread's name. Musl
implements that GNU extension through `/proc/self/task/<tid>/comm`, which
Kandelo does not expose. The failure remains visible in the test suite.

### Upstream skips

- `std.fs` skips the test that obtains a file descriptor for the symlink
  itself through OS-specific open behavior. `invalid UTF-8/WTF-8 paths`
  tests the Windows and WASI error for such paths. `readlink on Windows`
  exercises Windows-specific path handling.
- `std.Thread` skips its generic TLS test on ILP32 due to upstream issue
  [ziglang/zig#25498](https://github.com/ziglang/zig/issues/25498). The SDK smoke
  checks TLS on the Kandelo target.
- `std.Io.Threaded` skips its two Windows path tests, `toPrefixedFileW` and
  `getWin32PathType vs RtlDetermineDosPathNameType_U`.
- `std.posix` skips `dl_iterate_phdr` for Wasm. Its `memfd_create`, `signalfd`
  and `sync`/`syncfs` tests are upstream OS-gated. The current Zig target does
  not expose a `std.posix.memfd_create` binding. The `signalfd` and `sync`
  upstream tests only check declarations. The harness enables the `fsync`
  and `fdatasync` test for Kandelo.

## Compiling Zig programs inside Kandelo

From the Kandelo dev shell with the wasm32 SDK built, use a clean Zig 0.17.1
release source tree to build the experimental guest compiler.

```bash
sdk/zig/build-guest-compiler.sh /path/to/zig-0.17.1 .scratch/guest-zig
```

The output has `bin/zig` and `lib/zig`. Place the tree in the guest, for
example under `/opt/zig`. The guest also needs the C/C++ SDK with
`wasm32posix-cc --print-kandelo-sdk` support, `wasm32posix-ar`, and the guest
`wasm-fork-instrument` on `PATH`. The compiler is currently built and
installed separately from the Kandelo images.

Zig emits LLVM bitcode in the guest and uses the SDK's Clang to lower it to
relocatable Wasm objects. The SDK archives `compiler_rt` and performs the
final executable link. Zig then prepares the executable for fork, including
the build runner that `zig build` starts. This path compiles Zig sources.
`zig cc` and Zig build steps that invoke bundled Clang require a full Zig
compiler. The Kandelo C/C++ SDK is available for separate C and C++ builds.

From a writable guest directory containing the files in [guest/smoke](guest/smoke),
compile and run the sample.

```bash
/opt/zig/bin/zig build-exe main.zig -femit-bin=main.wasm
./main.wasm
```

To exercise the project's `build.zig`, run the following from the same
directory. The first build compiles the runner and a configuration
executable inside the guest, which can take several minutes.

```bash
/opt/zig/bin/zig build -j1
./zig-out/bin/guest-zig-smoke.wasm
```

Keep Zig's global and project caches on guest filesystems when reusing a
Node host-mounted project across boots. Host mounts keep guest permission
changes in virtual metadata for the life of the mount, and Zig needs execute
permission on cached build helpers. A disposable build sandbox can use a
fresh project directory and `ZIG_GLOBAL_CACHE_DIR=/tmp/zig-cache`.
[POSIX support matrix](../../docs/posix-status.md)

To reproduce the project build with the Node guest-build runner, use a
`kandelo-build-image` artifact with the current guest SDK. Place the guest
fork instrumenter on the writable workspace mount if the image lacks it.

```bash
workspace=$(mktemp -d "$PWD/.scratch/guest-zig-smoke.XXXXXX")
cp sdk/zig/guest/smoke/*.zig "$workspace/"
cp /path/to/wasm-fork-instrument.wasm "$workspace/wasm-fork-instrument"
chmod +x "$workspace/wasm-fork-instrument"
npx tsx scripts/guest-build.ts \
  --kernel target/wasm32-unknown-unknown/release/kandelo_kernel.wasm \
  --image /path/to/kandelo-build-image.vfs.zst \
  --workspace "$workspace" --input "/opt/zig=$PWD/.scratch/guest-zig" \
  --env ZIG_GLOBAL_CACHE_DIR=/tmp/zig-cache --source-date-epoch 0 \
  --timeout-ms 900000 -- /bin/bash -ec \
  'export PATH=/opt/zig/bin:/build:$PATH; zig build -j1; ./zig-out/bin/guest-zig-smoke.wasm'
```

Both `zig build-exe` and `zig build` compiled and ran the sample on Node and
Chromium. The executable printed `zig build inside Kandelo passed` and
exited with status 0 in each case. A second `zig build` in the same Node
guest also built and ran the sample successfully.

The checked-in smoke suite runs both hosts from the same fixture image and
checks that Zig reuses cached objects and archives until the SDK identity
changes. Prepare it from a `kandelo-build-image` artifact in the dev shell.
For an older build image, pass a current guest `kandelo-cc.wasm` as the
optional fifth argument.

```bash
npx tsx sdk/zig/guest/prepare-smoke-image.ts \
  /path/to/kandelo-build-image.vfs.zst .scratch/guest-zig \
  /path/to/wasm-fork-instrument.wasm .scratch/guest-zig-smoke.vfs
zstd -1 -f .scratch/guest-zig-smoke.vfs
KANDELO_ZIG_GUEST_IMAGE="$PWD/.scratch/guest-zig-smoke.vfs.zst" \
  npx --prefix apps/browser-demos playwright test \
  -c sdk/zig/guest/playwright.config.ts --project=chromium
```

## Testing the zigcli port

```bash
./run.sh partial shell zigcli zigcli-docs mandoc-browser-bundle --with-tests

export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/partial-image.test.ts'
KANDELO_ZIGCLI_PARTIAL_IMAGE=1 npx --prefix apps/browser-demos playwright test \
  -c apps/browser-demos/playwright.config.ts zigcli-shell.spec.ts --project=chromium
```

The partial-image tests run `tree`, `loc` and `hexdump` over the same
three-line Zig source fixture. Node renders all three manuals. Chromium
looks up their paths through the shell's `man` command.
