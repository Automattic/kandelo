/*
 * ffi_shim.c — Wayland-scoped libffi shim. See include/ffi.h for the
 * rationale and docs/plans/2026-07-08-dri-wayland-compositor-plan.md §4.
 *
 * `ffi_call` reads `cif->nargs` 32-bit words from `avalue` and calls
 * `fn` through a function-pointer type of matching i32 arity. On wasm32
 * each such call lowers to `call_indirect` against the program's
 * function table — the exact mechanism `wl_closure_invoke` relies on.
 * The invoked function returns void (the only shape Wayland uses).
 */
#include <ffi.h>

#include <stdlib.h> /* abort */

/*
 * Type globals. The shim never dispatches on these — every Wayland wire
 * argument is one i32 word regardless of type — but callers may read
 * `.size`/`.type`, so give each a plausible value. `elements` is NULL
 * for all non-aggregate types.
 */
#define DEF_TYPE(sym, sz, al, tag) \
    ffi_type sym = { (sz), (al), (tag), NULL }

DEF_TYPE(ffi_type_void,    1, 1, FFI_TYPE_VOID);
DEF_TYPE(ffi_type_uint8,   1, 1, FFI_TYPE_UINT8);
DEF_TYPE(ffi_type_sint8,   1, 1, FFI_TYPE_SINT8);
DEF_TYPE(ffi_type_uint16,  2, 2, FFI_TYPE_UINT16);
DEF_TYPE(ffi_type_sint16,  2, 2, FFI_TYPE_SINT16);
DEF_TYPE(ffi_type_uint32,  4, 4, FFI_TYPE_UINT32);
DEF_TYPE(ffi_type_sint32,  4, 4, FFI_TYPE_SINT32);
DEF_TYPE(ffi_type_uint64,  8, 8, FFI_TYPE_UINT64);
DEF_TYPE(ffi_type_sint64,  8, 8, FFI_TYPE_SINT64);
/* wasm32 (ILP32): int/uint = 4, long/ulong = 4, pointer = 4 */
DEF_TYPE(ffi_type_uint,    4, 4, FFI_TYPE_UINT32);
DEF_TYPE(ffi_type_sint,    4, 4, FFI_TYPE_SINT32);
DEF_TYPE(ffi_type_ulong,   4, 4, FFI_TYPE_UINT32);
DEF_TYPE(ffi_type_slong,   4, 4, FFI_TYPE_SINT32);
DEF_TYPE(ffi_type_float,   4, 4, FFI_TYPE_FLOAT);
DEF_TYPE(ffi_type_double,  8, 8, FFI_TYPE_DOUBLE);
DEF_TYPE(ffi_type_pointer, 4, 4, FFI_TYPE_POINTER);

#undef DEF_TYPE

ffi_status ffi_prep_cif(ffi_cif *cif, ffi_abi abi, unsigned int nargs,
                        ffi_type *rtype, ffi_type **atypes)
{
    if (cif == NULL)
        return FFI_BAD_TYPEDEF;
    if (nargs > FFI_SHIM_MAX_ARGS)
        return FFI_BAD_ARGTYPE; /* beyond WL_CLOSURE_MAX_ARGS+2 */

    cif->abi = abi;
    cif->nargs = nargs;
    cif->rtype = rtype;
    cif->arg_types = atypes;
    return FFI_OK;
}

ffi_status ffi_prep_cif_var(ffi_cif *cif, ffi_abi abi,
                            unsigned int nfixedargs, unsigned int ntotalargs,
                            ffi_type *rtype, ffi_type **atypes)
{
    (void) nfixedargs;
    return ffi_prep_cif(cif, abi, ntotalargs, rtype, atypes);
}

void ffi_call(ffi_cif *cif, void (*fn)(void), void *rvalue, void **avalue)
{
    /* Wayland's invoked functions return void; nothing is written back. */
    (void) rvalue;

    unsigned int n = cif->nargs;
    uint32_t a[FFI_SHIM_MAX_ARGS];

    /* avalue[i] points at the i-th argument value; each is one i32 word. */
    for (unsigned int i = 0; i < n; i++)
        a[i] = *(uint32_t *) avalue[i];

    /*
     * Arity dispatch. Each case casts `fn` to a `(uint32_t, ...) -> void`
     * pointer of matching width and calls it; on wasm32 this is a
     * `call_indirect` with the corresponding type signature. Generated
     * for arities 0..FFI_SHIM_MAX_ARGS.
     */
    switch (n) {
    case 0:  ((void (*)(void)) fn)(); break;
    case  1: ((void (*)(uint32_t)) fn)(a[0]); break;
    case  2: ((void (*)(uint32_t,uint32_t)) fn)(a[0],a[1]); break;
    case  3: ((void (*)(uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2]); break;
    case  4: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3]); break;
    case  5: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4]); break;
    case  6: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5]); break;
    case  7: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6]); break;
    case  8: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7]); break;
    case  9: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8]); break;
    case 10: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9]); break;
    case 11: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10]); break;
    case 12: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11]); break;
    case 13: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12]); break;
    case 14: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13]); break;
    case 15: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14]); break;
    case 16: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],a[15]); break;
    case 17: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],a[15],a[16]); break;
    case 18: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],a[15],a[16],a[17]); break;
    case 19: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],a[15],a[16],a[17],a[18]); break;
    case 20: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],a[15],a[16],a[17],a[18],a[19]); break;
    case 21: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],a[15],a[16],a[17],a[18],a[19],a[20]); break;
    case 22: ((void (*)(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t)) fn)(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],a[15],a[16],a[17],a[18],a[19],a[20],a[21]); break;
    default:
        /* ffi_prep_cif rejects nargs > FFI_SHIM_MAX_ARGS, so this is
         * unreachable unless a caller hand-builds a cif. Fail loudly
         * rather than silently skip the dispatch. */
        abort();
    }
}
