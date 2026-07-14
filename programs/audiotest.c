/*
 * audiotest — open /dev/dsp, configure OSS sample rate / format /
 * channel count, write a known PCM frame sequence, then exit.
 *
 * Used by host/test/audio-integration.test.ts to verify the kernel
 *   - exposes /dev/dsp
 *   - accepts OSS ioctls (SNDCTL_DSP_SPEED / STEREO / SETFMT / GETFMTS)
 *   - compiles against Kandelo's installed OSS source-compatibility header
 *   - buffers `write()` bytes for the host PCM sink
 *   - reports the configured sample rate / channel count via the
 *     PCM transport descriptor
 *
 * On success the program prints:
 *
 *     ready <rate> <chans>
 *     wrote <bytes>
 *
 * and exits 0 after the final close has drained. The host sink observes the
 * same deterministic bytes while advancing the audio clock.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/soundcard.h>
#include <unistd.h>

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
    if ((size_t)n != sizeof(pcm)) {
        fprintf(stderr, "short blocking /dev/dsp write: %zd of %zu bytes\n",
                n, sizeof(pcm));
        close(fd);
        return 1;
    }

    printf("wrote %zd\n", n);
    fflush(stdout);

    if (close(fd) < 0) {
        perror("close /dev/dsp");
        return 1;
    }
    return 0;
}
