/* compiler_rt.c — Soft-float builtins for wasm32 fp128 (long double).
 *
 * Wasm32 clang uses 128-bit IEEE quad precision for long double, but
 * there's no hardware support. We provide minimal implementations
 * using raw bit manipulation to avoid recursive compiler-rt calls
 * (e.g. (double)fp128_val would call __trunctfdf2, causing infinite recursion).
 *
 * IEEE 754 quad precision (128-bit, little-endian):
 *   bits [0..111]   = fraction (112 bits)
 *   bits [112..126]  = exponent (15 bits, bias 16383)
 *   bit  [127]       = sign
 *
 * IEEE 754 double (64-bit, little-endian):
 *   bits [0..51]    = fraction (52 bits)
 *   bits [52..62]   = exponent (11 bits, bias 1023)
 *   bit  [63]       = sign
 *
 * IEEE 754 float (32-bit):
 *   bits [0..22]    = fraction (23 bits)
 *   bits [23..30]   = exponent (8 bits, bias 127)
 *   bit  [31]       = sign
 */

#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef long double fp128;

/* Raw bit representation of fp128 as two 64-bit words (little-endian). */
typedef union {
    fp128 f;
    uint64_t u[2];
} fp128_bits;

/* Raw bit representation of double. */
typedef union {
    double f;
    uint64_t u;
} f64_bits;

/* Raw bit representation of float. */
typedef union {
    float f;
    uint32_t u;
} f32_bits;

/* ===== 128-bit unsigned integer helpers ===== */

/* 128-bit unsigned integer as (lo, hi) pair */
typedef struct { uint64_t lo; uint64_t hi; } uint128_t_;

static uint128_t_ u128_from64(uint64_t v) {
    uint128_t_ r = {v, 0};
    return r;
}

static uint128_t_ u128_or(uint128_t_ a, uint128_t_ b) {
    uint128_t_ r = {a.lo | b.lo, a.hi | b.hi};
    return r;
}

static uint128_t_ u128_and(uint128_t_ a, uint128_t_ b) {
    uint128_t_ r = {a.lo & b.lo, a.hi & b.hi};
    return r;
}

static uint128_t_ u128_not(uint128_t_ a) {
    uint128_t_ r = {~a.lo, ~a.hi};
    return r;
}

static int u128_is_zero(uint128_t_ a) {
    return a.lo == 0 && a.hi == 0;
}

static int u128_gt(uint128_t_ a, uint128_t_ b) {
    return a.hi > b.hi || (a.hi == b.hi && a.lo > b.lo);
}

static int u128_ge(uint128_t_ a, uint128_t_ b) {
    return a.hi > b.hi || (a.hi == b.hi && a.lo >= b.lo);
}

static uint128_t_ u128_add(uint128_t_ a, uint128_t_ b) {
    uint128_t_ r;
    r.lo = a.lo + b.lo;
    r.hi = a.hi + b.hi + (r.lo < a.lo ? 1 : 0);
    return r;
}

static uint128_t_ u128_sub(uint128_t_ a, uint128_t_ b) {
    uint128_t_ r;
    r.lo = a.lo - b.lo;
    r.hi = a.hi - b.hi - (a.lo < b.lo ? 1 : 0);
    return r;
}

static uint128_t_ u128_shl(uint128_t_ a, int n) {
    if (n == 0) return a;
    if (n >= 128) { uint128_t_ z = {0,0}; return z; }
    uint128_t_ r;
    if (n >= 64) {
        r.hi = a.lo << (n - 64);
        r.lo = 0;
    } else {
        r.hi = (a.hi << n) | (a.lo >> (64 - n));
        r.lo = a.lo << n;
    }
    return r;
}

static uint128_t_ u128_shr(uint128_t_ a, int n) {
    if (n == 0) return a;
    if (n >= 128) { uint128_t_ z = {0,0}; return z; }
    uint128_t_ r;
    if (n >= 64) {
        r.lo = a.hi >> (n - 64);
        r.hi = 0;
    } else {
        r.lo = (a.lo >> n) | (a.hi << (64 - n));
        r.hi = a.hi >> n;
    }
    return r;
}

/* Count leading zeros in 128-bit value */
static int u128_clz(uint128_t_ a) {
    if (a.hi != 0) {
        int n = 0;
        uint64_t x = a.hi;
        if (x <= 0x00000000FFFFFFFFULL) { n += 32; x <<= 32; }
        if (x <= 0x0000FFFFFFFFFFFFULL) { n += 16; x <<= 16; }
        if (x <= 0x00FFFFFFFFFFFFFFULL) { n += 8;  x <<= 8;  }
        if (x <= 0x0FFFFFFFFFFFFFFFULL) { n += 4;  x <<= 4;  }
        if (x <= 0x3FFFFFFFFFFFFFFFULL) { n += 2;  x <<= 2;  }
        if (x <= 0x7FFFFFFFFFFFFFFFULL) { n += 1; }
        return n;
    }
    if (a.lo != 0) {
        int n = 64;
        uint64_t x = a.lo;
        if (x <= 0x00000000FFFFFFFFULL) { n += 32; x <<= 32; }
        if (x <= 0x0000FFFFFFFFFFFFULL) { n += 16; x <<= 16; }
        if (x <= 0x00FFFFFFFFFFFFFFULL) { n += 8;  x <<= 8;  }
        if (x <= 0x0FFFFFFFFFFFFFFFULL) { n += 4;  x <<= 4;  }
        if (x <= 0x3FFFFFFFFFFFFFFFULL) { n += 2;  x <<= 2;  }
        if (x <= 0x7FFFFFFFFFFFFFFFULL) { n += 1; }
        return n;
    }
    return 128;
}

/* ===== fp128 decompose/recompose ===== */

#define FP128_EXP_BIAS  16383
#define FP128_EXP_INF   0x7FFF
#define FP128_FRAC_BITS 112
/* Significand has implicit 1 + 112 fraction bits = 113 bits total.
 * We store it in 128-bit uint with the implicit bit at position 112. */

