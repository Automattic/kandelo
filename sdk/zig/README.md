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
