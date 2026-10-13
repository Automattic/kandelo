#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    int state = open("/state", O_RDWR);
    if (state < 0) return 1;
    if (open("/created", O_WRONLY | O_CREAT, 0600) >= 0) return 6;
    if (pwrite(state, "x", 1, 8) >= 0) return 7;
    char count;
    if (pread(state, &count, 1, 0) != 1 || count < '0' || count >= '9') return 2;
    count++;
    if (pwrite(state, &count, 1, 0) != 1) return 3;
    if (fsync(state) != 0) return 4;
    if (close(state) != 0) return 5;
    printf("PERSISTENCE_BOOT_%c\n", count);
    fflush(stdout);
    for (;;) pause();
}
