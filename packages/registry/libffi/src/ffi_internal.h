/*
 * ffi_internal.h — the contract between the hand-written core
 * (ffi_core.c) and the generated dispatch + trampoline pool
 * (gen-dispatch.sh). Both sides compute the same signature key: the
 * return class in bits 0..2, the argument count in bits 3..7, and two
 * bits per argument class from bit 8 (so 22 args end at bit 51, inside
 * the double-exact range the awk generator can produce).
 *
 * A by-value non-singleton struct argument is a pointer word (the
 * wasm32 byval lowering); a non-singleton struct return is a leading
 * pointer word with return class VOID (the sret lowering). Pointers
 * classify per word size so the same core is correct on the native
 * test leg.
 */
#ifndef KANDELO_FFI_INTERNAL_H
#define KANDELO_FFI_INTERNAL_H

#include <ffi.h>
#include <stdint.h>

enum {
    FFI_CLS_I32 = 0,
    FFI_CLS_I64 = 1,
    FFI_CLS_F32 = 2,
    FFI_CLS_F64 = 3
};

enum {
    FFI_RET_VOID = 0,
    FFI_RET_I32 = 1,
    FFI_RET_I64 = 2,
    FFI_RET_F32 = 3,
    FFI_RET_F64 = 4
};

union ffi_word {
    uint32_t w_i32;
    uint64_t w_i64;
    float w_f32;
    double w_f64;
    uintptr_t w_ptr;
};

/* generated: the ffi_call signature switch; -1 = key not emitted */
int ffi_wasm_dispatch_call(uint64_t key, void (*fn)(void),
                           const union ffi_word *a, union ffi_word *r);

/* generated: one entry per closure signature class */
struct ffi_closure_class {
    uint64_t key;
    uint32_t base;
    uint32_t count;
    void *const *tramps;
};

extern const struct ffi_closure_class ffi_closure_classes[];
extern const uint32_t ffi_closure_class_count;
extern ffi_closure *ffi_closure_slot_owner[];
extern const uint32_t ffi_closure_slot_count;

/* core: called by every generated per-class dispatcher */
void ffi_wasm_closure_invoke(uint32_t slot, union ffi_word *argv,
                             union ffi_word *ret);

#endif /* KANDELO_FFI_INTERNAL_H */
