#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

__attribute__((import_module("kandelo.clock.v1"),import_name("__kandelo_clock_query_v1")))
extern int __kandelo_clock_query_v1(void *,int,unsigned);
static struct timespec sample;
static int checked_clock(void) {
    if (clock_gettime(CLOCK_REALTIME, &sample)) return 1;
    return sample.tv_sec <= 0 || sample.tv_nsec < 0 || sample.tv_nsec >= 1000000000;
}
int main(void) {
    int fd = open("/tmp/clock-query-probe", O_CREAT|O_RDWR|O_TRUNC, 0600);
    if (fd < 0 || write(fd, "x", 1) != 1 || close(fd)) return 10;
    if (write(1,"CLOCK_PHASE plain\n",18)!=18)return 25;
    for (unsigned i=0; i<128; ++i) if (checked_clock()) return 11;
    if (write(1,"CLOCK_PHASE metadata\n",21)!=21)return 25;
    // The phase marker invalidates the previous certificate. The first read
    // establishes one; every real stat thereafter must remain observable.
    if (checked_clock()) return 12;
    for (unsigned i=0; i<128; ++i) {
        struct stat st;
        if (stat("/tmp/clock-query-probe", &st) || st.st_size != 1) return 13;
        if (checked_clock()) return 14;
    }
    if (write(1,"CLOCK_PHASE done\n",17)!=17)return 25;
    unsigned char *pages=mmap(0,2*65536,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(pages==MAP_FAILED) return 15;
    struct timespec *cross=(struct timespec *)(pages+65536-8);
    if(clock_gettime(CLOCK_REALTIME,cross)||clock_gettime(CLOCK_REALTIME,cross)) return 16;
    unsigned char before[16];memcpy(before,cross,16);
    if(mprotect(pages+65536,65536,PROT_READ))return 17;
    if(__kandelo_clock_query_v1(cross,CLOCK_REALTIME,0)!=1||memcmp(before,cross,16))return 18;
    if(mprotect(pages+65536,65536,PROT_READ|PROT_WRITE)||clock_gettime(CLOCK_REALTIME,cross))return 19;
    if(munmap(pages,2*65536))return 20;
    if(__kandelo_clock_query_v1(cross,CLOCK_REALTIME,0)!=1)return 21;
    puts("PASS clock: real timestamp reads and 128 uncached metadata checks");
    return 0;
}
