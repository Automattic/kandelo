/* A plugin module that calls libc directly. libc's symbols are hidden, so
 * a program linked with --export-dynamic does not export printf, and this
 * module cannot be loaded unless the program exports printf itself
 * (-Wl,--export=printf). */
#include <stdio.h>

int plugin_run(int x) {
    printf("plugin-libc: %d\n", x);
    return x + 1;
}