static fp128 fp128_pack(uint32_t sign, int32_t exp, uint128_t_ sig) {
    fp128_bits r;
    /* sig has the significand in bits [112:0] (113 bits with implicit bit at 112).
     * We need to pack: sign(1) + exp(15) + frac(112) = 128 bits.
     * For normal: frac = sig[111:0] (strip implicit bit).
     * hi word: sign(1) + exp(15) + frac[111:64](48 bits) = 64 bits
     * lo word: frac[63:0] = 64 bits */
    uint64_t frac_lo = sig.lo;
    uint64_t frac_hi = sig.hi & 0x0000FFFFFFFFFFFFULL; /* bits [111:64] = 48 bits */
    r.u[0] = frac_lo;
    r.u[1] = ((uint64_t)sign << 63) | ((uint64_t)(exp & 0x7FFF) << 48) | frac_hi;
    fp128 result;
    memcpy(&result, &r, sizeof(result));
    return result;
}

/* Make fp128 zero with given sign */
static fp128 fp128_zero(uint32_t sign) {
    return fp128_pack(sign, 0, u128_from64(0));
}

/* Make fp128 infinity with given sign */
static fp128 fp128_inf(uint32_t sign) {
    return fp128_pack(sign, FP128_EXP_INF, u128_from64(0));
}

/* The significand includes guard, round and sticky bits in positions 2, 1 and 0. */
static fp128 fp128_round(uint32_t sign, int exp, uint128_t_ significand) {
    if (exp <= 0) {
        int shift = 1 - exp;
        if (shift > FP128_FRAC_BITS + 1) return fp128_zero(sign);
        int discarded = !u128_is_zero(u128_shl(significand, 128 - shift));
        significand = u128_shr(significand, shift);
        significand.lo |= discarded;
        exp = 1; /* Effective exponent for both subnormals and the smallest normal. */
    }

    uint32_t round_bits = significand.lo & 7;
    significand = u128_shr(significand, 3);
    if (round_bits > 4 || (round_bits == 4 && (significand.lo & 1))) {
        significand = u128_add(significand, u128_from64(1));
        uint128_t_ carry = u128_shl(u128_from64(1), FP128_FRAC_BITS + 1);
        if (!u128_is_zero(u128_and(significand, carry))) {
            significand = u128_shr(significand, 1);
            exp++;
        }
    }
    if (exp >= FP128_EXP_INF) return fp128_inf(sign);

    uint128_t_ implicit = u128_shl(u128_from64(1), FP128_FRAC_BITS);
    if (exp == 1 && u128_is_zero(u128_and(significand, implicit))) {
        exp = 0;
    }
    return fp128_pack(sign, exp, u128_and(significand, u128_not(implicit)));
}

/* ===== Conversions between IEEE binary128, binary64 and binary32 ===== */

static uint64_t fp128_to_binary(fp128 a, int fraction_bits, int exponent_bits, int bias) {
    fp128_bits in;
    memcpy(&in, &a, sizeof(in));
    uint64_t sign = (in.u[1] >> 63) << (exponent_bits + fraction_bits);
    int exponent_limit = (1 << exponent_bits) - 1;
    uint64_t infinity = (uint64_t)exponent_limit << fraction_bits;
    int exponent = (in.u[1] >> 48) & FP128_EXP_INF;
    uint128_t_ fraction = { in.u[0], in.u[1] & 0x0000FFFFFFFFFFFFULL };
    int shift = FP128_FRAC_BITS - fraction_bits;

    if (exponent == FP128_EXP_INF) {
        uint64_t payload = u128_shr(fraction, shift).lo;
        if (!u128_is_zero(fraction)) payload |= 1ULL << (fraction_bits - 1);
        return sign | infinity | payload;
    }
    if (exponent == 0) return sign; /* Binary128 subnormals are below either output range. */

    exponent += bias - FP128_EXP_BIAS;
    if (exponent >= exponent_limit) return sign | infinity;
    if (exponent <= 0) shift += 1 - exponent;
    if (shift > FP128_FRAC_BITS + 1) return sign;

    uint128_t_ significand = u128_or(fraction, u128_shl(u128_from64(1), FP128_FRAC_BITS));
    uint64_t rounded = u128_shr(significand, shift).lo;
    uint128_t_ discarded = u128_shl(significand, 128 - shift);
    const uint64_t halfway = 1ULL << 63;
    if (discarded.hi > halfway ||
        (discarded.hi == halfway && (discarded.lo || (rounded & 1)))) {
        rounded++;
    }

    /* The retained leading bit supplies one exponent unit for normals.
     * Addition also carries a rounded subnormal or significand overflow. */
    uint64_t encoded_exp = (uint64_t)(exponent > 0 ? exponent - 1 : 0) << fraction_bits;
    return sign | (encoded_exp + rounded);
}

static fp128 fp128_from_binary(uint64_t bits, int fraction_bits, int exponent_bits, int bias) {
    uint64_t fraction_mask = (1ULL << fraction_bits) - 1;
    uint64_t fraction = bits & fraction_mask;
    int exponent_limit = (1 << exponent_bits) - 1;
    int exponent = (bits >> fraction_bits) & exponent_limit;
    uint32_t sign = bits >> (exponent_bits + fraction_bits);

    if (exponent == exponent_limit) {
        if (fraction != 0) fraction |= 1ULL << (fraction_bits - 1);
        exponent = FP128_EXP_INF;
    } else if (exponent != 0) {
        exponent += FP128_EXP_BIAS - bias;
    } else if (fraction != 0) {
        int shift = u128_clz(u128_from64(fraction)) - (127 - fraction_bits);
        fraction = (fraction << shift) & fraction_mask;
        exponent = FP128_EXP_BIAS + 1 - bias - shift;
    }

    return fp128_pack(sign, exponent, u128_shl(u128_from64(fraction), FP128_FRAC_BITS - fraction_bits));
}

static double fp128_to_f64(fp128 a) {
    f64_bits out = { .u = fp128_to_binary(a, 52, 11, 1023) };
    return out.f;
}

static float fp128_to_f32(fp128 a) {
    f32_bits out = { .u = (uint32_t)fp128_to_binary(a, 23, 8, 127) };
    return out.f;
}

