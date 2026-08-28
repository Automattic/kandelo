/*
 * Host-backed filesystem guest for the native Wasmtime host's increment-5 test.
 *
 * The earlier fixtures never left the kernel: uname/pipe/getpid/write/mmap are
 * all kernel-internal. This one reaches the *host filesystem*. The kernel uses
 * the host's host_lstat/host_open/host_read capabilities as its root
 * filesystem, so opening and reading a path exercises that whole capability
 * path natively:
 *
 *   - open("/native.txt")  — RAW, path CString In; the kernel resolves the path
 *                            against the host (host_lstat) and opens it
 *                            (host_open);
 *   - read(fd, buf, N)     — RAW Out; the kernel calls host_read, which serves
 *                            the file contents into the kernel scratch, and the
 *                            host copies them into the guest buffer;
 *   - write(1, buf, r)     — echo what was read to stdout.
 *
 * The native host serves "/native.txt" with a fixed string; a correct final
 * line proves open()/read() route through the host FS capabilities on a non-JS
 * engine — the first fixture to touch a real (host-backed) file.
 *
 * Built through the SDK like the example C programs; see fixtures/README.md.
 */
#include <fcntl.h>
#include <unistd.h>

int main(void) {
    int fd = open("/native.txt", O_RDONLY);
    if (fd < 0) {
        return 2;
    }
    char buf[128];
    ssize_t r = read(fd, buf, sizeof(buf));
    if (r <= 0) {
        return 3;
    }
    close(fd);
    write(1, buf, (size_t)r);
    return 0;
}
