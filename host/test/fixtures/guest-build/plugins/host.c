/* A program that loads a plugin module with dlopen(3). The plugin calls
 * back into this program (host_log, host_callback, host_scale), so the
 * program exports them: it links with its build system's export switch
 * (-Wl,--export-dynamic), which exports default-visibility symbols, and
 * WebAssembly symbols are hidden unless declared otherwise. */
#include <dlfcn.h>
#include <stdio.h>

#define HOST_API __attribute__((visibility("default")))

HOST_API int host_scale = 3;

HOST_API int host_callback(int x) { return x * host_scale; }

HOST_API void host_log(const char *label, int value) {
    printf("%s%d\n", label, value);
}

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