static fp128 f64_to_fp128(double a) {
    f64_bits in = { .f = a };
    return fp128_from_binary(in.u, 52, 11, 1023);
}

static fp128 f32_to_fp128(float a) {
    f32_bits in = { .f = a };
    return fp128_from_binary(in.u, 23, 8, 127);
}

/* ===== Proper fp128 addition ===== */

fp128 __addtf3(fp128 a, fp128 b) {
    fp128_bits ua, ub;
    memcpy(&ua, &a, sizeof(ua));
    memcpy(&ub, &b, sizeof(ub));

    uint32_t sign_a = (ua.u[1] >> 63) & 1;
    uint32_t sign_b = (ub.u[1] >> 63) & 1;
    int32_t exp_a = (ua.u[1] >> 48) & 0x7FFF;
    int32_t exp_b = (ub.u[1] >> 48) & 0x7FFF;

    /* Extract 112-bit fractions */
    uint128_t_ sig_a = { ua.u[0], ua.u[1] & 0x0000FFFFFFFFFFFFULL };
    uint128_t_ sig_b = { ub.u[0], ub.u[1] & 0x0000FFFFFFFFFFFFULL };

    /* Handle special cases */
    if (exp_a == FP128_EXP_INF) {
        if (!u128_is_zero(sig_a)) return a; /* NaN */
        if (exp_b == FP128_EXP_INF && !u128_is_zero(sig_b)) return b; /* NaN */
        if (exp_b == FP128_EXP_INF && sign_a != sign_b) {
            /* inf + (-inf) = NaN */
            return fp128_pack(0, FP128_EXP_INF, u128_from64(1));
        }
        return a; /* inf */
    }
    if (exp_b == FP128_EXP_INF) {
        if (!u128_is_zero(sig_b)) return b; /* NaN */
        return b; /* inf */
    }

    /* Add implicit bit for normal numbers */
    if (exp_a != 0) {
        sig_a = u128_or(sig_a, u128_shl(u128_from64(1), FP128_FRAC_BITS));
    } else if (!u128_is_zero(sig_a)) {
        exp_a = 1; /* subnormal: treat exponent as 1 */
    }
    if (exp_b != 0) {
        sig_b = u128_or(sig_b, u128_shl(u128_from64(1), FP128_FRAC_BITS));
    } else if (!u128_is_zero(sig_b)) {
        exp_b = 1;
    }

    /* Both zero */
    if (u128_is_zero(sig_a) && u128_is_zero(sig_b)) {
        return fp128_zero(sign_a & sign_b);
    }
    if (u128_is_zero(sig_a)) {
        return b;
    }
    if (u128_is_zero(sig_b)) {
        return a;
    }

    /* Shift significands left by 3 for rounding room (guard, round, sticky).
     * sig now has meaningful bits in positions [115:3], implicit at [115]. */
    sig_a = u128_shl(sig_a, 3);
    sig_b = u128_shl(sig_b, 3);

    /* Align exponents — shift smaller significand right */
    int32_t exp_diff = exp_a - exp_b;
    int32_t result_exp;
    if (exp_diff > 0) {
        result_exp = exp_a;
        if (exp_diff < 128) {
            /* Capture sticky bits from shifted-out portion */
            uint128_t_ sticky_mask = u128_sub(u128_shl(u128_from64(1), exp_diff), u128_from64(1));
            int sticky = !u128_is_zero(u128_and(sig_b, sticky_mask));
            sig_b = u128_shr(sig_b, exp_diff);
            if (sticky) sig_b.lo |= 1;
        } else {
            sig_b = u128_from64(1); /* sticky */
        }
    } else if (exp_diff < 0) {
        result_exp = exp_b;
        exp_diff = -exp_diff;
        if (exp_diff < 128) {
            uint128_t_ sticky_mask = u128_sub(u128_shl(u128_from64(1), exp_diff), u128_from64(1));
            int sticky = !u128_is_zero(u128_and(sig_a, sticky_mask));
            sig_a = u128_shr(sig_a, exp_diff);
            if (sticky) sig_a.lo |= 1;
        } else {
            sig_a = u128_from64(1);
        }
    } else {
        result_exp = exp_a;
    }

    /* Add or subtract significands based on signs */
    uint128_t_ result_sig;
    uint32_t result_sign;
    if (sign_a == sign_b) {
        result_sig = u128_add(sig_a, sig_b);
        result_sign = sign_a;
    } else {
        if (u128_gt(sig_a, sig_b)) {
            result_sig = u128_sub(sig_a, sig_b);
            result_sign = sign_a;
        } else if (u128_gt(sig_b, sig_a)) {
            result_sig = u128_sub(sig_b, sig_a);
            result_sign = sign_b;
        } else {
            return fp128_zero(0); /* equal magnitude, opposite signs */
        }
    }

    if (u128_is_zero(result_sig)) {
        return fp128_zero(0);
    }

    /* Normalize: implicit bit should be at position 115 (= 112 + 3 guard bits).
     * The result significand is in a 128-bit field. */
    int lz = u128_clz(result_sig);
    int target = 128 - 116; /* bit 115 should be the MSB position → clz = 12 */

    if (lz < target) {
        /* Significand too large — shift right */
        int shift = target - lz;
        /* Capture sticky */
        uint128_t_ sticky_mask = u128_sub(u128_shl(u128_from64(1), shift), u128_from64(1));
        int sticky = !u128_is_zero(u128_and(result_sig, sticky_mask));
        result_sig = u128_shr(result_sig, shift);
        if (sticky) result_sig.lo |= 1;
        result_exp += shift;
    } else if (lz > target) {
        /* Significand too small — shift left */
        int shift = lz - target;
        if (shift > result_exp - 1) shift = result_exp - 1; /* don't go below exp=1 */
        if (shift > 0) {
            result_sig = u128_shl(result_sig, shift);
            result_exp -= shift;
        }
    }

    return fp128_round(result_sign, result_exp, result_sig);
}

/* ===== Proper fp128 subtraction ===== */

