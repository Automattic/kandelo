/* SPDX-License-Identifier: MIT
 * Query the guest OS clock. Neither the embedding process start time nor a
 * process-local timer is a substitute for the guest's boot-time clock.
 */
#include "uv.h"
#include "internal.h"

#include <errno.h>
#include <time.h>

int uv_uptime(double* uptime) {
  struct timespec now;

  if (clock_gettime(CLOCK_BOOTTIME, &now) != 0)
    return UV__ERR(errno);

  *uptime = (double) now.tv_sec + (double) now.tv_nsec / 1e9;
  return 0;
}
