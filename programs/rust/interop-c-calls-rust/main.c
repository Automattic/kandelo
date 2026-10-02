/* C consumer of a Rust std staticlib (Kandelo M7.1 interop fixture). */
#include <stdio.h>

extern int rust_add(int a, int b);
extern int rust_greet(const char *name);

int main(void) {
    printf("C: rust_add(20, 22) = %d\n", rust_add(20, 22));
    int n = rust_greet("Kandelo");
    printf("C: rust_greet returned length %d\n", n);
    return 0;
}