fp128 __subtf3(fp128 a, fp128 b) {
    /* Negate b and add */
    fp128_bits ub;
    memcpy(&ub, &b, sizeof(ub));
    ub.u[1] ^= (1ULL << 63); /* flip sign bit */
    fp128 neg_b;
    memcpy(&neg_b, &ub, sizeof(neg_b));
    return __addtf3(a, neg_b);
}

/* ===== Proper fp128 multiplication ===== */

/* Helper: 64×64 → 128-bit unsigned multiply */
static void mul64(uint64_t a, uint64_t b, uint64_t *hi, uint64_t *lo) {
    uint64_t a_lo = a & 0xFFFFFFFF, a_hi = a >> 32;
    uint64_t b_lo = b & 0xFFFFFFFF, b_hi = b >> 32;

    uint64_t p00 = a_lo * b_lo;
    uint64_t p01 = a_lo * b_hi;
    uint64_t p10 = a_hi * b_lo;
    uint64_t p11 = a_hi * b_hi;

    uint64_t mid = (p00 >> 32) + (p01 & 0xFFFFFFFF) + (p10 & 0xFFFFFFFF);
    *lo = (p00 & 0xFFFFFFFF) | (mid << 32);
    *hi = p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
}

/* 256-bit result of 128×128 multiply */
typedef struct { uint64_t w[4]; } uint256_t_;

/* Multiply two 128-bit unsigned integers, return full 256-bit result.
 * w[0] = least significant, w[3] = most significant. */
static uint256_t_ u128_mul_full(uint128_t_ a, uint128_t_ b) {
    uint64_t p0_hi, p0_lo, p1_hi, p1_lo, p2_hi, p2_lo, p3_hi, p3_lo;
    mul64(a.lo, b.lo, &p0_hi, &p0_lo);
    mul64(a.lo, b.hi, &p1_hi, &p1_lo);
    mul64(a.hi, b.lo, &p2_hi, &p2_lo);
    mul64(a.hi, b.hi, &p3_hi, &p3_lo);

    /* Assemble 256-bit result:
     * w[0] = p0_lo
     * w[1] = p0_hi + p1_lo + p2_lo  (with carry)
     * w[2] = p3_lo + p1_hi + p2_hi + carry
     * w[3] = p3_hi + carry */
    uint256_t_ r;
    r.w[0] = p0_lo;

    uint64_t carry = 0;
    uint64_t w1 = p0_hi + p1_lo;
    carry = (w1 < p0_hi) ? 1 : 0;
    uint64_t w1b = w1 + p2_lo;
    carry += (w1b < w1) ? 1 : 0;
    r.w[1] = w1b;

    uint64_t w2 = p3_lo + carry;
    carry = (w2 < p3_lo) ? 1 : 0;
    uint64_t w2b = w2 + p1_hi;
    carry += (w2b < w2) ? 1 : 0;
    uint64_t w2c = w2b + p2_hi;
    carry += (w2c < w2b) ? 1 : 0;
    r.w[2] = w2c;

    r.w[3] = p3_hi + carry;
    return r;
}

fp128 __multf3(fp128 a, fp128 b) {
    fp128_bits ua, ub;
    memcpy(&ua, &a, sizeof(ua));
    memcpy(&ub, &b, sizeof(ub));

    uint32_t sign_a = (ua.u[1] >> 63) & 1;
    uint32_t sign_b = (ub.u[1] >> 63) & 1;
    uint32_t result_sign = sign_a ^ sign_b;

    int32_t exp_a = (ua.u[1] >> 48) & 0x7FFF;
    int32_t exp_b = (ub.u[1] >> 48) & 0x7FFF;

    uint128_t_ sig_a = { ua.u[0], ua.u[1] & 0x0000FFFFFFFFFFFFULL };
    uint128_t_ sig_b = { ub.u[0], ub.u[1] & 0x0000FFFFFFFFFFFFULL };

    /* Handle NaN/Inf */
    if (exp_a == FP128_EXP_INF) {
        if (!u128_is_zero(sig_a)) return a; /* NaN */
        if (exp_b == 0 && u128_is_zero(sig_b)) {
            return fp128_pack(0, FP128_EXP_INF, u128_from64(1)); /* inf*0=NaN */
        }
        if (exp_b == FP128_EXP_INF && !u128_is_zero(sig_b)) return b; /* NaN */
        return fp128_inf(result_sign);
    }
    if (exp_b == FP128_EXP_INF) {
        if (!u128_is_zero(sig_b)) return b;
        if (exp_a == 0 && u128_is_zero(sig_a)) {
            return fp128_pack(0, FP128_EXP_INF, u128_from64(1));
        }
        return fp128_inf(result_sign);
    }

    /* Handle zero */
    if (exp_a == 0 && u128_is_zero(sig_a)) return fp128_zero(result_sign);
    if (exp_b == 0 && u128_is_zero(sig_b)) return fp128_zero(result_sign);

    /* Normalize both significands before multiplying. */
    uint128_t_ implicit = u128_shl(u128_from64(1), FP128_FRAC_BITS);
    if (exp_a != 0) {
        sig_a = u128_or(sig_a, implicit);
    } else {
        int shift = u128_clz(sig_a) - (127 - FP128_FRAC_BITS);
        sig_a = u128_shl(sig_a, shift);
        exp_a = 1 - shift;
    }
    if (exp_b != 0) {
        sig_b = u128_or(sig_b, implicit);
    } else {
        int shift = u128_clz(sig_b) - (127 - FP128_FRAC_BITS);
        sig_b = u128_shl(sig_b, shift);
        exp_b = 1 - shift;
    }

    /* Result exponent (before normalization) */
    int32_t result_exp = exp_a + exp_b - FP128_EXP_BIAS;

    /* Multiply: sig_a (113 bits) * sig_b (113 bits) → 226 bits.
     * The product has implicit bit at position 224 or 225 of the 256-bit result.
     * We need the top 116 bits (113 + 3 guard/round/sticky) plus a sticky
     * bit from everything below. */
    uint256_t_ prod = u128_mul_full(sig_a, sig_b);

    /* Extract the 116 highest bits. The least significant bit folds in the
     * rest of the product so rounding retains all discarded information. */
    uint128_t_ prod_hi = { prod.w[2], prod.w[3] };
    int top_bit = 255 - u128_clz(prod_hi); /* 224 or 225 */
    int shift = top_bit - 115 - 64;
    uint128_t_ result_sig = {
        (prod.w[2] << (64 - shift)) | (prod.w[1] >> shift),
        (prod.w[3] << (64 - shift)) | (prod.w[2] >> shift),
    };
    if (prod.w[0] || (prod.w[1] & ((1ULL << shift) - 1))) {
        result_sig.lo |= 1;
    }
    result_exp += top_bit - 2 * FP128_FRAC_BITS;

    return fp128_round(result_sign, result_exp, result_sig);
}

