/*
 * Kandelo <linux/sync_file.h>: Linux's sync_file uAPI
 * (include/uapi/linux/sync_file.h) with the same layouts and request
 * numbers. A sync_file descriptor carries one fence; see
 * docs/architecture.md, "Explicit synchronization".
 *
 * Any change to the struct/ioctl marshalling here is part of the kernel
 * ABI (crates/shared/src/dri_sync.rs mirrors it).
 */
#ifndef _LINUX_SYNC_FILE_H
#define _LINUX_SYNC_FILE_H 1

#include <stdint.h>
#include <sys/ioctl.h>

struct sync_merge_data {
	char name[32];
	int32_t fd2;
	int32_t fence;
	uint32_t flags;
	uint32_t pad;
};

struct sync_fence_info {
	char obj_name[32];
	char driver_name[32];
	int32_t status;
	uint32_t flags;
	uint64_t timestamp_ns;
};

struct sync_file_info {
	char name[32];
	int32_t status;
	uint32_t flags;
	uint32_t num_fences;
	uint32_t pad;
	uint64_t sync_fence_info;
};

struct sync_set_deadline {
	uint64_t deadline_ns;
	uint64_t pad;
};

#define SYNC_IOC_MAGIC '>'
#define SYNC_IOC_MERGE _IOWR(SYNC_IOC_MAGIC, 3, struct sync_merge_data)
#define SYNC_IOC_FILE_INFO _IOWR(SYNC_IOC_MAGIC, 4, struct sync_file_info)
#define SYNC_IOC_SET_DEADLINE _IOW(SYNC_IOC_MAGIC, 5, struct sync_set_deadline)

#endif
