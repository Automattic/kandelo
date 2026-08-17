/*
 * audiotest — open /dev/dsp, configure OSS sample rate / format /
 * channel count, write a known PCM frame sequence, then exit.
 *
 * Used by host/test/audio-integration.test.ts to verify the kernel
 *   - exposes /dev/dsp
 *   - accepts OSS ioctls (SNDCTL_DSP_SPEED / STEREO / SETFMT / GETFMTS)
 *   - buffers `write()` bytes into the ring drained by
 *     `kernel_drain_audio`
 *   - reports the configured sample rate / channel count via the
 *     dedicated wasm exports
 *
 * On success the program prints:
 *
 *     ready <rate> <chans>
 *     wrote <bytes>
 *
 * and exits 0. The harness reads the rate/chans from the first line,
 * then calls drainAudio() repeatedly until it has the same byte count
 * back, asserting that the bytes match what we wrote.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

/* OSS ioctls — same numeric values the kernel and Linux use. We
 * hard-code rather than #include <sys/soundcard.h> so the test program
 * builds without pulling additional headers into the toolchain. */
#define SNDCTL_DSP_RESET     0x00005000u
#define SNDCTL_DSP_SPEED     0xc0045002u
#define SNDCTL_DSP_STEREO    0xc0045003u
#define SNDCTL_DSP_SETFMT    0xc0045005u
#define SNDCTL_DSP_GETFMTS   0x8004500bu
#define AFMT_S16_LE          0x10

int main(void) {
    int fd = open("/dev/dsp", O_WRONLY);
    if (fd < 0) {
        perror("open /dev/dsp");
        return 1;
    }

    int speed = 44100;
    if (ioctl(fd, SNDCTL_DSP_SPEED, &speed) < 0) {
        perror("ioctl SNDCTL_DSP_SPEED");
        close(fd);
        return 1;
    }

    int stereo = 1; /* 1 = stereo */
    if (ioctl(fd, SNDCTL_DSP_STEREO, &stereo) < 0) {
        perror("ioctl SNDCTL_DSP_STEREO");
        close(fd);
        return 1;
    }

    int fmts = 0;
    if (ioctl(fd, SNDCTL_DSP_GETFMTS, &fmts) < 0) {
        perror("ioctl SNDCTL_DSP_GETFMTS");
        close(fd);
        return 1;
    }
    if (!(fmts & AFMT_S16_LE)) {
        fprintf(stderr, "kernel doesn't advertise AFMT_S16_LE (got %#x)\n", fmts);
        close(fd);
        return 1;
    }

    int fmt = AFMT_S16_LE;
    if (ioctl(fd, SNDCTL_DSP_SETFMT, &fmt) < 0) {
        perror("ioctl SNDCTL_DSP_SETFMT");
        close(fd);
        return 1;
    }

    /* The harness picks up speed=44100, chans=2 from the first line. */
    printf("ready %d %d\n", speed, stereo ? 2 : 1);
    fflush(stdout);

    /* Write 64 stereo S16 frames = 256 bytes. The bytes are easy to
     * recognize on the host side: byte i = i & 0xff, with even bytes
     * holding the L sample low byte and odd bytes the high byte. */
    uint8_t pcm[256];
    for (size_t i = 0; i < sizeof(pcm); ++i) {
        pcm[i] = (uint8_t)(i & 0xff);
    }

    ssize_t n = write(fd, pcm, sizeof(pcm));
    if (n < 0) {
        perror("write /dev/dsp");
        close(fd);
        return 1;
    }

    printf("wrote %zd\n", n);
    fflush(stdout);

    close(fd);
    return 0;
}
