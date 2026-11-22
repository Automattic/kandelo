/* SPDX-License-Identifier: MIT
 * Kandelo exposes real address-space/data limits but has no process residency
 * or physical-memory information service. Preserve that distinction here;
 * current kernel rusage/sysinfo placeholders are not measurements.
 */
#include "uv.h"
#include "internal.h"

int uv_resident_set_memory(size_t* rss) {
  if (rss == NULL)
    return UV_EINVAL;
  return UV_ENOSYS;
}

uint64_t uv_get_free_memory(void) {
  /* libuv defines zero as unknown, not as a measured empty machine. */
  return 0;
}

uint64_t uv_get_total_memory(void) {
  return 0;  /* Physical capacity is unknown. */
}

uint64_t uv_get_constrained_memory(void) {
  /* The complete upstream helper queries the guest's actual OS limits. */
  return uv__get_rlimit_max_memory();
}

uint64_t uv_get_available_memory(void) {
  /* Available physical memory cannot be inferred from virtual limits. */
  return uv_get_free_memory();
}
