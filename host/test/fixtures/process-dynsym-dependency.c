#include "abi_constants.h"

__attribute__((export_name("__abi_version")))
unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }

__attribute__((visibility("default")))
int dependency_data = 19;

__attribute__((visibility("default")))
int dependency_value(void) { return dependency_data; }
