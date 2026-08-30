/*
 * libffi_full_test — PR20 gate: the full libffi port (real type
 * classification in ffi_call + ffi_closure over the static trampoline
 * pool) against the matrix the glib/gobject stack exercises:
 * arities x {i32, i64, f32, f64, small-struct, big-struct} x
 * {ffi_call, ffi_closure}.
 *
 * The same driver compiles for the host (host/test/libffi-full-unit
 * .test.ts, fast iteration on classification + closure routing) and
 * for wasm32 under the kernel (ground truth). Aggregate call/closure
 * cases are wasm-only: the port dispatches a by-value struct as a
 * pointer to a scratch copy, which IS the wasm32 C ABI's byval/sret
 * lowering, but native ABIs pass small aggregates in registers, so the
 * pointer cast would be wrong there. Everything scalar — including the
 * signature encoder and struct size/alignment computation in
 * ffi_prep_cif — runs on both legs.
 *
 * Prints one line per failing case and "LIBFFI_FULL_OK cases=N" on
 * success; exits non-zero on any failure.
 */
#include <ffi.h>

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int failures = 0;
static int cases = 0;

#define CHECK(cond, name)                                                  \
    do {                                                                   \
        cases++;                                                           \
        if (!(cond)) {                                                     \
            failures++;                                                    \
            printf("FAIL %s (line %d)\n", (name), __LINE__);               \
        }                                                                  \
    } while (0)

static void check_i64(const char *name, int64_t got, int64_t want)
{
    cases++;
    if (got != want) {
        failures++;
        printf("FAIL %s: got %lld want %lld\n", name,
               (long long) got, (long long) want);
    }
}

static void check_f64(const char *name, double got, double want)
{
    cases++;
    if (memcmp(&got, &want, sizeof(double)) != 0) {
        failures++;
        printf("FAIL %s: got %f want %f\n", name, got, want);
    }
}

static void check_f32(const char *name, float got, float want)
{
    cases++;
    if (memcmp(&got, &want, sizeof(float)) != 0) {
        failures++;
        printf("FAIL %s: got %f want %f\n", name, (double) got,
               (double) want);
    }
}

/* ---------------------------------------------------------------------
 * Struct types shared by the encoder, call and closure sections.
 * ------------------------------------------------------------------- */

struct s1   { int32_t a; };                 /* singleton -> i32 class  */
struct sf1  { float a; };                   /* singleton -> f32 class  */
struct sd1  { double a; };                  /* singleton -> f64 class  */
struct sl1  { int64_t a; };                 /* singleton -> i64 class  */
struct snest { struct s1 inner; };          /* nested singleton -> i32 */
struct s2   { int32_t a; int32_t b; };      /* small, indirect         */
struct smix { int32_t a; double b; };       /* align 8, indirect       */
struct sbig { uint8_t buf[64]; };           /* big, indirect           */

static ffi_type *s1_elems[]    = { &ffi_type_sint32, NULL };
static ffi_type *sf1_elems[]   = { &ffi_type_float, NULL };
static ffi_type *sd1_elems[]   = { &ffi_type_double, NULL };
static ffi_type *sl1_elems[]   = { &ffi_type_sint64, NULL };
static ffi_type *s2_elems[]    = { &ffi_type_sint32, &ffi_type_sint32, NULL };
static ffi_type *smix_elems[]  = { &ffi_type_sint32, &ffi_type_double, NULL };
static ffi_type *sbig_elems[65];
static ffi_type  s1_type    = { 0, 0, FFI_TYPE_STRUCT, s1_elems };
static ffi_type  sf1_type   = { 0, 0, FFI_TYPE_STRUCT, sf1_elems };
static ffi_type  sd1_type   = { 0, 0, FFI_TYPE_STRUCT, sd1_elems };
static ffi_type  sl1_type   = { 0, 0, FFI_TYPE_STRUCT, sl1_elems };
static ffi_type  s2_type    = { 0, 0, FFI_TYPE_STRUCT, s2_elems };
static ffi_type  smix_type  = { 0, 0, FFI_TYPE_STRUCT, smix_elems };
static ffi_type  sbig_type  = { 0, 0, FFI_TYPE_STRUCT, sbig_elems };
static ffi_type *snest_elems[] = { &s1_type, NULL };
static ffi_type  snest_type = { 0, 0, FFI_TYPE_STRUCT, snest_elems };

static void init_struct_types(void)
{
    for (int i = 0; i < 64; i++)
        sbig_elems[i] = &ffi_type_uint8;
    sbig_elems[64] = NULL;
}

/* ---------------------------------------------------------------------
 * Section 1 — ffi_prep_cif computes aggregate size/alignment (both legs).
 * ------------------------------------------------------------------- */

static void test_encoder(void)
{
    ffi_cif cif;
    ffi_type *args[1] = { &s2_type };

    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_void, args)
              == FFI_OK, "prep s2 arg");
    CHECK(s2_type.size == sizeof(struct s2), "s2 size");
    CHECK(s2_type.alignment == _Alignof(struct s2), "s2 align");

    args[0] = &smix_type;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_void, args)
              == FFI_OK, "prep smix arg");
    CHECK(smix_type.size == sizeof(struct smix), "smix size");
    CHECK(smix_type.alignment == _Alignof(struct smix), "smix align");

    args[0] = &sbig_type;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_void, args)
              == FFI_OK, "prep sbig arg");
    CHECK(sbig_type.size == sizeof(struct sbig), "sbig size");
    CHECK(sbig_type.alignment == _Alignof(struct sbig), "sbig align");

    args[0] = &snest_type;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_void, args)
              == FFI_OK, "prep snest arg");
    CHECK(snest_type.size == sizeof(struct snest), "snest size");
    CHECK(sl1_type.elements == sl1_elems, "sl1 elements untouched");

    args[0] = &sl1_type;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_void, args)
              == FFI_OK, "prep sl1 arg");
    CHECK(sl1_type.size == sizeof(struct sl1), "sl1 size");
    CHECK(sl1_type.alignment == _Alignof(struct sl1), "sl1 align");

    args[0] = &sf1_type;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_void, args)
              == FFI_OK, "prep sf1 arg");
    CHECK(sf1_type.size == sizeof(struct sf1), "sf1 size");

    args[0] = &sd1_type;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_void, args)
              == FFI_OK, "prep sd1 arg");
    CHECK(sd1_type.size == sizeof(struct sd1), "sd1 size");
    CHECK(sd1_type.alignment == _Alignof(struct sd1), "sd1 align");
}

