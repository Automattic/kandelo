#!/usr/bin/env bash
#
# gen-dispatch.sh <out-dir> — generate the two combinatorial TUs of the
# full libffi port (see src/ffi_internal.h for the shared key encoding):
#
#   ffi_dispatch.c      the ffi_call signature switch. Emitted families:
#                       every signature of arity <= 8 with at most two
#                       non-i32 arguments (glib generic-marshal calls are
#                       instance + params + data, pointers all being i32
#                       words on wasm32; two doubles/i64s covers the
#                       gesture-style tails), plus all-i32 signatures up
#                       to arity 22 (the Wayland ceiling), each times the
#                       five return classes. An un-emitted signature
#                       makes ffi_call abort printing its key — extend a
#                       family bound here and rebuild.
#
#                       The switch is split into one function per
#                       (return class, arity): a single function holding
#                       all 4435 cases compiles to a ~275 KB wasm
#                       function, and V8 aborts the whole process with
#                       "Fatal process out of memory: Zone" when its
#                       optimizing tier compiles it. The key low byte is
#                       rc + nargs * 8, so the router indexes a function
#                       pointer table with key & 0xff and each leaf
#                       stays <= 277 cases. The table (not a switch of
#                       direct calls) is load-bearing: the clang driver
#                       runs wasm-opt -O2 post-link when binaryen is on
#                       PATH, and binaryen re-inlines single-caller
#                       functions of any size — noinline does not
#                       survive into the wasm. An indirect call through
#                       a dynamic index is the one shape neither LLVM
#                       nor binaryen can fuse back together.
#
#   ffi_closure_pool.c  the static closure trampoline pool: per class a
#                       dispatcher plus K real C functions baked into
#                       the function table. K is generous for the
#                       all-i32 classes gobject leans on and small for
#                       the float/i64-bearing tails; ffi_prep_closure_loc
#                       aborts naming the class when a pool runs dry.
#
# Families are wider on the closure side for all-i32 arity (0..8) and
# narrower for pairs (arity <= 4): a closure class costs K+1 functions
# while a call case costs one switch line.
#
# Deliberately dependency-free (bash + awk): the build runs inside the
# nix dev shell and the native vitest leg runs on developer hosts.

set -euo pipefail

OUT="${1:?usage: gen-dispatch.sh <out-dir>}"
mkdir -p "$OUT"

awk -v out="$OUT" '
function ctype(c) { return c == 0 ? "uint32_t" : c == 1 ? "uint64_t" : c == 2 ? "float" : "double" }
function cfield(c) { return c == 0 ? "w_i32" : c == 1 ? "w_i64" : c == 2 ? "w_f32" : "w_f64" }
function rtype(rc) { return rc == 1 ? "uint32_t" : rc == 2 ? "uint64_t" : rc == 3 ? "float" : "double" }
function rfield(rc) { return rc == 1 ? "w_i32" : rc == 2 ? "w_i64" : rc == 3 ? "w_f32" : "w_f64" }

function keyof(rc, n, cls,    k, i) {
    k = rc + n * 8
    for (i = 0; i < n; i++)
        k += cls[i] * (2 ^ (8 + 2 * i))
    return sprintf("%.0f", k)
}

function reset(n, cls,    i) { for (i = 0; i < n; i++) cls[i] = 0 }

function emit_case(rc, n, cls,    key, sig, args, i) {
    key = keyof(rc, n, cls)
    sig = ""; args = ""
    for (i = 0; i < n; i++) {
        sig = sig (i ? ", " : "") ctype(cls[i])
        args = args (i ? ", " : "") "a[" i "]." cfield(cls[i])
    }
    if (n == 0) sig = "void"
    if (rc == 0)
        body = body sprintf("    case %sULL: ((void (*)(%s)) fn)(%s); return 0;\n", key, sig, args)
    else
        body = body sprintf("    case %sULL: r->%s = ((%s (*)(%s)) fn)(%s); return 0;\n", key, rfield(rc), rtype(rc), sig, args)
}

function emit_leaf(rc, n) {
    printf "static int d_%d_%d(uint64_t key, void (*fn)(void),\n                    const union ffi_word *a, union ffi_word *r)\n{\n    (void) a;\n    (void) r;\n    switch (key) {\n%s    default:\n        return -1;\n    }\n}\n\n", rc, n, body > DF
    routes = routes sprintf("    [%d] = d_%d_%d,\n", rc + n * 8, rc, n)
    body = ""
}

