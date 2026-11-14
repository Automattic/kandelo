# libcxx package patches

The recipe applies these patches, in order, to private writable copies of
the Nix-provided `libcxx` and `libunwind` sources. The Nix derivations and
the checkout are never modified.

## Wasm unwinder source selection

`0001-select-wasm-unwind-sources.patch` selects libunwind's existing Wasm
exception-handling implementation without hardware register assembly when
CMake targets wasm32 or wasm64. `Unwind-wasm.c` delegates stack unwinding to
the VM. `UnwindRegistersSave.S` and `UnwindRegistersRestore.S` instead include
`assembly.h`, whose object-format branches reject Wasm as an unsupported
target; they provide no Wasm register-save implementation.

The previous recipe left assembly compiler settings unset, so those files
compiled as native host objects and entered the Wasm archives. wasm-ld
warned and ignored them. This patch omits the inapplicable source files;
it does not add stub functions or change the VM unwinder. Hardware targets
retain their original assembly sources. The recipe also sets explicit ASM
compiler/target/flags and checks every static/PIC archive member's format
and address width before publishing.

## musl locale support

`0002-select-musl-locale-support.patch` selects libc++'s
`__locale_dir/support/linux.h` locale backend when `_LIBCPP_HAS_MUSL_LIBC`
is set, not only when `__linux__` is defined. libc++ 23 removed the
`locale_base_api/musl.h` shim that LLVM 21 used for musl on non-Linux
targets. Without this patch Kandelo falls through to the IBM shim, whose
inline `strtod_l`/`strtof_l`/`strtold_l`/`vasprintf` definitions conflict
with musl's declarations, and libc++ does not compile. The selected backend
calls POSIX.1-2008 locale functions (including `wcsnrtombs`, `mbsnrtowcs`
and `nl_langinfo_l`), the GNU extensions `strtod_l`, `strtof_l` and
`strtold_l`, and `vasprintf` (GNU/BSD, standardized in POSIX.1-2024).
Kandelo's musl provides all of them. It is not yet proposed upstream.
The patch keys on the libc capability libc++ already records; it does not
define `__linux__` or make Kandelo a Linux target. Because the patched
header is installed, C++ consumers see the same selection.