/* ---------------------------------------------------------------------
 * Section 2 — ffi_call, all-i32 arities 0..8, every return class.
 *
 * Each target multiplies argument i by a distinct prime so a swapped
 * or dropped slot changes the checksum.
 * ------------------------------------------------------------------- */

static const int64_t PRIME[8] = { 3, 5, 7, 11, 13, 17, 19, 23 };

static int64_t void_sink;

#define DEF_I32_TARGETS(N, PARAMS, SUM)                                    \
    static void    tv_i32_##N PARAMS { void_sink = (SUM); }                \
    static int32_t ti_i32_##N PARAMS { return (int32_t) (SUM); }           \
    static int64_t tl_i32_##N PARAMS { return (SUM); }                     \
    static float   tf_i32_##N PARAMS { return (float) (SUM); }             \
    static double  td_i32_##N PARAMS { return (double) (SUM); }

DEF_I32_TARGETS(0, (void), 29)
DEF_I32_TARGETS(1, (int32_t a0), a0 * PRIME[0])
DEF_I32_TARGETS(2, (int32_t a0, int32_t a1), a0 * PRIME[0] + a1 * PRIME[1])
DEF_I32_TARGETS(3, (int32_t a0, int32_t a1, int32_t a2),
                a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2])
DEF_I32_TARGETS(4, (int32_t a0, int32_t a1, int32_t a2, int32_t a3),
                a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2] + a3 * PRIME[3])
DEF_I32_TARGETS(5, (int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                    int32_t a4),
                a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2] +
                a3 * PRIME[3] + a4 * PRIME[4])
DEF_I32_TARGETS(6, (int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                    int32_t a4, int32_t a5),
                a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2] +
                a3 * PRIME[3] + a4 * PRIME[4] + a5 * PRIME[5])
DEF_I32_TARGETS(7, (int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                    int32_t a4, int32_t a5, int32_t a6),
                a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2] +
                a3 * PRIME[3] + a4 * PRIME[4] + a5 * PRIME[5] +
                a6 * PRIME[6])
DEF_I32_TARGETS(8, (int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                    int32_t a4, int32_t a5, int32_t a6, int32_t a7),
                a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2] +
                a3 * PRIME[3] + a4 * PRIME[4] + a5 * PRIME[5] +
                a6 * PRIME[6] + a7 * PRIME[7])

static void call_i32_arity(unsigned n, void (*fv)(void), void (*fi)(void),
                           void (*fl)(void), void (*ff)(void),
                           void (*fd)(void))
{
    ffi_cif cif;
    ffi_type *atypes[8];
    int32_t vals[8];
    void *avalue[8];
    int64_t expect = (n == 0) ? 29 : 0;
    char name[64];

    for (unsigned i = 0; i < n; i++) {
        atypes[i] = &ffi_type_sint32;
        vals[i] = (int32_t) (100 + i);
        avalue[i] = &vals[i];
        expect += (int64_t) vals[i] * PRIME[i];
    }

    snprintf(name, sizeof(name), "call i32x%u", n);

    void_sink = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n, &ffi_type_void, atypes)
              == FFI_OK, name);
    ffi_call(&cif, fv, NULL, avalue);
    check_i64(name, void_sink, expect);

    ffi_arg ri = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n, &ffi_type_sint32, atypes)
              == FFI_OK, name);
    ffi_call(&cif, fi, &ri, avalue);
    check_i64(name, (int32_t) ri, (int32_t) expect);

    int64_t rl = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n, &ffi_type_sint64, atypes)
              == FFI_OK, name);
    ffi_call(&cif, fl, &rl, avalue);
    check_i64(name, rl, expect);

    float rf = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n, &ffi_type_float, atypes)
              == FFI_OK, name);
    ffi_call(&cif, ff, &rf, avalue);
    check_f32(name, rf, (float) expect);

    double rd = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n, &ffi_type_double, atypes)
              == FFI_OK, name);
    ffi_call(&cif, fd, &rd, avalue);
    check_f64(name, rd, (double) expect);
}

#define CALL_I32_ARITY(N)                                                  \
    call_i32_arity(N, (void (*)(void)) tv_i32_##N,                         \
                   (void (*)(void)) ti_i32_##N,                            \
                   (void (*)(void)) tl_i32_##N,                            \
                   (void (*)(void)) tf_i32_##N,                            \
                   (void (*)(void)) td_i32_##N)

static void test_call_i32_arities(void)
{
    CALL_I32_ARITY(0);
    CALL_I32_ARITY(1);
    CALL_I32_ARITY(2);
    CALL_I32_ARITY(3);
    CALL_I32_ARITY(4);
    CALL_I32_ARITY(5);
    CALL_I32_ARITY(6);
    CALL_I32_ARITY(7);
    CALL_I32_ARITY(8);
}

/* ---------------------------------------------------------------------
 * Section 3 — ffi_call, one non-i32 argument in every position
 * (arities 1, 3 and 6), and non-i32 pairs. i64 values exceed 2^32 to
 * prove the full word travels.
 * ------------------------------------------------------------------- */

#define BIG64 0x123456789abLL

/* one i64/f32/f64 at position P, the rest i32 */
#define DEF_MIX1(NAME, PARAMS, SUM)                                        \
    static int64_t tl_##NAME PARAMS { return (SUM); }

DEF_MIX1(l_p0_a1, (int64_t a0), a0)
DEF_MIX1(f_p0_a1, (float a0), (int64_t) a0)
DEF_MIX1(d_p0_a1, (double a0), (int64_t) a0)

DEF_MIX1(l_p0_a3, (int64_t a0, int32_t a1, int32_t a2),
         a0 + a1 * PRIME[1] + a2 * PRIME[2])
DEF_MIX1(l_p1_a3, (int32_t a0, int64_t a1, int32_t a2),
         a0 * PRIME[0] + a1 + a2 * PRIME[2])
DEF_MIX1(l_p2_a3, (int32_t a0, int32_t a1, int64_t a2),
         a0 * PRIME[0] + a1 * PRIME[1] + a2)
DEF_MIX1(f_p0_a3, (float a0, int32_t a1, int32_t a2),
         (int64_t) a0 + a1 * PRIME[1] + a2 * PRIME[2])
DEF_MIX1(f_p1_a3, (int32_t a0, float a1, int32_t a2),
         a0 * PRIME[0] + (int64_t) a1 + a2 * PRIME[2])
DEF_MIX1(f_p2_a3, (int32_t a0, int32_t a1, float a2),
         a0 * PRIME[0] + a1 * PRIME[1] + (int64_t) a2)
DEF_MIX1(d_p0_a3, (double a0, int32_t a1, int32_t a2),
         (int64_t) a0 + a1 * PRIME[1] + a2 * PRIME[2])
DEF_MIX1(d_p1_a3, (int32_t a0, double a1, int32_t a2),
         a0 * PRIME[0] + (int64_t) a1 + a2 * PRIME[2])
DEF_MIX1(d_p2_a3, (int32_t a0, int32_t a1, double a2),
         a0 * PRIME[0] + a1 * PRIME[1] + (int64_t) a2)

/* the double-returning shapes call_mix1_d drives */
static double td_l_p1_a3(int32_t a0, int64_t a1, int32_t a2)
{
    return (double) (a0 * PRIME[0] + a1 + a2 * PRIME[2]);
}

static double td_f_p1_a3(int32_t a0, float a1, int32_t a2)
{
    return (double) (a0 * PRIME[0] + (int64_t) a1 + a2 * PRIME[2]);
}

static double td_d_p1_a3(int32_t a0, double a1, int32_t a2)
{
    return (double) (a0 * PRIME[0] + (int64_t) a1 + a2 * PRIME[2]);
}

DEF_MIX1(l_p0_a6, (int64_t a0, int32_t a1, int32_t a2, int32_t a3,
                   int32_t a4, int32_t a5),
         a0 + a1 * PRIME[1] + a2 * PRIME[2] + a3 * PRIME[3] +
         a4 * PRIME[4] + a5 * PRIME[5])
DEF_MIX1(l_p3_a6, (int32_t a0, int32_t a1, int32_t a2, int64_t a3,
                   int32_t a4, int32_t a5),
         a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2] + a3 +
         a4 * PRIME[4] + a5 * PRIME[5])
