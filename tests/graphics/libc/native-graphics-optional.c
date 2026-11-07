/* Native source fixtures without a Wayland backend have no copied Kandelo
 * musl epoch or deferred native queue. Defined weak defaults make that test
 * environment explicit; real adapter/epoch fixtures override these from a
 * separate translation unit. Never link this file into the SDK or product. */
#include <stdint.h>
__attribute__((weak)) uint64_t __wasm_posix_native_fork_epoch(void) { return 0; }
__attribute__((weak)) int _wpk_wlegl_drain_deferred(void) { return 0; }
__attribute__((weak)) int _wpk_wl_log_drain_deferred(void) { return 0; }

#include "../../../libc/glue/wayland-retirement.h"
#include <stdlib.h>
/* Exact empty capsules are valid without a Wayland backend. A nonempty
 * capsule here is a fixture/linkage defect, never a simulated release. */
__attribute__((weak)) enum wpk_wl_retire_result _wpk_wlegl_release_pending(struct wpk_wlegl_retirement *p) {
    if(!p||p->live||p->retired)abort();return WPK_WL_RETIRE_COMPLETE;
}
__attribute__((weak)) enum wpk_wl_retire_result _wpk_wl_display_release_pending(struct wpk_wl_display_retirement *p) {
    if(!p||p->live||p->retired)abort();return WPK_WL_RETIRE_COMPLETE;
}
