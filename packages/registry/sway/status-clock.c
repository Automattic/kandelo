/* A long-lived status command for the Kandelo Sway desktop. */
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(void)
{
    setlocale(LC_TIME, "");

    for (;;) {
        time_t now = time(NULL);
        struct tm local;
        char line[128];

        if (now == (time_t)-1 || localtime_r(&now, &local) == NULL ||
            strftime(line, sizeof line, "%Y-%m-%d %X", &local) == 0 ||
            puts(line) == EOF || fflush(stdout) == EOF)
            return EXIT_FAILURE;

        struct timespec remaining = { .tv_sec = 1 };
        while (nanosleep(&remaining, &remaining) != 0) {
            if (errno != EINTR)
                return EXIT_FAILURE;
        }
    }
}
