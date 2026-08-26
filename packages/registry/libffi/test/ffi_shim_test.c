/*
 * ffi_shim_test.c — native unit test proving the Wayland-scoped libffi
 * shim's arity dispatch. Compiled for the HOST (see
 * host/test/libffi-shim-unit.test.ts) and also link-clean for wasm32.
 *
 * What this proves: given N 32-bit argument words, `ffi_call` invokes an
 * N-ary function delivering every word to the correct parameter slot,
 * for every arity 0..FFI_SHIM_MAX_ARGS. On wasm32 each such call is a
 * `call_indirect` — the exact mechanism `wl_closure_invoke` uses — so a
 * correct arity+marshalling result here is the proof that libwayland's
 * closure dispatch will land arguments correctly.
 *
 * Every Wayland wire argument (int, uint, wl_fixed_t, new_id, object
 * pointer, char* string, wl_array*, fd) is a single 32-bit word on
 * wasm32, so testing with uint32 words faithfully models the real call.
 * We deliberately do NOT pass native 64-bit pointers: the shim reads one
 * i32 per arg by design (correct for its wasm32 target), which would
 * truncate an LP64 host pointer — that truncation is not a bug, it is
 * the wasm32 ABI the shim targets.
 */
#include <ffi.h>

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint32_t g_recorded[FFI_SHIM_MAX_ARGS];
static unsigned int g_count;

static void reset_record(void) {
    memset(g_recorded, 0, sizeof g_recorded);
    g_count = 0xFFFFu;
}

static void t0(void) {
    g_count = 0;
}

static void t1(uint32_t p0) {
    g_recorded[0] = p0;
    g_count = 1;
}

static void t2(uint32_t p0, uint32_t p1) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_count = 2;
}

static void t3(uint32_t p0, uint32_t p1, uint32_t p2) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_count = 3;
}

static void t4(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_count = 4;
}

static void t5(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_count = 5;
}

static void t6(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_count = 6;
}

static void t7(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_count = 7;
}

static void t8(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_count = 8;
}

static void t9(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_count = 9;
}

static void t10(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_count = 10;
}

static void t11(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_count = 11;
}

static void t12(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_count = 12;
}

static void t13(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_count = 13;
}

static void t14(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12, uint32_t p13) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_recorded[13] = p13;
    g_count = 14;
}

static void t15(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12, uint32_t p13, uint32_t p14) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_recorded[13] = p13;
    g_recorded[14] = p14;
    g_count = 15;
}

static void t16(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12, uint32_t p13, uint32_t p14, uint32_t p15) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_recorded[13] = p13;
    g_recorded[14] = p14;
    g_recorded[15] = p15;
    g_count = 16;
}

static void t17(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12, uint32_t p13, uint32_t p14, uint32_t p15, uint32_t p16) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_recorded[13] = p13;
    g_recorded[14] = p14;
    g_recorded[15] = p15;
    g_recorded[16] = p16;
    g_count = 17;
}

static void t18(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12, uint32_t p13, uint32_t p14, uint32_t p15, uint32_t p16, uint32_t p17) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_recorded[13] = p13;
    g_recorded[14] = p14;
    g_recorded[15] = p15;
    g_recorded[16] = p16;
    g_recorded[17] = p17;
    g_count = 18;
}

static void t19(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12, uint32_t p13, uint32_t p14, uint32_t p15, uint32_t p16, uint32_t p17, uint32_t p18) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_recorded[13] = p13;
    g_recorded[14] = p14;
    g_recorded[15] = p15;
    g_recorded[16] = p16;
    g_recorded[17] = p17;
    g_recorded[18] = p18;
    g_count = 19;
}

static void t20(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12, uint32_t p13, uint32_t p14, uint32_t p15, uint32_t p16, uint32_t p17, uint32_t p18, uint32_t p19) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_recorded[13] = p13;
    g_recorded[14] = p14;
    g_recorded[15] = p15;
    g_recorded[16] = p16;
    g_recorded[17] = p17;
    g_recorded[18] = p18;
    g_recorded[19] = p19;
    g_count = 20;
}

static void t21(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12, uint32_t p13, uint32_t p14, uint32_t p15, uint32_t p16, uint32_t p17, uint32_t p18, uint32_t p19, uint32_t p20) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_recorded[13] = p13;
    g_recorded[14] = p14;
    g_recorded[15] = p15;
    g_recorded[16] = p16;
    g_recorded[17] = p17;
    g_recorded[18] = p18;
    g_recorded[19] = p19;
    g_recorded[20] = p20;
    g_count = 21;
}

static void t22(uint32_t p0, uint32_t p1, uint32_t p2, uint32_t p3, uint32_t p4, uint32_t p5, uint32_t p6, uint32_t p7, uint32_t p8, uint32_t p9, uint32_t p10, uint32_t p11, uint32_t p12, uint32_t p13, uint32_t p14, uint32_t p15, uint32_t p16, uint32_t p17, uint32_t p18, uint32_t p19, uint32_t p20, uint32_t p21) {
    g_recorded[0] = p0;
    g_recorded[1] = p1;
    g_recorded[2] = p2;
    g_recorded[3] = p3;
    g_recorded[4] = p4;
    g_recorded[5] = p5;
    g_recorded[6] = p6;
    g_recorded[7] = p7;
    g_recorded[8] = p8;
    g_recorded[9] = p9;
    g_recorded[10] = p10;
    g_recorded[11] = p11;
    g_recorded[12] = p12;
    g_recorded[13] = p13;
    g_recorded[14] = p14;
    g_recorded[15] = p15;
    g_recorded[16] = p16;
    g_recorded[17] = p17;
    g_recorded[18] = p18;
    g_recorded[19] = p19;
    g_recorded[20] = p20;
    g_recorded[21] = p21;
    g_count = 22;
}


