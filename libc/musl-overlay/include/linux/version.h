/*
 * Kandelo <linux/version.h>: Linux's version uAPI
 * (include/generated/uapi/linux/version.h), describing the Linux uAPI
 * headers this sysroot ships under <linux/...>.
 *
 * Why it exists: the overlay mirrors Linux uAPI headers for interfaces the
 * Kandelo kernel implements with the same layouts and request numbers
 * (dma-buf, sync_file, evdev, fbdev, ...). Upstream code that uses them
 * also includes this header. wlroots, for example, compiles
 * render/dmabuf_linux.c whenever <linux/dma-buf.h> declares
 * DMA_BUF_IOCTL_IMPORT_SYNC_FILE, and that file includes <linux/version.h>
 * for KERNEL_VERSION().
 *
 * What the value means: LINUX_VERSION_CODE names the Linux release whose
 * uAPI first contains every definition the overlay mirrors. The newest is
 * DMA_BUF_IOCTL_{EXPORT,IMPORT}_SYNC_FILE (Linux 6.0). It describes these
 * headers, not the running system. Kandelo is not Linux: uname() reports
 * the sysname "wasm-posix" and Kandelo's own release, and code that decides
 * at runtime from the uname() of a "Linux" system (as wlroots does) takes
 * its non-Linux path. Raise the value only when an overlay header gains a
 * definition from a newer Linux release.
 */
#ifndef _LINUX_VERSION_H
#define _LINUX_VERSION_H 1

#define LINUX_VERSION_MAJOR 6
#define LINUX_VERSION_PATCHLEVEL 0
#define LINUX_VERSION_SUBLEVEL 0
#define LINUX_VERSION_CODE 393216
#define KERNEL_VERSION(a, b, c) (((a) << 16) + ((b) << 8) + ((c) > 255 ? 255 : (c)))

#endif
