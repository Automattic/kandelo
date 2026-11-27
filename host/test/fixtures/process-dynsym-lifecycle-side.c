#include "abi_constants.h"
#include <dlfcn.h>
#include <unistd.h>

__attribute__((export_name("__abi_version")))
unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }

extern void observe_lifecycle(int);
extern int lifecycle_fork_stage;
extern pid_t lifecycle_fork_result;
extern int dependency_value(void);

int lifecycle_check(void) { return dependency_value(); }

__attribute__((constructor))
static void on_load(void)
{
    observe_lifecycle(0);
    if (lifecycle_fork_stage == 1) lifecycle_fork_result = fork();
    void *nested = dlopen("/lib/dynsym-dependency.so", RTLD_NOW | RTLD_LOCAL);
    int (*value)(void) = nested ? dlsym(nested, "dependency_value") : 0;
    if (value && value() == 19 && !dlclose(nested) &&
        !dlopen("/lib/missing-constructor-module.so", RTLD_NOW) && dlerror())
        observe_lifecycle(2);
}

__attribute__((destructor))
static void on_close(void)
{
    observe_lifecycle(1);
    if (lifecycle_fork_stage == 2) lifecycle_fork_result = fork();
}