DEF_MIX1(l_p5_a6, (int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                   int32_t a4, int64_t a5),
         a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2] + a3 * PRIME[3] +
         a4 * PRIME[4] + a5)
DEF_MIX1(d_p0_a6, (double a0, int32_t a1, int32_t a2, int32_t a3,
                   int32_t a4, int32_t a5),
         (int64_t) a0 + a1 * PRIME[1] + a2 * PRIME[2] + a3 * PRIME[3] +
         a4 * PRIME[4] + a5 * PRIME[5])
DEF_MIX1(d_p3_a6, (int32_t a0, int32_t a1, int32_t a2, double a3,
                   int32_t a4, int32_t a5),
         a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2] + (int64_t) a3 +
         a4 * PRIME[4] + a5 * PRIME[5])
DEF_MIX1(d_p5_a6, (int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                   int32_t a4, double a5),
         a0 * PRIME[0] + a1 * PRIME[1] + a2 * PRIME[2] + a3 * PRIME[3] +
         a4 * PRIME[4] + (int64_t) a5)
DEF_MIX1(f_p2_a6, (int32_t a0, int32_t a1, float a2, int32_t a3,
                   int32_t a4, int32_t a5),
         a0 * PRIME[0] + a1 * PRIME[1] + (int64_t) a2 + a3 * PRIME[3] +
         a4 * PRIME[4] + a5 * PRIME[5])

/* pairs at positions (1,3) of arity 4 */
#define DEF_MIX2(NAME, T1, T2)                                             \
    static int64_t tl_##NAME(int32_t a0, T1 a1, int32_t a2, T2 a3)         \
    {                                                                      \
        return a0 * PRIME[0] + (int64_t) a1 * PRIME[1] +                   \
               a2 * PRIME[2] + (int64_t) a3 * PRIME[3];                    \
    }

DEF_MIX2(ll, int64_t, int64_t)
DEF_MIX2(lf, int64_t, float)
DEF_MIX2(ld, int64_t, double)
DEF_MIX2(fl, float, int64_t)
DEF_MIX2(ff, float, float)
DEF_MIX2(fd, float, double)
DEF_MIX2(dl, double, int64_t)
DEF_MIX2(df, double, float)
DEF_MIX2(dd, double, double)

static double t_gesture(double x, double y) { return x * 3.0 + y * 5.0; }

struct mixval {
    ffi_type *type;
    int64_t l;
    float f;
    double d;
};

static void set_mixval(struct mixval *v, char cls, int64_t scalar)
{
    v->type = (cls == 'l') ? &ffi_type_sint64
            : (cls == 'f') ? &ffi_type_float
                           : &ffi_type_double;
    v->l = (cls == 'l') ? BIG64 + scalar : 0;
    v->f = (cls == 'f') ? (float) (scalar * 2) : 0;
    v->d = (cls == 'd') ? (double) (scalar * 4) : 0;
}

static int64_t mixval_i64(const struct mixval *v)
{
    if (v->type == &ffi_type_sint64) return v->l;
    if (v->type == &ffi_type_float) return (int64_t) v->f;
    return (int64_t) v->d;
}

static void *mixval_ptr(struct mixval *v)
{
    if (v->type == &ffi_type_sint64) return &v->l;
    if (v->type == &ffi_type_float) return &v->f;
    return &v->d;
}

static void call_mix1(const char *name, void (*fn)(void), unsigned n,
                      unsigned pos, char cls)
{
    ffi_cif cif;
    ffi_type *atypes[6];
    int32_t ivals[6];
    struct mixval mv;
    void *avalue[6];
    int64_t expect = 0;

    set_mixval(&mv, cls, 7);
    for (unsigned i = 0; i < n; i++) {
        if (i == pos) {
            atypes[i] = mv.type;
            avalue[i] = mixval_ptr(&mv);
            expect += mixval_i64(&mv);
        } else {
            ivals[i] = (int32_t) (200 + i);
            atypes[i] = &ffi_type_sint32;
            avalue[i] = &ivals[i];
            expect += (int64_t) ivals[i] * PRIME[i];
        }
    }

    int64_t rl = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n, &ffi_type_sint64, atypes)
              == FFI_OK, name);
    ffi_call(&cif, fn, &rl, avalue);
    check_i64(name, rl, expect);
}

static void call_mix1_d(const char *name, void (*fn)(void), unsigned n,
                        unsigned pos, char cls)
{
    ffi_cif cif;
    ffi_type *atypes[6];
    int32_t ivals[6];
    struct mixval mv;
    void *avalue[6];
    int64_t expect = 0;

    set_mixval(&mv, cls, 9);
    for (unsigned i = 0; i < n; i++) {
        if (i == pos) {
            atypes[i] = mv.type;
            avalue[i] = mixval_ptr(&mv);
            expect += mixval_i64(&mv);
        } else {
            ivals[i] = (int32_t) (300 + i);
            atypes[i] = &ffi_type_sint32;
            avalue[i] = &ivals[i];
            expect += (int64_t) ivals[i] * PRIME[i];
        }
    }

    double rd = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n, &ffi_type_double, atypes)
              == FFI_OK, name);
    ffi_call(&cif, fn, &rd, avalue);
    check_f64(name, rd, (double) expect);
}

