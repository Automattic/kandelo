#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define SIZE 65536

static int reap(pid_t pid) {
    int status = -1;
    if (pid <= 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status);
}

int main(void) {
    int failed = 0;
    char *anon = mmap(NULL, SIZE, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    int fd = open("/tmp/shm-file", O_CREAT | O_RDWR | O_TRUNC, 0600);
    if (anon == MAP_FAILED || fd < 0 || ftruncate(fd, SIZE) != 0) return 3;
    char *file = mmap(NULL, SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (file == MAP_FAILED) return 4;
    anon[0] = 1;
    file[0] = 1;

    pid_t child = fork();
    if (child == 0) {
        int inherited = anon[0] == 1 && file[0] == 1;
        anon[1] = 2;
        file[1] = 2;
        msync(file, SIZE, MS_SYNC);
        _exit(inherited ? 42 : 2);
    }
    anon[SIZE - 1] = 3;
    file[SIZE - 1] = 3;
    int code = reap(child);
    if (code != 42) failed |= 1;
    if (anon[0] != 1 || anon[1] != 2 || anon[SIZE - 1] != 3) failed |= 2;
    if (msync(file, SIZE, MS_SYNC) != 0) failed |= 4;
    if (file[0] != 1 || file[1] != 2 || file[SIZE - 1] != 3) failed |= 8;
    char head[2] = { 0, 0 }, tail = 0;
    if (pread(fd, head, 2, 0) != 2 || pread(fd, &tail, 1, SIZE - 1) != 1
        || head[0] != 1 || head[1] != 2 || tail != 3) failed |= 16;

    pid_t second = fork();
    if (second == 0) _exit(anon[1] == 2 && anon[SIZE - 1] == 3 && file[1] == 2 && file[SIZE - 1] == 3 ? 43 : 2);
    if (reap(second) != 43) failed |= 32;

    printf("parent child=%d failed=%d head=%d,%d tail=%d\n", code, failed, head[0], head[1], tail);
    return failed;
}
