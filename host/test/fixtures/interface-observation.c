/* Print what getifaddrs() reports, one interface per line:
 *   <name> flags=<hex> addr=<a> netmask=<m> broadcast=<b>
 * with "-" for an absent address. */
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdio.h>

static const char *show(struct sockaddr *sa, char *buf) {
    if (!sa) return "-";
    if (sa->sa_family != AF_INET) return "?";
    return inet_ntop(AF_INET, &((struct sockaddr_in *)sa)->sin_addr, buf, INET_ADDRSTRLEN);
}

int main(void) {
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
