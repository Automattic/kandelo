#include <dlfcn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

typedef int (*side_vfork_fn)(int (*)(void));
typedef int (*side_probe_fn)(void);

int main(int argc, char **argv) {
    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) return 2;
    side_vfork_fn side_vfork = (side_vfork_fn)dlsym(lib, "side_vfork");
    side_probe_fn side_probe = (side_probe_fn)dlsym(lib, "side_probe");
    if (!side_vfork || !side_probe || side_probe() != 73) return 3;

    for (int iteration = 0; iteration < 2; iteration++) {
        int pid = side_vfork(vfork);
        if (pid < 0) return 4;
        if (pid == 0) {
            if (side_probe() != 73) _exit(95);
            _exit(0);
        }
        int status = 0;
        if (waitpid(pid, &status, 0) != pid) return 5;
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 6;
        if (side_probe() != 73) return 7;
        puts("PRODUCTION_SIDE_VFORK_ROUND_TRIP");
    }

    if (dlclose(lib) != 0) return 8;
    puts("PRODUCTION_SIDE_VFORK_PASS");
    return 0;
}
