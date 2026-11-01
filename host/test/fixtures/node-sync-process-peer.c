#include <stdio.h>
#include <unistd.h>

int main(void) {
    pid_t sid = getsid(0);
    if (sid < 0) { perror("getsid"); return 1; }
    printf("%ld %ld %ld %lu %lu %lu %lu\n", (long)getpid(),
           (long)getpgrp(), (long)sid, (unsigned long)getuid(),
           (unsigned long)geteuid(), (unsigned long)getgid(),
           (unsigned long)getegid());
    return 0;
}
