#include <stdlib.h>
struct ops_a { void (*run)(int); };
static void ra(int x) { (void)x; }
void *xrealloc(void *p, size_t n) { void *r = realloc(p, n); if (!r) abort(); return r; }
void grow(struct ops_a **arr, size_t n) { *arr = xrealloc(*arr, n * sizeof **arr); }
void (**fns)(void);
void growf(size_t n) { fns = (void (**)(void))xrealloc((void *)fns, n * sizeof *fns); }
