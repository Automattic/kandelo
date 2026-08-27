# host-native test fixtures

## `native_hello.wasm`

The trivial guest the native Wasmtime host runs end-to-end in
`smoke_runs_trivial_guest_through_channel` (see `../src/guest.rs`). Source:
`native_hello.c`.

It is built through the SDK toolchain with the **same** compile/link recipe
`scripts/build-programs.sh` uses for the example C programs — same `CFLAGS`,
the channel syscall glue, `compiler_rt.c`, `crt1.o`, and `libc.a`. A
non-forking standalone program is returned byte-for-byte unchanged by
`wasm-fork-instrument`, so the raw linker output is committed directly (no
fork instrumentation step).

The committed `.wasm` is checked in so the test needs only a built
`kernel.wasm`, not a full guest-program build. Regenerate it from within the
dev shell (`scripts/dev-shell.sh`) whenever `native_hello.c`, the libc glue, or
the ABI changes:

```sh
# From the repo root, inside scripts/dev-shell.sh. SYSROOT must be a sysroot
# built for the current ABI (this branch's libc). $LLVM_BIN is set by the shell.
SYSROOT=<repo>/sysroot
GLUE=<repo>/libc/glue
OUT=crates/host-native/fixtures

"$LLVM_BIN/clang" \
  --target=wasm32-unknown-unknown --sysroot="$SYSROOT" -nostdlib -O2 \
  -matomics -mbulk-memory -fno-trapping-math \
  -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false \
  "$OUT/native_hello.c" \
  "$GLUE/channel_syscall.c" "$GLUE/compiler_rt.c" "$SYSROOT/lib/crt1.o" \
  "$SYSROOT/lib/libc.a" \
  -Wl,--no-entry -Wl,--export=_start -Wl,--import-memory -Wl,--shared-memory \
  -Wl,--max-memory=1073741824 -Wl,--allow-undefined -Wl,--table-base=3 \
  -Wl,--export-table -Wl,--growable-table \
  -Wl,--export=__wasm_init_tls -Wl,--export=__tls_base -Wl,--export=__tls_size \
  -Wl,--export=__tls_align -Wl,--export=__stack_pointer \
  -Wl,--export=__wasm_thread_init -Wl,--export=__abi_version \
  -o "$OUT/native_hello.wasm"
```

The program's `__abi_version` export must match the kernel's ABI (the host
asserts this at load), so a stale fixture built for an older ABI fails loudly
rather than running wrong.
