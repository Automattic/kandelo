#define _GNU_SOURCE

#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    cpu_set_t set;

    memset(&set, 0xa5, sizeof(set));
    if (sched_getaffinity(0, sizeof(set), &set) != 0) {
        perror("sched_getaffinity");
        return 1;
    }
    if (!CPU_ISSET(0, &set)) {
        fputs("CPU 0 missing\n", stderr);
        return 2;
    }
    for (int cpu = 1; cpu < CPU_SETSIZE; ++cpu) {
        if (CPU_ISSET(cpu, &set)) {
            fprintf(stderr, "unexpected CPU %d\n", cpu);
            return 3;
        }
    }

    long online = sysconf(_SC_NPROCESSORS_ONLN);
    if (online != 1) {
        fprintf(stderr, "unexpected online CPU count: %ld\n", online);
        return 4;
    }

    errno = 0;
    if (sched_getaffinity(0, 0, &set) != -1 || errno != EINVAL) {
        fprintf(stderr, "zero-size affinity returned errno %d\n", errno);
        return 5;
    }

    printf("sched-getaffinity-ok cpus=%ld\n", online);
    return 0;
}
