#define _GNU_SOURCE 1
/* C library linked into the Rust program (rustbin/). */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Mirrors `Record` in rustbin/src/main.rs; the layouts must agree. */
struct record {
    uint8_t tag;
    uint64_t big;
    uint16_t small;
    double ratio;
};

size_t c_record_size(void) { return sizeof(struct record); }

void c_record_fill(struct record *r) {
    r->tag = 7;
    r->big = 0x0123456789abcdefULL;
    r->small = 0xbeef;
    r->ratio = 0.25;
}

/* compiler-rt's 128-bit intrinsics on the C side of the link. */
uint64_t c_u128_muldiv(uint64_t a, uint64_t b, uint64_t d) {
    return (uint64_t)(((unsigned __int128)a * b) / d);
}

/* Sorts with a comparator the Rust program supplies. */
void c_sort_ints(int *v, size_t n, int (*cmp)(const void *, const void *)) {
    qsort(v, n, sizeof *v, cmp);
}

/* A malloc'd string the Rust program frees with libc free(). */
char *c_describe(int n) {
    char *s = malloc(32);
    if (s) snprintf(s, 32, "C says %d", n);
    return s;
}

void c_set_errno(int e) { errno = e; }

const char *c_getenv(const char *key) { return getenv(key); }

/* The installed C headers are the authority for the Rust libc mirror. */
#include <stddef.h>
#include <signal.h>
#include <pthread.h>
#include <semaphore.h>
#include <time.h>
#include <sys/time.h>
#include <poll.h>
#include <sys/uio.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/sysinfo.h>
#include <sys/select.h>
#include <sched.h>
#include <sys/utsname.h>
#include <pwd.h>
#include <netinet/in.h>
#include <sys/un.h>
#include <sys/epoll.h>
#include <termios.h>
#include <sys/ioctl.h>
size_t c_libc_type_size(unsigned id) {
    switch (id) {
    case 0: return sizeof(sigset_t);
    case 1: return sizeof(struct sigaction);
    case 2: return sizeof(siginfo_t);
    case 3: return sizeof(stack_t);
    case 4: return sizeof(pthread_attr_t);
    case 5: return sizeof(pthread_mutex_t);
    case 6: return sizeof(pthread_cond_t);
    case 7: return sizeof(pthread_rwlock_t);
    case 8: return sizeof(pthread_barrier_t);
    case 9: return sizeof(sem_t);
    case 10: return sizeof(struct timespec);
    case 11: return sizeof(struct timeval);
    case 12: return sizeof(struct pollfd);
    case 13: return sizeof(struct iovec);
    case 14: return sizeof(struct msghdr);
    case 15: return sizeof(struct cmsghdr);
    case 16: return sizeof(struct stat);
    case 17: return sizeof(struct statfs);
    case 18: return sizeof(struct sysinfo);
    case 19: return sizeof(fd_set);
    case 20: return sizeof(cpu_set_t);
    case 21: return sizeof(struct utsname);
    case 22: return sizeof(struct passwd);
    case 23: return sizeof(struct tm);
    case 24: return sizeof(struct sockaddr_in);
    case 25: return sizeof(struct sockaddr_un);
    case 26: return sizeof(struct epoll_event);
    case 27: return sizeof(struct termios);
    case 28: return sizeof(struct winsize);
    default: abort();
    }
}
size_t c_libc_type_align(unsigned id) {
    switch (id) {
    case 0: return _Alignof(sigset_t);
    case 1: return _Alignof(struct sigaction);
    case 2: return _Alignof(siginfo_t);
    case 3: return _Alignof(stack_t);
    case 4: return _Alignof(pthread_attr_t);
    case 5: return _Alignof(pthread_mutex_t);
    case 6: return _Alignof(pthread_cond_t);
    case 7: return _Alignof(pthread_rwlock_t);
    case 8: return _Alignof(pthread_barrier_t);
    case 9: return _Alignof(sem_t);
    case 10: return _Alignof(struct timespec);
    case 11: return _Alignof(struct timeval);
    case 12: return _Alignof(struct pollfd);
    case 13: return _Alignof(struct iovec);
    case 14: return _Alignof(struct msghdr);
    case 15: return _Alignof(struct cmsghdr);
    case 16: return _Alignof(struct stat);
    case 17: return _Alignof(struct statfs);
    case 18: return _Alignof(struct sysinfo);
    case 19: return _Alignof(fd_set);
    case 20: return _Alignof(cpu_set_t);
    case 21: return _Alignof(struct utsname);
    case 22: return _Alignof(struct passwd);
    case 23: return _Alignof(struct tm);
    case 24: return _Alignof(struct sockaddr_in);
    case 25: return _Alignof(struct sockaddr_un);
    case 26: return _Alignof(struct epoll_event);
    case 27: return _Alignof(struct termios);
    case 28: return _Alignof(struct winsize);
    default: abort();
    }
}
size_t c_sigaction_flags_offset(void) { return offsetof(struct sigaction, sa_flags); }
int c_raise_signal(int signal_number) { return raise(signal_number); }
