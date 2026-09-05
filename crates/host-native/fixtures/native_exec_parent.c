/*
 * N1-I3c Task 1: the `execve` PARENT/caller side. Calls `execve` on
 * `/bin/exectarget` (placed in the `BaseImage`, resolved through the
 * kernel's exec-target authority against this SAME process's own
 * namespace). Per POSIX, a successful `execve` never returns to the caller
 * — it replaces the calling process's image in place. If it DOES return
 * (today's RED state: `SYS_EXECVE` falls through to the kernel's generic
 * dispatch, which has no handler for it and returns `-ENOSYS`), that is a
 * failure, so this fixture prints a line that must NEVER appear once
 * `execve` actually works, then exits 1 (a status the exec'd target never
 * uses, so the host test can tell the two outcomes apart even without the
 * stdout check).
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <unistd.h>

int main(void) {
    char *argv[] = { "/bin/exectarget", (char *)0 };
    char *envp[] = { (char *)0 };
    execve("/bin/exectarget", argv, envp);
    write(1, "execve returned\n", 16);
    _exit(1);
}