static void call_mix2(const char *name, void (*fn)(void), char c1, char c2)
{
    ffi_cif cif;
    ffi_type *atypes[4];
    int32_t i0 = 41, i2 = 43;
    struct mixval m1, m3;
    void *avalue[4];

    set_mixval(&m1, c1, 11);
    set_mixval(&m3, c2, 13);
    atypes[0] = &ffi_type_sint32;
    atypes[1] = m1.type;
    atypes[2] = &ffi_type_sint32;
    atypes[3] = m3.type;
    avalue[0] = &i0;
    avalue[1] = mixval_ptr(&m1);
    avalue[2] = &i2;
    avalue[3] = mixval_ptr(&m3);

    int64_t expect = i0 * PRIME[0] + mixval_i64(&m1) * PRIME[1] +
                     i2 * PRIME[2] + mixval_i64(&m3) * PRIME[3];

    int64_t rl = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 4, &ffi_type_sint64, atypes)
              == FFI_OK, name);
    ffi_call(&cif, fn, &rl, avalue);
    check_i64(name, rl, expect);
}

static void test_call_mixed(void)
{
    call_mix1("mix l@0/1", (void (*)(void)) tl_l_p0_a1, 1, 0, 'l');
    call_mix1("mix f@0/1", (void (*)(void)) tl_f_p0_a1, 1, 0, 'f');
    call_mix1("mix d@0/1", (void (*)(void)) tl_d_p0_a1, 1, 0, 'd');

    call_mix1("mix l@0/3", (void (*)(void)) tl_l_p0_a3, 3, 0, 'l');
    call_mix1("mix l@1/3", (void (*)(void)) tl_l_p1_a3, 3, 1, 'l');
    call_mix1("mix l@2/3", (void (*)(void)) tl_l_p2_a3, 3, 2, 'l');
    call_mix1("mix f@0/3", (void (*)(void)) tl_f_p0_a3, 3, 0, 'f');
    call_mix1("mix f@1/3", (void (*)(void)) tl_f_p1_a3, 3, 1, 'f');
    call_mix1("mix f@2/3", (void (*)(void)) tl_f_p2_a3, 3, 2, 'f');
    call_mix1("mix d@0/3", (void (*)(void)) tl_d_p0_a3, 3, 0, 'd');
    call_mix1("mix d@1/3", (void (*)(void)) tl_d_p1_a3, 3, 1, 'd');
    call_mix1("mix d@2/3", (void (*)(void)) tl_d_p2_a3, 3, 2, 'd');

    call_mix1_d("mixd d@1/3", (void (*)(void)) td_d_p1_a3, 3, 1, 'd');
    call_mix1_d("mixd f@1/3", (void (*)(void)) td_f_p1_a3, 3, 1, 'f');
    call_mix1_d("mixd l@1/3", (void (*)(void)) td_l_p1_a3, 3, 1, 'l');

    call_mix1("mix l@0/6", (void (*)(void)) tl_l_p0_a6, 6, 0, 'l');
    call_mix1("mix l@3/6", (void (*)(void)) tl_l_p3_a6, 6, 3, 'l');
    call_mix1("mix l@5/6", (void (*)(void)) tl_l_p5_a6, 6, 5, 'l');
    call_mix1("mix d@0/6", (void (*)(void)) tl_d_p0_a6, 6, 0, 'd');
    call_mix1("mix d@3/6", (void (*)(void)) tl_d_p3_a6, 6, 3, 'd');
    call_mix1("mix d@5/6", (void (*)(void)) tl_d_p5_a6, 6, 5, 'd');
    call_mix1("mix f@2/6", (void (*)(void)) tl_f_p2_a6, 6, 2, 'f');

    call_mix2("pair ll", (void (*)(void)) tl_ll, 'l', 'l');
    call_mix2("pair lf", (void (*)(void)) tl_lf, 'l', 'f');
    call_mix2("pair ld", (void (*)(void)) tl_ld, 'l', 'd');
    call_mix2("pair fl", (void (*)(void)) tl_fl, 'f', 'l');
    call_mix2("pair ff", (void (*)(void)) tl_ff, 'f', 'f');
    call_mix2("pair fd", (void (*)(void)) tl_fd, 'f', 'd');
    call_mix2("pair dl", (void (*)(void)) tl_dl, 'd', 'l');
    call_mix2("pair df", (void (*)(void)) tl_df, 'd', 'f');
    call_mix2("pair dd", (void (*)(void)) tl_dd, 'd', 'd');

    /* the GtkGesture shape: (double, double) -> double */
    {
        ffi_cif cif;
        ffi_type *atypes[2] = { &ffi_type_double, &ffi_type_double };
        double x = 1.5, y = 2.25, rd = 0;
        void *avalue[2] = { &x, &y };
        CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_double,
                           atypes) == FFI_OK, "gesture prep");
        ffi_call(&cif, (void (*)(void)) t_gesture, &rd, avalue);
        check_f64("gesture", rd, t_gesture(x, y));
    }
}

/* ---------------------------------------------------------------------
 * Section 4 — small-int argument extension and return widening.
 * ffi_call's contract: integral returns narrower than ffi_arg are
 * widened to a full ffi_arg (signed types sign-extend).
 * ------------------------------------------------------------------- */

static int64_t t_i8(int8_t v, int32_t w) { return (int64_t) v * 3 + w; }
static int64_t t_u8(uint8_t v, int32_t w) { return (int64_t) v * 3 + w; }
static int64_t t_i16(int16_t v, int32_t w) { return (int64_t) v * 3 + w; }
static int64_t t_u16(uint16_t v, int32_t w) { return (int64_t) v * 3 + w; }
static int8_t  r_i8(int32_t v) { return (int8_t) v; }
static uint8_t r_u8(int32_t v) { return (uint8_t) v; }
static int16_t r_i16(int32_t v) { return (int16_t) v; }
static uint16_t r_u16(int32_t v) { return (uint16_t) v; }

