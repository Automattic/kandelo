/* Print what getifaddrs() reports, one interface per line:
 *   <name> flags=<hex> addr=<a> netmask=<m> broadcast=<b>
 * with "-" for an absent address. With "send ADDRESS", send one UDP
 * datagram there instead and print "send errno=<n>" (0 on success). */
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>

static const char *show(struct sockaddr *sa, char *buf) {
    if (!sa) return "-";
    if (sa->sa_family != AF_INET) return "?";
    return inet_ntop(AF_INET, &((struct sockaddr_in *)sa)->sin_addr, buf, INET_ADDRSTRLEN);
}

int main(int argc, char **argv) {
    if (argc == 3 && !strcmp(argv[1], "send")) {
        int fd = socket(AF_INET, SOCK_DGRAM, 0);
        struct sockaddr_in dst = { .sin_family = AF_INET, .sin_port = htons(9) };
        if (fd < 0 || inet_pton(AF_INET, argv[2], &dst.sin_addr) != 1) return 2;
        ssize_t sent = sendto(fd, "x", 1, 0, (struct sockaddr *)&dst, sizeof dst);
        printf("send errno=%d\n", sent == 1 ? 0 : errno);
        return 0;
    }
    struct ifaddrs *list;
    if (getifaddrs(&list) != 0) { perror("getifaddrs"); return 1; }
    for (struct ifaddrs *ifa = list; ifa; ifa = ifa->ifa_next) {
        char a[INET_ADDRSTRLEN], m[INET_ADDRSTRLEN], b[INET_ADDRSTRLEN];
        printf("%s flags=%#x addr=%s netmask=%s broadcast=%s\n", ifa->ifa_name, ifa->ifa_flags,
            show(ifa->ifa_addr, a), show(ifa->ifa_netmask, m),
            show((ifa->ifa_flags & IFF_BROADCAST) ? ifa->ifa_broadaddr : 0, b));
    }
    freeifaddrs(list);
    return 0;
}
