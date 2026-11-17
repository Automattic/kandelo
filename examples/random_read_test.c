#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

/* Exercise real read/channel/device transfers as an unprivileged guest. */
static int check_read(int fd, size_t size)
{
    unsigned char *bytes = malloc(size + 2);
    if (!bytes) return 1;
    memset(bytes, 0xa5, size + 2);
    ssize_t n = read(fd, bytes + 1, size);
    if (n != (ssize_t)size || bytes[0] != 0xa5 || bytes[size + 1] != 0xa5) {
        fprintf(stderr, "random read size %zu returned %zd\n", size, n);
        perror("read");
        free(bytes);
        return 1;
    }
    /* Check whole regions rather than individual bytes that can randomly
       equal the sentinel. Include the final partial Web Crypto quota. */
    for (size_t offset = 0; offset < size; offset += 65536) {
        size_t end = size - offset > 65536 ? offset + 65536 : size;
        size_t changed = 0;
        for (size_t i = offset; i < end; i++) changed += bytes[i + 1] != 0xa5;
        if (end - offset >= 16 && changed == 0) {
            fprintf(stderr, "unfilled random region at %zu\n", offset);
            free(bytes);
            return 1;
        }
    }
    if (size >= 1048576) {
        int out = open("/tmp/random-read-result", O_CREAT | O_TRUNC | O_RDWR, 0600);
        struct stat st;
        unsigned char check[8192];
        if (out < 0 || write(out, bytes + 1, size) != (ssize_t)size ||
            fstat(out, &st) != 0 || st.st_size != (off_t)size ||
            lseek(out, 0, SEEK_SET) != 0) {
            perror("random file write");
            free(bytes);
            return 1;
        }
        for (size_t offset = 0; offset < size;) {
            size_t count = size - offset > sizeof(check) ? sizeof(check) : size - offset;
            if (read(out, check, count) != (ssize_t)count ||
                memcmp(check, bytes + 1 + offset, count) != 0) {
                fprintf(stderr, "random file differs at %zu\n", offset);
                close(out);
                free(bytes);
                return 1;
            }
            offset += count;
        }
        /* A wide successful result can share a narrow transport marker's
           low word. It must remain an ordinary successful file offset. */
        if (lseek(out, (off_t)2147483648LL, SEEK_SET) != (off_t)2147483648LL) {
            perror("wide seek");
            close(out);
            free(bytes);
            return 1;
        }
        close(out);
        unlink("/tmp/random-read-result");
    }
    free(bytes);
    return 0;
}

static int memory_probe(void)
{
    const size_t maximum = 32 * 1024 * 1024;
    unsigned char *bytes = malloc(maximum + 2);
    if (!bytes) return 1;
    memset(bytes, 0xa5, maximum + 2); /* Allocate guest pages before measuring. */
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) return 1;
    const size_t sizes[] = { 1048576, 4 * 1048576, 16 * 1048576, maximum, maximum };
    for (size_t phase = 0; phase < sizeof(sizes) / sizeof(sizes[0]); phase++) {
        size_t size = sizes[phase];
        ssize_t count = read(fd, bytes + 1, size);
        if (count != (ssize_t)size || bytes[0] != 0xa5 || bytes[maximum + 1] != 0xa5) return 1;
        printf("RANDOM_MEMORY_PHASE %zu\n", phase);
        fflush(stdout);
        char acknowledgement;
        if (read(STDIN_FILENO, &acknowledgement, 1) != 1) return 1;
    }
    close(fd);
    free(bytes);
    return 0;
}

static unsigned char *pending_bytes;
static const size_t pending_size = 32 * 1024 * 1024;
static pthread_t pending_reader;
static atomic_int pending_finished;
static atomic_int pending_observer_ready;
static volatile sig_atomic_t pending_signals;
static int pending_exit;

static void caught_signal(int signal_number)
{
    (void)signal_number;
    pending_signals++;
}

static void *interrupt_after_publication(void *unused)
{
    (void)unused;
    atomic_store(&pending_observer_ready, 1);
    /* Observe actual publication, not a wall-clock delay. A whole eight-byte
       sentinel is vanishingly unlikely to be returned by the entropy source. */
    for (;;) {
        int changed = 0;
        for (size_t i = 1; i <= 8; i++)
            changed |= __atomic_load_n(pending_bytes + i, __ATOMIC_RELAXED) != 0xa5;
        if (changed) break;
        if (atomic_load(&pending_finished)) return (void *)1;
        sched_yield();
    }
    if (pending_exit) {
        puts("RANDOM_PENDING_EXIT");
        fflush(stdout);
        _exit(0);
    }
    return (void *)(long)(pthread_kill(pending_reader, SIGUSR1) != 0);
}

