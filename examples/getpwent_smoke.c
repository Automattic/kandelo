/*
 * getpwent_smoke — exercise libc nss-style readers backed by the
 * rootfs.vfs mount installed by the default Node/Browser host setup.
 *
 * Used by host/test/getpwent.test.ts to prove that /etc/passwd,
 * /etc/group and /etc/services bytes flow through the new mount router
 * after Task 4.5 removed the synthetic_file_content fast path. If the
 * mount image is missing or stale, getpwent() returns NULL on the very
 * first call and this program exits non-zero with a diagnostic.
 *
 * Output is one machine-parseable line per check so the host test can
 * assert on exact substrings without C-side marshalling cleverness.
 */
#include <errno.h>
#include <grp.h>
#include <netdb.h>
#include <pwd.h>
#include <stdio.h>
#include <string.h>

static int check_pwent_iteration(void) {
    setpwent();
    int n = 0;
    struct passwd *pw;
    while ((pw = getpwent()) != NULL) {
        printf("PWENT %d name=%s uid=%u gid=%u home=%s shell=%s\n",
               n, pw->pw_name, pw->pw_uid, pw->pw_gid, pw->pw_dir, pw->pw_shell);
        n++;
    }
    endpwent();
    printf("PWENT count=%d\n", n);
    return n > 0 ? 0 : 1;
}

static int check_pwnam(const char *name, int expect_found) {
    errno = 0;
    struct passwd *pw = getpwnam(name);
    if (pw == NULL) {
        printf("PWNAM name=%s result=NULL errno=%d\n", name, errno);
        return expect_found ? 1 : 0;
    }
    printf("PWNAM name=%s uid=%u gid=%u home=%s shell=%s\n",
           pw->pw_name, pw->pw_uid, pw->pw_gid, pw->pw_dir, pw->pw_shell);
    return expect_found ? 0 : 1;
}

static int check_pwuid(uid_t uid, int expect_found) {
    errno = 0;
    struct passwd *pw = getpwuid(uid);
    if (pw == NULL) {
        printf("PWUID uid=%u result=NULL errno=%d\n", uid, errno);
        return expect_found ? 1 : 0;
    }
    printf("PWUID uid=%u name=%s gid=%u home=%s shell=%s\n",
           uid, pw->pw_name, pw->pw_gid, pw->pw_dir, pw->pw_shell);
    return expect_found ? 0 : 1;
}

static int check_grent_iteration(void) {
    setgrent();
    int n = 0;
    struct group *gr;
    while ((gr = getgrent()) != NULL) {
        printf("GRENT %d name=%s gid=%u\n", n, gr->gr_name, gr->gr_gid);
        n++;
    }
    endgrent();
    printf("GRENT count=%d\n", n);
    return n > 0 ? 0 : 1;
}

static int check_servbyname(const char *name, const char *proto, int expect_port) {
    struct servent *se = getservbyname(name, proto);
    if (se == NULL) {
        printf("SERV name=%s proto=%s result=NULL\n", name, proto);
        return expect_port > 0 ? 1 : 0;
    }
    /* s_port is in network byte order. Decode by hand to avoid pulling
     * in arpa/inet.h here — the rootfs/etc/services entries are small
     * port numbers so a straight ntohs equivalent is fine. */
    unsigned short port = ((unsigned short)se->s_port << 8) | ((unsigned short)se->s_port >> 8);
    printf("SERV name=%s proto=%s port=%u\n", se->s_name, proto, (unsigned)port);
    return port == (unsigned)expect_port ? 0 : 1;
}

int main(void) {
    int rc = 0;
    rc |= check_pwent_iteration();
    rc |= check_pwnam("root", 1);
    rc |= check_pwnam("user", 1);
    rc |= check_pwnam("nonexistent-user-xyz", 0);
    rc |= check_pwuid(0, 1);
    rc |= check_pwuid(1000, 1);
    rc |= check_grent_iteration();
    rc |= check_servbyname("ssh", "tcp", 22);
    rc |= check_servbyname("http", "tcp", 80);
    printf("DONE rc=%d\n", rc);
    return rc;
}
