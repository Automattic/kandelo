/* int128_division_test.c — 128-bit integer division and modulo.
 *
 * Clang lowers every __int128 division and modulo to compiler-rt builtins
 * (__udivti3, __umodti3, __divti3, __modti3). This checks exact quotients
 * and remainders, including divisors above 2^64, negative operands, and
 * INT128_MIN, against values computed independently with Python integers.
 */
#include <stdint.h>
#include <stdio.h>

typedef unsigned __int128 u128;
typedef __int128 s128;
#define W(hi, lo) ((((u128)(hi)) << 64) | (u128)(lo))

struct row { u128 a, b, q, r; };

static const struct row unsigned_rows[] = {
    { W(0x0123456789abcdefULL, 0xfedcba9876543210ULL), W(0x0000000000000000ULL, 0x0000000100000001ULL), W(0x0000000001234567ULL, 0x8888888876543210ULL), W(0x0000000000000000ULL, 0x0000000000000000ULL) },
    { W(0xffffffffffffffffULL, 0xffffffffffffffffULL), W(0x0000000000000001ULL, 0x0000000000000003ULL), W(0x0000000000000000ULL, 0xfffffffffffffffdULL), W(0x0000000000000000ULL, 0x0000000000000008ULL) },
    { W(0x0000000000000000ULL, 0xab54a98ceb1f0ad2ULL), W(0x0000000000000000ULL, 0x000000003ade68b1ULL), W(0x0000000000000000ULL, 0x00000002e90edc8fULL), W(0x0000000000000000ULL, 0x00000000143c73f3ULL) },
    { W(0x0000000000000000ULL, 0x0000000000000005ULL), W(0x0000001000000000ULL, 0x0000000000000000ULL), W(0x0000000000000000ULL, 0x0000000000000000ULL), W(0x0000000000000000ULL, 0x0000000000000005ULL) },
    { W(0x8000000000000000ULL, 0x0000000000003039ULL), W(0x0000000000000000ULL, 0x0000000000000001ULL), W(0x8000000000000000ULL, 0x0000000000003039ULL), W(0x0000000000000000ULL, 0x0000000000000000ULL) },
};
static const struct row signed_rows[] = {
    { W(0xfedcba9876543210ULL, 0xfffffffffffffff9ULL), W(0x0000000000000000ULL, 0x0000000100000001ULL), W(0xfffffffffedcba98ULL, 0x7777777888888888ULL), W(0xffffffffffffffffULL, 0xffffffff77777771ULL) },
    { W(0x7fffffffffffffffULL, 0x0000000000000005ULL), W(0xfffffffffffffffcULL, 0xffffffffffffffffULL), W(0xffffffffffffffffULL, 0xd555555555555556ULL), W(0x0000000000000000ULL, 0xd55555555555555bULL) },
    { W(0xffffffffffffffffULL, 0xffffffffffffffefULL), W(0xffffffffffffffffULL, 0xfffffffffffffffbULL), W(0x0000000000000000ULL, 0x0000000000000003ULL), W(0xffffffffffffffffULL, 0xfffffffffffffffeULL) },
    { W(0x8000000000000000ULL, 0x0000000000000000ULL), W(0x0000000000000000ULL, 0x0000000000000003ULL), W(0xd555555555555555ULL, 0x5555555555555556ULL), W(0xffffffffffffffffULL, 0xfffffffffffffffeULL) },
    { W(0x0000000000000000ULL, 0x0000000000000064ULL), W(0xffffffffffffffffULL, 0xfffffffffffffff9ULL), W(0xffffffffffffffffULL, 0xfffffffffffffff2ULL), W(0x0000000000000000ULL, 0x0000000000000002ULL) },
};

static int failures;

static void report(const char *kind, int i, const char *what, u128 got, u128 want) {
    if (got == want) return;
    failures++;
    printf("FAIL %s row %d %s: got %016llx%016llx want %016llx%016llx\n", kind, i, what,
           (unsigned long long)(got >> 64), (unsigned long long)got,
           (unsigned long long)(want >> 64), (unsigned long long)want);
}

int main(void) {
    for (int i = 0; i < (int)(sizeof unsigned_rows / sizeof unsigned_rows[0]); i++) {
        /* volatile keeps the compiler from folding the division away */
        volatile u128 a = unsigned_rows[i].a, b = unsigned_rows[i].b;
        report("unsigned", i, "quotient", a / b, unsigned_rows[i].q);
        report("unsigned", i, "remainder", a % b, unsigned_rows[i].r);
    }
    for (int i = 0; i < (int)(sizeof signed_rows / sizeof signed_rows[0]); i++) {
        volatile s128 a = (s128)signed_rows[i].a, b = (s128)signed_rows[i].b;
        report("signed", i, "quotient", (u128)(a / b), signed_rows[i].q);
        report("signed", i, "remainder", (u128)(a % b), signed_rows[i].r);
    }
    if (failures) return 1;
    printf("PASS int128 division\n");
    return 0;
}
