// Replay the existing SpiderMonkey embedding macro in this compile-only
// fixture. Neither the SDK nor this package's recipe claims a Linux target.
#if defined(KANDELO_TEST_LEGACY_OS_MACROS)
# define __linux__ 1
#endif
#include <v8config.h>
#include <string_view>
#if !defined(V8_OS_KANDELO) || !defined(V8_OS_POSIX)
# error Missing explicit Kandelo target
#endif
#if defined(V8_OS_LINUX) || defined(V8_TARGET_OS_LINUX)
# error Legacy embedding macro overrode the explicit Kandelo selector
#endif
#if !defined(V8_HOST_ARCH_WASM32) || !defined(V8_TARGET_ARCH_WASM32)
# error Missing true wasm32 architecture
#endif
static_assert(V8_HOST_ARCH_32_BIT && V8_TARGET_ARCH_32_BIT && sizeof(void*)==4);
static_assert(std::string_view(V8_OS_STRING)=="kandelo");
static_assert(std::string_view(V8_TARGET_OS_STRING)=="kandelo");