static void (*const targets[FFI_SHIM_MAX_ARGS + 1])(void) = {
    (void (*)(void)) t0, (void (*)(void)) t1, (void (*)(void)) t2, (void (*)(void)) t3, (void (*)(void)) t4, (void (*)(void)) t5, (void (*)(void)) t6, (void (*)(void)) t7, (void (*)(void)) t8, (void (*)(void)) t9, (void (*)(void)) t10, (void (*)(void)) t11, (void (*)(void)) t12, (void (*)(void)) t13, (void (*)(void)) t14, (void (*)(void)) t15, (void (*)(void)) t16, (void (*)(void)) t17, (void (*)(void)) t18, (void (*)(void)) t19, (void (*)(void)) t20, (void (*)(void)) t21, (void (*)(void)) t22
};


static int failures;

#define CHECK(cond, msg, ...) \
    do { if (!(cond)) { \
        printf("ffi_shim_test: FAIL: " msg "\n", ##__VA_ARGS__); \
        failures++; \
    } } while (0)

/* Drive one arity through prep_cif + ffi_call and verify every word. */
static void check_arity(unsigned int n) {
    uint32_t vals[FFI_SHIM_MAX_ARGS];
    void *avalue[FFI_SHIM_MAX_ARGS];
    ffi_type *atypes[FFI_SHIM_MAX_ARGS];

    for (unsigned int i = 0; i < n; i++) {
        /* distinctive per-(arity,slot) sentinel so a mis-routed word is
         * caught, not masked by a coincidental match */
        vals[i] = 0xA0000000u | (n << 8) | i;
        avalue[i] = &vals[i];
        atypes[i] = &ffi_type_uint32;
    }

    ffi_cif cif;
    reset_record();
    ffi_status s = ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n,
                                &ffi_type_void, atypes);
    CHECK(s == FFI_OK, "ffi_prep_cif(n=%u) returned %d", n, (int) s);

    ffi_call(&cif, targets[n], NULL, avalue);

    CHECK(g_count == n, "arity %u: target saw count %u", n, g_count);
    for (unsigned int i = 0; i < n; i++)
        CHECK(g_recorded[i] == vals[i],
              "arity %u slot %u: got 0x%08x want 0x%08x",
              n, i, g_recorded[i], vals[i]);
}

/* Mirror wl_closure_invoke's shape: data + target prepended to K args. */
static void check_wl_closure_shape(void) {
    /* the two leading words model `data` and `target` pointers */
    const unsigned int K = 6; /* six real message args */
    const unsigned int n = 2 + K;
    uint32_t vals[FFI_SHIM_MAX_ARGS];
    void *avalue[FFI_SHIM_MAX_ARGS];
    ffi_type *atypes[FFI_SHIM_MAX_ARGS];

    vals[0] = 0xDA7A0000u; /* data */
    vals[1] = 0x7A76E700u; /* target */
    for (unsigned int i = 2; i < n; i++)
        vals[i] = 0x00A26000u | i; /* message args */
    for (unsigned int i = 0; i < n; i++) {
        avalue[i] = &vals[i];
        atypes[i] = (i < 2) ? &ffi_type_pointer : &ffi_type_uint32;
    }

    ffi_cif cif;
    reset_record();
    ffi_status s = ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n,
                                &ffi_type_void, atypes);
    CHECK(s == FFI_OK, "wl-shape prep_cif returned %d", (int) s);
    ffi_call(&cif, targets[n], NULL, avalue);
    CHECK(g_count == n, "wl-shape: count %u != %u", g_count, n);
    for (unsigned int i = 0; i < n; i++)
        CHECK(g_recorded[i] == vals[i],
              "wl-shape slot %u: got 0x%08x want 0x%08x",
              i, g_recorded[i], vals[i]);
}

/* prep_cif must reject an arity beyond the Wayland ceiling. */
static void check_overflow_rejected(void) {
    ffi_cif cif;
    ffi_type *atypes[1] = { &ffi_type_uint32 };
    ffi_status s = ffi_prep_cif(&cif, FFI_DEFAULT_ABI,
                                FFI_SHIM_MAX_ARGS + 1, &ffi_type_void, atypes);
    CHECK(s != FFI_OK, "prep_cif accepted nargs > FFI_SHIM_MAX_ARGS");
}

int main(void) {
    for (unsigned int n = 0; n <= FFI_SHIM_MAX_ARGS; n++)
        check_arity(n);
    check_wl_closure_shape();
    check_overflow_rejected();

    if (failures == 0) {
        printf("ffi_shim_test: ALL PASS (arities 0..%u)\n", FFI_SHIM_MAX_ARGS);
        return 0;
    }
    printf("ffi_shim_test: %d FAILURE(S)\n", failures);
    return 1;
}
