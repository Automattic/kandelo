/*
 * mount_probe_test — exercise the Node-host default mount layout.
 *
 * Drives three integration points used by host/test/node-host-mounts.test.ts:
 *
 *   probe-rootfs       stat + open + read /etc/services and report bytes
 *                      (proves a rootfs image mount is wired and readable)
 *
 *   probe-scratch      write /tmp/<fname>, read it back via lstat, print contents
 *                      (proves a scratch mount is wired and writable)
 *
 *   probe-unmounted    stat /no/such/mount/point and report the errno
 *                      (proves VirtualPlatformIO's VFS-only-lens has no
 *                      fallthrough — unmounted paths must hit ENOENT)
 *
 *   path-resolution    exercise component-wise symlink, dot-dot, and mount
 *                      crossing behavior below the supplied scratch path
 *
 * Output format is one machine-parseable line per probe so the host test
 * can assert on substrings without compiling-in C-specific marshalling.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int probe_rootfs(const char *path) {
    struct stat st;
    if (stat(path, &st) < 0) {
        printf("ROOTFS stat-errno=%d\n", errno);
        return 1;
    }
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        printf("ROOTFS open-errno=%d\n", errno);
        return 1;
    }
    char buf[1024];
    ssize_t n = read(fd, buf, sizeof(buf));
    close(fd);
    if (n < 0) {
        printf("ROOTFS read-errno=%d\n", errno);
        return 1;
    }
    /* Print first 16 bytes hex-encoded to keep the line ASCII-safe. */
    char hex[33] = {0};
    int max = n < 16 ? (int)n : 16;
    for (int i = 0; i < max; i++) {
        snprintf(hex + i * 2, 3, "%02x", (unsigned char)buf[i]);
    }
    printf("ROOTFS size=%lld read=%zd head=%s\n", (long long)st.st_size, n, hex);
    return 0;
}

static int probe_scratch(const char *path) {
    const char *msg = "scratch-mount-roundtrip\n";
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        printf("SCRATCH open-errno=%d\n", errno);
        return 1;
    }
    ssize_t w = write(fd, msg, strlen(msg));
    close(fd);
    if (w < 0) {
        printf("SCRATCH write-errno=%d\n", errno);
        return 1;
    }
    struct stat st;
    if (lstat(path, &st) < 0) {
        printf("SCRATCH lstat-errno=%d\n", errno);
        return 1;
    }
    fd = open(path, O_RDONLY);
    if (fd < 0) {
        printf("SCRATCH reopen-errno=%d\n", errno);
        return 1;
    }
    char buf[128] = {0};
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n < 0) {
        printf("SCRATCH read-errno=%d\n", errno);
        return 1;
    }
    /* Strip the trailing newline so the assertion is exact. */
    if (n > 0 && buf[n - 1] == '\n') buf[n - 1] = '\0';
    printf("SCRATCH size=%lld content=%s\n", (long long)st.st_size, buf);
    return 0;
}

static int probe_unmounted(const char *path) {
    struct stat st;
    int rc = stat(path, &st);
    int err = errno;
    if (rc == 0) {
        printf("UNMOUNTED unexpected-success size=%lld\n", (long long)st.st_size);
        return 1;
    }
    printf("UNMOUNTED errno=%d (ENOENT=%d)\n", err, ENOENT);
    return 0;
}

static int join_path(char *out, size_t out_len, const char *base, const char *suffix) {
    int n = snprintf(out, out_len, "%s/%s", base, suffix);
    return n > 0 && (size_t)n < out_len ? 0 : -1;
}