static void test_small_ints(void)
{
    ffi_cif cif;
    ffi_type *atypes[2];
    void *avalue[2];
    int32_t w = 1000;
    int64_t rl;

    int8_t i8 = -5;
    atypes[0] = &ffi_type_sint8;
    atypes[1] = &ffi_type_sint32;
    avalue[0] = &i8;
    avalue[1] = &w;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint64, atypes)
              == FFI_OK, "prep i8 arg");
    ffi_call(&cif, (void (*)(void)) t_i8, &rl, avalue);
    check_i64("i8 arg sext", rl, t_i8(i8, w));

    uint8_t u8 = 0xab;
    atypes[0] = &ffi_type_uint8;
    avalue[0] = &u8;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint64, atypes)
              == FFI_OK, "prep u8 arg");
    ffi_call(&cif, (void (*)(void)) t_u8, &rl, avalue);
    check_i64("u8 arg zext", rl, t_u8(u8, w));

    int16_t i16 = -3000;
    atypes[0] = &ffi_type_sint16;
    avalue[0] = &i16;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint64, atypes)
              == FFI_OK, "prep i16 arg");
    ffi_call(&cif, (void (*)(void)) t_i16, &rl, avalue);
    check_i64("i16 arg sext", rl, t_i16(i16, w));

    uint16_t u16 = 0xbeef;
    atypes[0] = &ffi_type_uint16;
    avalue[0] = &u16;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint64, atypes)
              == FFI_OK, "prep u16 arg");
    ffi_call(&cif, (void (*)(void)) t_u16, &rl, avalue);
    check_i64("u16 arg zext", rl, t_u16(u16, w));

    ffi_arg ra;
    int32_t seed = -7;
    atypes[0] = &ffi_type_sint32;
    avalue[0] = &seed;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_sint8, atypes)
              == FFI_OK, "prep i8 ret");
    ffi_call(&cif, (void (*)(void)) r_i8, &ra, avalue);
    check_i64("i8 ret widened", (int64_t) (ffi_sarg) ra, -7);

    seed = 0x1ab;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_uint8, atypes)
              == FFI_OK, "prep u8 ret");
    ffi_call(&cif, (void (*)(void)) r_u8, &ra, avalue);
    check_i64("u8 ret widened", (int64_t) ra, 0xab);

    seed = -30000;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_sint16, atypes)
              == FFI_OK, "prep i16 ret");
    ffi_call(&cif, (void (*)(void)) r_i16, &ra, avalue);
    check_i64("i16 ret widened", (int64_t) (ffi_sarg) ra, -30000);

    seed = 0x1beef;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_uint16, atypes)
              == FFI_OK, "prep u16 ret");
    ffi_call(&cif, (void (*)(void)) r_u16, &ra, avalue);
    check_i64("u16 ret widened", (int64_t) ra, 0xbeef);
}

/* ---------------------------------------------------------------------
 * Section 5 — by-value structs through ffi_call (wasm32 only: the
 * pointer-cast dispatch is the wasm32 byval/sret lowering; native ABIs
 * pass these in registers).
 * ------------------------------------------------------------------- */

#ifdef __wasm__

static int32_t t_s1(struct s1 v) { return v.a * 3; }
static float   t_sf1(struct sf1 v) { return v.a * 2.0f; }
static double  t_sd1(struct sd1 v) { return v.a * 2.0; }
static int64_t t_sl1(struct sl1 v) { return v.a + 1; }
static int32_t t_snest(struct snest v) { return v.inner.a * 5; }

static int64_t t_s2_p0(struct s2 v, int32_t x, int32_t y)
{
    int64_t r = (int64_t) v.a * 3 + (int64_t) v.b * 5 + x * 7 + y * 11;
    v.a = 0; /* clobber the byval copy — the caller's struct must survive */
    return r;
}

static int64_t t_s2_p1(int32_t x, struct s2 v, int32_t y)
{
    return x * 3 + (int64_t) v.a * 5 + (int64_t) v.b * 7 + y * 11;
}

static int64_t t_s2_p2(int32_t x, int32_t y, struct s2 v)
{
    return x * 3 + y * 5 + (int64_t) v.a * 7 + (int64_t) v.b * 11;
}

static double t_smix(int32_t x, struct smix v)
{
    return x * 3.0 + v.a * 5.0 + v.b;
}

static int64_t t_sbig(struct sbig v)
{
    int64_t sum = 0;
    for (int i = 0; i < 64; i++) {
        sum += (int64_t) v.buf[i] * (i + 1);
        v.buf[i] = 0; /* clobber the byval copy */
    }
    return sum;
}

static struct s1 r_s1(int32_t seed)
{
    struct s1 v = { seed * 3 };
    return v;
}

static struct s2 r_s2(int32_t seed)
{
    struct s2 v = { seed * 3, seed * 5 };
    return v;
}

static struct smix r_smix(int32_t seed)
{
    struct smix v = { seed, seed * 2.5 };
    return v;
}

static struct sbig r_sbig(int32_t seed)
{
    struct sbig v;
    for (int i = 0; i < 64; i++)
        v.buf[i] = (uint8_t) (seed + i);
    return v;
}

