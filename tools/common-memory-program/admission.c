#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

__attribute__((import_module("kernel"), import_name("kernel_clone")))
extern int kernel_clone(unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned);
static void *thread_main(void *p) { return p; }

int main(int argc, char **argv) {
    const int grouped = argc == 2 && !strcmp(argv[1], "grouped");
    int fd = open("/tmp/common-memory-admission", O_CREAT|O_TRUNC|O_RDWR, 0600);
    if (fd < 0 || ftruncate(fd, 65536)) return 10;
    void *private = mmap(0, 65536, PROT_READ|PROT_WRITE, MAP_PRIVATE, fd, 0);
    if (private == MAP_FAILED || munmap(private, 65536)) return 11;
    errno = 0;
    void *shared = mmap(0, 65536, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
    int map_error = errno;
    if (grouped) {
        if (shared != MAP_FAILED || map_error != EOPNOTSUPP) {
            fprintf(stderr, "file sharing result=%p errno=%d\n", shared, map_error);
            return 12;
        }
    } else if (shared == MAP_FAILED || munmap(shared, 65536)) return 13;
    close(fd);
    // Use the supported thread-style flags; flags=0 correctly fails the
    // ordinary clone-shape check before the process memory model is consulted.
    if (grouped && kernel_clone(0, 0, 0x00010100, 0, 0, 0, 0) != -EOPNOTSUPP) return 18;
    pthread_t thread;
    int thread_error = pthread_create(&thread, 0, thread_main, (void *)42);
    if (grouped) {
        // musl intentionally maps every clone failure to pthread EAGAIN. The
        // direct import above checks the kernel's actual admission errno.
        if (thread_error != EAGAIN) {
            fprintf(stderr, "pthread_create result=%d\n", thread_error);
            return 14;
        }
    } else {
        void *result = 0;
        if (thread_error || pthread_join(thread, &result) || result != (void *)42) return 15;
    }
    errno = 0;
    pid_t child = vfork();
    int vfork_error = errno;
    if (!child) _exit(0);
    if (grouped) {
        if (child != -1 || vfork_error != EOPNOTSUPP) {
            fprintf(stderr, "vfork result=%d errno=%d\n", child, vfork_error);
            return 16;
        }
    } else {
        int status = -1;
        if (child < 0 || waitpid(child, &status, 0) != child || status != 0) return 17;
    }
    puts(grouped ? "PASS grouped admission: private file map; denied shared file map, thread, vfork"
                 : "PASS ordinary control: private/shared file maps, thread, vfork");
    return 0;
}
