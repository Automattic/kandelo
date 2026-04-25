/*
 * getpwent_test — exercises the passwd database from the rootfs VFS
 * image. Walks the full passwd file via setpwent/getpwent, then
 * looks up the root and user entries by name and uid.
 *
 * Expected output depends on rootfs/etc/passwd content; the host-side
 * test asserts the lines below match what the manifest declared.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <pwd.h>

int main(void) {
    /* Sanity check: can we open and read /etc/passwd at all? */
    fprintf(stderr, "[diag] opening /etc/passwd...\n");
    int fd = open("/etc/passwd", O_RDONLY);
    fprintf(stderr, "[diag] open fd=%d\n", fd);
    if (fd >= 0) {
        char buf[512];
        ssize_t n = read(fd, buf, sizeof(buf) - 1);
        fprintf(stderr, "[diag] read n=%zd\n", n);
        if (n > 0) {
            buf[n] = 0;
            fprintf(stderr, "[diag] first bytes: %.80s\n", buf);
        }
        close(fd);
    } else {
        fprintf(stderr, "[diag] open failed\n");
        return 2;
    }

    struct passwd *pw;

    /* Walk all entries */
    fprintf(stderr, "[diag] setpwent\n");
    setpwent();
    int count = 0;
    while ((pw = getpwent()) != NULL) {
        printf("ENT %d: name=%s uid=%u gid=%u home=%s shell=%s\n",
               count, pw->pw_name, pw->pw_uid, pw->pw_gid,
               pw->pw_dir ? pw->pw_dir : "",
               pw->pw_shell ? pw->pw_shell : "");
        count++;
    }
    endpwent();
    printf("TOTAL %d\n", count);

    /* Lookup by name */
    pw = getpwnam("root");
    if (pw) {
        printf("BYNAME root: uid=%u shell=%s\n", pw->pw_uid, pw->pw_shell);
    } else {
        printf("BYNAME root: NOT FOUND\n");
    }
    pw = getpwnam("user");
    if (pw) {
        printf("BYNAME user: uid=%u shell=%s\n", pw->pw_uid, pw->pw_shell);
    } else {
        printf("BYNAME user: NOT FOUND\n");
    }

    /* Lookup by uid */
    pw = getpwuid(0);
    if (pw) printf("BYUID 0: name=%s\n", pw->pw_name);
    pw = getpwuid(1000);
    if (pw) printf("BYUID 1000: name=%s\n", pw->pw_name);
    pw = getpwuid(99999);
    printf("BYUID 99999: %s\n", pw ? "found" : "NOT FOUND");

    return 0;
}
