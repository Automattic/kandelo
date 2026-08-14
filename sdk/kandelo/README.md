# Kandelo-Native SDK Wrappers

These scripts are the in-session SDK contract installed by the Homebrew
`kandelo-sdk` Formula. User-facing command links live in
`/opt/kandelo/homebrew/bin`; the wrappers and SDK payload remain under stable
Formula-owned prefixes so they do not depend on the shell's installation path.

They assume the compiler package installs LLVM tools here:

```text
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/clang
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/clang++
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/wasm-ld
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/llvm-ar
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/llvm-ranlib
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/llvm-nm
```

and SDK data here:

```text
/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix/sysroot
/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix/glue
/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix/glue-objects
/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix/config.site
/opt/kandelo/homebrew/opt/libcxx/include/c++/v1
/opt/kandelo/homebrew/opt/libcxx/lib
```

The overrides intentionally mirror the host SDK:

```sh
WASM_POSIX_LLVM_DIR=/custom/llvm
WASM_POSIX_SYSROOT=/custom/sysroot
WASM_POSIX_GLUE_DIR=/custom/glue
WASM_POSIX_GLUE_OBJ_DIR=/custom/glue-objects
WASM_POSIX_CLANG_RESOURCE_DIR=/custom/llvm/lib/clang/21
WASM_POSIX_LIBCXX_DIR=/custom/libcxx
```

`WASM_POSIX_LLVM_DIR` names the LLVM root containing `bin/`, not the `bin/`
directory itself. These six variables are the supported relocation/testing
overrides. The compatibility paths `/usr/lib/llvm` and `/usr/wasm32posix` may
exist in older images, but the wrappers never use them as defaults.

The wrappers are deliberately shell-based for the first milestone because the
kernel workers already resolve shebang scripts. If argument handling becomes
too complex, these can be replaced by a small C or Rust command driver without
changing the VFS contract.
