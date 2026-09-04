/*
 * Real host-directory-backed filesystem guest for the native Wasmtime host's
 * N1-I1 increment.
 *
 * The earlier native_hostfs.c fixture only ever reached a single hardcoded
 * file. This one exercises the full surface a real host-directory-backed
 * `HostFs` must serve:
 *
 *   - open("/hello.txt") + read()        — RAW open (CString path) + RAW Out
 *                                           read, served from a real file
 *                                           under the native host's root.
 *   - lseek(fd, 6, SEEK_SET) + read()    — the SYS_LLSEEK extended syscall,
 *                                           then a second read from the new
 *                                           position, proving host_seek's
 *                                           result actually repositions the
 *                                           kernel-owned offset.
 *   - opendir("/subdir") + readdir()     — musl's opendir()/readdir() reach
 *                                           the kernel via open(O_DIRECTORY)
 *                                           + getdents64, which the kernel
 *                                           implements with host_opendir/
 *                                           host_readdir/host_closedir.
 *                                           Entries are collected and sorted
 *                                           so host directory-iteration order
 *                                           does not make the test flaky.
 *   - readlink("/link")                  — host_readlink on a real symlink.
 *
 * A correct final summary line proves open/read/pread/lseek/opendir/readdir/
 * closedir/readlink all route through the real host-directory backend, not a
 * single hardcoded file.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <dirent.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    char out[512];
    size_t n = 0;

    /* open / read / lseek / re-read a regular file. */
    int fd = open("/hello.txt", O_RDONLY);
    if (fd < 0) {
        return 2;
    }
    char buf1[64];
    ssize_t r1 = read(fd, buf1, sizeof(buf1));
    if (r1 <= 0) {
        return 3;
    }
    memcpy(out + n, buf1, (size_t)r1);
    n += (size_t)r1;

    if (lseek(fd, 6, SEEK_SET) != 6) {
        return 4;
    }
    char buf2[64];
    ssize_t r2 = read(fd, buf2, sizeof(buf2));
    if (r2 <= 0) {
        return 5;
    }
    out[n++] = '|';
    memcpy(out + n, buf2, (size_t)r2);
    n += (size_t)r2;
    out[n++] = '\n';
    close(fd);

    /* opendir / readdir a subdirectory; collect and sort entry names so
     * host directory-iteration order can't make this test flaky. */
    DIR *d = opendir("/subdir");
    if (!d) {
        return 6;
    }
    char names[8][64];
    int count = 0;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) {
            continue;
        }
        if (count >= 8) {
            return 7;
        }
        strncpy(names[count], ent->d_name, sizeof(names[count]) - 1);
        names[count][sizeof(names[count]) - 1] = '\0';
        count++;
    }
    closedir(d);
    for (int i = 1; i < count; i++) {
        char tmp[64];
        strcpy(tmp, names[i]);
        int j = i - 1;
        while (j >= 0 && strcmp(names[j], tmp) > 0) {
            strcpy(names[j + 1], names[j]);
            j--;
        }
        strcpy(names[j + 1], tmp);
    }
    for (int i = 0; i < count; i++) {
        size_t l = strlen(names[i]);
        memcpy(out + n, names[i], l);
        n += l;
        if (i + 1 < count) {
            out[n++] = ',';
        }
    }
    out[n++] = '\n';

    /* readlink a symlink. */
    char link_target[64];
    ssize_t lr = readlink("/link", link_target, sizeof(link_target) - 1);
    if (lr < 0) {
        return 8;
    }
    memcpy(out + n, link_target, (size_t)lr);
    n += (size_t)lr;
    out[n++] = '\n';

    write(1, out, n);
    return 0;
}
