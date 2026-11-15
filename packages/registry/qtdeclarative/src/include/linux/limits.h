/*
 * linux/limits.h — build shim for the Qt port.
 *
 * Part of the Qt recipes' documented Linux adaptation (-D__linux__=1
 * -DQT_LINUXBASE; see build-qtbase.sh). Kandelo has no Linux kernel and
 * vendors no <linux/limits.h>. Qt 6.12's bundled WTF includes it from
 * src/3rdparty/masm/wtf/OSAllocatorPosix.cpp under OS(LINUX), for
 * PATH_MAX, and OS(LINUX) holds only because the recipes define
 * __linux__. Qt 6.10.2 did not include it and took PATH_MAX from POSIX
 * <limits.h>, which is what this shim forwards to.
 *
 * It goes away when the Qt recipes stop defining __linux__ (see
 * docs/future-improvements.md).
 */
#ifndef KANDELO_SHIM_LINUX_LIMITS_H
#define KANDELO_SHIM_LINUX_LIMITS_H
#include <limits.h>
#endif
