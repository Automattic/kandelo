#include <stdlib.h>
#include <string.h>
struct ops_a { void (*run)(int); };
struct ops_b { void (*go)(long); };
struct plain { int x; };
union u { void (*f)(int); void *p; };
static void ra(int x) { (void)x; }
static void rb(long x) { (void)x; }
static void ru(int x) { (void)x; }
static struct ops_a A = { .run = ra };
void same_copy(struct ops_a *d) { memcpy(d, &A, sizeof A); }            /* safe: same type */
void diff_copy(struct ops_b *d) { memcpy(d, &A, sizeof A); }            /* pool: ops_a and ops_b */
void *stash(struct ops_a *a) { return a; }                               /* pool: ops_a */
struct ops_a *fresh(void) { return malloc(sizeof(struct ops_a)); }       /* fresh: no pool */
void zero(struct ops_a *a) { memset(a, 0, sizeof *a); free(a); }        /* safe */
void uni(union u *x) { x->f = ru; }                                      /* union pool */
void raw(char *p) { (*(void (**)(int))p)(1); }                          /* Z * void(int) */
static struct ops_b B = { .go = rb };
struct plain *pl(void *p) { return p; }                                   /* no fn ptrs: nothing */
