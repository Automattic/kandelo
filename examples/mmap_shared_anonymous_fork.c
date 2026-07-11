#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static int wait_ok(pid_t pid) {
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        return 0;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "child failed: status=%d\n", status);
        return 0;
    }
    return 1;
}

int main(void) {
    const long page_size = sysconf(_SC_PAGESIZE);
    if (page_size <= 0) {
        perror("sysconf");
        return 1;
    }

    char *shared = mmap(
        NULL,
        (size_t)page_size,
        PROT_READ | PROT_WRITE,
        MAP_SHARED | MAP_ANONYMOUS,
        -1,
        0
    );
    if (shared == MAP_FAILED) {
        perror("mmap");
        return 1;
    }

    shared[0] = 'A';
    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 1;
    }
    if (pid == 0) {
        if (shared[0] != 'A') {
            fprintf(stderr, "child did not see parent write: %c\n", shared[0]);
            _exit(2);
        }
        shared[0] = 'B';
        _exit(0);
    }
    if (!wait_ok(pid)) return 1;
    if (shared[0] != 'B') {
        fprintf(stderr, "parent did not see child write: %c\n", shared[0]);
        return 1;
    }
    printf("inherited anonymous mapping coherent\n");

    shared[1] = 'C';
    pid = fork();
    if (pid < 0) {
        perror("fork second");
        return 1;
    }
    if (pid == 0) {
        shared[1] = 'D';
        _exit(0);
    }
    if (!wait_ok(pid)) return 1;
    if (shared[1] != 'D') {
        fprintf(stderr, "parent did not see second child write: %c\n", shared[1]);
        return 1;
    }
    printf("reused anonymous backing coherent\n");

    if (munmap(shared, (size_t)page_size) < 0) {
        perror("munmap");
        return 1;
    }
    printf("PASS\n");
    return 0;
}
