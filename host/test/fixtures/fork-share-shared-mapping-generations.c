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
    int fd = open("/tmp/shmgen-file", O_CREAT | O_RDWR | O_TRUNC, 0600);
    if (anon == MAP_FAILED || fd < 0 || ftruncate(fd, SIZE) != 0) return 3;
    char *file = mmap(NULL, SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (file == MAP_FAILED) return 4;
    anon[0] = 1;
    file[0] = 1;

    pid_t child = fork();
    if (child == 0) {
        int bad = anon[0] != 1 || file[0] != 1;
        anon[1] = 2;
        file[1] = 2;
        pid_t grandchild = fork();
        if (grandchild == 0) {
            int inherited = anon[0] == 1 && anon[1] == 2 && file[0] == 1 && file[1] == 2;
            anon[2] = 3;
            file[2] = 3;
            msync(file, SIZE, MS_SYNC);
            _exit(inherited ? 44 : 2);
        }
        anon[3] = 4;
        file[3] = 4;
        if (reap(grandchild) != 44) bad |= 2;
        if (anon[2] != 3 || anon[3] != 4 || file[2] != 3 || file[3] != 4) bad |= 4;
        msync(file, SIZE, MS_SYNC);
        _exit(bad ? bad : 42);
    }
    anon[SIZE - 1] = 5;
    file[SIZE - 1] = 5;
    int code = reap(child);
    if (code != 42) failed |= 1;
    for (int i = 0; i < 4; i++) {
        if (anon[i] != i + 1) failed |= 2;
        if (file[i] != i + 1) failed |= 4;
    }
    if (anon[SIZE - 1] != 5 || file[SIZE - 1] != 5) failed |= 8;

    printf("parent child=%d failed=%d\n", code, failed);
    return failed;
}
