/*
 * ffi.h — Wayland-scoped libffi shim for wasm32-posix-kernel.
 *
 * This is NOT a full libffi. It is a deliberately tiny substitute that
 * covers the *only* way libwayland uses libffi: `wl_closure_invoke`
 * (and its dispatch sibling) calling a listener/implementation function
 * with a decoded message's arguments.
 *
 * On wasm32 every Wayland wire argument — int, uint, wl_fixed_t,
 * new_id, object pointer, char* string, wl_array*, fd int — is a single
 * 32-bit word, and the invoked function returns void. There are no
 * doubles and no by-value structs anywhere in the Wayland ABI. So the
 * shim ignores libffi's type machinery entirely: `ffi_prep_cif` records
 * only the argument *count*, and `ffi_call` reads that many i32 words
 * and dispatches through a `switch` over arity. Each case is a
 * function-pointer call of a distinct `(i32, ...) -> ()` signature,
 * which the LLVM wasm backend lowers to `call_indirect` against the
 * program's function table — exactly what real libffi provides here,
 * minus everything Wayland never exercises.
 *
 * Full libffi (doubles, by-value structs, ffi_closure trampolines) is
 * deferred to the glib/gobject tail (post-v1). See
 * docs/plans/2026-07-08-dri-wayland-compositor-plan.md §4.
 *
 * The public surface below is a subset of the real <ffi.h> ABI, chosen
 * so that an unmodified libwayland `#include <ffi.h>` compiles and links
 * against this shim. libwayland treats `ffi_cif` as opaque (it only
 * takes its address) and only references the `ffi_type_*` globals by
 * address, so the exact struct layouts here need not match any real
 * libffi build — only this shim consumes them.
 */
#ifndef KANDELO_FFI_SHIM_H
#define KANDELO_FFI_SHIM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Widest single argument / return word. On wasm32 (ILP32) this is a
 * 32-bit register; real libffi uses `unsigned long` for `ffi_arg`.
 */
typedef unsigned long ffi_arg;
typedef signed long ffi_sarg;

/* Maximum arity the shim dispatches. WL_CLOSURE_MAX_ARGS is 20;
 * wl_closure_invoke prepends `data` + `target`, so 22 is the ceiling. */
#define FFI_SHIM_MAX_ARGS 22

typedef enum {
    FFI_OK = 0,
    FFI_BAD_TYPEDEF,
    FFI_BAD_ABI,
    FFI_BAD_ARGTYPE
} ffi_status;

/* Only one ABI on wasm32; the value is never inspected by the shim. */
typedef enum {
    FFI_FIRST_ABI = 0,
    FFI_DEFAULT_ABI,
    FFI_LAST_ABI
} ffi_abi;

/*
 * ffi_type — layout mirrors real libffi so that callers taking the
 * address of `ffi_type_*` and reading `.size` / `.type` stay valid,
 * even though the shim itself never dispatches on these fields.
 */
typedef struct _ffi_type {
    size_t size;
    unsigned short alignment;
    unsigned short type;
    struct _ffi_type **elements;
} ffi_type;

/* real libffi's FFI_TYPE_* tags for the globals we expose */
#define FFI_TYPE_VOID    0
#define FFI_TYPE_INT     1
#define FFI_TYPE_FLOAT   2
#define FFI_TYPE_DOUBLE  3
#define FFI_TYPE_UINT8   5
#define FFI_TYPE_SINT8   6
#define FFI_TYPE_UINT16  7
#define FFI_TYPE_SINT16  8
#define FFI_TYPE_UINT32  9
#define FFI_TYPE_SINT32  10
#define FFI_TYPE_UINT64  11
#define FFI_TYPE_SINT64  12
#define FFI_TYPE_POINTER 14

/*
 * The type globals libwayland references when mapping wire types. All
 * Wayland wire types collapse to a 32-bit word, but the full common set
 * is exposed so any consumer's `<ffi.h>` expectations resolve.
 */
extern ffi_type ffi_type_void;
extern ffi_type ffi_type_uint8;
extern ffi_type ffi_type_sint8;
extern ffi_type ffi_type_uint16;
extern ffi_type ffi_type_sint16;
extern ffi_type ffi_type_uint32;
extern ffi_type ffi_type_sint32;
extern ffi_type ffi_type_uint64;
extern ffi_type ffi_type_sint64;
extern ffi_type ffi_type_uint;
extern ffi_type ffi_type_sint;
extern ffi_type ffi_type_ulong;
extern ffi_type ffi_type_slong;
extern ffi_type ffi_type_float;
extern ffi_type ffi_type_double;
extern ffi_type ffi_type_pointer;

/*
 * ffi_cif — opaque to callers (they only pass `&cif`). The shim stores
 * the argument count recorded by `ffi_prep_cif`.
 */
typedef struct {
    ffi_abi abi;
    unsigned int nargs;
    ffi_type *rtype;
    ffi_type **arg_types;
} ffi_cif;

ffi_status ffi_prep_cif(ffi_cif *cif, ffi_abi abi, unsigned int nargs,
                        ffi_type *rtype, ffi_type **atypes);

/* variadic prep — libwayland does not use it, but expose for parity */
ffi_status ffi_prep_cif_var(ffi_cif *cif, ffi_abi abi, unsigned int nfixedargs,
                            unsigned int ntotalargs, ffi_type *rtype,
                            ffi_type **atypes);

void ffi_call(ffi_cif *cif, void (*fn)(void), void *rvalue, void **avalue);

#ifdef __cplusplus
}
#endif

#endif /* KANDELO_FFI_SHIM_H */
