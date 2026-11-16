#include <stdio.h>
#include <stdlib.h>

extern int foo(int);
extern int foo_counter;
extern int foo_ctor_ran(void);
extern int foo_apply(int (*fn)(int), int x);

static int twice(int x) { return 2 * x; }

int main(void) {
    printf("main: lib ctor ran before main: %d\n", foo_ctor_ran());
    foo_counter += 1;
    int r = foo(1);
    int (*fp)(int) = foo;
    printf("main: foo(1)=%d via pointer=%d apply=%d\n", r, fp(2), foo_apply(twice, 21));
    return r == 43 ? 0 : 1;
}
