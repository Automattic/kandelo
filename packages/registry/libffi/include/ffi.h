/*
 * ffi.h — full libffi API for wasm32-posix-kernel (PR20).
 *
 * This is a from-scratch libffi for a target that cannot generate code
 * at runtime. `ffi_call` classifies every argument and the return into
 * the wasm32 C ABI's word classes (i32/i64/f32/f64; by-value
 * non-singleton structs become a pointer to a caller-owned copy, struct
 * returns become a hidden leading sret pointer) and dispatches through
 * a compile-time-generated `switch` of `call_indirect` shapes.
 * `ffi_closure` hands out entries from a compile-time-generated static
 * trampoline pool — N real C functions per signature class, each baked
 * into the function table — the pattern emscripten's libffi port proved
 * viable where JIT-written trampolines are impossible. See
 * packages/registry/libffi/gen-dispatch.sh (the generator) and
 * src/ffi_core.c (classification, marshalling, pool bookkeeping).
 *
 * ABI note: `ffi_cif` deliberately carries NO port-private fields.
 * Consumers (libwayland) embed `ffi_cif` by value, so growing it would
 * corrupt any archive built against the older layout. Everything the
 * dispatch needs is recomputed per call from rtype/arg_types.
 *
 * Deliberately absent: long double (no `ffi_type_longdouble`), complex
 * types, raw/java APIs, `ffi_prep_closure` (the deprecated pre-alloc
 * variant). `ffi_prep_closure_loc` must be called while the `code`
 * out-pointer from `ffi_closure_alloc` is still live: the trampoline is
 * chosen once the signature is known, and prep rebinds `*code` through
 * the pointer captured at alloc (the universal alloc-then-prep idiom).
 */
#ifndef KANDELO_FFI_H
#define KANDELO_FFI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Widest single integral argument / return word. Integral returns
 * narrower than ffi_arg are widened to a full ffi_arg by ffi_call
 * (signed types sign-extend), per the libffi contract.
 */
typedef unsigned long ffi_arg;
typedef signed long ffi_sarg;

/* Maximum arity. WL_CLOSURE_MAX_ARGS is 20; wl_closure_invoke prepends
 * `data` + `target`, so 22 is the ceiling. */
#define FFI_SHIM_MAX_ARGS 22
#define FFI_MAX_ARGS FFI_SHIM_MAX_ARGS

typedef enum {
    FFI_OK = 0,
    FFI_BAD_TYPEDEF,
    FFI_BAD_ABI,
    FFI_BAD_ARGTYPE
} ffi_status;

/* Only one ABI on wasm32. */
typedef enum {
    FFI_FIRST_ABI = 0,
    FFI_DEFAULT_ABI,
    FFI_LAST_ABI
} ffi_abi;

/*
 * ffi_type — layout mirrors real libffi. For FFI_TYPE_STRUCT the caller
 * provides `elements` (NULL-terminated) and ffi_prep_cif fills in
 * `size` and `alignment`.
 */
typedef struct _ffi_type {
    size_t size;
    unsigned short alignment;
    unsigned short type;
    struct _ffi_type **elements;
} ffi_type;

/* real libffi's FFI_TYPE_* tags */
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
#define FFI_TYPE_STRUCT  13
#define FFI_TYPE_POINTER 14

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

typedef struct {
    ffi_abi abi;
    unsigned int nargs;
    ffi_type *rtype;
    ffi_type **arg_types;
} ffi_cif;

ffi_status ffi_prep_cif(ffi_cif *cif, ffi_abi abi, unsigned int nargs,
                        ffi_type *rtype, ffi_type **atypes);

ffi_status ffi_prep_cif_var(ffi_cif *cif, ffi_abi abi, unsigned int nfixedargs,
                            unsigned int ntotalargs, ffi_type *rtype,
                            ffi_type **atypes);

void ffi_call(ffi_cif *cif, void (*fn)(void), void *rvalue, void **avalue);

/* ---- closures over the static trampoline pool ---- */

#define FFI_CLOSURES 1

typedef struct {
    void *tramp;
    ffi_cif *cif;
    void (*fun)(ffi_cif *, void *, void **, void *);
    void *user_data;
    int32_t slot;
    void **code_out;
} ffi_closure;

void *ffi_closure_alloc(size_t size, void **code);
void ffi_closure_free(void *closure);

ffi_status ffi_prep_closure_loc(ffi_closure *closure, ffi_cif *cif,
                                void (*fun)(ffi_cif *, void *, void **,
                                            void *),
                                void *user_data, void *codeloc);

#ifdef __cplusplus
}
#endif

#endif /* KANDELO_FFI_H */
