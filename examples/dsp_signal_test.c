#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/soundcard.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

enum { PCM_BYTES = 8192 };

static volatile sig_atomic_t alarm_count;
static unsigned char pcm[PCM_BYTES];

static void on_alarm(int signum)
{
    (void)signum;
    alarm_count++;
}

static int arm_alarm(long usec)
{
    const struct itimerval timer = {
        .it_value = { .tv_sec = 0, .tv_usec = usec },
    };
    return setitimer(ITIMER_REAL, &timer, NULL);
}

static long elapsed_ms(struct timespec start, struct timespec end)
{
    return (end.tv_sec - start.tv_sec) * 1000L
        + (end.tv_nsec - start.tv_nsec) / 1000000L;
}

static int configure_dsp(int fd)
{
    int format = AFMT_U8;
    int channels = 1;
    int rate = 8000;
    int fragments = (2 << 16) | 12;

    if (ioctl(fd, SNDCTL_DSP_SETFMT, &format) != 0 || format != AFMT_U8)
        return -1;
    if (ioctl(fd, SNDCTL_DSP_CHANNELS, &channels) != 0 || channels != 1)
        return -1;
    if (ioctl(fd, SNDCTL_DSP_SPEED, &rate) != 0 || rate != 8000)
        return -1;
    if (ioctl(fd, SNDCTL_DSP_SETFRAGMENT, &fragments) != 0 ||
        fragments != ((2 << 16) | 12))
        return -1;
    return 0;
}

static int fill_dsp(int fd)
{
    ssize_t written = write(fd, pcm, sizeof(pcm));
    if (written != (ssize_t)sizeof(pcm)) {
        fprintf(stderr, "fill write: result=%ld errno=%d\n", (long)written, errno);
        return -1;
    }
    return 0;
}

static int expect_interrupted_write(int fd)
{
    const int before = alarm_count;
    if (fill_dsp(fd) != 0 || arm_alarm(20 * 1000) != 0)
        return -1;
    errno = 0;
    ssize_t result = write(fd, pcm, sizeof(pcm));
    if (result != -1 || errno != EINTR || alarm_count != before + 1) {
        fprintf(stderr, "write interruption: result=%ld errno=%d alarms=%d\n",
                (long)result, errno, (int)alarm_count);
        return -1;
    }
    return ioctl(fd, SNDCTL_DSP_RESET, 0);
}

static int expect_interrupted_sync(int fd)
{
    const int before = alarm_count;
    if (fill_dsp(fd) != 0 || arm_alarm(20 * 1000) != 0)
        return -1;
    errno = 0;
    int result = ioctl(fd, SNDCTL_DSP_SYNC, 0);
    if (result != -1 || errno != EINTR || alarm_count != before + 1) {
        fprintf(stderr, "sync interruption: result=%d errno=%d alarms=%d\n",
                result, errno, (int)alarm_count);
        return -1;
    }
    return ioctl(fd, SNDCTL_DSP_RESET, 0);
}

static int expect_interrupted_close(int fd)
{
    const int before = alarm_count;
    if (fill_dsp(fd) != 0 || arm_alarm(20 * 1000) != 0)
        return -1;
    errno = 0;
    int result = close(fd);
    if (result != -1 || errno != EINTR || alarm_count != before + 1) {
        fprintf(stderr, "close interruption: result=%d errno=%d alarms=%d\n",
                result, errno, (int)alarm_count);
        return -1;
    }
    if (fcntl(fd, F_GETFL) < 0) {
        perror("interrupted close consumed fd");
        return -1;
    }
    return 0;
}

static int expect_restarted_write(int fd)
{
    const int before = alarm_count;
    struct timespec start;
    struct timespec end;
    if (fill_dsp(fd) != 0 || arm_alarm(20 * 1000) != 0 ||
        clock_gettime(CLOCK_MONOTONIC, &start) != 0)
        return -1;
    errno = 0;
    ssize_t result = write(fd, pcm, sizeof(pcm));
    if (clock_gettime(CLOCK_MONOTONIC, &end) != 0)
        return -1;
    long duration = elapsed_ms(start, end);
    if (result != (ssize_t)sizeof(pcm) || alarm_count != before + 1 ||
        duration < 500 || duration > 5000) {
        fprintf(stderr,
                "restarted write: result=%ld errno=%d alarms=%d elapsed=%ld\n",
                (long)result, errno, (int)alarm_count, duration);
        return -1;
    }
    return ioctl(fd, SNDCTL_DSP_RESET, 0);
}

static int expect_restarted_sync(int fd)
{
    const int before = alarm_count;
    struct timespec start;
    struct timespec end;
    if (fill_dsp(fd) != 0 || arm_alarm(20 * 1000) != 0 ||
        clock_gettime(CLOCK_MONOTONIC, &start) != 0)
        return -1;
    errno = 0;
    int result = ioctl(fd, SNDCTL_DSP_SYNC, 0);
    if (clock_gettime(CLOCK_MONOTONIC, &end) != 0)
        return -1;
    long duration = elapsed_ms(start, end);
    if (result != 0 || alarm_count != before + 1 ||
        duration < 500 || duration > 5000) {
        fprintf(stderr,
                "restarted sync: result=%d errno=%d alarms=%d elapsed=%ld\n",
                result, errno, (int)alarm_count, duration);
        return -1;
    }
    return 0;
}

int main(void)
{
    for (size_t i = 0; i < sizeof(pcm); i++)
        pcm[i] = (unsigned char)i;

    struct sigaction action = { .sa_handler = on_alarm };
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGALRM, &action, NULL) != 0) {
        perror("sigaction");
        return 2;
    }

    int fd = open("/dev/dsp", O_WRONLY);
    if (fd < 0 || configure_dsp(fd) != 0) {
        perror("open/configure dsp");
        return 3;
    }
    if (expect_interrupted_write(fd) != 0 ||
        expect_interrupted_sync(fd) != 0 ||
        expect_interrupted_close(fd) != 0) {
        return 4;
    }
    if (ioctl(fd, SNDCTL_DSP_RESET, 0) != 0 || close(fd) != 0) {
        perror("cleanup after interrupted close");
        return 5;
    }

    action.sa_flags = SA_RESTART;
    if (sigaction(SIGALRM, &action, NULL) != 0) {
        perror("sigaction(SA_RESTART)");
        return 6;
    }
    fd = open("/dev/dsp", O_WRONLY);
    if (fd < 0 || configure_dsp(fd) != 0) {
        perror("reopen/configure dsp");
        return 7;
    }
    if (expect_restarted_write(fd) != 0 || expect_restarted_sync(fd) != 0)
        return 8;

    /* close is intentionally outside the SA_RESTART whitelist: an EINTR
     * leaves the descriptor live, so policy remains with the caller. */
    if (expect_interrupted_close(fd) != 0)
        return 9;
    if (ioctl(fd, SNDCTL_DSP_RESET, 0) != 0 || close(fd) != 0) {
        perror("final cleanup");
        return 10;
    }

    printf("PASS dsp signal interruption alarms=%d\n", (int)alarm_count);
    return 0;
}
