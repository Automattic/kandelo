#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/timerfd.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#if defined(__wasm__)
_Static_assert(sizeof(struct epoll_event) == 16, "event stride");
_Static_assert(offsetof(struct epoll_event, data) == 8, "event data offset");
#endif
#define CHECK(x)                                                               \
  do {                                                                         \
    if (!(x)) {                                                                \
      fprintf(stderr, "epoll line %d: %s errno=%d\n", __LINE__, #x, errno);    \
      exit(1);                                                                 \
    }                                                                          \
  } while (0)
static const uint64_t TAG = UINT64_C(0xfedcba9876543210);
static void ctl(int ep, int op, int fd, uint32_t bits, uint64_t data) {
  struct epoll_event ev = {.events = bits, .data.u64 = data};
  CHECK(epoll_ctl(ep, op, fd, &ev) == 0);
}
static struct epoll_event event;
static int wait_one(int ep, int ms) { return epoll_wait(ep, &event, 1, ms); }
static void poke(int fd) {
  uint64_t one = 1;
  CHECK(write(fd, &one, 8) == 8);
}
static long long now_ms(void) {
  struct timespec t;
  CHECK(clock_gettime(CLOCK_MONOTONIC, &t) == 0);
  return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void edges_and_oneshot(void) {
  int p[2], ep = epoll_create1(EPOLL_CLOEXEC);
  CHECK(ep >= 0 && pipe2(p, O_NONBLOCK) == 0);
  CHECK(fcntl(ep, F_GETFD) & FD_CLOEXEC);
  CHECK(write(p[1], "a", 1) == 1);
  ctl(ep, EPOLL_CTL_ADD, p[0], EPOLLIN | EPOLLET, TAG);
  CHECK(wait_one(ep, 0) == 1 && event.events == EPOLLIN &&
        event.data.u64 == TAG);
  CHECK(wait_one(ep, 0) == 0);
  CHECK(write(p[1], "b", 1) == 1);
  CHECK(wait_one(ep, 100) == 1 && event.data.u64 == TAG);
  char buf[8];
  CHECK(read(p[0], buf, 8) == 2);
  CHECK(read(p[0], buf, 8) == -1 && errno == EAGAIN);
  CHECK(write(p[1], "c", 1) == 1);
  CHECK(wait_one(ep, 100) == 1);
  CHECK(wait_one(ep, 0) == 0);
  ctl(ep, EPOLL_CTL_MOD, p[0], EPOLLIN | EPOLLET | EPOLLONESHOT, 2);
  CHECK(wait_one(ep, 0) == 1 && event.data.u64 == 2);
  CHECK(write(p[1], "d", 1) == 1);
  CHECK(wait_one(ep, 0) == 0);
  ctl(ep, EPOLL_CTL_MOD, p[0], EPOLLIN | EPOLLONESHOT, 3);
  CHECK(wait_one(ep, 0) == 1 && event.data.u64 == 3);
  CHECK(wait_one(ep, 0) == 0);
  CHECK(epoll_ctl(ep, EPOLL_CTL_DEL, p[0], (void *)(uintptr_t)1) == 0);
  close(p[0]);
  close(p[1]);
  close(ep);
}

static void fairness_and_lifetime(void) {
  int ep = epoll_create1(0), f[3];
  CHECK(ep >= 0);
  for (int i = 0; i < 3; i++) {
    f[i] = eventfd(1, EFD_NONBLOCK);
    CHECK(f[i] >= 0);
    ctl(ep, EPOLL_CTL_ADD, f[i], EPOLLIN, i + 1);
  }
  unsigned seen = 0;
  for (int i = 0; i < 3; i++) {
    CHECK(wait_one(ep, 0) == 1);
    seen |= 1u << event.data.u64;
  }
  CHECK(seen == 14);
  int alias = dup(f[0]);
  CHECK(alias >= 0);
  close(f[0]);
  ctl(ep, EPOLL_CTL_ADD, alias, EPOLLIN, 4);
  struct epoll_event out[8];
  CHECK(epoll_wait(ep, out, 8, 0) == 4);
  close(alias);
  CHECK(epoll_wait(ep, out, 8, 0) == 2);
  close(f[1]);
  close(f[2]);
  close(ep);
}

static void sockets_and_hangup(void) {
  int s[2], ep = epoll_create1(0);
  CHECK(socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0, s) == 0);
  ctl(ep, EPOLL_CTL_ADD, s[0], EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLET, 1);
  CHECK(wait_one(ep, 0) == 1 && event.events == EPOLLOUT);
  ctl(ep, EPOLL_CTL_MOD, s[0], EPOLLPRI | EPOLLET, 1);
  CHECK(send(s[1], "!", 1, MSG_OOB) == 1);
  CHECK(wait_one(ep, 100) == 1 && event.events == EPOLLPRI);
  char urgent;
  CHECK(recv(s[0], &urgent, 1, MSG_OOB) == 1 && urgent == '!');
  CHECK(wait_one(ep, 0) == 0);
  /* Linux can retain normal readability after consuming an urgent record.
     Use a fresh pair to test half-close independently of that queue state. */
  close(s[0]);
  close(s[1]);
  CHECK(socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0, s) == 0);
  ctl(ep, EPOLL_CTL_ADD, s[0], EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLET, 1);
  CHECK(wait_one(ep, 0) == 1 && event.events == EPOLLOUT);
  CHECK(write(s[1], "x", 1) == 1);
  CHECK(shutdown(s[1], SHUT_WR) == 0);
  CHECK(wait_one(ep, 100) == 1);
  CHECK((event.events & (EPOLLIN | EPOLLRDHUP | EPOLLOUT)) ==
        (EPOLLIN | EPOLLRDHUP | EPOLLOUT));
  CHECK(!(event.events & EPOLLHUP));
  char c;
  CHECK(read(s[0], &c, 1) == 1);
  CHECK(read(s[0], &c, 1) == 0);
  ctl(ep, EPOLL_CTL_MOD, s[0], EPOLLIN, 2);
  CHECK(wait_one(ep, 0) == 1 && event.events == EPOLLIN);
  close(s[1]);
  CHECK(wait_one(ep, 100) == 1 && (event.events & EPOLLHUP));
  close(s[0]);
  close(ep);
  int p[2];
  CHECK(pipe(p) == 0);
  ep = epoll_create1(0);
  ctl(ep, EPOLL_CTL_ADD, p[1], 0, 3);
  close(p[0]);
  CHECK(wait_one(ep, 0) == 1 && (event.events & EPOLLERR));
  close(p[1]);
  close(ep);
}

