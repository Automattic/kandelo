/* Hand-curated meson config.h for basu 0.2.1 on wasm32 musl (the meson
 * bypass pattern — see build-basu.sh). Values mirror what upstream's
 * compile probes resolve to against this sysroot:
 *   - pid_t/uid_t/gid_t are 4 bytes, dev_t is 8 (musl wasm32);
 *   - musl provides explicit_bzero + reallocarray but not secure_getenv;
 *   - no libcap, no audit (Linux-only surfaces);
 *   - the flake's gperf 3.x emits size_t length parameters.
 */
#pragma once

#define PACKAGE_STRING "basu 0.2.1"

#define _GNU_SOURCE 1
#define __SANE_USERSPACE_TYPES__ 1

#define SIZEOF_PID_T 4
#define SIZEOF_UID_T 4
#define SIZEOF_GID_T 4
#define SIZEOF_DEV_T 8

#define HAVE_CHAR16_T 1
#define HAVE_CHAR32_T 1

#define HAVE_EXPLICIT_BZERO 1
#define HAVE_REALLOCARRAY 1
#define HAVE_SECURE_GETENV 0

#define GPERF_LEN_TYPE size_t

#define NOBODY_USER_NAME "nobody"
#define DEFAULT_SYSTEM_BUS_ADDRESS "unix:path=/run/dbus/system_bus_socket"
#define GETTEXT_PACKAGE "basu"

#define ENABLE_DEBUG_HASHMAP 0
#define HAVE_LIBCAP 0
#define HAVE_AUDIT 0

/* glibc's sys/types.h leaks major()/minor(); musl keeps them in
 * sys/sysmacros.h, which upstream never includes. */
#include <sys/sysmacros.h>
