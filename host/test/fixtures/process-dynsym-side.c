#include "abi_constants.h"
#include <sys/types.h>
#include <unistd.h>

__attribute__((export_name("__abi_version")))
unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }

extern int process_value(void);

#ifdef PROCESS_DYNSYM_NEEDED
extern int dependency_value(void);
extern int dependency_data;

static int (*volatile dependency_slot)(void);
static int *volatile dependency_address;
#endif

__attribute__((visibility("hidden"), export_name("plugin_value")))
int plugin_value(int additional)
{
    return process_value() + additional;
}

__attribute__((visibility("default")))
int (*plugin_address(void))(int)
{
    return &plugin_value;
}

__attribute__((visibility("default")))
pid_t plugin_fork(void)
{
    volatile int preserved = process_value();
#ifdef PROCESS_DYNSYM_NEEDED
    dependency_slot = dependency_value;
    dependency_address = &dependency_data;
#endif
    pid_t child = fork();
#ifdef PROCESS_DYNSYM_NEEDED
    /* Re-enter the provider from inside the consumer's restored frame.
     * Exercise the direct import and both kinds of GOT binding. */
    if (child == 0 && (dependency_value() != 19 || dependency_slot() != 19 ||
                       *dependency_address != 19))
        _exit(23);
#endif
    return preserved == 42 ? child : -1;
}

extern int process_data;

__attribute__((visibility("default")))
int (*plugin_import_address(void))(void)
{
    return &process_value;
}

__attribute__((visibility("default")))
int *plugin_data_address(void)
{
    return &process_data;
}
