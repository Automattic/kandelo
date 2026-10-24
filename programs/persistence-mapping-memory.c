#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(int argc, char **argv) {
    const off_t file_length = (off_t)8 * 1024 * 1024 * 1024;
    const off_t window_offset = file_length - 8192;
    const size_t large_length = 64 * 1024 * 1024;
    const int verify = argc > 1 && strcmp(argv[1], "verify") == 0;
    const int descriptor = open("/mapping-window", verify ? O_RDWR : O_CREAT | O_RDWR, 0600);
    if (descriptor < 0 || (!verify && ftruncate(descriptor, file_length) != 0)) return 1;
    unsigned char *window = mmap(NULL, 8192, PROT_READ | PROT_WRITE,
        MAP_SHARED, descriptor, window_offset);
    if (window == MAP_FAILED) return 2;
    if (!verify) {
        window[0] = 0x9a;
        window[8191] = 0x55;
    }
    if (window[0] != 0x9a || window[8191] != 0x55) return 3;
    if (msync(window, 8192, MS_SYNC) != 0) return 4;
    puts("SMALL_HIGH_OFFSET_WINDOW_SYNCED");
    fflush(stdout);

    errno = 0;
    void *oversized = mmap(NULL, large_length, PROT_READ | PROT_WRITE,
        MAP_SHARED, descriptor, 0);
    if (oversized != MAP_FAILED || errno != ENOMEM) return 5;
    errno = 0;
    oversized = mmap(window, large_length, PROT_READ | PROT_WRITE,
        MAP_SHARED | MAP_FIXED, descriptor, 0);
    if (oversized != MAP_FAILED || errno != ENOMEM) return 6;
    if (window[0] != 0x9a || window[8191] != 0x55) return 7;

    errno = 0;
    oversized = mremap(window, 8192, large_length, MREMAP_MAYMOVE);
    if (oversized != MAP_FAILED || errno != ENOMEM) return 8;
    if (window[0] != 0x9a || window[8191] != 0x55) return 9;
    if (!verify) window[1] = 0x7c;
    if (window[1] != 0x7c) return 10;
    if (msync(window, 8192, MS_SYNC) != 0 || munmap(window, 8192) != 0
        || fsync(descriptor) != 0) return 11;
    unsigned char observed;
    if (pread(descriptor, &observed, 1, window_offset) != 1 || observed != 0x9a
        || pread(descriptor, &observed, 1, window_offset + 1) != 1 || observed != 0x7c
        || pread(descriptor, &observed, 1, file_length - 1) != 1 || observed != 0x55) return 12;
    if (close(descriptor) != 0) return 13;
    puts("MAPPING_MEMORY_REFUSAL_VERIFIED");
    return 0;
}