static int pending_probe(int exit_during_read)
{
    pending_bytes = malloc(pending_size + 2);
    if (!pending_bytes) return 1;
    pending_exit = exit_during_read;
    struct sigaction action = {0};
    action.sa_handler = caught_signal;
    action.sa_flags = SA_RESTART;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR1, &action, NULL) != 0) return 1;
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) return 1;
    pending_reader = pthread_self();
    for (int mode = 0; mode < 3; mode++) {
        memset(pending_bytes, 0xa5, pending_size + 2);
        atomic_store(&pending_finished, 0);
        atomic_store(&pending_observer_ready, 0);
        pending_signals = 0;
        pthread_t observer;
        if (pthread_create(&observer, NULL, interrupt_after_publication, NULL) != 0) return 1;
        while (!atomic_load(&pending_observer_ready)) sched_yield();
        struct iovec iov[] = {{pending_bytes + 1, 3}, {NULL, 0},
            {pending_bytes + 4, 65537}, {pending_bytes + 65541, pending_size - 65540}};
        ssize_t count = mode == 0 ? read(fd, pending_bytes + 1, pending_size)
            : mode == 1 ? readv(fd, iov, 4) : getrandom(pending_bytes + 1, pending_size, 0);
        atomic_store(&pending_finished, 1);
        void *observer_result = NULL;
        if (pthread_join(observer, &observer_result) != 0 || observer_result != NULL
            || pending_signals != 1 || count <= 0 || (size_t)count >= pending_size
            || pending_bytes[0] != 0xa5 || pending_bytes[pending_size + 1] != 0xa5) {
            fprintf(stderr, "pending entropy mode=%d returned %zd, signals=%d\n", mode, count, (int)pending_signals);
            return 1;
        }
        /* No replay under SA_RESTART and no publication after completion. */
        for (size_t i = (size_t)count + 1; i <= pending_size; i++)
            if (pending_bytes[i] != 0xa5) return 1;
    }
    close(fd);
    free(pending_bytes);
    puts("RANDOM_INTERRUPT_PASS");
    return 0;
}

int main(int argc, char **argv)
{
    if (setgid(1000) != 0 || setuid(1000) != 0) {
        perror("drop guest credentials");
        return 1;
    }
    if (argc > 1 && strcmp(argv[1], "--memory") == 0) return memory_probe();
    if (argc > 1 && strcmp(argv[1], "--interrupt") == 0) return pending_probe(0);
    if (argc > 1 && strcmp(argv[1], "--pending-exit") == 0) return pending_probe(1);
    const size_t sizes[] = { 0, 1, 65535, 65536, 65537, 1048576, 1048593, 3145757 };
    const char *devices[] = { "/dev/urandom", "/dev/random" };
    for (size_t d = 0; d < sizeof(devices) / sizeof(devices[0]); d++) {
        int fd = open(devices[d], O_RDONLY);
        if (fd < 0) { perror(devices[d]); return 1; }
        for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
            if (check_read(fd, sizes[i])) { close(fd); return 1; }
        }
        unsigned char *vector = malloc(3145757 + 2);
        if (!vector) return 1;
        memset(vector, 0xa5, 3145757 + 2);
        struct iovec iov[] = {{vector + 1, 3}, {NULL, 0}, {vector + 4, 65537},
            {vector + 65541, 3145757 - 65540}};
        if (readv(fd, iov, 4) != 3145757 || vector[0] != 0xa5 || vector[3145758] != 0xa5) return 1;
        free(vector);
        close(fd);
    }
    /* The syscall shares the entropy import with both device aliases. */
    unsigned char bytes[257];
    if (getrandom(bytes, sizeof(bytes), 0) != sizeof(bytes)) {
        perror("getrandom");
        return 1;
    }
    unsigned char *large = malloc(3145757);
    if (!large || getrandom(large, 3145757, 0) != 3145757) return 1;
    free(large);
    puts("RANDOM_READ_PASS uid=1000");
    return 0;
}
