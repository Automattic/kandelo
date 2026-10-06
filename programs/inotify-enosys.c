#include <errno.h>
#include <stdio.h>
#include <sys/inotify.h>

static int expect_enosys(const char *name, int rc) {
    if (rc != -1 || errno != ENOSYS) {
        fprintf(stderr, "%s: rc=%d errno=%d, expected -1/ENOSYS\n", name, rc, errno);
        return 1;
    }
    return 0;
}

int main(void) {
    int failures = 0;

    errno = 0;
    failures += expect_enosys("inotify_init", inotify_init());
    errno = 0;
    failures += expect_enosys("inotify_init1", inotify_init1(0));
    errno = 0;
    failures += expect_enosys("inotify_add_watch", inotify_add_watch(0, "/", IN_CREATE));
    errno = 0;
    failures += expect_enosys("inotify_rm_watch", inotify_rm_watch(0, 1));

    if (failures) return 1;
    printf("PASS\n");
    return 0;
}