static int probe_path_resolution(const char *base) {
    char target[512], child[512], link[512], link_parent[512];
    char missing_walk[512], regular[512], regular_dot[512];
    char etc_link[512], services_via_link[512], cwd[512];
    if (join_path(target, sizeof(target), base, "target") < 0 ||
        join_path(child, sizeof(child), target, "child") < 0 ||
        join_path(link, sizeof(link), base, "link") < 0 ||
        join_path(link_parent, sizeof(link_parent), link, "..") < 0 ||
        join_path(missing_walk, sizeof(missing_walk), base, "missing/../target") < 0 ||
        join_path(regular, sizeof(regular), base, "regular") < 0 ||
        join_path(regular_dot, sizeof(regular_dot), regular, ".") < 0 ||
        join_path(etc_link, sizeof(etc_link), base, "etc-link") < 0 ||
        join_path(services_via_link, sizeof(services_via_link), etc_link, "services") < 0) {
        printf("PATH_RESOLUTION path-too-long\n");
        return 1;
    }

    /* Make the probe repeatable after an interrupted prior run. */
    unlink(link);
    unlink(etc_link);
    unlink(regular);
    rmdir(child);
    rmdir(target);
    rmdir(base);

    if (mkdir(base, 0700) < 0 || mkdir(target, 0700) < 0 || mkdir(child, 0700) < 0) {
        printf("PATH_RESOLUTION mkdir-errno=%d\n", errno);
        return 1;
    }
    if (symlink("target/child", link) < 0) {
        printf("PATH_RESOLUTION symlink-errno=%d\n", errno);
        return 1;
    }
    if (chdir(link_parent) < 0 || getcwd(cwd, sizeof(cwd)) == NULL) {
        printf("PATH_RESOLUTION chdir-errno=%d\n", errno);
        return 1;
    }
    if (strcmp(cwd, target) != 0) {
        printf("PATH_RESOLUTION cwd=%s expected=%s\n", cwd, target);
        return 1;
    }
    if (chdir("/") < 0) {
        printf("PATH_RESOLUTION root-chdir-errno=%d\n", errno);
        return 1;
    }

    struct stat st;
    errno = 0;
    if (stat(missing_walk, &st) == 0 || errno != ENOENT) {
        printf("PATH_RESOLUTION missing-dotdot-errno=%d expected=%d\n", errno, ENOENT);
        return 1;
    }

    int fd = open(regular, O_CREAT | O_WRONLY | O_TRUNC, 0600);
    if (fd < 0) {
        printf("PATH_RESOLUTION regular-open-errno=%d\n", errno);
        return 1;
    }
    close(fd);
    errno = 0;
    if (stat(regular_dot, &st) == 0 || errno != ENOTDIR) {
        printf("PATH_RESOLUTION regular-dot-errno=%d expected=%d\n", errno, ENOTDIR);
        return 1;
    }

    if (symlink("/etc", etc_link) < 0) {
        printf("PATH_RESOLUTION cross-mount-symlink-errno=%d\n", errno);
        return 1;
    }
    struct stat direct_services;
    if (stat(services_via_link, &st) < 0 || stat("/etc/services", &direct_services) < 0) {
        printf("PATH_RESOLUTION cross-mount-stat-errno=%d\n", errno);
        return 1;
    }
    if (st.st_size != direct_services.st_size) {
        printf("PATH_RESOLUTION cross-mount-size=%lld expected=%lld\n",
               (long long)st.st_size, (long long)direct_services.st_size);
        return 1;
    }

    printf("PATH_RESOLUTION_PASS cwd=%s services=%lld\n",
           target, (long long)st.st_size);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <probe> <path>\n", argv[0]);
        return 2;
    }
    if (strcmp(argv[1], "path-resolution") == 0) {
        if (argc < 3) return 2;
        return probe_path_resolution(argv[2]);
    }
    if (argc < 3) return 2;
    if (strcmp(argv[1], "rootfs") == 0) return probe_rootfs(argv[2]);
    if (strcmp(argv[1], "scratch") == 0) return probe_scratch(argv[2]);
    if (strcmp(argv[1], "unmounted") == 0) return probe_unmounted(argv[2]);
    fprintf(stderr, "unknown probe: %s\n", argv[1]);
    return 2;
}