enum { TCP_STREAM_PAIR = 3 };
static void readiness_socket_pair(int variant, int s[2]) {
  if (variant != TCP_STREAM_PAIR) {
    CHECK(socketpair(AF_UNIX, variant | SOCK_NONBLOCK, 0, s) == 0);
    return;
  }
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = {
      .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  socklen_t length = sizeof address;
  CHECK(listener >= 0 && bind(listener, (void *)&address, length) == 0);
  CHECK(listen(listener, 1) == 0);
  CHECK(getsockname(listener, (void *)&address, &length) == 0);
  s[0] = socket(AF_INET, SOCK_STREAM, 0);
  CHECK(s[0] >= 0 && connect(s[0], (void *)&address, length) == 0);
  s[1] = accept(listener, NULL, NULL);
  CHECK(s[1] >= 0);
  close(listener);
}

static void socket_shutdown_masks(void) {
  const uint32_t readable = EPOLLIN | EPOLLRDNORM | EPOLLRDHUP;
  for (int variant = SOCK_STREAM; variant <= TCP_STREAM_PAIR; variant++) {
    const uint32_t writable = EPOLLOUT | EPOLLWRNORM |
        (variant == TCP_STREAM_PAIR ? 0 : EPOLLWRBAND);
    for (int side = 0; side < 2; side++) {
      for (int how = 0; how < 4; how++) {
        if (side == 0 && how == 3) continue;
        int s[2], ep = epoll_create1(0);
        CHECK(ep >= 0);
        readiness_socket_pair(variant, s);
        ctl(ep, EPOLL_CTL_ADD, s[0], readable | writable, TAG);
        if (how == 3) CHECK(close(s[side]) == 0);
        else CHECK(shutdown(s[side], how) == 0);
        if (variant == TCP_STREAM_PAIR && side == 1 && how != SHUT_RD) {
          ctl(ep, EPOLL_CTL_MOD, s[0], readable, TAG);
          CHECK(wait_one(ep, 1000) == 1 && (event.events & EPOLLRDHUP));
          ctl(ep, EPOLL_CTL_MOD, s[0], readable | writable, TAG);
        }
        uint32_t expected = writable;
        if ((side == 0 && how != SHUT_WR) ||
            (side == 1 && variant != SOCK_DGRAM && how != SHUT_RD)) expected |= readable;
        if (how >= SHUT_RDWR && (side == 0 || variant == SOCK_STREAM)) expected |= EPOLLHUP;
        CHECK(wait_one(ep, 0) == 1 && event.events == expected && event.data.u64 == TAG);
        close(ep); close(s[0]); if (how != 3) close(s[1]);
      }
    }
  }
  for (int domain = AF_UNIX; domain <= AF_INET; domain++) {
    for (int type = SOCK_STREAM; type <= SOCK_DGRAM; type++) {
      int fd = socket(domain, type | SOCK_NONBLOCK, 0), ep = epoll_create1(0);
      CHECK(fd >= 0 && ep >= 0);
      ctl(ep, EPOLL_CTL_ADD, fd, readable | EPOLLOUT | EPOLLWRNORM | EPOLLWRBAND, TAG);
      uint32_t expected = EPOLLOUT | EPOLLWRNORM;
      if (domain == AF_UNIX || type == SOCK_DGRAM) expected |= EPOLLWRBAND;
      if (type == SOCK_STREAM) expected |= EPOLLHUP;
      CHECK(wait_one(ep, 0) == 1 && event.events == expected);
      close(ep); close(fd);
    }
  }
}

static void socket_write_band_edges(void) {
  for (int type = SOCK_STREAM; type <= SOCK_DGRAM; type++) {
    for (int close_receiver = 0; close_receiver < 2; close_receiver++) {
      int s[2], ep = epoll_create1(0);
      CHECK(ep >= 0 && socketpair(AF_UNIX, type | SOCK_NONBLOCK, 0, s) == 0);
      char bytes[4096] = {0};
      ssize_t n;
      do { n = write(s[0], bytes, sizeof bytes); } while (n > 0);
      CHECK(n < 0 && errno == EAGAIN);
      ctl(ep, EPOLL_CTL_ADD, s[0], EPOLLWRBAND | EPOLLET, TAG);
      CHECK(wait_one(ep, 0) == 0);
      if (close_receiver) {
        int alias = dup(s[1]);
        CHECK(alias >= 0 && close(s[1]) == 0);
        CHECK(wait_one(ep, 0) == 0);
        CHECK(close(alias) == 0);
      } else {
        do { n = read(s[1], bytes, sizeof bytes); } while (n > 0);
        CHECK(n < 0 && errno == EAGAIN);
      }
      CHECK(wait_one(ep, 1000) == 1 && (event.events & EPOLLWRBAND) && event.data.u64 == TAG);
      close(ep); close(s[0]); if (!close_receiver) close(s[1]);
    }
  }
}

static void datagram_edges(void) {
  int s[2], ep = epoll_create1(0);
  CHECK(ep >= 0 && socketpair(AF_UNIX, SOCK_DGRAM | SOCK_NONBLOCK, 0, s) == 0);
  ctl(ep, EPOLL_CTL_ADD, s[0], EPOLLIN | EPOLLET, TAG);
  CHECK(send(s[1], "a", 1, 0) == 1);
  CHECK(wait_one(ep, 100) == 1);
  CHECK(send(s[1], "b", 1, 0) == 1);
  CHECK(wait_one(ep, 100) == 1);
  char c;
  CHECK(recv(s[0], &c, 1, 0) == 1);
  CHECK(wait_one(ep, 0) == 0);
  CHECK(recv(s[0], &c, 1, 0) == 1);
  CHECK(recv(s[0], &c, 1, 0) == -1 && errno == EAGAIN);
  CHECK(send(s[1], "", 0, 0) == 0);
  CHECK(wait_one(ep, 100) == 1 && event.data.u64 == TAG);
  CHECK(recv(s[0], &c, 1, 0) == 0);
  CHECK(wait_one(ep, 0) == 0);
  close(s[0]);
  close(s[1]);
  close(ep);
}

static void nesting_and_errors(void) {
  int a = epoll_create1(0), b = epoll_create1(0), fd = eventfd(1, 0);
  CHECK(a >= 0 && b >= 0 && fd >= 0);
  ctl(b, EPOLL_CTL_ADD, fd, EPOLLIN | EPOLLONESHOT, 1);
  ctl(a, EPOLL_CTL_ADD, b, EPOLLIN | EPOLLET, 2);
  CHECK(wait_one(a, 0) == 1 && event.data.u64 == 2);
  CHECK(wait_one(b, 0) == 1 && event.data.u64 == 1);
  CHECK(wait_one(a, 0) == 0);
  ctl(b, EPOLL_CTL_MOD, fd, EPOLLIN | EPOLLONESHOT, 3);
  CHECK(wait_one(a, 0) == 1);
  struct epoll_event ev = {.events = EPOLLIN};
  CHECK(epoll_ctl(b, EPOLL_CTL_ADD, a, &ev) == -1 && errno == ELOOP);
  int alias = dup(a);
  CHECK(epoll_ctl(a, EPOLL_CTL_ADD, alias, &ev) == -1 && errno == EINVAL);
  close(alias);
  CHECK(epoll_wait(a, &ev, 0, 0) == -1 && errno == EINVAL);
  CHECK(epoll_create(0) == -1 && errno == EINVAL);
  CHECK(epoll_create1(123) == -1 && errno == EINVAL);
#ifdef SYS_epoll_create
  /* Both Kandelo targets expose this legacy syscall; some native Linux
     architectures provide only epoll_create1. */
  CHECK(syscall(SYS_epoll_create, 0) == -1 && errno == EINVAL);
#endif
  CHECK(epoll_ctl(b, EPOLL_CTL_ADD, fd, NULL) == -1 && errno == EFAULT);
  ev.events = EPOLLIN | EPOLLEXCLUSIVE | EPOLLONESHOT;
  int extra = eventfd(0, 0);
  CHECK(epoll_ctl(a, EPOLL_CTL_ADD, extra, &ev) == -1 && errno == EINVAL);
  close(extra);
  close(fd);
  close(a);
  close(b);
}

struct wait_args {
  int ep, timeout, result;
  uint64_t data;
  pthread_barrier_t *barrier;
};
static void *wait_thread(void *v) {
  struct wait_args *a = v;
  struct epoll_event ev;
  if (a->barrier)
    pthread_barrier_wait(a->barrier);
  a->result = epoll_wait(a->ep, &ev, 1, a->timeout);
  if (a->result > 0)
    a->data = ev.data.u64;
  return NULL;
}
static void concurrent_waits(void) {
  int ep = epoll_create1(0), fd = eventfd(0, 0);
  pthread_t t[2];
  pthread_barrier_t barrier;
  CHECK(ep >= 0 && fd >= 0 && pthread_barrier_init(&barrier, NULL, 3) == 0);
  ctl(ep, EPOLL_CTL_ADD, fd, EPOLLIN | EPOLLET | EPOLLONESHOT, TAG);
  struct wait_args a[2] = {{ep, 180, -2, 0, &barrier},
                           {ep, 180, -2, 0, &barrier}};
  CHECK(pthread_create(&t[0], NULL, wait_thread, &a[0]) == 0);
  CHECK(pthread_create(&t[1], NULL, wait_thread, &a[1]) == 0);
  pthread_barrier_wait(&barrier);
  poke(fd);
  CHECK(pthread_join(t[0], NULL) == 0 && pthread_join(t[1], NULL) == 0);
  CHECK(a[0].result + a[1].result == 1);
  CHECK((a[0].result ? a[0].data : a[1].data) == TAG);
  pthread_barrier_destroy(&barrier);
  close(fd);
  close(ep);
  ep = epoll_create1(0);
  fd = eventfd(1, 0);
  CHECK(ep >= 0 && fd >= 0);
  struct wait_args empty = {ep, 1000, -2, 0, NULL};
  CHECK(pthread_create(&t[0], NULL, wait_thread, &empty) == 0);
  ctl(ep, EPOLL_CTL_ADD, fd, EPOLLIN, TAG);
  CHECK(pthread_join(t[0], NULL) == 0);
  CHECK(empty.result == 1 && empty.data == TAG);
  close(fd);
  close(ep);
  ep = epoll_create1(0);
  long long before = now_ms();
  CHECK(wait_one(ep, 45) == 0);
  CHECK(now_ms() - before >= 35);
  close(ep);
}

static volatile sig_atomic_t caught;
static void handler(int sig) {
  (void)sig;
  caught++;
}
static void *send_signal(void *v) {
  pthread_t *target = v;
  CHECK(pthread_kill(*target, SIGUSR1) == 0);
  return NULL;
}
static void masks_and_devices(void) {
  sigset_t block, old, wait_mask;
  sigemptyset(&block);
  sigaddset(&block, SIGUSR1);
  CHECK(pthread_sigmask(SIG_BLOCK, &block, &old) == 0);
  wait_mask = old;
  sigdelset(&wait_mask, SIGUSR1);
  struct sigaction sa = {.sa_handler = handler};
  sigemptyset(&sa.sa_mask);
  CHECK(sigaction(SIGUSR1, &sa, NULL) == 0);
  int ep = epoll_create1(0);
  pthread_t self = pthread_self(), sender;
  CHECK(pthread_create(&sender, NULL, send_signal, &self) == 0);
  CHECK(epoll_pwait(ep, &event, 1, 1000, &wait_mask) == -1 && errno == EINTR);
  CHECK(pthread_join(sender, NULL) == 0);
  CHECK(caught == 1);
  sigset_t after;
  CHECK(pthread_sigmask(SIG_SETMASK, NULL, &after) == 0 &&
        sigismember(&after, SIGUSR1) == 1);
  /* Ready results and validation errors restore the mask before a pending
     signal that is unblocked only by the temporary wait mask can run. */
  int ready = eventfd(1, 0);
  CHECK(ready >= 0);
  ctl(ep, EPOLL_CTL_ADD, ready, EPOLLIN | EPOLLET | EPOLLONESHOT, TAG);
  CHECK(raise(SIGUSR1) == 0);
  volatile uintptr_t invalid_events = UINTPTR_MAX;
  CHECK(epoll_pwait(ep, (struct epoll_event *)invalid_events, 1, 0, &wait_mask) ==
            -1 &&
        errno == EFAULT && caught == 1);
  CHECK(epoll_pwait(-1, &event, 1, 0, &wait_mask) == -1 && errno == EBADF &&
        caught == 1);
  CHECK(epoll_pwait(ep, &event, 1, 1000, &wait_mask) == 1 &&
        event.data.u64 == TAG && caught == 1);
  sigset_t pending;
  CHECK(sigpending(&pending) == 0 && sigismember(&pending, SIGUSR1) == 1);
  CHECK(wait_one(ep, 0) == 0);
  CHECK(pthread_sigmask(SIG_SETMASK, NULL, &after) == 0 &&
        sigismember(&after, SIGUSR1) == 1);
  CHECK(epoll_pwait(ep, &event, 1, 1000, &wait_mask) == -1 && errno == EINTR &&
        caught == 2);
  CHECK(pthread_sigmask(SIG_SETMASK, NULL, &after) == 0 &&
        sigismember(&after, SIGUSR1) == 1);
  close(ready);
  int sfd = signalfd(-1, &block, SFD_NONBLOCK);
  CHECK(sfd >= 0);
  ctl(ep, EPOLL_CTL_ADD, sfd, EPOLLIN | EPOLLET, 1);
  CHECK(raise(SIGUSR1) == 0);
  CHECK(wait_one(ep, 100) == 1 && event.data.u64 == 1);
  struct signalfd_siginfo info;
  CHECK(read(sfd, &info, sizeof info) == sizeof info);
  CHECK(wait_one(ep, 0) == 0);
  close(sfd);
  CHECK(pthread_sigmask(SIG_SETMASK, &old, NULL) == 0);
  int timer = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK);
  CHECK(timer >= 0);
  ctl(ep, EPOLL_CTL_ADD, timer, EPOLLIN | EPOLLET, 2);
  struct itimerspec spec = {.it_value = {0, 10000000}};
  CHECK(timerfd_settime(timer, 0, &spec, NULL) == 0);
  CHECK(wait_one(ep, 200) == 1 && event.data.u64 == 2);
  CHECK(wait_one(ep, 0) == 0);
  uint64_t count;
  CHECK(read(timer, &count, 8) == 8);
  close(timer);
  int master = posix_openpt(O_RDWR | O_NONBLOCK);
  CHECK(master >= 0 && grantpt(master) == 0 && unlockpt(master) == 0);
  int slave = open(ptsname(master), O_RDWR | O_NONBLOCK);
  CHECK(slave >= 0);
  struct termios term;
  CHECK(tcgetattr(slave, &term) == 0);
  cfmakeraw(&term);
  CHECK(tcsetattr(slave, TCSANOW, &term) == 0);
  ctl(ep, EPOLL_CTL_ADD, master, EPOLLIN | EPOLLET, 3);
  CHECK(write(slave, "a", 1) == 1);
  CHECK(wait_one(ep, 100) == 1 && event.data.u64 == 3);
  CHECK(write(slave, "b", 1) == 1);
  CHECK(wait_one(ep, 100) == 1);
  char buf[8];
  CHECK(read(master, buf, 8) == 2);
  CHECK(wait_one(ep, 0) == 0);
  close(slave);
  close(master);
  close(ep);
}

