/*
 * Host-import coverage guest for the native Wasmtime host
 * (`smoke_host_metadata_imports`, see `../src/lib.rs`).
 *
 * L-D3 converted sixteen sites that wrote at a pointer the kernel handed in,
 * so each one now proves the lent range before copying. A per-import counter
 * over the whole `host-native` suite then showed that FIVE of those imports
 * are never called by any test in this repository: `host_readlinkat`,
 * `host_fpathconf`, `host_readdir`, `host_getrandom` and `host_fstatfs`.
 * Their conversions type-checked and their capacities were derived by reading
 * the kernel's declared buffer sizes, but nothing executed them, so a wrong
 * capacity there would not have been caught.
 *
 * This fixture calls all five against a mounted native directory, which is
 * what routes them to the host rather than to the in-kernel overlay. Each
 * step returns its own exit code so a failure says which import broke rather
 * than only that one did.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <dirent.h>
#include <fcntl.h>
#include <string.h>
#include <sys/random.h>
#include <sys/statvfs.h>
#include <unistd.h>

int main(void) {
    /* host_readlinkat: the mount holds `link.txt -> greeting.txt`. */
    char target[64];
    ssize_t n = readlink("/host/link.txt", target, sizeof(target));
    if (n <= 0) {
        return 10;
    }
    if (n != (ssize_t)strlen("greeting.txt")
        || memcmp(target, "greeting.txt", (size_t)n) != 0) {
        return 11;
    }

    int fd = open("/host/greeting.txt", O_RDONLY);
    if (fd < 0) {
        return 20;
    }

    /* host_fpathconf: one `pathconf(3)` answer through the host. */
    long name_max = fpathconf(fd, _PC_NAME_MAX);
    if (name_max <= 0) {
        close(fd);
        return 21;
    }

    /* host_fstatfs: the 72-byte WasmStatfs record the kernel reads back. */
    struct statvfs vfs;
    if (fstatvfs(fd, &vfs) != 0) {
        close(fd);
        return 22;
    }
    if (vfs.f_bsize == 0) {
        close(fd);
        return 23;
    }
    close(fd);

    /* host_readdir: the 16-byte dirent record plus a separate name buffer,
     * which is the one site that lends TWICE per entry. */
    DIR *dir = opendir("/host");
    if (dir == NULL) {
        return 30;
    }
    int saw_greeting = 0;
    for (;;) {
        struct dirent *entry = readdir(dir);
        if (entry == NULL) {
            break;
        }
        if (strcmp(entry->d_name, "greeting.txt") == 0) {
            saw_greeting = 1;
        }
    }
    closedir(dir);
    if (!saw_greeting) {
        return 31;
    }

    /* host_getrandom: entropy, and the one import here that is not a file
     * operation. Two draws, because a buffer left untouched would otherwise
     * look like a legitimate run of zeroes. */
    unsigned char a[32];
    unsigned char b[32];
    memset(a, 0, sizeof(a));
    memset(b, 0, sizeof(b));
    if (getrandom(a, sizeof(a), 0) != (ssize_t)sizeof(a)) {
        return 40;
    }
    if (getrandom(b, sizeof(b), 0) != (ssize_t)sizeof(b)) {
        return 41;
    }
    if (memcmp(a, b, sizeof(a)) == 0) {
        return 42;
    }

    write(1, "host metadata imports ok\n", 25);
    return 0;
}
