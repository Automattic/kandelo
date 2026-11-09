/*
 * Kandelo <linux/dma-buf.h>: the implicit-fence part of Linux's dma-buf
 * uAPI (include/uapi/linux/dma-buf.h), with the same layouts and request
 * numbers. A PRIME descriptor's buffer keeps a reservation of reader and
 * writer fences that these ioctls export to and import from sync_files.
 * The CPU-access DMA_BUF_IOCTL_SYNC and naming ioctls are not provided:
 * the kernel does not implement them.
 *
 * Any change to the struct/ioctl marshalling here is part of the kernel
 * ABI (crates/shared/src/dri_sync.rs mirrors it).
 */
#ifndef _LINUX_DMA_BUF_H
#define _LINUX_DMA_BUF_H 1

#include <stdint.h>
#include <sys/ioctl.h>

#define DMA_BUF_SYNC_READ      (1 << 0)
#define DMA_BUF_SYNC_WRITE     (2 << 0)
#define DMA_BUF_SYNC_RW        (DMA_BUF_SYNC_READ | DMA_BUF_SYNC_WRITE)

struct dma_buf_export_sync_file {
	uint32_t flags;
	int32_t fd;
};

struct dma_buf_import_sync_file {
	uint32_t flags;
	int32_t fd;
};

#define DMA_BUF_BASE 'b'
#define DMA_BUF_IOCTL_EXPORT_SYNC_FILE _IOWR(DMA_BUF_BASE, 2, struct dma_buf_export_sync_file)
#define DMA_BUF_IOCTL_IMPORT_SYNC_FILE _IOW(DMA_BUF_BASE, 3, struct dma_buf_import_sync_file)

#endif
