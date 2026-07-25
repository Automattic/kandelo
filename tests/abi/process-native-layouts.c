#define _GNU_SOURCE

#include <mqueue.h>
#include <signal.h>
#include <stddef.h>
#include <sys/statfs.h>
#include <sys/sysinfo.h>
#include <sys/time.h>

#define ASSERT_OFFSET(type, field, expected) \
	_Static_assert(offsetof(type, field) == (expected), #type "." #field)

_Static_assert(sizeof(long) == sizeof(void *),
	       "Kandelo process long and pointer widths must match");
_Static_assert(sizeof(struct itimerval) == 32, "public time64 itimerval size");
ASSERT_OFFSET(struct itimerval, it_interval.tv_sec, 0);
ASSERT_OFFSET(struct itimerval, it_interval.tv_usec, 8);
ASSERT_OFFSET(struct itimerval, it_value.tv_sec, 16);
ASSERT_OFFSET(struct itimerval, it_value.tv_usec, 24);
_Static_assert(sizeof(struct sigevent) == 64, "sigevent size");

#if __SIZEOF_POINTER__ == 4

_Static_assert(sizeof(stack_t) == 12, "wasm32 stack_t size");
ASSERT_OFFSET(stack_t, ss_sp, 0);
ASSERT_OFFSET(stack_t, ss_flags, 4);
ASSERT_OFFSET(stack_t, ss_size, 8);

/*
 * WHY: wasm32 musl translates the public time64 struct above into the
 * historical four-native-long kernel record. These width assertions bind the
 * generated 16-byte kernel contract to the translation's actual scalar types.
 */
_Static_assert(sizeof(time_t) == 8, "wasm32 time_t width");
_Static_assert(sizeof(long) == 4, "wasm32 kernel itimerval scalar width");

_Static_assert(sizeof(struct mq_attr) == 32, "wasm32 mq_attr size");
ASSERT_OFFSET(struct mq_attr, mq_flags, 0);
ASSERT_OFFSET(struct mq_attr, mq_maxmsg, 4);
ASSERT_OFFSET(struct mq_attr, mq_msgsize, 8);
ASSERT_OFFSET(struct mq_attr, mq_curmsgs, 12);

ASSERT_OFFSET(struct sigevent, sigev_value, 0);
ASSERT_OFFSET(struct sigevent, sigev_signo, 4);
ASSERT_OFFSET(struct sigevent, sigev_notify, 8);
ASSERT_OFFSET(struct sigevent, __sev_fields, 12);

_Static_assert(sizeof(struct statfs) == 88, "wasm32 statfs size");
ASSERT_OFFSET(struct statfs, f_type, 0);
ASSERT_OFFSET(struct statfs, f_bsize, 4);
ASSERT_OFFSET(struct statfs, f_blocks, 8);
ASSERT_OFFSET(struct statfs, f_bfree, 16);
ASSERT_OFFSET(struct statfs, f_bavail, 24);
ASSERT_OFFSET(struct statfs, f_files, 32);
ASSERT_OFFSET(struct statfs, f_ffree, 40);
ASSERT_OFFSET(struct statfs, f_fsid, 48);
ASSERT_OFFSET(struct statfs, f_namelen, 56);
ASSERT_OFFSET(struct statfs, f_frsize, 60);
ASSERT_OFFSET(struct statfs, f_flags, 64);
ASSERT_OFFSET(struct statfs, f_spare, 68);

_Static_assert(sizeof(struct sysinfo) == 312, "wasm32 sysinfo size");
ASSERT_OFFSET(struct sysinfo, uptime, 0);
ASSERT_OFFSET(struct sysinfo, loads, 4);
ASSERT_OFFSET(struct sysinfo, totalram, 16);
ASSERT_OFFSET(struct sysinfo, freeram, 20);
ASSERT_OFFSET(struct sysinfo, sharedram, 24);
ASSERT_OFFSET(struct sysinfo, bufferram, 28);
ASSERT_OFFSET(struct sysinfo, totalswap, 32);
ASSERT_OFFSET(struct sysinfo, freeswap, 36);
ASSERT_OFFSET(struct sysinfo, procs, 40);
ASSERT_OFFSET(struct sysinfo, pad, 42);
ASSERT_OFFSET(struct sysinfo, totalhigh, 44);
ASSERT_OFFSET(struct sysinfo, freehigh, 48);
ASSERT_OFFSET(struct sysinfo, mem_unit, 52);
ASSERT_OFFSET(struct sysinfo, __reserved, 56);

#elif __SIZEOF_POINTER__ == 8

_Static_assert(sizeof(stack_t) == 24, "wasm64 stack_t size");
ASSERT_OFFSET(stack_t, ss_sp, 0);
ASSERT_OFFSET(stack_t, ss_flags, 8);
ASSERT_OFFSET(stack_t, ss_size, 16);

_Static_assert(sizeof(time_t) == 8, "wasm64 time_t width");
_Static_assert(sizeof(long) == 8, "wasm64 kernel itimerval scalar width");

_Static_assert(sizeof(struct mq_attr) == 64, "wasm64 mq_attr size");
ASSERT_OFFSET(struct mq_attr, mq_flags, 0);
ASSERT_OFFSET(struct mq_attr, mq_maxmsg, 8);
ASSERT_OFFSET(struct mq_attr, mq_msgsize, 16);
ASSERT_OFFSET(struct mq_attr, mq_curmsgs, 24);

ASSERT_OFFSET(struct sigevent, sigev_value, 0);
ASSERT_OFFSET(struct sigevent, sigev_signo, 8);
ASSERT_OFFSET(struct sigevent, sigev_notify, 12);
ASSERT_OFFSET(struct sigevent, __sev_fields, 16);

_Static_assert(sizeof(struct statfs) == 120, "wasm64 statfs size");
ASSERT_OFFSET(struct statfs, f_type, 0);
ASSERT_OFFSET(struct statfs, f_bsize, 8);
ASSERT_OFFSET(struct statfs, f_blocks, 16);
ASSERT_OFFSET(struct statfs, f_bfree, 24);
ASSERT_OFFSET(struct statfs, f_bavail, 32);
ASSERT_OFFSET(struct statfs, f_files, 40);
ASSERT_OFFSET(struct statfs, f_ffree, 48);
ASSERT_OFFSET(struct statfs, f_fsid, 56);
ASSERT_OFFSET(struct statfs, f_namelen, 64);
ASSERT_OFFSET(struct statfs, f_frsize, 72);
ASSERT_OFFSET(struct statfs, f_flags, 80);
ASSERT_OFFSET(struct statfs, f_spare, 88);

_Static_assert(sizeof(struct sysinfo) == 368, "wasm64 sysinfo size");
ASSERT_OFFSET(struct sysinfo, uptime, 0);
ASSERT_OFFSET(struct sysinfo, loads, 8);
ASSERT_OFFSET(struct sysinfo, totalram, 32);
ASSERT_OFFSET(struct sysinfo, freeram, 40);
ASSERT_OFFSET(struct sysinfo, sharedram, 48);
ASSERT_OFFSET(struct sysinfo, bufferram, 56);
ASSERT_OFFSET(struct sysinfo, totalswap, 64);
ASSERT_OFFSET(struct sysinfo, freeswap, 72);
ASSERT_OFFSET(struct sysinfo, procs, 80);
ASSERT_OFFSET(struct sysinfo, pad, 82);
ASSERT_OFFSET(struct sysinfo, totalhigh, 88);
ASSERT_OFFSET(struct sysinfo, freehigh, 96);
ASSERT_OFFSET(struct sysinfo, mem_unit, 104);
ASSERT_OFFSET(struct sysinfo, __reserved, 108);

#else
#error "Kandelo supports only four- and eight-byte process pointers"
#endif
