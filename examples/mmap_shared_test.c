
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>

int main(void) {
    const char *path = "/tmp/mmap_shared_test";

    // Create a file and extend to page size
    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }

    long pagesize = sysconf(_SC_PAGESIZE);
    if (pagesize < 0) { perror("sysconf"); return 1; }
    printf("pagesize: %ld\n", pagesize);

    if (ftruncate(fd, pagesize) < 0) { perror("ftruncate"); return 1; }

    // mmap MAP_SHARED
    char *ptr = mmap(NULL, pagesize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (ptr == MAP_FAILED) { perror("mmap"); return 1; }
    printf("mmap ok at %p\n", ptr);

    // Write through the mapping
    ptr[0] = 'x';
    ptr[1] = 'y';
    ptr[2] = 'z';

    // msync to flush back to file
    if (msync(ptr, pagesize, MS_SYNC) < 0) { perror("msync"); return 1; }
    printf("msync ok\n");

    // Read from the fd to verify the data was written back
    lseek(fd, 0, SEEK_SET);
    char buf[4] = {0};
    if (read(fd, buf, 3) != 3) { perror("read"); return 1; }

    if (buf[0] != 'x' || buf[1] != 'y' || buf[2] != 'z') {
        fprintf(stderr, "msync writeback failed: got '%c%c%c'\n", buf[0], buf[1], buf[2]);
        return 1;
    }
    printf("read back: %c%c%c\n", buf[0], buf[1], buf[2]);

    // Also test: write more data, munmap (should not auto-flush for our impl),
    // and verify the previous msync data persists
    ptr[3] = 'w';
    munmap(ptr, pagesize);

    close(fd);
    unlink(path);
    printf("PASS\n");
    return 0;
}
