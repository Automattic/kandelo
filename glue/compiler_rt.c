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

/* ===== fp128 → double conversion (no compiler-rt calls) ===== */

static double fp128_to_f64(fp128 a) {
    fp128_bits in;
    memcpy(&in, &a, sizeof(in));

    /* Extract fp128 fields */
    uint64_t lo = in.u[0];  /* fraction bits [0..63] */
    uint64_t hi = in.u[1];  /* fraction bits [64..111], exp [112..126], sign [127] */

    uint32_t sign = (hi >> 63) & 1;
    uint32_t exp128 = (hi >> 48) & 0x7FFF;
    /* Fraction: top 48 bits in hi[47:0], bottom 64 bits in lo */

    f64_bits out;

    if (exp128 == 0x7FFF) {
        /* Inf or NaN */
        uint64_t frac_hi = hi & 0x0000FFFFFFFFFFFFULL;
        if (frac_hi == 0 && lo == 0) {
            /* Infinity */
            out.u = ((uint64_t)sign << 63) | 0x7FF0000000000000ULL;
        } else {
            /* NaN - preserve some fraction bits */
            out.u = ((uint64_t)sign << 63) | 0x7FF8000000000000ULL | 1;
        }
        return out.f;
    }

    if (exp128 == 0) {
        /* Zero or subnormal → flush to zero for simplicity */
        out.u = (uint64_t)sign << 63;
        return out.f;
    }

    /* Normal number: convert exponent */
    int32_t unbiased = (int32_t)exp128 - 16383;

    if (unbiased > 1023) {
        /* Overflow → infinity */
        out.u = ((uint64_t)sign << 63) | 0x7FF0000000000000ULL;
        return out.f;
    }

    if (unbiased < -1074) {
        /* Underflow → zero */
        out.u = (uint64_t)sign << 63;
        return out.f;
    }

    /* Extract top 52 bits of the 112-bit fraction.
     * fp128 fraction: hi[47:0] are bits [111:64], lo is bits [63:0].
     * We want the top 52 bits = hi[47:0] (48 bits) + lo[63:60] (4 bits). */
    uint64_t frac52 = ((hi & 0x0000FFFFFFFFFFFFULL) << 4) | (lo >> 60);

    if (unbiased < -1022) {
        /* Subnormal double: shift fraction right */
        int shift = -1022 - unbiased;
        /* Add implicit 1 bit */
        frac52 = (1ULL << 52) | frac52;
        if (shift < 64) {
            frac52 >>= shift;
        } else {
            frac52 = 0;
        }
        out.u = ((uint64_t)sign << 63) | frac52;
        return out.f;
    }

    uint64_t exp64 = (uint64_t)(unbiased + 1023) & 0x7FF;
    out.u = ((uint64_t)sign << 63) | (exp64 << 52) | (frac52 & 0x000FFFFFFFFFFFFFULL);
    return out.f;
}

/* ===== double → fp128 conversion ===== */

static fp128 f64_to_fp128(double a) {
    f64_bits in;
    in.f = a;

    uint32_t sign = (in.u >> 63) & 1;
    uint32_t exp64 = (in.u >> 52) & 0x7FF;
    uint64_t frac52 = in.u & 0x000FFFFFFFFFFFFFULL;

    fp128_bits out;

    if (exp64 == 0x7FF) {
        /* Inf or NaN */
        out.u[1] = ((uint64_t)sign << 63) | (0x7FFFULL << 48);
        if (frac52 != 0) {
            out.u[1] |= 0x0000800000000000ULL; /* quiet NaN */
            out.u[0] = 1;
        } else {
            out.u[0] = 0;
        }
        fp128 result;
        memcpy(&result, &out, sizeof(result));
        return result;
    }

    if (exp64 == 0 && frac52 == 0) {
        /* Zero */
        out.u[1] = (uint64_t)sign << 63;
        out.u[0] = 0;
        fp128 result;
        memcpy(&result, &out, sizeof(result));
        return result;
    }

    int32_t unbiased;
    if (exp64 == 0) {
        /* Subnormal double → normalize */
        unbiased = -1022;
        while (!(frac52 & (1ULL << 52))) {
            frac52 <<= 1;
            unbiased--;
        }
        frac52 &= 0x000FFFFFFFFFFFFFULL; /* remove implicit 1 */
    } else {
        unbiased = (int32_t)exp64 - 1023;
    }

    uint64_t exp128 = (uint64_t)(unbiased + 16383) & 0x7FFF;

    /* Place 52-bit fraction into 112-bit field.
     * Top 48 bits of fraction → hi[47:0], remaining 4 bits → lo[63:60] */
    uint64_t frac_hi = frac52 >> 4;
    uint64_t frac_lo = (frac52 & 0xF) << 60;

    out.u[1] = ((uint64_t)sign << 63) | (exp128 << 48) | frac_hi;
    out.u[0] = frac_lo;

    fp128 result;
    memcpy(&result, &out, sizeof(result));
    return result;
}

