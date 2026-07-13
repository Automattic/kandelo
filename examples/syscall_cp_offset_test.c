#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    if (argc > 2) {
        fprintf(stderr, "usage: %s [FILE]\n", argv[0]);
        return 2;
    }
    const char *path = argc == 2 ? argv[1] : "/tmp/syscall-cp-offset.bin";

    int fd = open(path, O_CREAT | O_TRUNC | O_RDWR, 0600);
    if (fd < 0) {
        perror("open");
        return 3;
    }
    if (write(fd, "abc", 3) != 3) {
        perror("write");
        close(fd);
        return 4;
    }

    /* musl routes pread() through __syscall_cp. If wasm32 truncates its i64
     * argument slot, this offset becomes 1 and incorrectly reads 'b'. */
    const off_t high_offset = ((off_t)1 << 32) + 1;
    char byte = '?';
    errno = 0;
    ssize_t n = pread(fd, &byte, 1, high_offset);
    if (n != 0) {
        fprintf(stderr,
                "high pread: expected EOF, got n=%zd byte=%d errno=%d (%s)\n",
                n, (unsigned char)byte, errno, strerror(errno));
        close(fd);
        return 5;
    }

    byte = '?';
    n = pread(fd, &byte, 1, 1);
    if (n != 1 || byte != 'b') {
        fprintf(stderr, "control pread: n=%zd byte=%d errno=%d (%s)\n",
                n, (unsigned char)byte, errno, strerror(errno));
        close(fd);
        return 6;
    }

    close(fd);
    puts("PASS syscall_cp 64-bit offset");
    return 0;
}