static void test_call_structs(void)
{
    ffi_cif cif;
    ffi_type *atypes[3];
    void *avalue[3];

    struct s1 v1 = { 21 };
    ffi_arg ri = 0;
    atypes[0] = &s1_type;
    avalue[0] = &v1;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_sint32, atypes)
              == FFI_OK, "prep s1");
    ffi_call(&cif, (void (*)(void)) t_s1, &ri, avalue);
    check_i64("singleton s1 arg", (int32_t) ri, t_s1(v1));

    struct sf1 vf = { 1.25f };
    float rf = 0;
    atypes[0] = &sf1_type;
    avalue[0] = &vf;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_float, atypes)
              == FFI_OK, "prep sf1");
    ffi_call(&cif, (void (*)(void)) t_sf1, &rf, avalue);
    check_f32("singleton sf1 arg", rf, t_sf1(vf));

    struct sd1 vd = { 2.5 };
    double rd = 0;
    atypes[0] = &sd1_type;
    avalue[0] = &vd;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_double, atypes)
              == FFI_OK, "prep sd1");
    ffi_call(&cif, (void (*)(void)) t_sd1, &rd, avalue);
    check_f64("singleton sd1 arg", rd, t_sd1(vd));

    struct sl1 vl = { BIG64 };
    int64_t rl = 0;
    atypes[0] = &sl1_type;
    avalue[0] = &vl;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_sint64, atypes)
              == FFI_OK, "prep sl1");
    ffi_call(&cif, (void (*)(void)) t_sl1, &rl, avalue);
    check_i64("singleton sl1 arg", rl, t_sl1(vl));

    struct snest vn = { { 9 } };
    ri = 0;
    atypes[0] = &snest_type;
    avalue[0] = &vn;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_sint32, atypes)
              == FFI_OK, "prep snest");
    ffi_call(&cif, (void (*)(void)) t_snest, &ri, avalue);
    check_i64("nested singleton arg", ri, t_snest(vn));

    struct s2 v2 = { 31, 37 };
    int32_t x = 5, y = 6;
    atypes[0] = &s2_type;
    atypes[1] = &ffi_type_sint32;
    atypes[2] = &ffi_type_sint32;
    avalue[0] = &v2;
    avalue[1] = &x;
    avalue[2] = &y;
    rl = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_sint64, atypes)
              == FFI_OK, "prep s2@0");
    ffi_call(&cif, (void (*)(void)) t_s2_p0, &rl, avalue);
    check_i64("s2 arg @0", rl,
              (int64_t) 31 * 3 + 37 * 5 + x * 7 + y * 11);
    check_i64("s2 byval clobber isolated", v2.a, 31);

    atypes[0] = &ffi_type_sint32;
    atypes[1] = &s2_type;
    avalue[0] = &x;
    avalue[1] = &v2;
    rl = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_sint64, atypes)
              == FFI_OK, "prep s2@1");
    ffi_call(&cif, (void (*)(void)) t_s2_p1, &rl, avalue);
    check_i64("s2 arg @1", rl, t_s2_p1(x, v2, y));

    atypes[1] = &ffi_type_sint32;
    atypes[2] = &s2_type;
    avalue[1] = &y;
    avalue[2] = &v2;
    rl = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_sint64, atypes)
              == FFI_OK, "prep s2@2");
    ffi_call(&cif, (void (*)(void)) t_s2_p2, &rl, avalue);
    check_i64("s2 arg @2", rl, t_s2_p2(x, y, v2));

    struct smix vm = { 3, 0.75 };
    atypes[0] = &ffi_type_sint32;
    atypes[1] = &smix_type;
    avalue[0] = &x;
    avalue[1] = &vm;
    rd = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_double, atypes)
              == FFI_OK, "prep smix");
    ffi_call(&cif, (void (*)(void)) t_smix, &rd, avalue);
    check_f64("smix arg", rd, t_smix(x, vm));

    struct sbig vb;
    for (int i = 0; i < 64; i++)
        vb.buf[i] = (uint8_t) (i * 3 + 1);
    struct sbig vb_orig = vb;
    atypes[0] = &sbig_type;
    avalue[0] = &vb;
    rl = 0;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_sint64, atypes)
              == FFI_OK, "prep sbig");
    ffi_call(&cif, (void (*)(void)) t_sbig, &rl, avalue);
    check_i64("sbig arg", rl, t_sbig(vb_orig));
    CHECK(memcmp(&vb, &vb_orig, sizeof(vb)) == 0,
          "sbig byval clobber isolated");

    /* struct returns: singleton (scalar class) and sret shapes */
    int32_t seed = 13;
    atypes[0] = &ffi_type_sint32;
    avalue[0] = &seed;

    struct s1 rs1 = { 0 };
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &s1_type, atypes)
              == FFI_OK, "prep ret s1");
    ffi_call(&cif, (void (*)(void)) r_s1, &rs1, avalue);
    check_i64("ret singleton s1", rs1.a, seed * 3);

    struct s2 rs2 = { 0, 0 };
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &s2_type, atypes)
              == FFI_OK, "prep ret s2");
    ffi_call(&cif, (void (*)(void)) r_s2, &rs2, avalue);
    check_i64("ret s2 .a", rs2.a, seed * 3);
    check_i64("ret s2 .b", rs2.b, seed * 5);

    struct smix rsm = { 0, 0 };
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &smix_type, atypes)
              == FFI_OK, "prep ret smix");
    ffi_call(&cif, (void (*)(void)) r_smix, &rsm, avalue);
    check_i64("ret smix .a", rsm.a, seed);
    check_f64("ret smix .b", rsm.b, seed * 2.5);

    struct sbig rsb;
    memset(&rsb, 0, sizeof(rsb));
    atypes[0] = &ffi_type_sint32;
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &sbig_type, atypes)
              == FFI_OK, "prep ret sbig");
    ffi_call(&cif, (void (*)(void)) r_sbig, &rsb, avalue);
    struct sbig want_sb = r_sbig(seed);
    CHECK(memcmp(&rsb, &want_sb, sizeof(rsb)) == 0, "ret sbig");
}

#endif /* __wasm__ */

/* ---------------------------------------------------------------------
 * Section 6 — closures over the static trampoline pool.
 *
 * The generic handler checksums its arguments by cif->arg_types (which
 * also proves the cif carries the classified types through to the
 * handler) and folds in user_data, so two closures of the same class
 * prove they route to their own state.
 * ------------------------------------------------------------------- */

static int64_t closure_arg_i64(ffi_type *t, void *p)
{
    switch (t->type) {
    case FFI_TYPE_SINT8: return *(int8_t *) p;
    case FFI_TYPE_UINT8: return *(uint8_t *) p;
    case FFI_TYPE_SINT16: return *(int16_t *) p;
    case FFI_TYPE_UINT16: return *(uint16_t *) p;
    case FFI_TYPE_INT:
    case FFI_TYPE_SINT32: return *(int32_t *) p;
    case FFI_TYPE_UINT32:
    case FFI_TYPE_POINTER: return *(uint32_t *) p;
    case FFI_TYPE_SINT64:
    case FFI_TYPE_UINT64: return *(int64_t *) p;
    case FFI_TYPE_FLOAT: return (int64_t) *(float *) p;
    case FFI_TYPE_DOUBLE: return (int64_t) *(double *) p;
    default: return 0;
    }
}

static void h_checksum(ffi_cif *cif, void *ret, void **args, void *ud)
{
    int64_t sum = (int64_t) (intptr_t) ud;

    for (unsigned i = 0; i < cif->nargs; i++)
        sum += closure_arg_i64(cif->arg_types[i], args[i]) *
               PRIME[i % 8];

    switch (cif->rtype->type) {
    case FFI_TYPE_VOID: void_sink = sum; break;
    case FFI_TYPE_SINT8: *(ffi_arg *) ret = (ffi_arg) (ffi_sarg) (int8_t) sum; break;
    case FFI_TYPE_UINT16: *(ffi_arg *) ret = (ffi_arg) (uint16_t) sum; break;
    case FFI_TYPE_INT:
    case FFI_TYPE_SINT32: *(ffi_arg *) ret = (ffi_arg) (ffi_sarg) (int32_t) sum; break;
    case FFI_TYPE_SINT64: *(int64_t *) ret = sum; break;
    case FFI_TYPE_FLOAT: *(float *) ret = (float) sum; break;
    case FFI_TYPE_DOUBLE: *(double *) ret = (double) sum; break;
    default: break;
    }
}

