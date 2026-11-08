# Wasm unwinder source selection

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