/* ===== Proper fp128 division ===== */

fp128 __divtf3(fp128 a, fp128 b) {
    fp128_bits ua, ub;
    memcpy(&ua, &a, sizeof(ua));
    memcpy(&ub, &b, sizeof(ub));

    uint32_t sign_a = (ua.u[1] >> 63) & 1;
    uint32_t sign_b = (ub.u[1] >> 63) & 1;
    uint32_t result_sign = sign_a ^ sign_b;

    int32_t exp_a = (ua.u[1] >> 48) & 0x7FFF;
    int32_t exp_b = (ub.u[1] >> 48) & 0x7FFF;

    uint128_t_ sig_a = { ua.u[0], ua.u[1] & 0x0000FFFFFFFFFFFFULL };
    uint128_t_ sig_b = { ub.u[0], ub.u[1] & 0x0000FFFFFFFFFFFFULL };

    /* Handle NaN/Inf */
    if (exp_a == FP128_EXP_INF) {
        if (!u128_is_zero(sig_a)) return a;
        if (exp_b == FP128_EXP_INF) return fp128_pack(0, FP128_EXP_INF, u128_from64(1));
        return fp128_inf(result_sign);
    }
    if (exp_b == FP128_EXP_INF) {
        if (!u128_is_zero(sig_b)) return b;
        return fp128_zero(result_sign);
    }

    /* Handle zero */
    int a_zero = (exp_a == 0 && u128_is_zero(sig_a));
    int b_zero = (exp_b == 0 && u128_is_zero(sig_b));
    if (a_zero && b_zero) return fp128_pack(0, FP128_EXP_INF, u128_from64(1)); /* 0/0=NaN */
    if (a_zero) return fp128_zero(result_sign);
    if (b_zero) return fp128_inf(result_sign);

    /* Add implicit bits */
    if (exp_a != 0) {
        sig_a = u128_or(sig_a, u128_shl(u128_from64(1), FP128_FRAC_BITS));
    } else {
        exp_a = 1;
    }
    if (exp_b != 0) {
        sig_b = u128_or(sig_b, u128_shl(u128_from64(1), FP128_FRAC_BITS));
    } else {
        exp_b = 1;
    }

    int32_t result_exp = exp_a - exp_b + FP128_EXP_BIAS;

    /* Normalize both significands so leading bit is at position 127 */
    int lz_a = u128_clz(sig_a);
    int lz_b = u128_clz(sig_b);
    sig_a = u128_shl(sig_a, lz_a);
    sig_b = u128_shl(sig_b, lz_b);
    result_exp -= (lz_a - lz_b);

    /* Long division: compute 116 bits of quotient (113 + 3 guard bits).
     * dividend is in sig_a, divisor is in sig_b.
     * Both have leading 1 at bit 127.
     *
     * We use compare-before-shift (Form A): compare remainder against
     * divisor first, then shift remainder left for the next iteration.
     * The carry bit tracks overflow from the previous shift so that
     * comparisons against the full (carry:remainder) value are correct. */
    uint128_t_ quotient = u128_from64(0);
    uint128_t_ remainder = sig_a;
    int carry = 0;
    if (!u128_ge(sig_a, sig_b)) {
        /* Make the first quotient bit implicit while retaining all guard bits. */
        carry = 1;
        remainder = u128_shl(remainder, 1);
        result_exp--;
    }

    for (int i = 0; i < 116; i++) {
        quotient = u128_shl(quotient, 1);
        /* Compare true remainder (carry:remainder) against divisor */
        if (carry || u128_ge(remainder, sig_b)) {
            remainder = u128_sub(remainder, sig_b);
            quotient.lo |= 1;
        }
        /* Shift remainder for next iteration, tracking carry */
        carry = (remainder.hi >> 63) & 1;
        remainder = u128_shl(remainder, 1);
    }

    if (carry || !u128_is_zero(remainder)) quotient.lo |= 1;
    return fp128_round(result_sign, result_exp, quotient);
}

/* ===== Public API: Conversions ===== */

fp128 __extendsftf2(float a) {
    return f32_to_fp128(a);
}

fp128 __extenddftf2(double a) {
    return f64_to_fp128(a);
}

float __trunctfsf2(fp128 a) {
    return fp128_to_f32(a);
}

double __trunctfdf2(fp128 a) {
    return fp128_to_f64(a);
}

/* Convert fp128 to signed 64-bit integer (truncate toward zero) */
static long long fp128_to_i64(fp128 a) {
    fp128_bits ua;
    memcpy(&ua, &a, sizeof(ua));

    uint32_t sign = (ua.u[1] >> 63) & 1;
    int32_t exp = (ua.u[1] >> 48) & 0x7FFF;
    uint128_t_ sig = { ua.u[0], ua.u[1] & 0x0000FFFFFFFFFFFFULL };

    if (exp == 0) return 0; /* zero or subnormal → 0 */
    if (exp == 0x7FFF) return 0; /* NaN/Inf → 0 (undefined behavior) */

    /* Add implicit bit */
    sig = u128_or(sig, u128_shl(u128_from64(1), FP128_FRAC_BITS));

    int32_t unbiased = exp - FP128_EXP_BIAS;
    if (unbiased < 0) return 0;
    if (unbiased >= 63) return sign ? (long long)(-9223372036854775807LL - 1) : 9223372036854775807LL;

    /* sig has implicit bit at position 112. Shift to get integer value.
     * If unbiased=0, integer part = 1. We need to shift right by (112 - unbiased). */
    int shift = FP128_FRAC_BITS - unbiased; /* 112 - unbiased */
    uint64_t result;
    if (shift >= 64) {
        result = sig.hi >> (shift - 64);
    } else if (shift > 0) {
        result = (sig.hi << (64 - shift)) | (sig.lo >> shift);
    } else {
        result = sig.lo << (-shift);
    }

    return sign ? -(long long)result : (long long)result;
}

