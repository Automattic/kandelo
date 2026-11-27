/* SPDX-License-Identifier: MIT
 * Kandelo has no libuv process-title integration yet. Preserve that boundary
 * as an error; upstream no-proctitle.c instead reports a successful no-op.
 */
#include "uv.h"
#include "internal.h"

char** uv_setup_args(int argc, char** argv) {
  return argv;
}

void uv__process_title_cleanup(void) {
  /* This backend does not allocate argument/title storage. */
}

int uv_set_process_title(const char* title) {
  return UV_ENOSYS;
}

int uv_get_process_title(char* buffer, size_t size) {
  if (buffer == NULL || size == 0)
    return UV_EINVAL;
  return UV_ENOSYS;
}
