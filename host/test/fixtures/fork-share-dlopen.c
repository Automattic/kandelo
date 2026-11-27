#include <dlfcn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static int reap(pid_t pid) {
    int status = -1;
    if (pid <= 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status);
}

int main(int argc, char **argv) {
    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) {
        fprintf(stderr, "dlopen failed: %s\n", dlerror());
        return 2;
    }
    int (*bump)(int) = (int (*)(int))dlsym(lib, "bump");
    void (*fill)(char) = (void (*)(char))dlsym(lib, "fill");
    int (*check)(char) = (int (*)(char))dlsym(lib, "check");
    int (*side_fork)(void) = (int (*)(void))dlsym(lib, "side_fork");
    if (!bump || !fill || !check || !side_fork) return 3;

    int initial = bump(1) == 6 && check(0);
    fill(7);

    pid_t child = fork();
    if (child == 0) {
        int inherited = bump(0) == 6 && check(7);
        bump(10);
        fill(9);
        int grandchild = side_fork();
        if (grandchild == 0) {
            int seen = bump(0) == 16 && check(9);
            bump(100);
            fill(1);
            _exit(seen ? 43 : 1);
        }
        int code = reap(grandchild);
        int kept = bump(0) == 16 && check(9);
        printf("child inherited=%d grandchild=%d kept=%d\n", inherited, code, kept);
        fflush(stdout);
        _exit(inherited && code == 43 && kept ? 42 : 2);
    }
    bump(2);
    int code = reap(child);
    int kept = bump(0) == 8 && check(7);
    printf("parent initial=%d forked=%d child=%d kept=%d\n", initial, child > 0, code, kept);
    return !(initial && child > 0 && code == 42 && kept && dlclose(lib) == 0);
}
