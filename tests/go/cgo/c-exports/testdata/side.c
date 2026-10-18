#include "abi_constants.h"

extern int export_only_data;
extern int export_only_function(int value);

__attribute__((used))
__attribute__((retain))
__attribute__((export_name("__abi_version")))
unsigned int __wasm_posix_user_abi_version(void) {
    return WASM_POSIX_ABI_VERSION;
}

int side_result(void) {
    return export_only_function(5) + export_only_data;
}