int __fixtfsi(fp128 a) {
    return (int)fp128_to_i64(a);
}

long long __fixtfdi(fp128 a) {
    return fp128_to_i64(a);
}

unsigned int __fixunstfsi(fp128 a) {
    long long v = fp128_to_i64(a);
    return (unsigned int)(v < 0 ? 0 : v);
}

fp128 __floatsitf(int a) {
    return f64_to_fp128((double)a);
}

fp128 __floatunsitf(unsigned int a) {
    return f64_to_fp128((double)a);
}

/* Convert unsigned 64-bit integer to fp128 (exact — fp128 has 113-bit significand) */
fp128 __floatunditf(unsigned long long a) {
    if (a == 0) {
        fp128_bits out;
        out.u[0] = 0;
        out.u[1] = 0;
        fp128 result;
        memcpy(&result, &out, sizeof(result));
        return result;
    }

    /* Find the position of the highest set bit */
    int lz = 0;
    uint64_t x = a;
    if (x <= 0x00000000FFFFFFFFULL) { lz += 32; x <<= 32; }
    if (x <= 0x0000FFFFFFFFFFFFULL) { lz += 16; x <<= 16; }
    if (x <= 0x00FFFFFFFFFFFFFFULL) { lz += 8;  x <<= 8;  }
    if (x <= 0x0FFFFFFFFFFFFFFFULL) { lz += 4;  x <<= 4;  }
    if (x <= 0x3FFFFFFFFFFFFFFFULL) { lz += 2;  x <<= 2;  }
    if (x <= 0x7FFFFFFFFFFFFFFFULL) { lz += 1; }
    int msb = 63 - lz; /* bit position of highest set bit (0-based) */

    /* Exponent: value is a = significand * 2^msb, biased exp = msb + 16383 */
    uint64_t exp128 = (uint64_t)(msb + 16383);

    /* Remove the implicit leading 1 bit, leaving msb fraction bits.
     * We need to place these into the 112-bit fraction field.
     * Fraction: hi[47:0] = bits [111:64], lo = bits [63:0]. */
    uint64_t val = a & ~(1ULL << msb); /* clear implicit bit */

    /* val has 'msb' significant bits. Shift left to fill 112-bit fraction.
     * shift_amount = 112 - msb */
    fp128_bits out;
    int shift = 112 - msb;
    if (shift >= 64) {
        out.u[1] = val << (shift - 64);
        out.u[0] = 0;
    } else if (shift > 0) {
        out.u[1] = val >> (64 - shift);
        out.u[0] = val << shift;
    } else {
        /* shift == 0: msb == 112, impossible for 64-bit input */
        out.u[1] = 0;
        out.u[0] = val;
    }

    /* Mask fraction into hi, combine with sign (0) and exponent */
    out.u[1] = (exp128 << 48) | (out.u[1] & 0x0000FFFFFFFFFFFFULL);

    fp128 result;
    memcpy(&result, &out, sizeof(result));
    return result;
}

/* Convert signed 64-bit integer to fp128 (exact) */
fp128 __floatditf(long long a) {
    if (a == 0) {
        fp128_bits out;
        out.u[0] = 0;
        out.u[1] = 0;
        fp128 result;
        memcpy(&result, &out, sizeof(result));
        return result;
    }

    uint32_t sign = 0;
    unsigned long long ua;
    if (a < 0) {
        sign = 1;
        /* Handle INT64_MIN carefully: -(-2^63) overflows, but (unsigned)-2^63 = 2^63 */
        ua = (unsigned long long)(-(a + 1)) + 1ULL;
    } else {
        ua = (unsigned long long)a;
    }

    /* Use unsigned conversion, then set sign bit */
    fp128 tmp = __floatunditf(ua);
    if (sign) {
        fp128_bits bits;
        memcpy(&bits, &tmp, sizeof(bits));
        bits.u[1] |= (1ULL << 63);
        memcpy(&tmp, &bits, sizeof(tmp));
    }
    return tmp;
}

/* Convert fp128 to unsigned 64-bit integer (truncate toward zero, clamp negatives to 0) */
unsigned long long __fixunstfdi(fp128 a) {
    fp128_bits ua;
    memcpy(&ua, &a, sizeof(ua));

    uint32_t sign = (ua.u[1] >> 63) & 1;
    int32_t exp = (ua.u[1] >> 48) & 0x7FFF;
    uint128_t_ sig = { ua.u[0], ua.u[1] & 0x0000FFFFFFFFFFFFULL };

    if (exp == 0) return 0; /* zero or subnormal → 0 */
    if (sign) return 0;     /* negative → 0 for unsigned */
    if (exp == 0x7FFF) return 0; /* NaN/Inf → 0 (undefined behavior) */

    /* Add implicit bit */
    sig = u128_or(sig, u128_shl(u128_from64(1), FP128_FRAC_BITS));

    int32_t unbiased = exp - FP128_EXP_BIAS;
    if (unbiased < 0) return 0;
    if (unbiased >= 64) return 0xFFFFFFFFFFFFFFFFULL; /* overflow → saturate */

    /* sig has implicit bit at position 112. Shift to get integer value. */
    int shift = FP128_FRAC_BITS - unbiased; /* 112 - unbiased */
    uint64_t result;
    if (shift >= 64) {
        result = sig.hi >> (shift - 64);
    } else if (shift > 0) {
        result = (sig.hi << (64 - shift)) | (sig.lo >> shift);
    } else {
        result = sig.lo << (-shift);
    }

    return result;
}

/* ===== Public API: Comparisons ===== */

