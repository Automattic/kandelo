#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "readonly-file:%d errno=%d\n", __LINE__, errno); return 1; } } while (0)
int main(void) {
    const char *path = "/grouped-readonly-input";
    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0600);
    CHECK(fd >= 0);
    CHECK(write(fd, "hello", 5) == 5);
    char *first = mmap(0, 5, PROT_READ, MAP_SHARED, fd, 0);
    CHECK(first != MAP_FAILED && !memcmp(first, "hello", 5));
    int alias_fd = open(path, O_RDONLY);
    CHECK(alias_fd >= 0);
    char *alias = mmap(0, 5, PROT_READ, MAP_SHARED, alias_fd, 0);
    CHECK(alias != MAP_FAILED && !memcmp(alias, "hello", 5));
    CHECK(pwrite(fd, "x", 1, 0) == -1 && errno == EOPNOTSUPP);
    CHECK(ftruncate(fd, 0) == -1 && errno == EOPNOTSUPP);
    CHECK(mprotect(first, 65536, PROT_READ | PROT_WRITE) == -1 && errno == EACCES);
    CHECK(close(alias_fd) == 0 && close(fd) == 0);
    pid_t child = fork();
    CHECK(child >= 0);
    if (child == 0) {
        CHECK(!memcmp(first, "hello", 5) && !memcmp(alias, "hello", 5));
        CHECK(munmap(first, 5) == 0 && munmap(alias, 5) == 0);
        _exit(23);
    }
    int status = 0;
    CHECK(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 23);
    CHECK(munmap(alias, 5) == 0);
    fd = open(path, O_RDWR);
    CHECK(fd >= 0 && pwrite(fd, "x", 1, 0) == -1 && errno == EOPNOTSUPP);
    CHECK(!memcmp(first, "hello", 5));
    CHECK(munmap(first, 5) == 0);
    CHECK(pwrite(fd, "new", 3, 0) == 3);
    CHECK(close(fd) == 0 && unlink(path) == 0);
    puts("grouped-sdk-readonly-file PASS");
    return 0;
}
