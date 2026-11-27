/* A program that loads a plugin module with dlopen(3). The plugin calls
 * back into this program (host_callback, host_scale) and into libc
 * (printf), so the program links with its build system's export switch
 * (CMake ENABLE_EXPORTS, Meson export_dynamic, Libtool -export-dynamic),
 * as on any Unix. */
#include <dlfcn.h>
#include <stdio.h>

int host_scale = 3;

int host_callback(int x) { return x * host_scale; }

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s MODULE\n", argv[0]);
        return 2;
    }
    void *module = dlopen(argv[1], RTLD_NOW);
    if (!module) {
        fprintf(stderr, "dlopen: %s\n", dlerror());
        return 1;
    }
    int (*run)(int) = (int (*)(int))dlsym(module, "plugin_run");
    if (!run) {
        fprintf(stderr, "dlsym: %s\n", dlerror());
        return 1;
    }
    printf("plugin_run(7) = %d\n", run(7));
    return dlclose(module) == 0 ? 0 : 1;
}
