/* C library linked into the Rust program (rustbin/). */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Mirrors `Record` in rustbin/src/main.rs; the layouts must agree. */
struct record {
    uint8_t tag;
    uint64_t big;
    uint16_t small;
    double ratio;
};

size_t c_record_size(void) { return sizeof(struct record); }

void c_record_fill(struct record *r) {
    r->tag = 7;
    r->big = 0x0123456789abcdefULL;
    r->small = 0xbeef;
    r->ratio = 0.25;
}

/* compiler-rt's 128-bit intrinsics on the C side of the link. */
uint64_t c_u128_muldiv(uint64_t a, uint64_t b, uint64_t d) {
    return (uint64_t)(((unsigned __int128)a * b) / d);
}

/* Sorts with a comparator the Rust program supplies. */
void c_sort_ints(int *v, size_t n, int (*cmp)(const void *, const void *)) {
    qsort(v, n, sizeof *v, cmp);
}

/* A malloc'd string the Rust program frees with libc free(). */
char *c_describe(int n) {
    char *s = malloc(32);
    if (s) snprintf(s, 32, "C says %d", n);
    return s;
}

void c_set_errno(int e) { errno = e; }

const char *c_getenv(const char *key) { return getenv(key); }
