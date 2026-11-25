# Process-owned lookup prototype

The linker patch targets wasm-ld 23.1.3. On a private copy of the
LLVM 23.1.3 LLD source tree under `.scratch/llvm-dynsym`, apply the
repository's wasm-only driver patch and the prototype patch. The tree
needs the LLD sources and the sibling LLVM CMake utilities. Use the
LLVM libraries from the dev shell and matching `llvm-tblgen`.

```sh
patch -p1 -d .scratch/llvm-dynsym < packages/registry/clang/patches/0003-wasm-only-lld-driver.patch
patch -p1 -d .scratch/llvm-dynsym < sdk/lld/0001-kandelo-dynamic-symbol-index.patch
scripts/dev-shell.sh bash -c '
  cmake -G Ninja -S .scratch/llvm-dynsym/lld -B .scratch/llvm-dynsym/build \
    -DCMAKE_BUILD_TYPE=Release -DLLVM_DIR="$KANDELO_LLVM_DEV/lib/cmake/llvm" \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_TABLEGEN_EXE="$1"
  cmake --build .scratch/llvm-dynsym/build --target lld -j 6
' bash /absolute/path/to/matching/llvm-tblgen
scripts/dev-shell.sh bash sdk/lld/build-prototype-fixtures.sh
```

Build the repository's normal kernel and image-writer prerequisites.
Install the host and browser test dependencies. Run the opt-in fixture
tests through the dev shell so the test runner can reproduce the frozen
program baseline with its own compiler.

```sh
scripts/dev-shell.sh bash -c '
  export KANDELO_PROCESS_DYNSYM_PROTOTYPE=1
  cd host
  npx vitest run test/process-dynsym.prototype.test.ts
'
scripts/dev-shell.sh bash -c '
  export KANDELO_PROCESS_DYNSYM_PROTOTYPE=1
  cd apps/browser-demos
  npx playwright test test/process-dynsym.prototype.spec.ts --project=chromium --workers=1
'
```

The fixture links the experimental libc entry points explicitly.
The map extension currently accepts one instrumented wasm32 side module
with no NEEDED objects or TLS exports. Its application imports can bind
to executable functions and data, including GOT function and data
addresses. The guest owns the references and
lookup scopes. The adapter uses the existing archive for engine mapping
and activation reconstruction. Final close withdraws the guest handle.
The prototype retains the instance until process exit. This path has no
in-guest wasm-ld build and has yet to establish package compatibility,
general constructor/finalizer semantics, and pthread loader behavior.
