#include <float.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>

_Static_assert(LDBL_MANT_DIG == 113, "requires binary128 long double");

static int check_conversions(void)
{
    volatile long double double_midpoint = 1.0L + 0x1p-53L + 0x1p-112L;
    volatile long double float_midpoint = 1.0L + 0x1p-24L + 0x1p-112L;
    volatile long double double_tiny = 0x1.8p-1075L;
    volatile long double float_tiny = 0x1.8p-150L;
    if ((double)double_midpoint != 0x1.0000000000001p+0 ||
        (float)float_midpoint != 0x1.000002p+0f ||
        (double)double_tiny != 0x1p-1074 || (float)float_tiny != 0x1p-149f) {
        fputs("binary128 narrowing failed\n", stderr);
        return 1;
    }

    union { float f; uint32_t bits; } float_nan = {.bits = 0xffc00123};
    union { double f; uint64_t bits; } double_nan = {.bits = 0x7ff8123456789abcULL};
    volatile float source_float = float_nan.f;
    volatile double source_double = double_nan.f;
    volatile long double widened_float = source_float;
    volatile long double widened_double = source_double;
    float_nan.f = widened_float;
    double_nan.f = widened_double;
    if (float_nan.bits != 0xffc00123 || double_nan.bits != 0x7ff8123456789abcULL) {
        fputs("binary128 NaN payload conversion failed\n", stderr);
        return 1;
    }
    if (widened_double > 1.0L || widened_double >= 1.0L ||
        widened_double < 1.0L || widened_double <= 1.0L ||
        widened_double == 1.0L || !(widened_double != 1.0L)) {
        fputs("binary128 unordered comparison failed\n", stderr);
        return 1;
    }
    return 0;
}

int main(void)
{
    volatile long double least = 0x1p-16494L;
    volatile long double three_least = 0x3p-16494L;
    volatile long double largest_power_of_two = 0x1p16383L;
    volatile long double half = 0.5L;
    volatile long double three_quarters = 0.75L;
    volatile long double one_and_half = 1.5L;
    volatile long double below_one = 0x1.ffffffffffffffffffffffffffffp-1L;
    volatile long double smallest_normal = LDBL_MIN;
    volatile long double largest_subnormal = 0x0.ffffffffffffffffffffffffffffp-16382L;

    if (least + least != 0x2p-16494L ||
        smallest_normal - largest_subnormal != least ||
        largest_subnormal + least != smallest_normal) {
        fputs("binary128 subnormal addition and subtraction failed\n", stderr);
        return 1;
    }
    if (least * three_quarters != least || least * half != 0.0L ||
        three_least * half != 0x2p-16494L || !signbit(-least * half)) {
        fputs("binary128 subnormal rounding failed\n", stderr);
        return 1;
    }
    if (smallest_normal * below_one != smallest_normal ||
        least * largest_power_of_two != 0x1p-111L ||
        ldexpl(one_and_half, -16495) != least) {
        fputs("binary128 exponent scaling failed\n", stderr);
        return 1;
    }
    if (least / one_and_half != least || least / half != 0x2p-16494L ||
        three_least / 2.0L != 0x2p-16494L) {
        fputs("binary128 subnormal division failed\n", stderr);
        return 1;
    }
    if (check_conversions()) return 1;
    puts("binary128 arithmetic and conversions ok");
}
