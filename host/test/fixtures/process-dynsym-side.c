#include "abi_constants.h"
#include <sys/types.h>
#include <unistd.h>

__attribute__((export_name("__abi_version")))
unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }

extern int process_value(void);

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
    pid_t child = fork();
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
