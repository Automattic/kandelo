/* Exercise Kandelo's virtual-interface ioctl and libc name/index contracts. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <net/if.h>
#include <net/if_arp.h>

static int failures;

static void check(int condition, const char *description)
{
    if (!condition) {
        printf("FAIL: %s (errno=%d)\n", description, errno);
        failures++;
    }
}

static void set_ifreq_name(struct ifreq *ifr, const char *name)
{
    memset(ifr, 0, sizeof(*ifr));
    strncpy(ifr->ifr_name, name, IF_NAMESIZE - 1);
}

static unsigned char *ifreq_ipv4(struct ifreq *ifr)
{
    return (unsigned char *)&ifr->ifr_addr + 4;
}

static int bytes_equal(const unsigned char *actual,
                       unsigned char a, unsigned char b,
                       unsigned char c, unsigned char d)
{
    return actual[0] == a && actual[1] == b &&
           actual[2] == c && actual[3] == d;
}

static void check_ifconf(int fd)
{
    struct ifconf ifc = {0};
    struct ifreq interfaces[4];

    check(ioctl(fd, SIOCGIFCONF, &ifc) == 0,
          "SIOCGIFCONF size query succeeds");
    check(ifc.ifc_len == 2 * (int)sizeof(struct ifreq),
          "SIOCGIFCONF size query reports two interfaces");
    printf("ifreq-size: %zu\n", sizeof(struct ifreq));

    struct {
        struct ifreq entry;
        unsigned char guard[16];
    } bounded;
    memset(&bounded, 0, sizeof(bounded));
    memset(bounded.guard, 0xa5, sizeof(bounded.guard));
    ifc.ifc_len = sizeof(bounded.entry);
    ifc.ifc_req = &bounded.entry;
    check(ioctl(fd, SIOCGIFCONF, &ifc) == 0,
          "bounded SIOCGIFCONF succeeds");
    check(ifc.ifc_len == (int)sizeof(struct ifreq),
          "bounded SIOCGIFCONF writes one complete entry");
    check(strcmp(bounded.entry.ifr_name, "lo") == 0,
          "bounded SIOCGIFCONF returns lo first");
    for (size_t i = 0; i < sizeof(bounded.guard); i++) {
        check(bounded.guard[i] == 0xa5,
              "bounded SIOCGIFCONF preserves trailing guard bytes");
    }

    memset(interfaces, 0xcc, sizeof(interfaces));
    ifc.ifc_len = sizeof(interfaces);
    ifc.ifc_req = interfaces;
    check(ioctl(fd, SIOCGIFCONF, &ifc) == 0,
          "full SIOCGIFCONF succeeds");
    int count = ifc.ifc_len / (int)sizeof(struct ifreq);
    check(count == 2, "full SIOCGIFCONF returns two interfaces");
    check(strcmp(interfaces[0].ifr_name, "lo") == 0,
          "SIOCGIFCONF names loopback lo");
    check(strcmp(interfaces[1].ifr_name, "eth0") == 0,
          "SIOCGIFCONF names external interface eth0");
    check(interfaces[0].ifr_addr.sa_family == AF_INET,
          "lo SIOCGIFCONF address uses AF_INET");
    check(interfaces[1].ifr_addr.sa_family == AF_INET,
          "eth0 SIOCGIFCONF address uses AF_INET");
    check(bytes_equal(ifreq_ipv4(&interfaces[0]), 127, 0, 0, 1),
          "lo SIOCGIFCONF address is loopback");
    unsigned char *eth = ifreq_ipv4(&interfaces[1]);
    printf("ifconf: lo=127.0.0.1 eth0=%u.%u.%u.%u\n",
           eth[0], eth[1], eth[2], eth[3]);

    ifc.ifc_len = sizeof(struct ifreq);
    ifc.ifc_req = (struct ifreq *)(uintptr_t)-16;
    errno = 0;
    check(ioctl(fd, SIOCGIFCONF, &ifc) == -1 && errno == EFAULT,
          "SIOCGIFCONF rejects an invalid nested buffer");

    ifc.ifc_len = -1;
    ifc.ifc_req = interfaces;
    errno = 0;
    check(ioctl(fd, SIOCGIFCONF, &ifc) == -1 && errno == EINVAL,
          "SIOCGIFCONF rejects a negative length");

    errno = 0;
    check(ioctl(fd, SIOCGIFCONF, (void *)(uintptr_t)-16) == -1 &&
          errno == EFAULT,
          "SIOCGIFCONF rejects an invalid outer pointer");
}

static void check_name_index_ioctls(int fd)
{
    struct ifreq ifr;

    set_ifreq_name(&ifr, "lo");
    check(ioctl(fd, SIOCGIFINDEX, &ifr) == 0 && ifr.ifr_ifindex == 1,
          "SIOCGIFINDEX maps lo to 1");
    set_ifreq_name(&ifr, "eth0");
    check(ioctl(fd, SIOCGIFINDEX, &ifr) == 0 && ifr.ifr_ifindex == 2,
          "SIOCGIFINDEX maps eth0 to 2");
    set_ifreq_name(&ifr, "missing0");
    errno = 0;
    check(ioctl(fd, SIOCGIFINDEX, &ifr) == -1 && errno == ENODEV,
          "SIOCGIFINDEX rejects an unknown name");

    memset(&ifr, 0, sizeof(ifr));
    ifr.ifr_ifindex = 1;
    check(ioctl(fd, SIOCGIFNAME, &ifr) == 0 &&
          strcmp(ifr.ifr_name, "lo") == 0,
          "SIOCGIFNAME maps 1 to lo");
    memset(&ifr, 0, sizeof(ifr));
    ifr.ifr_ifindex = 2;
    check(ioctl(fd, SIOCGIFNAME, &ifr) == 0 &&
          strcmp(ifr.ifr_name, "eth0") == 0,
          "SIOCGIFNAME maps 2 to eth0");
    memset(&ifr, 0, sizeof(ifr));
    ifr.ifr_ifindex = 99;
    errno = 0;
    check(ioctl(fd, SIOCGIFNAME, &ifr) == -1 && errno == ENODEV,
          "SIOCGIFNAME rejects an unknown index");

    errno = 0;
    check(ioctl(fd, SIOCGIFINDEX, (void *)(uintptr_t)-16) == -1 &&
          errno == EFAULT,
          "SIOCGIFINDEX rejects an invalid pointer");
    errno = 0;
    check(ioctl(fd, SIOCGIFNAME, (void *)(uintptr_t)-16) == -1 &&
          errno == EFAULT,
          "SIOCGIFNAME rejects an invalid pointer");
}

static void check_addresses(int fd)
{
    struct ifreq ifr;

    set_ifreq_name(&ifr, "lo");
    check(ioctl(fd, SIOCGIFADDR, &ifr) == 0,
          "SIOCGIFADDR returns lo address");
    check(ifr.ifr_addr.sa_family == AF_INET &&
          bytes_equal(ifreq_ipv4(&ifr), 127, 0, 0, 1),
          "SIOCGIFADDR reports 127.0.0.1 for lo");

    set_ifreq_name(&ifr, "eth0");
    check(ioctl(fd, SIOCGIFADDR, &ifr) == 0,
          "SIOCGIFADDR returns the backend eth0 address");
    check(ifr.ifr_addr.sa_family == AF_INET,
          "eth0 SIOCGIFADDR address uses AF_INET");
    unsigned char *address = ifreq_ipv4(&ifr);
    printf("eth0-address: %u.%u.%u.%u\n",
           address[0], address[1], address[2], address[3]);

    set_ifreq_name(&ifr, "missing0");
    errno = 0;
    check(ioctl(fd, SIOCGIFADDR, &ifr) == -1 && errno == ENODEV,
          "SIOCGIFADDR rejects an unknown name");
    errno = 0;
    check(ioctl(fd, SIOCGIFADDR, (void *)(uintptr_t)-16) == -1 &&
          errno == EFAULT,
          "SIOCGIFADDR rejects an invalid pointer");
}

static void check_hardware_addresses(int fd)
{
    struct ifreq ifr;

    set_ifreq_name(&ifr, "lo");
    check(ioctl(fd, SIOCGIFHWADDR, &ifr) == 0,
          "SIOCGIFHWADDR returns lo hardware type");
    check(ifr.ifr_hwaddr.sa_family == ARPHRD_LOOPBACK,
          "lo uses ARPHRD_LOOPBACK");
    int all_zero = 1;
    for (int i = 0; i < 6; i++) {
        if ((unsigned char)ifr.ifr_hwaddr.sa_data[i] != 0) all_zero = 0;
    }
    check(all_zero, "lo hardware address is all zero");

    set_ifreq_name(&ifr, "eth0");
    check(ioctl(fd, SIOCGIFHWADDR, &ifr) == 0,
          "SIOCGIFHWADDR returns eth0 hardware address");
    check(ifr.ifr_hwaddr.sa_family == ARPHRD_ETHER,
          "eth0 uses ARPHRD_ETHER");
    unsigned char *mac = (unsigned char *)ifr.ifr_hwaddr.sa_data;
    all_zero = 1;
    for (int i = 0; i < 6; i++) if (mac[i]) all_zero = 0;
    check(!all_zero, "eth0 hardware address is non-zero");
    check((mac[0] & 0x02) != 0 && (mac[0] & 0x01) == 0,
          "eth0 hardware address is local unicast");
    printf("eth0-mac: %02x:%02x:%02x:%02x:%02x:%02x\n",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    set_ifreq_name(&ifr, "missing0");
    errno = 0;
    check(ioctl(fd, SIOCGIFHWADDR, &ifr) == -1 && errno == ENODEV,
          "SIOCGIFHWADDR rejects an unknown name");
    errno = 0;
    check(ioctl(fd, SIOCGIFHWADDR, (void *)(uintptr_t)-16) == -1 &&
          errno == EFAULT,
          "SIOCGIFHWADDR rejects an invalid pointer");
}

static void check_libc_name_index(void)
{
    errno = 0;
    unsigned lo = if_nametoindex("lo");
    unsigned eth0 = if_nametoindex("eth0");
    unsigned missing = if_nametoindex("missing0");
    int missing_errno = errno;
    check(lo == 1 && eth0 == 2, "if_nametoindex uses host ioctl mappings");
    check(missing == 0 && missing_errno == ENODEV,
          "if_nametoindex rejects an unknown name");
    printf("libc-name-to-index: lo=%u eth0=%u missing=%u errno=%d\n",
           lo, eth0, missing, missing_errno);

    char name[IF_NAMESIZE];
    check(if_indextoname(1, name) && strcmp(name, "lo") == 0,
          "if_indextoname maps 1 to lo");
    check(if_indextoname(2, name) && strcmp(name, "eth0") == 0,
          "if_indextoname maps 2 to eth0");
    errno = 0;
    char *invalid = if_indextoname(99, name);
    int invalid_errno = errno;
    check(!invalid && invalid_errno == ENXIO,
          "if_indextoname reports ENXIO for an unknown index");
    printf("libc-invalid-index: errno=%d\n", invalid_errno);

    struct if_nameindex *list = if_nameindex();
    check(list != NULL, "if_nameindex returns an interface list");
    if (list) {
        int count = 0;
        int saw_lo = 0;
        int saw_eth0 = 0;
        for (struct if_nameindex *entry = list; entry->if_index; entry++) {
            printf("nameindex: %s=%u\n", entry->if_name, entry->if_index);
            saw_lo |= entry->if_index == 1 &&
                      strcmp(entry->if_name, "lo") == 0;
            saw_eth0 |= entry->if_index == 2 &&
                        strcmp(entry->if_name, "eth0") == 0;
            count++;
        }
        check(count == 2 && saw_lo && saw_eth0,
              "if_nameindex discovers lo and eth0 through ioctls");
        if_freenameindex(list);
    }
}

int main(void)
{
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    check_ifconf(fd);
    check_name_index_ioctls(fd);
    check_addresses(fd);
    check_hardware_addresses(fd);
    check_libc_name_index();

    close(fd);
    if (failures) {
        printf("FAILURES: %d\n", failures);
        return 1;
    }
    printf("PASS: virtual interface ioctl and libc contracts\n");
    return 0;
}
