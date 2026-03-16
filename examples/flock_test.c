/**
 * flock_test.c — Test advisory file locking via flock().
 *
 * Usage: flock_test <iterations>
 *
 * Opens /tmp/flock_counter.txt, acquires LOCK_EX, reads a counter,
 * increments it, writes it back, and releases the lock.
 * Repeats <iterations> times.
 *
 * When run concurrently by multiple processes sharing the same
 * SharedLockTable, the final counter should equal
 * (iterations * number_of_processes) with no lost updates.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/file.h>

#define COUNTER_FILE "/tmp/flock_counter.txt"

int main(int argc, char *argv[]) {
    int iterations = 10;
    if (argc > 1) {
        iterations = atoi(argv[1]);
        if (iterations <= 0) iterations = 10;
    }

    for (int i = 0; i < iterations; i++) {
        int fd = open(COUNTER_FILE, O_RDWR | O_CREAT, 0644);
        if (fd < 0) {
            perror("open");
            return 1;
        }

        /* Acquire exclusive lock */
        if (flock(fd, LOCK_EX) < 0) {
            perror("flock LOCK_EX");
            close(fd);
            return 1;
        }

        /* Read current counter */
        char buf[32] = {0};
        int n = read(fd, buf, sizeof(buf) - 1);
        int counter = 0;
        if (n > 0) {
            counter = atoi(buf);
        }

        /* Increment */
        counter++;

        /* Write back */
        lseek(fd, 0, SEEK_SET);
        int len = snprintf(buf, sizeof(buf), "%d", counter);
        /* Truncate file to new length */
        ftruncate(fd, len);
        write(fd, buf, len);

        /* Close releases the lock (POSIX) */
        close(fd);
    }

    /* Read final value */
    int fd = open(COUNTER_FILE, O_RDONLY);
    if (fd >= 0) {
        char buf[32] = {0};
        read(fd, buf, sizeof(buf) - 1);
        printf("counter=%s\n", buf);
        close(fd);
    }

    return 0;
}