function emit_class(rc, n, cls, slots,    id, key, sig, pack, fwd, dim, i, j) {
    id = nclasses++
    key = keyof(rc, n, cls)
    sig = "uint32_t slot"; pack = ""; fwd = ""
    for (i = 0; i < n; i++) {
        sig = sig ", " ctype(cls[i]) " a" i
        pack = pack sprintf("    argv[%d].%s = a%d;\n", i, cfield(cls[i]), i)
        fwd = fwd ", a" i
    }
    dim = n > 0 ? n : 1
    if (rc == 0) {
        printf "static void cd_%d(%s)\n{\n    union ffi_word argv[%d];\n    union ffi_word ret;\n%s    ffi_wasm_closure_invoke(slot, argv, &ret);\n}\n\n", id, sig, dim, pack > CF
    } else {
        printf "static %s cd_%d(%s)\n{\n    union ffi_word argv[%d];\n    union ffi_word ret;\n%s    ffi_wasm_closure_invoke(slot, argv, &ret);\n    return ret.%s;\n}\n\n", rtype(rc), id, sig, dim, pack, rfield(rc) > CF
    }
    for (j = 0; j < slots; j++) {
        sig = ""
        for (i = 0; i < n; i++)
            sig = sig (i ? ", " : "") ctype(cls[i]) " a" i
        if (n == 0) sig = "void"
        if (rc == 0)
            printf "static void ct_%d_%d(%s) { cd_%d(%d%s); }\n", id, j, sig, id, total + j, fwd > CF
        else
            printf "static %s ct_%d_%d(%s) { return cd_%d(%d%s); }\n", rtype(rc), id, j, sig, id, total + j, fwd > CF
    }
    printf "static void *const ctab_%d[] = {", id > CF
    for (j = 0; j < slots; j++)
        printf "%s (void *) ct_%d_%d", (j ? "," : ""), id, j > CF
    printf " };\n\n" > CF
    rows = rows sprintf("    { %sULL, %d, %d, ctab_%d },\n", key, total, slots, id)
    total += slots
}

BEGIN {
    DF = out "/ffi_dispatch.c"
    CF = out "/ffi_closure_pool.c"

    printf "/* Generated by packages/registry/libffi/gen-dispatch.sh — do not edit. */\n#include \"ffi_internal.h\"\n\n" > DF

    body = ""; routes = ""
    for (rc = 0; rc <= 4; rc++) {
        for (n = 0; n <= 8; n++) {
            reset(n, cls)
            emit_case(rc, n, cls)
            for (p = 0; p < n; p++)
                for (c = 1; c <= 3; c++) {
                    reset(n, cls); cls[p] = c
                    emit_case(rc, n, cls)
                }
            for (p1 = 0; p1 < n; p1++)
                for (p2 = p1 + 1; p2 < n; p2++)
                    for (c1 = 1; c1 <= 3; c1++)
                        for (c2 = 1; c2 <= 3; c2++) {
                            reset(n, cls); cls[p1] = c1; cls[p2] = c2
                            emit_case(rc, n, cls)
                        }
            emit_leaf(rc, n)
        }
        for (n = 9; n <= 22; n++) {
            reset(n, cls)
            emit_case(rc, n, cls)
            emit_leaf(rc, n)
        }
    }

    printf "static int (*const ffi_dispatch_route[181])(uint64_t, void (*)(void),\n                                             const union ffi_word *, union ffi_word *) = {\n%s};\n\nint ffi_wasm_dispatch_call(uint64_t key, void (*fn)(void),\n                           const union ffi_word *a, union ffi_word *r)\n{\n    uint32_t route = (uint32_t) (key & 0xff);\n    if (route > 180 || !ffi_dispatch_route[route]) return -1;\n    return ffi_dispatch_route[route](key, fn, a, r);\n}\n", routes > DF

    printf "/* Generated by packages/registry/libffi/gen-dispatch.sh — do not edit. */\n#include \"ffi_internal.h\"\n\n" > CF

    nclasses = 0; total = 0; rows = ""
    for (rc = 0; rc <= 4; rc++) {
        for (n = 0; n <= 8; n++) {
            reset(n, cls)
            emit_class(rc, n, cls, 24)
        }
        for (n = 1; n <= 6; n++)
            for (p = 0; p < n; p++)
                for (c = 1; c <= 3; c++) {
                    reset(n, cls); cls[p] = c
                    emit_class(rc, n, cls, 4)
                }
        for (n = 2; n <= 4; n++)
            for (p1 = 0; p1 < n; p1++)
                for (p2 = p1 + 1; p2 < n; p2++)
                    for (c1 = 1; c1 <= 3; c1++)
                        for (c2 = 1; c2 <= 3; c2++) {
                            reset(n, cls); cls[p1] = c1; cls[p2] = c2
                            emit_class(rc, n, cls, 2)
                        }
    }

    printf "const struct ffi_closure_class ffi_closure_classes[] = {\n%s};\n\nconst uint32_t ffi_closure_class_count = %d;\n\nffi_closure *ffi_closure_slot_owner[%d];\nconst uint32_t ffi_closure_slot_count = %d;\n", rows, nclasses, total, total > CF
}
' /dev/null

echo "gen-dispatch: $(grep -c 'ULL: ' "$OUT/ffi_dispatch.c") call cases," \
     "$(grep -c '^static void \*const ctab_' "$OUT/ffi_closure_pool.c") closure classes"
