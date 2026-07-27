#define _GNU_SOURCE

#include <bits/kandelo_process_layouts.h>
#include <mqueue.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/statfs.h>
#include <sys/sysinfo.h>
#include <sys/time.h>
#include <sys/uio.h>
#include <sys/un.h>

#define ASSERT_OFFSET(type, field, expected) \
	_Static_assert(offsetof(type, field) == (expected), #type "." #field)

_Static_assert(sizeof(long) == sizeof(void *),
	       "Kandelo process long and pointer widths must match");
_Static_assert(sizeof(int) == KANDELO_SCM_RIGHTS_FD_BYTES,
	       "generated SCM_RIGHTS descriptor width");
_Static_assert(SOL_SOCKET == KANDELO_SOCKET_SOL_SOCKET,
	       "generated SOL_SOCKET value");
_Static_assert(SCM_RIGHTS == KANDELO_SOCKET_SCM_RIGHTS,
	       "generated SCM_RIGHTS value");
_Static_assert(sizeof(struct sockaddr_storage) ==
	       KANDELO_SOCKADDR_STORAGE_BYTES,
	       "generated sockaddr_storage size");
ASSERT_OFFSET(struct sockaddr_storage, ss_family, 0);
_Static_assert(sizeof(struct sockaddr_un) == KANDELO_SOCKADDR_UNIX_BYTES,
	       "generated sockaddr_un size");
ASSERT_OFFSET(struct sockaddr_un, sun_path,
	      KANDELO_SOCKADDR_UNIX_PATH_OFFSET_BYTES);
_Static_assert(sizeof(((struct sockaddr_un *)0)->sun_path) ==
	       KANDELO_SOCKADDR_UNIX_PATH_BYTES,
	       "generated sockaddr_un sun_path size");
_Static_assert(FD_SETSIZE == KANDELO_SELECT_FD_SETSIZE,
	       "generated FD_SETSIZE");
_Static_assert(sizeof(fd_set) == KANDELO_SELECT_FD_SET_BYTES,
	       "generated fd_set size");
_Static_assert(sizeof(struct pollfd) == KANDELO_KERNEL_POLLFD_SIZE,
	       "generated pollfd size");
ASSERT_OFFSET(struct pollfd, fd, KANDELO_KERNEL_POLLFD_FD_OFFSET);
ASSERT_OFFSET(struct pollfd, events, KANDELO_KERNEL_POLLFD_EVENTS_OFFSET);
ASSERT_OFFSET(struct pollfd, revents, KANDELO_KERNEL_POLLFD_REVENTS_OFFSET);
_Static_assert(sizeof(struct itimerval) == 32, "public time64 itimerval size");
ASSERT_OFFSET(struct itimerval, it_interval.tv_sec, 0);
ASSERT_OFFSET(struct itimerval, it_interval.tv_usec, 8);
ASSERT_OFFSET(struct itimerval, it_value.tv_sec, 16);
ASSERT_OFFSET(struct itimerval, it_value.tv_usec, 24);
#if __SIZEOF_POINTER__ == 4

_Static_assert(sizeof(socklen_t) == KANDELO_SCM_RIGHTS_FD_BYTES,
	       "wasm32 socklen_t width");
_Static_assert(sizeof(int) == KANDELO_SCM_RIGHTS_FD_BYTES,
	       "wasm32 int width");

_Static_assert(sizeof(struct iovec) == KANDELO_PROCESS_IOVEC_WASM32_SIZE,
	       "generated wasm32 iovec size");
ASSERT_OFFSET(struct iovec, iov_base,
	      KANDELO_PROCESS_IOVEC_WASM32_BASE_OFFSET);
ASSERT_OFFSET(struct iovec, iov_len,
	      KANDELO_PROCESS_IOVEC_WASM32_LEN_OFFSET);

_Static_assert(sizeof(struct msghdr) == KANDELO_PROCESS_MSGHDR_WASM32_SIZE,
	       "generated wasm32 msghdr size");
ASSERT_OFFSET(struct msghdr, msg_name,
	      KANDELO_PROCESS_MSGHDR_WASM32_NAME_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_namelen,
	      KANDELO_PROCESS_MSGHDR_WASM32_NAMELEN_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_iov,
	      KANDELO_PROCESS_MSGHDR_WASM32_IOV_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_iovlen,
	      KANDELO_PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_control,
	      KANDELO_PROCESS_MSGHDR_WASM32_CONTROL_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_controllen,
	      KANDELO_PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_flags,
	      KANDELO_PROCESS_MSGHDR_WASM32_FLAGS_OFFSET);

_Static_assert(sizeof(struct cmsghdr) ==
	       KANDELO_PROCESS_CMSGHDR_WASM32_SIZE,
	       "generated wasm32 cmsghdr size");
ASSERT_OFFSET(struct cmsghdr, cmsg_len,
	      KANDELO_PROCESS_CMSGHDR_WASM32_LEN_OFFSET);
ASSERT_OFFSET(struct cmsghdr, cmsg_level,
	      KANDELO_PROCESS_CMSGHDR_WASM32_LEVEL_OFFSET);
ASSERT_OFFSET(struct cmsghdr, cmsg_type,
	      KANDELO_PROCESS_CMSGHDR_WASM32_TYPE_OFFSET);
_Static_assert(CMSG_ALIGN(1) == KANDELO_PROCESS_CMSGHDR_WASM32_ALIGN,
	       "generated wasm32 CMSG alignment");
_Static_assert(CMSG_LEN(0) == KANDELO_PROCESS_CMSGHDR_WASM32_DATA_OFFSET,
	       "generated wasm32 CMSG data offset");
_Static_assert(CMSG_ALIGN(KANDELO_SCM_RIGHTS_FD_BYTES) ==
	       KANDELO_PROCESS_CMSGHDR_WASM32_ALIGN,
	       "generated wasm32 SCM_RIGHTS payload alignment");
_Static_assert(CMSG_LEN(KANDELO_SCM_RIGHTS_FD_BYTES) ==
	       KANDELO_PROCESS_CMSGHDR_WASM32_DATA_OFFSET +
		       KANDELO_SCM_RIGHTS_FD_BYTES,
	       "generated wasm32 SCM_RIGHTS one-fd length");
_Static_assert(CMSG_SPACE(KANDELO_SCM_RIGHTS_FD_BYTES) ==
	       KANDELO_PROCESS_CMSGHDR_WASM32_DATA_OFFSET +
		       KANDELO_PROCESS_CMSGHDR_WASM32_ALIGN,
	       "generated wasm32 SCM_RIGHTS one-fd space");
_Static_assert(sizeof(struct group_req) ==
	       KANDELO_PROCESS_GROUP_REQ_WASM32_SIZE,
	       "generated wasm32 group_req size");
ASSERT_OFFSET(struct group_req, gr_group,
	      KANDELO_PROCESS_GROUP_REQ_WASM32_GROUP_OFFSET);
_Static_assert(sizeof(struct group_source_req) ==
	       KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM32_SIZE,
	       "generated wasm32 group_source_req size");
ASSERT_OFFSET(struct group_source_req, gsr_source,
	      KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM32_SOURCE_OFFSET);

_Static_assert(sizeof(stack_t) == 12, "wasm32 stack_t size");
ASSERT_OFFSET(stack_t, ss_sp, 0);
ASSERT_OFFSET(stack_t, ss_flags, 4);
ASSERT_OFFSET(stack_t, ss_size, 8);
_Static_assert(sizeof(siginfo_t) == KANDELO_PROCESS_SIGINFO_WASM32_SIZE,
	       "generated wasm32 siginfo_t size");
ASSERT_OFFSET(siginfo_t, si_signo, KANDELO_PROCESS_SIGINFO_SIGNO_OFFSET);
ASSERT_OFFSET(siginfo_t, si_errno, KANDELO_PROCESS_SIGINFO_ERRNO_OFFSET);
ASSERT_OFFSET(siginfo_t, si_code, KANDELO_PROCESS_SIGINFO_CODE_OFFSET);
ASSERT_OFFSET(siginfo_t, si_pid, KANDELO_PROCESS_SIGINFO_WASM32_PID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_uid, KANDELO_PROCESS_SIGINFO_WASM32_UID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_value,
	      KANDELO_PROCESS_SIGINFO_WASM32_VALUE_OFFSET);
ASSERT_OFFSET(siginfo_t, si_timerid,
	      KANDELO_PROCESS_SIGINFO_WASM32_PID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_overrun,
	      KANDELO_PROCESS_SIGINFO_WASM32_UID_OFFSET);

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

_Static_assert(sizeof(union sigval) ==
	       KANDELO_PROCESS_SIGEVENT_WASM32_VALUE_SIZE,
	       "generated wasm32 sigval width");
_Static_assert(sizeof(struct sigevent) ==
	       KANDELO_PROCESS_SIGEVENT_WASM32_SIZE,
	       "generated wasm32 sigevent size");
ASSERT_OFFSET(struct sigevent, sigev_value,
	      KANDELO_PROCESS_SIGEVENT_WASM32_VALUE_OFFSET);
ASSERT_OFFSET(struct sigevent, sigev_signo,
	      KANDELO_PROCESS_SIGEVENT_WASM32_SIGNO_OFFSET);
ASSERT_OFFSET(struct sigevent, sigev_notify,
	      KANDELO_PROCESS_SIGEVENT_WASM32_NOTIFY_OFFSET);
ASSERT_OFFSET(struct sigevent, __sev_fields,
	      KANDELO_PROCESS_SIGEVENT_WASM32_PAYLOAD_OFFSET);

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

_Static_assert(sizeof(socklen_t) == KANDELO_SCM_RIGHTS_FD_BYTES,
	       "wasm64 socklen_t width");
_Static_assert(sizeof(int) == KANDELO_SCM_RIGHTS_FD_BYTES,
	       "wasm64 int width");

_Static_assert(sizeof(struct iovec) == KANDELO_PROCESS_IOVEC_WASM64_SIZE,
	       "generated wasm64 iovec size");
ASSERT_OFFSET(struct iovec, iov_base,
	      KANDELO_PROCESS_IOVEC_WASM64_BASE_OFFSET);
ASSERT_OFFSET(struct iovec, iov_len,
	      KANDELO_PROCESS_IOVEC_WASM64_LEN_OFFSET);

_Static_assert(sizeof(struct msghdr) == KANDELO_PROCESS_MSGHDR_WASM64_SIZE,
	       "generated wasm64 msghdr size");
ASSERT_OFFSET(struct msghdr, msg_name,
	      KANDELO_PROCESS_MSGHDR_WASM64_NAME_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_namelen,
	      KANDELO_PROCESS_MSGHDR_WASM64_NAMELEN_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_iov,
	      KANDELO_PROCESS_MSGHDR_WASM64_IOV_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_iovlen,
	      KANDELO_PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_control,
	      KANDELO_PROCESS_MSGHDR_WASM64_CONTROL_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_controllen,
	      KANDELO_PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET);
ASSERT_OFFSET(struct msghdr, msg_flags,
	      KANDELO_PROCESS_MSGHDR_WASM64_FLAGS_OFFSET);

_Static_assert(sizeof(struct cmsghdr) ==
	       KANDELO_PROCESS_CMSGHDR_WASM64_SIZE,
	       "generated wasm64 cmsghdr size");
ASSERT_OFFSET(struct cmsghdr, cmsg_len,
	      KANDELO_PROCESS_CMSGHDR_WASM64_LEN_OFFSET);
ASSERT_OFFSET(struct cmsghdr, cmsg_level,
	      KANDELO_PROCESS_CMSGHDR_WASM64_LEVEL_OFFSET);
ASSERT_OFFSET(struct cmsghdr, cmsg_type,
	      KANDELO_PROCESS_CMSGHDR_WASM64_TYPE_OFFSET);
_Static_assert(CMSG_ALIGN(1) == KANDELO_PROCESS_CMSGHDR_WASM64_ALIGN,
	       "generated wasm64 CMSG alignment");
_Static_assert(CMSG_LEN(0) == KANDELO_PROCESS_CMSGHDR_WASM64_DATA_OFFSET,
	       "generated wasm64 CMSG data offset");
_Static_assert(CMSG_ALIGN(KANDELO_SCM_RIGHTS_FD_BYTES) ==
	       KANDELO_PROCESS_CMSGHDR_WASM64_ALIGN,
	       "generated wasm64 SCM_RIGHTS payload alignment");
_Static_assert(CMSG_LEN(KANDELO_SCM_RIGHTS_FD_BYTES) ==
	       KANDELO_PROCESS_CMSGHDR_WASM64_DATA_OFFSET +
		       KANDELO_SCM_RIGHTS_FD_BYTES,
	       "generated wasm64 SCM_RIGHTS one-fd length");
_Static_assert(CMSG_SPACE(KANDELO_SCM_RIGHTS_FD_BYTES) ==
	       KANDELO_PROCESS_CMSGHDR_WASM64_DATA_OFFSET +
		       KANDELO_PROCESS_CMSGHDR_WASM64_ALIGN,
	       "generated wasm64 SCM_RIGHTS one-fd space");
_Static_assert(sizeof(struct group_req) ==
	       KANDELO_PROCESS_GROUP_REQ_WASM64_SIZE,
	       "generated wasm64 group_req size");
ASSERT_OFFSET(struct group_req, gr_group,
	      KANDELO_PROCESS_GROUP_REQ_WASM64_GROUP_OFFSET);
_Static_assert(sizeof(struct group_source_req) ==
	       KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM64_SIZE,
	       "generated wasm64 group_source_req size");
ASSERT_OFFSET(struct group_source_req, gsr_source,
	      KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM64_SOURCE_OFFSET);

_Static_assert(sizeof(stack_t) == 24, "wasm64 stack_t size");
ASSERT_OFFSET(stack_t, ss_sp, 0);
ASSERT_OFFSET(stack_t, ss_flags, 8);
ASSERT_OFFSET(stack_t, ss_size, 16);
_Static_assert(sizeof(siginfo_t) == KANDELO_PROCESS_SIGINFO_WASM64_SIZE,
	       "generated wasm64 siginfo_t size");
ASSERT_OFFSET(siginfo_t, si_signo, KANDELO_PROCESS_SIGINFO_SIGNO_OFFSET);
ASSERT_OFFSET(siginfo_t, si_errno, KANDELO_PROCESS_SIGINFO_ERRNO_OFFSET);
ASSERT_OFFSET(siginfo_t, si_code, KANDELO_PROCESS_SIGINFO_CODE_OFFSET);
ASSERT_OFFSET(siginfo_t, si_pid, KANDELO_PROCESS_SIGINFO_WASM64_PID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_uid, KANDELO_PROCESS_SIGINFO_WASM64_UID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_value,
	      KANDELO_PROCESS_SIGINFO_WASM64_VALUE_OFFSET);
ASSERT_OFFSET(siginfo_t, si_timerid,
	      KANDELO_PROCESS_SIGINFO_WASM64_PID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_overrun,
	      KANDELO_PROCESS_SIGINFO_WASM64_UID_OFFSET);

_Static_assert(sizeof(time_t) == 8, "wasm64 time_t width");
_Static_assert(sizeof(long) == 8, "wasm64 kernel itimerval scalar width");

_Static_assert(sizeof(struct mq_attr) == 64, "wasm64 mq_attr size");
ASSERT_OFFSET(struct mq_attr, mq_flags, 0);
ASSERT_OFFSET(struct mq_attr, mq_maxmsg, 8);
ASSERT_OFFSET(struct mq_attr, mq_msgsize, 16);
ASSERT_OFFSET(struct mq_attr, mq_curmsgs, 24);

_Static_assert(sizeof(union sigval) ==
	       KANDELO_PROCESS_SIGEVENT_WASM64_VALUE_SIZE,
	       "generated wasm64 sigval width");
_Static_assert(sizeof(struct sigevent) ==
	       KANDELO_PROCESS_SIGEVENT_WASM64_SIZE,
	       "generated wasm64 sigevent size");
ASSERT_OFFSET(struct sigevent, sigev_value,
	      KANDELO_PROCESS_SIGEVENT_WASM64_VALUE_OFFSET);
ASSERT_OFFSET(struct sigevent, sigev_signo,
	      KANDELO_PROCESS_SIGEVENT_WASM64_SIGNO_OFFSET);
ASSERT_OFFSET(struct sigevent, sigev_notify,
	      KANDELO_PROCESS_SIGEVENT_WASM64_NOTIFY_OFFSET);
ASSERT_OFFSET(struct sigevent, __sev_fields,
	      KANDELO_PROCESS_SIGEVENT_WASM64_PAYLOAD_OFFSET);

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
