/*
 * vfs_smoke — exercises the mount-table VFS through real syscalls.
 *
 * One representative operation per backend type so a future regression
 * in the routing layer, the shadow-metadata store, the virtual-dir
 * synthesis, or the cross-mount EXDEV check fails this test loudly.
 *
 * Output is line-prefixed (OK/FAIL <tag>) so the host-side vitest can
 * assert against it without a structured RPC.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void ok(const char *tag) { printf("OK %s\n", tag); }
static void fail(const char *tag, const char *msg) {
    printf("FAIL %s: %s (errno=%d %s)\n", tag, msg, errno, strerror(errno));
}

int main(void) {
    /* 1. Image-backed read: /etc/passwd content from the rootfs image */
    {
        int fd = open("/etc/passwd", O_RDONLY);
        if (fd < 0) { fail("etc-passwd-open", "open"); return 1; }
        char buf[256] = {0};
        ssize_t n = read(fd, buf, sizeof(buf) - 1);
        close(fd);
        if (n <= 0) { fail("etc-passwd-read", "read"); return 1; }
        if (strstr(buf, "root:x:0:0") == NULL) {
            fail("etc-passwd-content", "missing root entry");
            return 1;
        }
        ok("etc-passwd");
    }

    /* 2. Image-backed stat reports honest uid/gid (0/0 from manifest) */
    {
        struct stat st;
        if (stat("/etc/passwd", &st) < 0) { fail("etc-passwd-stat", "stat"); return 1; }
        if (st.st_uid != 0 || st.st_gid != 0) {
            char m[64]; snprintf(m, sizeof(m), "uid=%u gid=%u", st.st_uid, st.st_gid);
            fail("etc-passwd-uid", m); return 1;
        }
        ok("etc-passwd-uid-gid-honest");
    }

    /* 3. Host-dir scratch: write to /tmp, read back, content matches */
    {
        int fd = open("/tmp/vfs_smoke.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0) { fail("tmp-create", "open"); return 1; }
        const char *msg = "hello from /tmp\n";
        if (write(fd, msg, strlen(msg)) < 0) { fail("tmp-write", "write"); return 1; }
        close(fd);

        fd = open("/tmp/vfs_smoke.txt", O_RDONLY);
        if (fd < 0) { fail("tmp-reopen", "open"); return 1; }
        char buf[64] = {0};
        ssize_t n = read(fd, buf, sizeof(buf) - 1);
        close(fd);
        if (n <= 0 || strcmp(buf, msg) != 0) {
            fail("tmp-readback", "content mismatch"); return 1;
        }
        ok("tmp-write-readback");
    }

    /* 4. Shadow store: chown a host-backed file, stat reflects */
    {
        if (chown("/tmp/vfs_smoke.txt", 500, 600) < 0) {
            fail("tmp-chown", "chown"); return 1;
        }
        struct stat st;
        if (stat("/tmp/vfs_smoke.txt", &st) < 0) { fail("tmp-chown-stat", "stat"); return 1; }
        if (st.st_uid != 500 || st.st_gid != 600) {
            char m[64]; snprintf(m, sizeof(m), "uid=%u gid=%u", st.st_uid, st.st_gid);
            fail("tmp-chown-roundtrip", m); return 1;
        }
        ok("tmp-chown-roundtrip");
    }

    /* 5. Virtual intermediate dir: access("/") and stat("/") work */
    {
        if (access("/", F_OK) < 0) { fail("root-access", "access"); return 1; }
        struct stat st;
        if (stat("/", &st) < 0) { fail("root-stat", "stat"); return 1; }
        if (!S_ISDIR(st.st_mode)) { fail("root-isdir", "not dir"); return 1; }
        ok("root-virtual-dir");
    }

    /* 6. Unmounted path returns ENOENT — no host fall-through */
    {
        struct stat st;
        if (stat("/no/such/mount/point/here", &st) == 0) {
            fail("unmounted-stat", "unexpected success"); return 1;
        }
        if (errno != ENOENT) {
            char m[64]; snprintf(m, sizeof(m), "wrong errno %d", errno);
            fail("unmounted-errno", m); return 1;
        }
        ok("unmounted-enoent");
    }

    /* 7. Cross-backend rename returns EXDEV */
    {
        /* /tmp is HostDirBackend; /etc is image MemFsBackend (under /). */
        errno = 0;
        if (rename("/tmp/vfs_smoke.txt", "/etc/vfs_smoke.txt") == 0) {
            fail("cross-rename", "unexpected success"); return 1;
        }
        if (errno != EXDEV) {
            char m[64]; snprintf(m, sizeof(m), "wrong errno %d (%s)", errno, strerror(errno));
            fail("cross-rename-errno", m); return 1;
        }
        ok("cross-backend-exdev");
    }

    /* 8. mkdir + access on a scratch home */
    {
        const char *path = "/home/user/vfs_smoke_dir";
        rmdir(path); /* in case a stale one lingers */
        if (mkdir(path, 0755) < 0) { fail("home-mkdir", "mkdir"); return 1; }
        if (access(path, F_OK) < 0) { fail("home-access", "access"); return 1; }
        struct stat st;
        if (stat(path, &st) < 0 || !S_ISDIR(st.st_mode)) {
            fail("home-stat", "not dir"); return 1;
        }
        rmdir(path);
        ok("home-mkdir");
    }

    /* Cleanup */
    unlink("/tmp/vfs_smoke.txt");
    printf("DONE\n");
    return 0;
}
