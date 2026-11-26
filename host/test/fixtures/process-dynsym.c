#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

__attribute__((visibility("default"), noinline))
int process_value(void) { return 42; }

__attribute__((visibility("default"), noinline))
pid_t process_fork(void)
{
    volatile int preserved = 23;
    pid_t child = fork();
    if (preserved != 23) _exit(11);
    return child;
}

__attribute__((visibility("default")))
int process_data = 17;

extern __typeof(process_value) process_alias
    __attribute__((alias("process_value"), visibility("default")));

typedef int (*value_fn)(void);
typedef pid_t (*fork_fn)(void);

int main(int argc, char **argv)
{
#ifdef PROCESS_DYNSYM_LOOKUP_ONLY
    void *main = RTLD_DEFAULT;
#else
    void *main = dlopen(NULL, RTLD_NOW);
    if (!main) return 1;
#endif

    value_fn value = (value_fn)dlsym(main, "process_value");
    value_fn alias = (value_fn)dlsym(RTLD_DEFAULT, "process_alias");
    fork_fn forker = (fork_fn)dlsym(RTLD_DEFAULT, "process_fork");
    if (!value || !alias || !forker) return 2;
    if (value != &process_value || alias != value ||
        dlsym(main, "process_data") != &process_data || value() != 42)
        return 3;

    if (dlsym(main, "missing_process_symbol")) return 4;
    if (dlsym(main, "process_value") != (void *)value) return 5;
    char *error = dlerror();
    if (!error || !strstr(error, "missing_process_symbol") || dlerror())
        return 6;
    if (dlsym(RTLD_NEXT, "process_value")) return 26;
    error = dlerror();
    if (!error || !strstr(error, "RTLD_NEXT") || dlerror()) return 26;

    void *side = 0;
    int (*plugin_value)(int) = 0;
    fork_fn plugin_fork = 0;
#ifndef PROCESS_DYNSYM_LOOKUP_ONLY
    if (argc > 1) {
        side = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
        if (!side) {
            fprintf(stderr, "%s\n", dlerror());
            return 14;
        }
        plugin_value = (int (*)(int))dlsym(side, "plugin_value");
        plugin_fork = (fork_fn)dlsym(side, "plugin_fork");
        int (*(*plugin_address)(void))(int) = dlsym(side, "plugin_address");
        value_fn (*plugin_import_address)(void) = dlsym(side, "plugin_import_address");
        int *(*plugin_data_address)(void) = dlsym(side, "plugin_data_address");
        if (!plugin_value || !plugin_fork || !plugin_address ||
            !plugin_import_address || !plugin_data_address ||
            plugin_address() != plugin_value || plugin_value(1) != 43 ||
            plugin_import_address() != value || plugin_data_address() != &process_data)
            return 15;
        if (dlsym(main, "plugin_value") || !dlerror())
            return 16;
        if (argc > 2) {
            value_fn dependency = (value_fn)dlsym(side, "dependency_value");
            if (!dependency || dependency() != 19 ||
                dlsym(RTLD_DEFAULT, "dependency_value") || !dlerror())
                return 24;
        }
    }
#endif

    /* Re-entry at the beginning would print a second prefix. */
    puts("before fork");
    pid_t child = forker();
    if (child < 0) return 7;
    if (child == 0) {
        if (dlsym(main, "process_alias") != (void *)value || alias() != 42)
            _exit(12);
        if (side && (dlsym(side, "plugin_value") != (void *)plugin_value ||
                     plugin_value(2) != 44 || dlclose(side)))
            _exit(17);
#ifdef PROCESS_DYNSYM_LOOKUP_ONLY
        _exit(0);
#else
        _exit(dlclose(main) == 0 ? 0 : 13);
#endif
    }
    int status;
    if (waitpid(child, &status, 0) != child || status != 0)
        return 8;
    if (side) {
        if (dlsym(side, "plugin_value") != (void *)plugin_value) return 18;
        puts("before plugin fork");
        pid_t plugin_child = plugin_fork();
        if (plugin_child < 0) return 19;
        if (plugin_child == 0) _exit(plugin_value(3) == 45 ? 0 : 20);
        if (waitpid(plugin_child, &status, 0) != plugin_child || status != 0)
            return 21;
        if (dlclose(side) || dlsym(side, "plugin_value") || !dlerror())
            return 22;
    }
#ifndef PROCESS_DYNSYM_LOOKUP_ONLY
    if (dlsym(main, "process_value") != (void *)value || dlclose(main) != 0)
        return 9;
    if (dlsym(main, "process_value") || !dlerror())
        return 10;
#endif
    puts("guest dynsym fork ok");
    return 0;
}