/* The compare builtins choose the unordered sentinel for their predicate. */
static int fp128_compare(fp128 a, fp128 b, int unordered) {
    fp128_bits ua, ub;
    memcpy(&ua, &a, sizeof(ua));
    memcpy(&ub, &b, sizeof(ub));

    uint32_t sign_a = (ua.u[1] >> 63) & 1;
    uint32_t sign_b = (ub.u[1] >> 63) & 1;
    uint32_t exp_a = (ua.u[1] >> 48) & 0x7FFF;
    uint32_t exp_b = (ub.u[1] >> 48) & 0x7FFF;
    uint64_t frac_a_hi = ua.u[1] & 0x0000FFFFFFFFFFFFULL;
    uint64_t frac_b_hi = ub.u[1] & 0x0000FFFFFFFFFFFFULL;

    /* Check NaN: exp=0x7FFF and frac!=0 */
    int a_nan = (exp_a == 0x7FFF) && (frac_a_hi != 0 || ua.u[0] != 0);
    int b_nan = (exp_b == 0x7FFF) && (frac_b_hi != 0 || ub.u[0] != 0);
    if (a_nan || b_nan) return unordered;

    /* Check ±0: both +0 and -0 are equal */
    int a_zero = (exp_a == 0) && (frac_a_hi == 0) && (ua.u[0] == 0);
    int b_zero = (exp_b == 0) && (frac_b_hi == 0) && (ub.u[0] == 0);
    if (a_zero && b_zero) return 0;

    /* Different signs: negative < positive */
    if (sign_a != sign_b) {
        return sign_a ? -1 : 1;
    }

    /* Same sign: compare magnitude (exponent then fraction) */
    int cmp;
    if (exp_a != exp_b) {
        cmp = (exp_a < exp_b) ? -1 : 1;
    } else if (frac_a_hi != frac_b_hi) {
        cmp = (frac_a_hi < frac_b_hi) ? -1 : 1;
    } else if (ua.u[0] != ub.u[0]) {
        cmp = (ua.u[0] < ub.u[0]) ? -1 : 1;
    } else {
        return 0; /* exactly equal */
    }

    /* If both negative, reverse the comparison */
    return sign_a ? -cmp : cmp;
}

int __eqtf2(fp128 a, fp128 b) {
    return fp128_compare(a, b, 1);
}

int __netf2(fp128 a, fp128 b) {
    return fp128_compare(a, b, 1);
}

int __letf2(fp128 a, fp128 b) {
    return fp128_compare(a, b, 1);
}

int __getf2(fp128 a, fp128 b) {
    return fp128_compare(a, b, -1);
}

int __lttf2(fp128 a, fp128 b) {
    return fp128_compare(a, b, 1);
}

int __gttf2(fp128 a, fp128 b) {
    return fp128_compare(a, b, -1);
}

int __unordtf2(fp128 a, fp128 b) {
    fp128_bits ua, ub;
    memcpy(&ua, &a, sizeof(ua));
    memcpy(&ub, &b, sizeof(ub));

    uint32_t exp_a = (ua.u[1] >> 48) & 0x7FFF;
    uint32_t exp_b = (ub.u[1] >> 48) & 0x7FFF;
    uint64_t frac_a_hi = ua.u[1] & 0x0000FFFFFFFFFFFFULL;
    uint64_t frac_b_hi = ub.u[1] & 0x0000FFFFFFFFFFFFULL;

    int a_nan = (exp_a == 0x7FFF) && (frac_a_hi != 0 || ua.u[0] != 0);
    int b_nan = (exp_b == 0x7FFF) && (frac_b_hi != 0 || ub.u[0] != 0);
    return a_nan || b_nan;
}

/* ===== 128-bit integer types ===== */

typedef struct { uint64_t lo; uint64_t hi; } u128;

typedef union {
    __int128 i;
    u128 parts;
} i128_bits;

/* ===== 128-bit integer shifts (needed by OpenSSL and other libraries) ===== */

/* Left shift: a << b */
__int128 __ashlti3(__int128 a, int b) {
    i128_bits ua;
    ua.i = a;
    uint64_t lo = ua.parts.lo, hi = ua.parts.hi;
    i128_bits result;
    if (b == 0) {
        return a;
    } else if (b >= 128) {
        result.parts.lo = 0;
        result.parts.hi = 0;
    } else if (b >= 64) {
        result.parts.lo = 0;
        result.parts.hi = lo << (b - 64);
    } else {
        result.parts.lo = lo << b;
        result.parts.hi = (hi << b) | (lo >> (64 - b));
    }
    return result.i;
}

/* Logical right shift: (unsigned)a >> b */
__int128 __lshrti3(__int128 a, int b) {
    i128_bits ua;
    ua.i = a;
    uint64_t lo = ua.parts.lo, hi = ua.parts.hi;
    i128_bits result;
    if (b == 0) {
        return a;
    } else if (b >= 128) {
        result.parts.lo = 0;
        result.parts.hi = 0;
    } else if (b >= 64) {
        result.parts.lo = hi >> (b - 64);
        result.parts.hi = 0;
    } else {
        result.parts.lo = (lo >> b) | (hi << (64 - b));
        result.parts.hi = hi >> b;
    }
    return result.i;
}

/* Arithmetic right shift: (signed)a >> b */
__int128 __ashrti3(__int128 a, int b) {
    i128_bits ua;
    ua.i = a;
    uint64_t lo = ua.parts.lo;
    int64_t hi = (int64_t)ua.parts.hi;
    i128_bits result;
    if (b == 0) {
        return a;
    } else if (b >= 128) {
        int64_t s = hi >> 63; /* all sign bits */
        result.parts.lo = (uint64_t)s;
        result.parts.hi = (uint64_t)s;
    } else if (b >= 64) {
        result.parts.lo = (uint64_t)(hi >> (b - 64));
        result.parts.hi = (uint64_t)(hi >> 63);
    } else {
        result.parts.lo = (lo >> b) | ((uint64_t)hi << (64 - b));
        result.parts.hi = (uint64_t)(hi >> b);
    }
    return result.i;
}

