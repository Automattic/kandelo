# Kandelo dynamic symbol index

The dev shell and the in-guest Clang package apply the same wasm-ld 23.1.3
patch. The SDK links the libc loader on demand and asks wasm-ld to emit
the side module index for shared builds. The linker uses the final
export set to assign canonical slots and write the executable's index
in one pass. Raw side-module links can request the format with
`--kandelo-side-dynsym`.

Build the kernel, image writer and core sysroot for the target. Then
build the runtime fixtures with the normal SDK and run the focused suites.

```sh
scripts/dev-shell.sh bash sdk/lld/build-prototype-fixtures.sh
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

Pass `wasm64posix` to the build script and set
`KANDELO_LOADER_FIXTURE_ARCH=wasm64posix` inside each test command to select
the memory64 fixtures. To include the compatibility arm, set
`KANDELO_ABI56_LOADER_FIXTURE` to the directory containing the retained
`plugin-host.wasm` and `plugin.so` from the legacy synthetic comparison.