/* ===== float → fp128 conversion ===== */

static fp128 f32_to_fp128(float a) {
    return f64_to_fp128((double)a);
}

/* ===== fp128 → float conversion ===== */

static float fp128_to_f32(fp128 a) {
    return (float)fp128_to_f64(a);
}

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

    /* Round: bits [2:0] are guard(2), round(1), sticky(0) */
    uint32_t round_bits = result_sig.lo & 0x7;
    result_sig = u128_shr(result_sig, 3); /* Remove guard/round/sticky */

    /* Round to nearest, ties to even */
    if (round_bits > 4 || (round_bits == 4 && (result_sig.lo & 1))) {
        result_sig = u128_add(result_sig, u128_from64(1));
        /* Check for carry into exponent */
        if (!u128_is_zero(u128_and(result_sig, u128_shl(u128_from64(1), 113)))) {
            result_sig = u128_shr(result_sig, 1);
            result_exp++;
        }
    }

    /* Handle overflow */
    if (result_exp >= FP128_EXP_INF) {
        return fp128_inf(result_sign);
    }

    /* Handle underflow to subnormal */
    if (result_exp <= 0) {
        int shift = 1 - result_exp;
        result_sig = u128_shr(result_sig, shift);
        result_exp = 0;
    }

    /* Strip implicit bit for normal numbers */
    uint128_t_ implicit = u128_shl(u128_from64(1), FP128_FRAC_BITS);
    if (result_exp > 0) {
        result_sig = u128_and(result_sig, u128_not(implicit));
    }

    return fp128_pack(result_sign, result_exp, result_sig);
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

    /* Add implicit bits */
    if (exp_a != 0) {
        sig_a = u128_or(sig_a, u128_shl(u128_from64(1), FP128_FRAC_BITS));
    } else {
        exp_a = 1; /* subnormal */
    }
    if (exp_b != 0) {
        sig_b = u128_or(sig_b, u128_shl(u128_from64(1), FP128_FRAC_BITS));
    } else {
        exp_b = 1;
    }

    /* Result exponent (before normalization) */
    int32_t result_exp = exp_a + exp_b - FP128_EXP_BIAS;

    /* Multiply: sig_a (113 bits) * sig_b (113 bits) → 226 bits.
     * The product has implicit bit at position 224 or 225 of the 256-bit result.
     * We need the top 116 bits (113 + 3 guard/round/sticky) plus a sticky
     * bit from everything below. */
    uint256_t_ prod = u128_mul_full(sig_a, sig_b);

    /* Find MSB of the 256-bit product. It's in w[3] at bit (127+128) or w[3]:w[2].
     * For two 113-bit significands, MSB is at bit 224 or 225. */
    uint128_t_ prod_hi = { prod.w[2], prod.w[3] };
    int lz = u128_clz(prod_hi);
    int msb_pos = 255 - lz; /* position in 256-bit product */

    /* We want 116 bits starting from msb_pos going down, placed at
     * positions [115:0] of result_sig. Position 115 = implicit bit,
     * positions [114:3] = fraction, positions [2:0] = guard/round/sticky.
     * Plus a sticky bit from all remaining lower bits. */
    int top_bit = msb_pos; /* e.g. 224 or 225 */
    int bottom_bit = top_bit - 115; /* lowest bit we extract, e.g. 109 or 110 */

    /* Extract bits [top_bit : bottom_bit] from the 256-bit product into result_sig.
     * Shift the product right by bottom_bit positions, then mask to 116 bits. */
    /* Shift the 256-bit product right by bottom_bit */
    uint128_t_ result_sig;
    if (bottom_bit >= 128) {
        /* Only need bits from high 128 */
        int shift = bottom_bit - 128;
        result_sig = u128_shr(prod_hi, shift);
    } else if (bottom_bit > 0) {
        /* Need bits spanning both high and low halves */
        uint128_t_ prod_lo = { prod.w[0], prod.w[1] };
        result_sig.lo = (prod_lo.lo >> bottom_bit) | (prod_lo.hi << (64 - bottom_bit));
        result_sig.hi = (prod_lo.hi >> bottom_bit) | (prod_hi.lo << (64 - bottom_bit));
        if (bottom_bit < 64) {
            result_sig.lo = (prod.w[1] << (64 - bottom_bit)) | (prod.w[0] >> bottom_bit);
            result_sig.hi = (prod.w[2] << (64 - bottom_bit)) | (prod.w[1] >> bottom_bit);
        } else {
            int s = bottom_bit - 64;
            if (s == 0) {
                result_sig.lo = prod.w[1];
                result_sig.hi = prod.w[2];
            } else {
                result_sig.lo = (prod.w[2] << (64 - s)) | (prod.w[1] >> s);
                result_sig.hi = (prod.w[3] << (64 - s)) | (prod.w[2] >> s);
            }
        }
    } else {
        uint128_t_ prod_lo = { prod.w[0], prod.w[1] };
        result_sig = prod_lo;
    }
    /* Mask to 116 bits (positions [115:0]) */
    result_sig.hi &= (1ULL << 52) - 1; /* 52 bits in hi (116-64=52) */

    /* Compute sticky from all bits below bottom_bit */
    int sticky = 0;
    if (bottom_bit > 0) {
        /* Check if any bits [bottom_bit-1 : 0] are set in the 256-bit product */
        if (bottom_bit >= 128) {
            sticky = (prod.w[0] != 0 || prod.w[1] != 0);
            if (bottom_bit > 128) {
                uint64_t mask = (bottom_bit - 128 >= 64) ? 0xFFFFFFFFFFFFFFFFULL
                              : ((1ULL << (bottom_bit - 128)) - 1);
                sticky |= (prod.w[2] & mask) != 0;
            }
            if (bottom_bit > 192) {
                uint64_t mask = ((1ULL << (bottom_bit - 192)) - 1);
                sticky |= (prod.w[3] & mask) != 0;
            }
        } else if (bottom_bit >= 64) {
            sticky = (prod.w[0] != 0);
            uint64_t mask = (bottom_bit - 64 >= 64) ? 0xFFFFFFFFFFFFFFFFULL
                          : ((1ULL << (bottom_bit - 64)) - 1);
            sticky |= (prod.w[1] & mask) != 0;
        } else {
            uint64_t mask = (1ULL << bottom_bit) - 1;
            sticky |= (prod.w[0] & mask) != 0;
        }
    }
    if (sticky) result_sig.lo |= 1; /* fold sticky into LSB */

    /* Adjust exponent: MSB should represent 2^(result_exp).
     * The MSB is at bit (top_bit) of the 256-bit product = bit (112+112)=224 nominally.
     * If at 225, product overflowed by 1 bit → add 1 to exponent. */
    result_exp += (top_bit - 224);

    /* Round: bits [2:0] are guard/round/sticky */
    uint32_t round_bits = result_sig.lo & 0x7;
    result_sig = u128_shr(result_sig, 3);

    if (round_bits > 4 || (round_bits == 4 && (result_sig.lo & 1))) {
        result_sig = u128_add(result_sig, u128_from64(1));
        if (!u128_is_zero(u128_and(result_sig, u128_shl(u128_from64(1), 113)))) {
            result_sig = u128_shr(result_sig, 1);
            result_exp++;
        }
    }

    /* Overflow */
    if (result_exp >= FP128_EXP_INF) {
        return fp128_inf(result_sign);
    }

    /* Underflow */
    if (result_exp <= 0) {
        int shift = 1 - result_exp;
        if (shift >= 113) return fp128_zero(result_sign);
        result_sig = u128_shr(result_sig, shift);
        result_exp = 0;
    }

    /* Strip implicit bit */
    if (result_exp > 0) {
        uint128_t_ implicit = u128_shl(u128_from64(1), FP128_FRAC_BITS);
        result_sig = u128_and(result_sig, u128_not(implicit));
    }

    return fp128_pack(result_sign, result_exp, result_sig);
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

    /* Sticky bit from remainder */
    if (!u128_is_zero(remainder)) quotient.lo |= 1;

    /* Now quotient has 116 bits: implicit at bit 115, fraction bits [114:3], guard bits [2:0] */
    /* If sig_a >= sig_b, first quotient bit is 1; otherwise 0.
     * If 0, shift left and decrement exponent */
    uint128_t_ bit115 = u128_shl(u128_from64(1), 115);
    if (u128_is_zero(u128_and(quotient, bit115))) {
        quotient = u128_shl(quotient, 1);
        result_exp--;
    }

    /* Round */
    uint32_t round_bits = quotient.lo & 0x7;
    uint128_t_ result_sig = u128_shr(quotient, 3);

    if (round_bits > 4 || (round_bits == 4 && (result_sig.lo & 1))) {
        result_sig = u128_add(result_sig, u128_from64(1));
        if (!u128_is_zero(u128_and(result_sig, u128_shl(u128_from64(1), 113)))) {
            result_sig = u128_shr(result_sig, 1);
            result_exp++;
        }
    }

    if (result_exp >= FP128_EXP_INF) return fp128_inf(result_sign);

    if (result_exp <= 0) {
        int shift = 1 - result_exp;
        if (shift >= 113) return fp128_zero(result_sign);
        result_sig = u128_shr(result_sig, shift);
        result_exp = 0;
    }

    if (result_exp > 0) {
        uint128_t_ implicit = u128_shl(u128_from64(1), FP128_FRAC_BITS);
        result_sig = u128_and(result_sig, u128_not(implicit));
    }

    return fp128_pack(result_sign, result_exp, result_sig);
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

