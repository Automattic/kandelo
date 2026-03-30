/**
 * main.c — Program that dynamically loads hello-lib.so via dlopen.
 *
 * Demonstrates:
 * - dlopen() to load a shared library
 * - dlsym() to look up functions
 * - Calling dynamically resolved functions
 * - dlerror() for error reporting
 * - dlclose() to unload
 *
 * Usage: ./main /path/to/hello-lib.so
 */
#include <dlfcn.h>
#include <stdio.h>

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <path-to-hello-lib.so>\n", argv[0]);
        return 1;
    }

    const char *lib_path = argv[1];
    printf("Loading library: %s\n", lib_path);

    void *lib = dlopen(lib_path, RTLD_LAZY);
    if (!lib) {
        fprintf(stderr, "dlopen failed: %s\n", dlerror());
        return 1;
    }
    printf("Library loaded successfully\n");

    /* Look up functions */
    int (*add)(int, int) = (int (*)(int, int))dlsym(lib, "add");
    if (!add) {
        fprintf(stderr, "dlsym(add) failed: %s\n", dlerror());
        dlclose(lib);
        return 1;
    }

    int (*multiply)(int, int) = (int (*)(int, int))dlsym(lib, "multiply");
    if (!multiply) {
        fprintf(stderr, "dlsym(multiply) failed: %s\n", dlerror());
        dlclose(lib);
        return 1;
    }

    int (*get_call_count)(void) = (int (*)(void))dlsym(lib, "get_call_count");
    const char *(*get_greeting)(void) = (const char *(*)(void))dlsym(lib, "get_greeting");

    /* Call functions */
    printf("add(3, 4) = %d\n", add(3, 4));
    printf("add(100, 200) = %d\n", add(100, 200));
    printf("multiply(5, 6) = %d\n", multiply(5, 6));

    if (get_call_count) {
        printf("call_count = %d\n", get_call_count());
    }

    if (get_greeting) {
        printf("greeting: %s\n", get_greeting());
    }

    /* Error handling demo: look up non-existent symbol */
    void *bad = dlsym(lib, "nonexistent_function");
    if (!bad) {
        printf("Expected: symbol not found\n");
    }

    dlclose(lib);
    printf("Library unloaded. Done.\n");
    return 0;
}
