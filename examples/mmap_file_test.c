
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>

int main(void) {
    // Create a file with known content
    const char *path = "/tmp/mmap_test_file";
    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }

    const char *data = "Hello from mmap file test!";
    int len = strlen(data);
    if (write(fd, data, len) != len) { perror("write"); return 1; }

    // mmap the file MAP_PRIVATE
    void *ptr = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);
    if (ptr == MAP_FAILED) { perror("mmap"); return 1; }

    // Verify the file content is visible through the mapping
    if (memcmp(ptr, data, len) != 0) {
        fprintf(stderr, "mmap content mismatch!\n");
        fprintf(stderr, "expected: %s\n", data);
        fprintf(stderr, "got: %.*s\n", len, (char *)ptr);
        return 1;
    }
    printf("mmap read: %.*s\n", len, (char *)ptr);

    // Write to the mapping (MAP_PRIVATE - doesn't affect the file)
    memcpy(ptr, "Modified content!", 17);
    printf("mmap modified: %.*s\n", 17, (char *)ptr);

    // Verify the file is unchanged
    char buf[64] = {0};
    lseek(fd, 0, SEEK_SET);
    int n = read(fd, buf, sizeof(buf) - 1);
    printf("file still: %.*s\n", n, buf);

    // msync should succeed (no-op for MAP_PRIVATE)
    if (msync(ptr, 4096, MS_SYNC) != 0) { perror("msync"); return 1; }
    printf("msync ok\n");

    munmap(ptr, 4096);
    close(fd);
    unlink(path);
    printf("PASS\n");
    return 0;
}
