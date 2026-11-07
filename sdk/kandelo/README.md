# Kandelo guest SDK

The Rust `kandelo-cc` driver is installed in `/usr/bin` by the
`kandelo-sdk` package, with command-name symlinks for the SDK tools.

They assume the compiler package installs LLVM tools here:

```text
/usr/lib/llvm/bin/clang
/usr/lib/llvm/bin/clang++
/usr/lib/llvm/bin/wasm-ld
/usr/lib/llvm/bin/llvm-ar
/usr/lib/llvm/bin/llvm-ranlib
/usr/lib/llvm/bin/llvm-nm
```

and SDK data here:

```text
/usr/lib/kandelo/wasm32posix/sysroot
/usr/lib/kandelo/wasm32posix/glue
/usr/lib/kandelo/wasm32posix/config.site
```

The overrides intentionally mirror the host SDK:

```sh
WASM_POSIX_LLVM_DIR=/usr/lib/llvm/bin
WASM_POSIX_SYSROOT=/usr/lib/kandelo/wasm32posix/sysroot
WASM_POSIX_GLUE_DIR=/usr/lib/kandelo/wasm32posix/glue
```

The driver shares argument handling with the build-machine SDK. Its guest
resource discovery uses these installed paths; the filesystem layout follows
[the image policy](../../docs/filesystem-layout.md).