struct made_closure {
    ffi_closure *closure;
    void *code;
    ffi_cif cif;
};

static int make_closure(struct made_closure *mc, unsigned nargs,
                        ffi_type **atypes, ffi_type *rtype, void *ud)
{
    mc->code = NULL;
    mc->closure = ffi_closure_alloc(sizeof(ffi_closure), &mc->code);
    if (mc->closure == NULL)
        return -1;
    if (ffi_prep_cif(&mc->cif, FFI_DEFAULT_ABI, nargs, rtype, atypes)
            != FFI_OK)
        return -1;
    if (ffi_prep_closure_loc(mc->closure, &mc->cif, h_checksum, ud,
                             mc->code) != FFI_OK)
        return -1;
    return 0;
}

static void test_closures_scalar(void)
{
    ffi_type *atypes[8];
    struct made_closure mc;

    /* () -> void */
    CHECK(make_closure(&mc, 0, NULL, &ffi_type_void,
                       (void *) (intptr_t) 55) == 0, "closure v0 make");
    void_sink = 0;
    ((void (*)(void)) mc.code)();
    check_i64("closure v0", void_sink, 55);
    ffi_closure_free(mc.closure);

    /* (i32) -> i32 */
    atypes[0] = &ffi_type_sint32;
    CHECK(make_closure(&mc, 1, atypes, &ffi_type_sint32,
                       (void *) (intptr_t) 7) == 0, "closure i1 make");
    check_i64("closure i1", ((int32_t (*)(int32_t)) mc.code)(100),
              7 + 100 * PRIME[0]);
    ffi_closure_free(mc.closure);

    /* (i32,i32,i32) -> i32 — two live closures of one class route to
     * their own user_data */
    struct made_closure mca, mcb;
    for (int i = 0; i < 3; i++)
        atypes[i] = &ffi_type_sint32;
    CHECK(make_closure(&mca, 3, atypes, &ffi_type_sint32,
                       (void *) (intptr_t) 1000) == 0, "closure i3a make");
    CHECK(make_closure(&mcb, 3, atypes, &ffi_type_sint32,
                       (void *) (intptr_t) 2000) == 0, "closure i3b make");
    CHECK(mca.code != mcb.code, "closure i3 distinct code");
    int64_t base = 4 * PRIME[0] + 5 * PRIME[1] + 6 * PRIME[2];
    check_i64("closure i3a",
              ((int32_t (*)(int32_t, int32_t, int32_t)) mca.code)(4, 5, 6),
              1000 + base);
    check_i64("closure i3b",
              ((int32_t (*)(int32_t, int32_t, int32_t)) mcb.code)(4, 5, 6),
              2000 + base);
    ffi_closure_free(mca.closure);
    ffi_closure_free(mcb.closure);

    /* (i32 x8) -> i64 */
    for (int i = 0; i < 8; i++)
        atypes[i] = &ffi_type_sint32;
    CHECK(make_closure(&mc, 8, atypes, &ffi_type_sint64, NULL) == 0,
          "closure i8 make");
    int64_t want = 0;
    for (int i = 0; i < 8; i++)
        want += (int64_t) (i + 1) * PRIME[i];
    check_i64("closure i8",
              ((int64_t (*)(int32_t, int32_t, int32_t, int32_t, int32_t,
                            int32_t, int32_t, int32_t)) mc.code)(
                  1, 2, 3, 4, 5, 6, 7, 8),
              want);
    ffi_closure_free(mc.closure);

    /* (f64,f64) -> f64 — the gesture shape */
    atypes[0] = &ffi_type_double;
    atypes[1] = &ffi_type_double;
    CHECK(make_closure(&mc, 2, atypes, &ffi_type_double,
                       (void *) (intptr_t) 3) == 0, "closure d2 make");
    check_f64("closure d2",
              ((double (*)(double, double)) mc.code)(4.0, 8.0),
              (double) (3 + 4 * PRIME[0] + 8 * PRIME[1]));
    ffi_closure_free(mc.closure);

    /* (i64) -> i64 full width */
    atypes[0] = &ffi_type_sint64;
    CHECK(make_closure(&mc, 1, atypes, &ffi_type_sint64, NULL) == 0,
          "closure l1 make");
    check_i64("closure l1", ((int64_t (*)(int64_t)) mc.code)(BIG64),
              BIG64 * PRIME[0]);
    ffi_closure_free(mc.closure);

    /* (f32) -> f32 */
    atypes[0] = &ffi_type_float;
    CHECK(make_closure(&mc, 1, atypes, &ffi_type_float, NULL) == 0,
          "closure f1 make");
    check_f32("closure f1", ((float (*)(float)) mc.code)(2.5f),
              (float) ((int64_t) 2.5f * PRIME[0]));
    ffi_closure_free(mc.closure);

    /* (i32,f64,i32) -> void */
    atypes[0] = &ffi_type_sint32;
    atypes[1] = &ffi_type_double;
    atypes[2] = &ffi_type_sint32;
    CHECK(make_closure(&mc, 3, atypes, &ffi_type_void,
                       (void *) (intptr_t) 11) == 0, "closure idi make");
    void_sink = 0;
    ((void (*)(int32_t, double, int32_t)) mc.code)(2, 3.0, 4);
    check_i64("closure idi", void_sink,
              11 + 2 * PRIME[0] + 3 * PRIME[1] + 4 * PRIME[2]);
    ffi_closure_free(mc.closure);

    /* (i8) -> i8 and (u16) -> u16 — extension through the trampoline */
    atypes[0] = &ffi_type_sint8;
    CHECK(make_closure(&mc, 1, atypes, &ffi_type_sint8, NULL) == 0,
          "closure i8->i8 make");
    check_i64("closure i8->i8", ((int8_t (*)(int8_t)) mc.code)(-4),
              (int8_t) (-4 * PRIME[0]));
    ffi_closure_free(mc.closure);

    atypes[0] = &ffi_type_uint16;
    CHECK(make_closure(&mc, 1, atypes, &ffi_type_uint16, NULL) == 0,
          "closure u16->u16 make");
    check_i64("closure u16->u16",
              ((uint16_t (*)(uint16_t)) mc.code)(0x4001),
              (uint16_t) (0x4001 * PRIME[0]));
    ffi_closure_free(mc.closure);
}

