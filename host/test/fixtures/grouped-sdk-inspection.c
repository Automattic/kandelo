#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>
#define P 65536
#define CHECK(e) do { if (!(e)) { fprintf(stderr, "FAIL inspection line=%d errno=%d: %s\n", __LINE__, errno, #e); return 1; } } while (0)
int main(void) {
    int fd = open("/tmp/inspection-object", O_CREAT | O_EXCL | O_RDWR, 0600);
    CHECK(fd >= 0 && unlink("/tmp/inspection-object") == 0);
    CHECK(ftruncate(fd, 2 * P) == 0);
    volatile unsigned char *a = mmap(0, 2 * P, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    volatile unsigned char *b = mmap(0, 2 * P, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    CHECK(a != MAP_FAILED && b != MAP_FAILED && a != b);
    a[0] = 37; a[P] = 91;
    CHECK(b[0] == 37 && b[P] == 91);
    puts("inspection-ready"); fflush(stdout);
    char token;
    CHECK(read(0, &token, 1) == 1 && token == 'x');
    CHECK(b[0] == 37 && b[P] == 91);
    CHECK(close(fd) == 0);
    CHECK(munmap((void *)a, 2 * P) == 0 && munmap((void *)b, 2 * P) == 0);
    puts("grouped-sdk-inspection PASS");
    return 0;
}
