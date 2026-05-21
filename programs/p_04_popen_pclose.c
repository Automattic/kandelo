// P-04 — popen("...", "r") followed by pclose() (fork+exec+pipe end-to-end).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Exercises the full pipeline: fork in libc's posix_spawn → exec the
// child program → child writes to the pipe → parent reads → pclose
// reaps. Documented broken in
// memory:fork-instrument-O2-bug-investigation.md (popen hangs under
// guard-dispatch's REWIND replay). The architectural pivot must fix
// it.
//
// Uses /bin/echo so the child program is the simplest possible
// post-exec process. We assert the captured output matches.
//
// Expected output on PASS:
//   POPEN_OPENED
//   READ: hello-popen
//   PCLOSE: status=0
//   PASS: P-04

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
    FILE *fp = popen("echo hello-popen", "r");
    if (!fp) {
        printf("FAIL: popen errno=%d\n", errno);
        return 1;
    }
    printf("POPEN_OPENED\n");
    fflush(stdout);

    char buf[64];
    if (!fgets(buf, sizeof(buf), fp)) {
        printf("FAIL: fgets returned NULL\n");
        pclose(fp);
        return 1;
    }
    // strip trailing newline
    size_t n = strlen(buf);
    if (n > 0 && buf[n-1] == '\n') buf[n-1] = '\0';
    printf("READ: %s\n", buf);
    fflush(stdout);

    int status = pclose(fp);
    printf("PCLOSE: status=%d\n", status);
    fflush(stdout);

    if (status != 0) {
        printf("FAIL: pclose status=%d\n", status);
        return 1;
    }
    if (strcmp(buf, "hello-popen") != 0) {
        printf("FAIL: got %s expected hello-popen\n", buf);
        return 1;
    }
    printf("PASS: P-04\n");
    return 0;
}
