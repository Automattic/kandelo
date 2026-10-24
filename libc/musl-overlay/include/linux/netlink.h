/*
 * <linux/netlink.h> for kandelo: the Linux UAPI netlink address, message
 * header and protocol numbers.
 *
 * The kernel implements only NETLINK_KOBJECT_UEVENT, the protocol a udev
 * monitor listens on; socket() returns EPROTONOSUPPORT for the others.
 *
 * Any change here is part of the kernel ABI — bump ABI_VERSION.
 */
#ifndef _LINUX_NETLINK_H
#define _LINUX_NETLINK_H 1

#include <stdint.h>
#include <sys/socket.h>

#define NETLINK_ROUTE          0
#define NETLINK_UNUSED         1
#define NETLINK_USERSOCK       2
#define NETLINK_FIREWALL       3
#define NETLINK_SOCK_DIAG      4
#define NETLINK_NFLOG          5
#define NETLINK_XFRM           6
#define NETLINK_SELINUX        7
#define NETLINK_ISCSI          8
#define NETLINK_AUDIT          9
#define NETLINK_FIB_LOOKUP     10
#define NETLINK_CONNECTOR      11
#define NETLINK_NETFILTER      12
#define NETLINK_IP6_FW         13
#define NETLINK_DNRTMSG        14
#define NETLINK_KOBJECT_UEVENT 15
#define NETLINK_GENERIC        16
#define NETLINK_SCSITRANSPORT  18
#define NETLINK_ECRYPTFS       19
#define NETLINK_RDMA           20
#define NETLINK_CRYPTO         21
#define NETLINK_SMC            22

struct sockaddr_nl {
	sa_family_t nl_family;
	unsigned short nl_pad;
	uint32_t nl_pid;
	uint32_t nl_groups;
};

struct nlmsghdr {
	uint32_t nlmsg_len;
	uint16_t nlmsg_type;
	uint16_t nlmsg_flags;
	uint32_t nlmsg_seq;
	uint32_t nlmsg_pid;
};

#define NLM_F_REQUEST 0x01
#define NLM_F_MULTI   0x02
#define NLM_F_ACK     0x04
#define NLM_F_ECHO    0x08

#define NLMSG_ALIGNTO     4U
#define NLMSG_ALIGN(len)  (((len) + NLMSG_ALIGNTO - 1) & ~(NLMSG_ALIGNTO - 1))
#define NLMSG_HDRLEN      ((int)NLMSG_ALIGN(sizeof(struct nlmsghdr)))
#define NLMSG_LENGTH(len) ((len) + NLMSG_HDRLEN)
#define NLMSG_SPACE(len)  NLMSG_ALIGN(NLMSG_LENGTH(len))
#define NLMSG_DATA(nlh)   ((void *)(((char *)(nlh)) + NLMSG_HDRLEN))
#define NLMSG_NEXT(nlh, len) \
	((len) -= NLMSG_ALIGN((nlh)->nlmsg_len), \
	 (struct nlmsghdr *)(((char *)(nlh)) + NLMSG_ALIGN((nlh)->nlmsg_len)))
#define NLMSG_OK(nlh, len) \
	((len) >= (int)sizeof(struct nlmsghdr) && \
	 (nlh)->nlmsg_len >= sizeof(struct nlmsghdr) && \
	 (nlh)->nlmsg_len <= (len))
#define NLMSG_PAYLOAD(nlh, len) ((nlh)->nlmsg_len - NLMSG_SPACE((len)))

#define NLMSG_NOOP    0x1
#define NLMSG_ERROR   0x2
#define NLMSG_DONE    0x3
#define NLMSG_OVERRUN 0x4

struct nlmsgerr {
	int error;
	struct nlmsghdr msg;
};

#endif
