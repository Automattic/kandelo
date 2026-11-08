#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

static unsigned char block[65536];
static const size_t window_length = 512 * 1024;
static const off_t file_length = (off_t)8 * 1024 * 1024 * 1024;

static void require(int accepted, const char *operation) {
    if (!accepted) {
        fprintf(stderr, "PRESSURE_FAILURE %s errno=%d\n", operation, errno);
        exit(1);
    }
}

static void name_at(char *path, size_t capacity, int index) {
    int prefix = snprintf(path, capacity, "/pressure/%08d-", index);
    require(prefix > 0 && prefix + 220 < (int)capacity, "name capacity");
    memset(path + prefix, 'n', 220);
    path[prefix + 220] = 0;
}

static void report_memory(void) {
    int descriptor = open("/proc/kandelo/fs_memory", O_RDONLY);
    require(descriptor >= 0, "filesystem memory report open");
    puts("FS_MEMORY_BEGIN");
    fflush(stdout);
    for (;;) {
        ssize_t count = read(descriptor, block, sizeof(block));
        require(count >= 0, "filesystem memory report read");
        if (count == 0) break;
        size_t done = 0;
        while (done < (size_t)count) {
            ssize_t written = write(STDOUT_FILENO, block + done, (size_t)count - done);
            require(written > 0, "filesystem memory report output");
            done += (size_t)written;
        }
    }
    require(close(descriptor) == 0, "filesystem memory report close");
    puts("FS_MEMORY_END");
    fflush(stdout);
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "memory") == 0) {
        report_memory();
        return 0;
    }
    int recovered = argc > 1 && strcmp(argv[1], "verify") == 0;
    char path[256];
    require(recovered || mkdir("/pressure", 0700) == 0, "mkdir");
    int state = open("/state", O_RDWR | (recovered ? 0 : O_CREAT), 0600);
    require(state >= 0, "state open");
    int mapped = open("/mapped", O_RDWR | (recovered ? 0 : O_CREAT), 0600);
    require(mapped >= 0, "mapped open");
    require(recovered || ftruncate(mapped, file_length) == 0, "sparse truncate");
    unsigned char *window = mmap(NULL, window_length, PROT_READ | PROT_WRITE,
        MAP_SHARED, mapped, file_length - window_length);
    require(window != MAP_FAILED, "small mapping");
    int created = 0;
    if (!recovered) {
        memset(window, 0x5a, window_length);
        require(msync(window, window_length, MS_SYNC) == 0, "initial msync");
        int bulk = open("/writeback", O_CREAT | O_RDWR, 0600);
        require(bulk >= 0, "bulk open");
        for (size_t offset = 0; offset < sizeof(block); offset++) {
            block[offset] = (unsigned char)(offset ^ (offset >> 8));
        }
        for (int index = 0; index < 128; index++) {
            require(write(bulk, block, sizeof(block)) == sizeof(block), "bulk write");
        }
        require(fsync(bulk) == 0 && close(bulk) == 0, "bulk sync");
        puts("PRESSURE_MAPPING_AND_WRITEBACK_READY");
        fflush(stdout);
        int refusal = 0;
        for (; created < 20000; created++) {
            name_at(path, sizeof(path), created);
            int descriptor = open(path, O_CREAT | O_EXCL | O_RDWR, 0600);
            if (descriptor < 0) {
                refusal = errno;
                break;
            }
            require(close(descriptor) == 0, "created close");
            if (created % 512 == 0) {
                printf("PRESSURE_NAMES %d\n", created);
                fflush(stdout);
            }
        }
        printf("PRESSURE_REFUSAL created=%d errno=%d\n", created, refusal);
        fflush(stdout);
        require(refusal == ENOMEM && created >= 128, "bounded metadata refusal");
        for (int index = created - 64; index < created; index++) {
            name_at(path, sizeof(path), index);
            require(unlink(path) == 0, "pressure reclaim");
        }
        created -= 64;
        int retry = open("/pressure/retry", O_CREAT | O_EXCL | O_RDWR, 0600);
        require(retry >= 0 && close(retry) == 0, "creation retry after reclaim");
        require(pwrite(state, &created, sizeof(created), 0) == sizeof(created), "state write");
        window[0] = 0xa5;
        window[window_length - 1] = 0x7c;
        require(msync(window, window_length, MS_SYNC) == 0, "post-pressure msync");
        require(fsync(state) == 0 && fsync(mapped) == 0, "post-pressure fsync");
    } else {
        require(pread(state, &created, sizeof(created), 0) == sizeof(created), "state recover");
        require(created >= 64 && created < 20000, "recovered count");
    }
    for (int index = 0; index < created; index++) {
        name_at(path, sizeof(path), index);
        require(access(path, F_OK) == 0, "accepted name preserved");
    }
    name_at(path, sizeof(path), created);
    require(access(path, F_OK) == -1 && errno == ENOENT, "reclaimed name absent");
    require(access("/pressure/retry", F_OK) == 0, "retry name present");
    require(window[0] == 0xa5 && window[window_length - 1] == 0x7c, "mapped endpoints");
    for (size_t offset = 1; offset < window_length - 1; offset++) {
        require(window[offset] == 0x5a, "mapped interior");
    }
    int bulk = open("/writeback", O_RDONLY);
    require(bulk >= 0, "bulk verification open");
    for (int index = 0; index < 128; index++) {
        require(read(bulk, block, sizeof(block)) == sizeof(block), "bulk verification read");
        for (size_t offset = 0; offset < sizeof(block); offset++) {
            require(block[offset] == (unsigned char)(offset ^ (offset >> 8)), "bulk byte");
        }
    }
    require(close(bulk) == 0 && close(state) == 0, "verification close");
    require(munmap(window, window_length) == 0 && close(mapped) == 0, "mapping close");
    printf("AGGREGATE_PRESSURE_VERIFIED names=%d recovered=%d\n", created, recovered);
    return 0;
}
