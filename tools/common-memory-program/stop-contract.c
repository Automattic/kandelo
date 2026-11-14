#include <errno.h>
#include <stdio.h>
#include <unistd.h>

/* A rejected prototype format must leave the original execution alive. */
static volatile int original_state = 42;
int main(void) {
    pid_t original_pid = getpid();
    errno = 0;
    execl("/tmp/old-common-memory.wasm", "old-prototype", (char *)0);
    if (errno != ENOEXEC || getpid() != original_pid || original_state != 42) {
        fprintf(stderr, "format rejection: errno=%d state=%d\n", errno, original_state);
        return 1;
    }
    puts("PASS stop contract: old prototype exec refused before image replacement");
    return 0;
}
