/* Exercise kernel-owned epoll copyout through translated, protected pages. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/epoll.h>
#include <sys/mman.h>
#include <sys/timerfd.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "epoll line %d errno %d\n", __LINE__, errno); return 1; } } while (0)

int main(void) {
    const size_t page = 65536;
    char *mapping = mmap(NULL, 2 * page, PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(mapping != MAP_FAILED);
    /* A nonzero offset and a page boundary force real translated copyout. */
    struct epoll_event *events = (void *)(mapping + page - 8);
    int ep = epoll_create1(EPOLL_CLOEXEC);
    int timer = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC);
    CHECK(ep >= 0 && timer >= 0);
    struct epoll_event interest = {.events = EPOLLIN, .data.u64 = UINT64_C(0x12345678abcdef01)};
    CHECK(epoll_ctl(ep, EPOLL_CTL_ADD, timer, &interest) == 0);
    CHECK(epoll_wait(ep, events, 1, 2) == 0);
    CHECK(mprotect(mapping + page, page, PROT_READ) == 0);
    errno = 0;
    CHECK(epoll_wait(ep, events, 1, 0) == -1 && errno == EFAULT);
    CHECK(mprotect(mapping + page, page, PROT_READ | PROT_WRITE) == 0);
    struct itimerspec spec = {.it_value = {.tv_nsec = 20000000}};
    CHECK(timerfd_settime(timer, 0, &spec, NULL) == 0);
    CHECK(epoll_wait(ep, events, 1, 2000) == 1);
    CHECK(events->events == EPOLLIN && events->data.u64 == interest.data.u64);
    uint64_t count;
    CHECK(read(timer, &count, sizeof(count)) == sizeof(count) && count == 1);
    CHECK(epoll_wait(ep, events, 1, 0) == 0);
    CHECK(close(timer) == 0 && close(ep) == 0);
    CHECK(munmap(mapping, 2 * page) == 0);
    puts("grouped-sdk-epoll PASS");
    return 0;
}
