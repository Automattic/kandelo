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

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: %s <probe> <path>\n", argv[0]);
        return 2;
    }
    if (strcmp(argv[1], "rootfs") == 0) return probe_rootfs(argv[2]);
    if (strcmp(argv[1], "scratch") == 0) return probe_scratch(argv[2]);
    if (strcmp(argv[1], "unmounted") == 0) return probe_unmounted(argv[2]);
    fprintf(stderr, "unknown probe: %s\n", argv[1]);
    return 2;
}
