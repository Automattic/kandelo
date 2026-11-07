/* Native source fixtures without a Wayland backend have no copied Kandelo
 * musl epoch or deferred native queue. Defined weak defaults make that test
 * environment explicit; real adapter/epoch fixtures override these from a
 * separate translation unit. Never link this file into the SDK or product. */
#include <stdint.h>
__attribute__((weak)) uint64_t __wasm_posix_native_fork_epoch(void) { return 0; }
__attribute__((weak)) int _wpk_wlegl_drain_deferred(void) { return 0; }
__attribute__((weak)) int _wpk_wl_log_drain_deferred(void) { return 0; }