static void fork_lifetime(void) {
#if !defined(__wasm__) || __SIZEOF_POINTER__ == 4
  int p[2], gate[2], ep = epoll_create1(0);
  CHECK(ep >= 0 && pipe(p) == 0 && pipe(gate) == 0);
  ctl(ep, EPOLL_CTL_ADD, p[0], EPOLLIN | EPOLLET, TAG);
  pid_t child = fork();
  CHECK(child >= 0);
  if (child == 0) {
    close(p[1]);
    close(gate[1]);
    char go;
    CHECK(read(gate[0], &go, 1) == 1);
    close(p[0]);
    _exit(0);
  }
  close(p[0]);
  close(gate[0]);
  CHECK(write(p[1], "x", 1) == 1);
  CHECK(wait_one(ep, 1000) == 1 && event.data.u64 == TAG);
  CHECK(write(gate[1], "x", 1) == 1);
  int status;
  CHECK(waitpid(child, &status, 0) == child && WIFEXITED(status) &&
        WEXITSTATUS(status) == 0);
  CHECK(wait_one(ep, 0) == 0);
  close(p[1]);
  close(gate[1]);
  close(ep);
#endif
}
static int after_exec(int argc, char **argv) {
  CHECK(argc == 5);
  int ep = atoi(argv[2]), fd = atoi(argv[3]), clo = atoi(argv[4]);
  CHECK(fcntl(clo, F_GETFD) == -1 && errno == EBADF);
  CHECK(wait_one(ep, 0) == 0); /* one-shot disablement survived replacement */
  ctl(ep, EPOLL_CTL_MOD, fd, EPOLLIN | EPOLLET, TAG);
  CHECK(wait_one(ep, 0) == 1 && event.data.u64 == TAG &&
        event.events == EPOLLIN);
  close(fd);
  close(ep);
  puts("EPOLL_SEMANTICS_PASS");
  return 0;
}
static void exec_lifetime(const char *self) {
  int ep = epoll_create1(0), fd = eventfd(1, 0),
      clo = epoll_create1(EPOLL_CLOEXEC);
  CHECK(ep >= 0 && fd >= 0 && clo >= 0);
  ctl(ep, EPOLL_CTL_ADD, fd, EPOLLIN | EPOLLONESHOT, 1);
  CHECK(wait_one(ep, 0) == 1);
  char ep_text[24], fd_text[24], clo_text[24];
  snprintf(ep_text, sizeof ep_text, "%d", ep);
  snprintf(fd_text, sizeof fd_text, "%d", fd);
  snprintf(clo_text, sizeof clo_text, "%d", clo);
  char *args[] = {(char *)self, "--after-exec", ep_text,
                  fd_text,      clo_text,       NULL};
  execv(self, args);
  CHECK(0);
}
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--after-exec") == 0)
    return after_exec(argc, argv);
  edges_and_oneshot();
  fairness_and_lifetime();
  sockets_and_hangup();
  socket_shutdown_masks();
  socket_write_band_edges();
  datagram_edges();
  nesting_and_errors();
  concurrent_waits();
  masks_and_devices();
  fork_lifetime();
#if defined(__wasm__)
  exec_lifetime("/epoll-self");
#else
  exec_lifetime(argv[0]);
#endif
  return 1;
}
