# Kandelo-Native SDK Wrappers

These scripts are the first in-session SDK contract. They are intended to be
installed into a Kandelo VFS at `/usr/bin` by the `kandelo-sdk` package.

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
/usr/wasm32posix/sysroot
/usr/wasm32posix/glue
/usr/wasm32posix/config.site
```

The overrides intentionally mirror the host SDK:

```sh
WASM_POSIX_LLVM_DIR=/usr/lib/llvm/bin
WASM_POSIX_SYSROOT=/usr/wasm32posix/sysroot
WASM_POSIX_GLUE_DIR=/usr/wasm32posix/glue
```

The wrappers are deliberately shell-based for the first milestone because the
kernel workers already resolve shebang scripts. If argument handling becomes
too complex, these can be replaced by a small C or Rust command driver without
changing the VFS contract.
