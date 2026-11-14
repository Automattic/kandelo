/* compiler_builtins_test.c — call every compiler builtin family at runtime.
 *
 * Clang lowers __int128 multiply and shifts, and every long double (fp128)
 * operation, to builtins that the SDK provides from libc/glue/compiler_rt.c.
 * A builtin whose own body the optimizer turns back into the operation it
 * implements calls itself and recurses until the stack overflows; clang 23
 * did that to __multi3. This program reaches each builtin through volatile
 * operands, so none is folded away, and checks exact results computed
 * independently with Python integers. 128-bit division and modulo are
 * covered by int128_division_test.c.
 */
#include <stdint.h>
#include <stdio.h>

typedef unsigned __int128 u128;
typedef __int128 s128;
#define W(hi, lo) ((((u128)(hi)) << 64) | (u128)(lo))

static int failures;

static void check_u128(const char *what, int i, u128 got, u128 want) {
    if (got == want) return;
    failures++;
    printf("FAIL %s row %d: got %016llx%016llx want %016llx%016llx\n", what, i,
           (unsigned long long)(got >> 64), (unsigned long long)got,
           (unsigned long long)(want >> 64), (unsigned long long)want);
}

static void check_true(const char *what, int ok) {
    if (ok) return;
    failures++;
    printf("FAIL %s\n", what);
}

struct mul_row { u128 a, b, p; };

/* p = a * b mod 2^128 */
static const struct mul_row mul_rows[] = {
    { W(0x0123456789abcdefULL, 0xfedcba9876543210ULL), W(0, 0x0000000100000001ULL), W(0x8acf135788888888ULL, 0x7530eca876543210ULL) },
    { W(0, 0xffffffffffffffffULL), W(0, 0xffffffffffffffffULL), W(0xfffffffffffffffeULL, 0x0000000000000001ULL) },
    { W(0xdeadbeefcafebabeULL, 0x0123456789abcdefULL), W(0x1111111111111111ULL, 0xfedcba9876543210ULL), W(0xa3aa461511292b01ULL, 0x2236d88fe5618cf0ULL) },
    { W(0, 0x00000000ffffffffULL), W(0, 0xffffffff00000001ULL), W(0x00000000fffffffeULL, 0x00000001ffffffffULL) },
    { W(0xffffffffffffffffULL, 0xfffffffedcba9877ULL), W(0, 0x0000000987654321ULL), W(0xfffffffffffffff5ULL, 0x28828bd331e7cc57ULL) },
    { W(0xffffffffffffffffULL, 0xffffffffffffffffULL), W(0xffffffffffffffffULL, 0xffffffffffffffffULL), W(0, 1) },
};

struct shift_row { int n; u128 shl, lshr, ashr; };

/* Shifts of W(0x8123456789abcdef, 0xfedcba9876543210) by n. */
static const struct shift_row shift_rows[] = {
    { 1, W(0x02468acf13579bdfULL, 0xfdb97530eca86420ULL), W(0x4091a2b3c4d5e6f7ULL, 0xff6e5d4c3b2a1908ULL), W(0xc091a2b3c4d5e6f7ULL, 0xff6e5d4c3b2a1908ULL) },
    { 63, W(0xff6e5d4c3b2a1908ULL, 0), W(0x0000000000000001ULL, 0x02468acf13579bdfULL), W(0xffffffffffffffffULL, 0x02468acf13579bdfULL) },
    { 64, W(0xfedcba9876543210ULL, 0), W(0, 0x8123456789abcdefULL), W(0xffffffffffffffffULL, 0x8123456789abcdefULL) },
    { 65, W(0xfdb97530eca86420ULL, 0), W(0, 0x4091a2b3c4d5e6f7ULL), W(0xffffffffffffffffULL, 0xc091a2b3c4d5e6f7ULL) },
    { 127, W(0, 0), W(0, 1), W(0xffffffffffffffffULL, 0xffffffffffffffffULL) },
};

int main(void) {
    for (int i = 0; i < (int)(sizeof mul_rows / sizeof mul_rows[0]); i++) {
        volatile u128 a = mul_rows[i].a, b = mul_rows[i].b;
        check_u128("multiply", i, a * b, mul_rows[i].p);
        volatile s128 sa = (s128)mul_rows[i].a, sb = (s128)mul_rows[i].b;
        /* Signed multiply wraps identically; compute it in unsigned to avoid
         * signed-overflow UB while still reaching __multi3 with signed data. */
        check_u128("signed multiply", i, (u128)sa * (u128)sb, mul_rows[i].p);
    }
    {
        /* The 64x64 -> 128 widening multiply, the form musl's number
         * formatting and parsing paths use. */
        volatile uint64_t a = 0xfedcba9876543210ULL, b = 0x0123456789abcdefULL;
        check_u128("widening multiply", 0, (u128)a * b,
                   W(0x0121fa00ad77d742ULL, 0x2236d88fe5618cf0ULL));
    }

    for (int i = 0; i < (int)(sizeof shift_rows / sizeof shift_rows[0]); i++) {
        volatile u128 v = W(0x8123456789abcdefULL, 0xfedcba9876543210ULL);
        volatile int n = shift_rows[i].n;
        check_u128("shift left", i, v << n, shift_rows[i].shl);
        check_u128("logical shift right", i, v >> n, shift_rows[i].lshr);
        check_u128("arithmetic shift right", i, (u128)((s128)v >> n), shift_rows[i].ashr);
    }

    /* fp128: values whose results are exact, so these check that each
     * builtin runs and returns, not the rounding of the soft-float code. */
    volatile long double x = 1.5L, y = 2.25L, z = -7.0L, q = 4.0L;
    check_true("long double add", x + y == 3.75L);
    check_true("long double subtract", x - y == -0.75L);
    check_true("long double multiply", x * z == -10.5L);
    check_true("long double divide", y / q == 0.5625L);
    check_true("long double compare", z < x && x <= y && y > z && q >= q && x != y);

    volatile long long i64 = -123456789012345LL;
    volatile unsigned long long u64 = 0xfedcba9876543210ULL;
    volatile int i32 = -2147483647;
    volatile unsigned u32 = 4000000000u;
    volatile double d = 0.1;
    volatile float f = 0.375f;
    long double li = i64, lu = u64, l32 = i32, lu32 = u32, ld = d, lf = f;
    check_true("long long round trip", (long long)li == -123456789012345LL);
    check_true("unsigned long long round trip", (unsigned long long)lu == 0xfedcba9876543210ULL);
    check_true("int round trip", (int)l32 == -2147483647);
    check_true("unsigned round trip", (unsigned)lu32 == 4000000000u);
    check_true("double round trip", (double)ld == 0.1);
    check_true("float round trip", (float)lf == 0.375f);

    if (failures) return 1;
    printf("PASS compiler builtins\n");
    return 0;
}