/* Proper fp128 comparison — returns -1, 0, or 1.
 * Handles NaN (returns 1 for unordered), ±0, sign, exponent, and fraction. */
static int fp128_compare(fp128 a, fp128 b) {
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
    if (a_nan || b_nan) return 1; /* unordered */

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
    return fp128_compare(a, b);
}

int __netf2(fp128 a, fp128 b) {
    return fp128_compare(a, b);
}

int __letf2(fp128 a, fp128 b) {
    return fp128_compare(a, b);
}

int __getf2(fp128 a, fp128 b) {
    return fp128_compare(a, b);
}

int __lttf2(fp128 a, fp128 b) {
    return fp128_compare(a, b);
}

int __gttf2(fp128 a, fp128 b) {
    return fp128_compare(a, b);
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

/* ===== 128-bit integer multiply (needed by scanf/printf internals) ===== */

__int128 __multi3(__int128 a, __int128 b) {
    i128_bits ua, ub;
    ua.i = a;
    ub.i = b;

    uint64_t a_lo = ua.parts.lo, a_hi = ua.parts.hi;
    uint64_t b_lo = ub.parts.lo, b_hi = ub.parts.hi;

    /* (a_hi * 2^64 + a_lo) * (b_hi * 2^64 + b_lo) mod 2^128
     * = a_lo*b_lo + (a_lo*b_hi + a_hi*b_lo) * 2^64 */
    uint64_t lo = a_lo * b_lo;

    /* High 64 bits of a_lo * b_lo */
    /* Use the widening multiply: split into 32-bit pieces */
    uint64_t a_lo_lo = a_lo & 0xFFFFFFFF;
    uint64_t a_lo_hi = a_lo >> 32;
    uint64_t b_lo_lo = b_lo & 0xFFFFFFFF;
    uint64_t b_lo_hi = b_lo >> 32;

    uint64_t cross1 = a_lo_lo * b_lo_hi;
    uint64_t cross2 = a_lo_hi * b_lo_lo;
    uint64_t lo_lo = a_lo_lo * b_lo_lo;
    uint64_t hi_hi = a_lo_hi * b_lo_hi;

    uint64_t carry = ((lo_lo >> 32) + (cross1 & 0xFFFFFFFF) + (cross2 & 0xFFFFFFFF)) >> 32;
    uint64_t hi = hi_hi + (cross1 >> 32) + (cross2 >> 32) + carry;

    hi += a_lo * b_hi + a_hi * b_lo;

    i128_bits result;
    result.parts.lo = lo;
    result.parts.hi = hi;
    return result.i;
}

#ifdef __cplusplus
}
#endif
