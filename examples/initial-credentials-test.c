/* Report the initial process credentials supplied by the host. */
#include <stdio.h>
#include <unistd.h>

int main(void) {
    printf("uid=%lu euid=%lu gid=%lu egid=%lu\n",
           (unsigned long) getuid(),
           (unsigned long) geteuid(),
           (unsigned long) getgid(),
           (unsigned long) getegid());
    return 0;
}
