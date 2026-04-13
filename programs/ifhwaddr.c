/* Test program: retrieve network interface hardware (MAC) address via ioctl.
 * Uses SIOCGIFCONF to enumerate interfaces, then SIOCGIFHWADDR on each. */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <net/if.h>
#include <net/if_arp.h>

int main(void) {
    struct ifreq ifr[8];
    struct ifconf ifc;
    int fd, i;

    fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    ifc.ifc_req = ifr;
    ifc.ifc_len = sizeof(ifr);

    if (ioctl(fd, SIOCGIFCONF, &ifc) < 0) {
        perror("SIOCGIFCONF");
        close(fd);
        return 1;
    }

    int n = ifc.ifc_len / sizeof(struct ifreq);
    printf("interfaces: %d\n", n);

    for (i = 0; i < n; i++) {
        printf("name: %s\n", ifr[i].ifr_name);

        if (ioctl(fd, SIOCGIFHWADDR, &ifr[i]) < 0) {
            perror("SIOCGIFHWADDR");
            continue;
        }

        unsigned char *mac = (unsigned char *)ifr[i].ifr_hwaddr.sa_data;
        printf("mac: %02x:%02x:%02x:%02x:%02x:%02x\n",
               mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

        /* Check locally-administered bit */
        if (mac[0] & 0x02) {
            printf("locally-administered: yes\n");
        }
        /* Check non-zero */
        int all_zero = 1;
        for (int j = 0; j < 6; j++) {
            if (mac[j]) { all_zero = 0; break; }
        }
        printf("non-zero: %s\n", all_zero ? "no" : "yes");
    }

    close(fd);
    return 0;
}
