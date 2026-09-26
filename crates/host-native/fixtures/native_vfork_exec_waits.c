/*
 * vfork's borrow ends at exec, not at the exec'd image's exit.
 *
 * The vfork child execs this same program (installed at /bin/self) with
 * "wait", and the new image cannot exit until it reads a byte the PARENT
 * writes after vfork() returned. A host or kernel that keeps the parent
 * parked until the child's image exits deadlocks here. `native_vfork_exec.c`
 * cannot tell the two apart, because its parent only waits for the child.
 *
 * Exit status: 0 success; 90-92 child-side failures; 93-95 parent-side.
 */
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "wait") == 0) {
        char byte = 0;
        if (read(0, &byte, 1) != 1) _exit(90);
        _exit(byte == 'x' ? 0 : 91);
    }

    int fds[2];
    if (pipe(fds) != 0) return 93;
    pid_t pid = vfork();
    if (pid == 0) {
        if (dup2(fds[0], 0) != 0) _exit(92);
        char *child_argv[] = { "/bin/self", "wait", (char *)0 };
        char *envp[] = { (char *)0 };
        execve("/bin/self", child_argv, envp);
        _exit(92);
    }
    if (pid < 0) return 94;
    close(fds[0]);
    write(1, "parent released\n", 16);
    if (write(fds[1], "x", 1) != 1) return 95;
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) return 95;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 96;
}