static void test_closure_pool_reuse(void)
{
    /* Exhaust-and-recycle: allocate a batch of one class, free it, and
     * allocate again — freed slots must come back. */
    enum { BATCH = 8 };
    struct made_closure mcs[BATCH];
    ffi_type *atypes[1] = { &ffi_type_sint32 };

    for (int round = 0; round < 3; round++) {
        for (int i = 0; i < BATCH; i++) {
            CHECK(make_closure(&mcs[i], 1, atypes, &ffi_type_sint32,
                               (void *) (intptr_t) (round * 100 + i)) == 0,
                  "pool batch make");
        }
        for (int i = 0; i < BATCH; i++) {
            check_i64("pool batch call",
                      ((int32_t (*)(int32_t)) mcs[i].code)(10),
                      round * 100 + i + 10 * PRIME[0]);
        }
        for (int i = 0; i < BATCH; i++)
            ffi_closure_free(mcs[i].closure);
    }
}

#ifdef __wasm__

static void h_struct(ffi_cif *cif, void *ret, void **args, void *ud)
{
    (void) ud;
    if (cif->rtype == &s2_type) {
        /* args: (i32 seed) -> struct s2 */
        int32_t seed = *(int32_t *) args[0];
        struct s2 *out = ret;
        out->a = seed * 3;
        out->b = seed * 5;
        return;
    }
    if (cif->arg_types[0] == &s2_type) {
        /* (struct s2) -> i32 */
        struct s2 *v = args[0];
        *(ffi_arg *) ret = (ffi_arg) (v->a * 3 + v->b * 5);
        return;
    }
    /* (i32, struct smix) -> f64 */
    int32_t x = *(int32_t *) args[0];
    struct smix *v = args[1];
    *(double *) ret = x * 3.0 + v->a * 5.0 + v->b;
}

static void test_closures_struct(void)
{
    ffi_type *atypes[2];
    ffi_cif cif;
    void *code;
    ffi_closure *cl;

    /* (struct s2) -> i32 */
    atypes[0] = &s2_type;
    code = NULL;
    cl = ffi_closure_alloc(sizeof(ffi_closure), &code);
    CHECK(cl != NULL, "closure s2 alloc");
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_sint32, atypes)
              == FFI_OK, "closure s2 prep cif");
    CHECK(ffi_prep_closure_loc(cl, &cif, h_struct, NULL, code) == FFI_OK,
          "closure s2 prep");
    struct s2 v2 = { 17, 19 };
    check_i64("closure s2 arg",
              ((int32_t (*)(struct s2)) code)(v2), 17 * 3 + 19 * 5);
    ffi_closure_free(cl);

    /* (i32, struct smix) -> f64 */
    atypes[0] = &ffi_type_sint32;
    atypes[1] = &smix_type;
    code = NULL;
    cl = ffi_closure_alloc(sizeof(ffi_closure), &code);
    CHECK(cl != NULL, "closure smix alloc");
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_double, atypes)
              == FFI_OK, "closure smix prep cif");
    CHECK(ffi_prep_closure_loc(cl, &cif, h_struct, NULL, code) == FFI_OK,
          "closure smix prep");
    struct smix vm = { 7, 0.5 };
    check_f64("closure smix arg",
              ((double (*)(int32_t, struct smix)) code)(2, vm),
              2 * 3.0 + 7 * 5.0 + 0.5);
    ffi_closure_free(cl);

    /* (i32) -> struct s2 — the sret shape */
    atypes[0] = &ffi_type_sint32;
    code = NULL;
    cl = ffi_closure_alloc(sizeof(ffi_closure), &code);
    CHECK(cl != NULL, "closure ret s2 alloc");
    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &s2_type, atypes)
              == FFI_OK, "closure ret s2 prep cif");
    CHECK(ffi_prep_closure_loc(cl, &cif, h_struct, NULL, code) == FFI_OK,
          "closure ret s2 prep");
    struct s2 out = ((struct s2 (*)(int32_t)) code)(23);
    check_i64("closure ret s2 .a", out.a, 23 * 3);
    check_i64("closure ret s2 .b", out.b, 23 * 5);
    ffi_closure_free(cl);
}

#endif /* __wasm__ */

/* ---------------------------------------------------------------------
 * Section 7 — the Wayland ceiling still holds: arity 22, all-i32,
 * non-void return (the shim's own test covers the void shape).
 * ------------------------------------------------------------------- */

static int64_t t_i32_22(int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                        int32_t a4, int32_t a5, int32_t a6, int32_t a7,
                        int32_t a8, int32_t a9, int32_t a10, int32_t a11,
                        int32_t a12, int32_t a13, int32_t a14, int32_t a15,
                        int32_t a16, int32_t a17, int32_t a18, int32_t a19,
                        int32_t a20, int32_t a21)
{
    int32_t a[22] = { a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11,
                      a12, a13, a14, a15, a16, a17, a18, a19, a20, a21 };
    int64_t sum = 0;
    for (int i = 0; i < 22; i++)
        sum += (int64_t) a[i] * (i + 1);
    return sum;
}

static void test_call_arity22(void)
{
    ffi_cif cif;
    ffi_type *atypes[22];
    int32_t vals[22];
    void *avalue[22];
    int64_t expect = 0, rl = 0;

    for (int i = 0; i < 22; i++) {
        atypes[i] = &ffi_type_sint32;
        vals[i] = 1000 + i;
        avalue[i] = &vals[i];
        expect += (int64_t) vals[i] * (i + 1);
    }

    CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 22, &ffi_type_sint64, atypes)
              == FFI_OK, "prep i32x22");
    ffi_call(&cif, (void (*)(void)) t_i32_22, &rl, avalue);
    check_i64("call i32x22 -> i64", rl, expect);
}

int main(void)
{
    init_struct_types();

    test_encoder();
    test_call_i32_arities();
    test_call_mixed();
    test_small_ints();
    test_call_arity22();
    test_closures_scalar();
    test_closure_pool_reuse();
#ifdef __wasm__
    test_call_structs();
    test_closures_struct();
#endif

    if (failures != 0) {
        printf("LIBFFI_FULL_FAILURES=%d\n", failures);
        return 1;
    }
    printf("LIBFFI_FULL_OK cases=%d\n", cases);
    return 0;
}
