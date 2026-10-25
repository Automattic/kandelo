/*
 * Block in kernel-timed syscalls for longer than the glue's first wait bound
 * (100 ms). The bounded wait times out, calls kernel.kernel_heap_safepoint,
 * and must keep waiting until the kernel completes the same request.
 */
#include <poll.h>
#include <stdio.h>
#include <time.h>

static long long monotonic_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

int main(void) {
  long long started = monotonic_ms();
  struct timespec duration = {0, 350 * 1000 * 1000};
  if (nanosleep(&duration, NULL) != 0) {
    perror("nanosleep");
    return 1;
  }
  long long slept = monotonic_ms() - started;
  if (slept < 340) {
    fprintf(stderr, "nanosleep returned after %lld ms\n", slept);
    return 1;
  }

  started = monotonic_ms();
  int ready = poll(NULL, 0, 250);
  long long polled = monotonic_ms() - started;
  if (ready != 0 || polled < 240) {
    fprintf(stderr, "poll returned %d after %lld ms\n", ready, polled);
    return 1;
  }

  printf("heap-safepoint-blocking-wait: ok\n");
  return 0;
}
