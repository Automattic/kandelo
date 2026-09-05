/*
 * N1-I3a Task 2: the posix_spawn PARENT side. Spawns a fresh-image child
 * process ("child" — resolved by the native host's `GuestOptions.programs`
 * map, not the VFS) and exits. No waitpid yet: reaping is Task 3, so this
 * fixture only proves the SYS_SPAWN interception + child launch, not the
 * parent observing the child's exit status.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <spawn.h>
#include <unistd.h>

extern char **environ;

int main(void) {
    pid_t pid = 0;
    char *argv[] = { "child", (char *)0 };
    int rc = posix_spawn(&pid, "child", NULL, NULL, argv, environ);
    if (rc != 0) {
        return 1;
    }
    if (pid <= 0) {
        return 2;
    }
    return 0;
}