/* ===== 128-bit integer multiply (needed by scanf/printf internals) =====
 *
 * Clang lowers every __int128 multiply, including a 64x64->128 widening
 * one, to __multi3, so nothing in this body may be recognizable as a
 * 128-bit multiply. Clang 23's AggressiveInstCombine (foldMulHigh) turns
 * the high word of a split 32-bit multiply, computed on its own, into
 * `mul i128` of the zero-extended operands; the Wasm backend lowers that
 * back to a call to __multi3, so the previous body here called itself
 * until the stack overflowed. -fno-builtin does not stop that fold.
 *
 * mul_64x64 follows LLVM compiler-rt's __mulddi3 (lib/builtins/multi3.c):
 * the low and high words are built from the same partial sums, the form
 * upstream compiles its own __multi3 from and one foldMulHigh does not
 * match, because those sums have more than one use. Adapted from LLVM
 * compiler-rt, Apache-2.0 WITH LLVM-exception. The compiler-builtins
 * guest test (host/test/compiler-builtins-guest.test.ts) fails if any
 * function in this file calls itself.
 */

static u128 mul_64x64(uint64_t a, uint64_t b) {
    const uint64_t lower_mask = 0xFFFFFFFFULL;
    u128 r;
    r.lo = (a & lower_mask) * (b & lower_mask);
    uint64_t t = r.lo >> 32;
    r.lo &= lower_mask;
    t += (a >> 32) * (b & lower_mask);
    r.lo += (t & lower_mask) << 32;
    r.hi = t >> 32;
    t = r.lo >> 32;
    r.lo &= lower_mask;
    t += (b >> 32) * (a & lower_mask);
    r.lo += (t & lower_mask) << 32;
    r.hi += t >> 32;
    r.hi += (a >> 32) * (b >> 32);
    return r;
}

/* (a_hi * 2^64 + a_lo) * (b_hi * 2^64 + b_lo) mod 2^128
 * = a_lo*b_lo + (a_hi*b_lo + a_lo*b_hi) * 2^64 */
__int128 __multi3(__int128 a, __int128 b) {
    i128_bits ua, ub, r;
    ua.i = a;
    ub.i = b;
    r.parts = mul_64x64(ua.parts.lo, ub.parts.lo);
    r.parts.hi += ua.parts.hi * ub.parts.lo + ua.parts.lo * ub.parts.hi;
    return r.i;
}

/* ===== 128-bit integer division and modulo =====
 *
 * Clang lowers every __int128 `/` and `%` to these builtins. The toolchain
 * ships no compiler-rt builtins archive for wasm, so without them a program
 * that divides 128-bit integers links (the SDK allows undefined symbols) and
 * then traps on the missing host import. Restoring shift-subtract division
 * on the 64-bit-half helpers above keeps this file free of calls back into
 * compiler-rt. Division by zero traps, as wasm's own integer division does.
 */
static uint128_t_ u128_divmod(uint128_t_ a, uint128_t_ b, uint128_t_ *rem) {
    uint128_t_ q = {0, 0};
    if (u128_is_zero(b)) __builtin_trap();
    if (a.hi == 0 && b.hi == 0) {
        q.lo = a.lo / b.lo;
        if (rem) { rem->lo = a.lo % b.lo; rem->hi = 0; }
        return q;
    }
    if (!u128_ge(a, b)) {
        if (rem) *rem = a;
        return q;
    }
    int shift = u128_clz(b) - u128_clz(a);
    b = u128_shl(b, shift);
    for (int i = 0; i <= shift; i++) {
        q = u128_shl(q, 1);
        if (u128_ge(a, b)) {
            a = u128_sub(a, b);
            q.lo |= 1;
        }
        b = u128_shr(b, 1);
    }
    if (rem) *rem = a;
    return q;
}

static uint128_t_ u128_from_bits(__int128 v) {
    i128_bits b;
    b.i = v;
    uint128_t_ r = {b.parts.lo, b.parts.hi};
    return r;
}

static __int128 u128_to_bits(uint128_t_ v) {
    i128_bits b;
    b.parts.lo = v.lo;
    b.parts.hi = v.hi;
    return b.i;
}

/* Two's-complement magnitude; correct for INT128_MIN as well. */
static uint128_t_ u128_abs_signed(__int128 v) {
    uint128_t_ u = u128_from_bits(v);
    if ((int64_t)u.hi >= 0) return u;
    return u128_add(u128_not(u), u128_from64(1));
}

static uint128_t_ u128_negate(uint128_t_ v) {
    return u128_add(u128_not(v), u128_from64(1));
}

unsigned __int128 __udivmodti4(unsigned __int128 a, unsigned __int128 b,
                               unsigned __int128 *rem) {
    uint128_t_ r;
    uint128_t_ q = u128_divmod(u128_from_bits((__int128)a),
                               u128_from_bits((__int128)b), &r);
    if (rem) *rem = (unsigned __int128)u128_to_bits(r);
    return (unsigned __int128)u128_to_bits(q);
}

unsigned __int128 __udivti3(unsigned __int128 a, unsigned __int128 b) {
    return (unsigned __int128)u128_to_bits(
        u128_divmod(u128_from_bits((__int128)a), u128_from_bits((__int128)b), 0));
}

unsigned __int128 __umodti3(unsigned __int128 a, unsigned __int128 b) {
    uint128_t_ r;
    u128_divmod(u128_from_bits((__int128)a), u128_from_bits((__int128)b), &r);
    return (unsigned __int128)u128_to_bits(r);
}

/* C truncates toward zero: the quotient is negative when the signs differ
 * and the remainder takes the dividend's sign. */
__int128 __divti3(__int128 a, __int128 b) {
    uint128_t_ q = u128_divmod(u128_abs_signed(a), u128_abs_signed(b), 0);
    return u128_to_bits(((a < 0) != (b < 0)) ? u128_negate(q) : q);
}

__int128 __modti3(__int128 a, __int128 b) {
    uint128_t_ r;
    u128_divmod(u128_abs_signed(a), u128_abs_signed(b), &r);
    return u128_to_bits(a < 0 ? u128_negate(r) : r);
}

#ifdef __cplusplus
}
#endif
