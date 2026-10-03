#include <stdlib.h>
#include <string.h>
struct ops_a { void (*run)(int); };
static void ra(int x) { (void)x; }
static struct ops_a A = { .run = ra };
void same_copy(struct ops_a *d) { memcpy(d, &A, sizeof A); }
struct ops_a *fresh(void) { return malloc(sizeof(struct ops_a)); }
void zero(struct ops_a *a) { memset(a, 0, sizeof *a); free(a); }
