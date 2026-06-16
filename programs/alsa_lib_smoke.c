/*
 * alsa-lib subset smoke test. Validates that the PCM-hw-direct
 * subset (packages/registry/alsa-lib/) links, that snd_pcm_open
 * resolves through the patched snd_pcm_open_noupdate ->
 * snd_pcm_hw_open path onto /dev/snd/pcmC0D0p, and that:
 *   * an hw_params round-trip against SNDRV_PCM_IOCTL_HW_REFINE +
 *     SNDRV_PCM_IOCTL_HW_PARAMS succeeds end-to-end.
 *   * snd_pcm_status() (SNDRV_PCM_IOCTL_STATUS) returns successfully
 *     against the wasm32-shaped WpkAlsaPcmStatus struct (catches the
 *     struct-size-drifts-from-userspace class of regression).
 *
 * Used by host/test/alsa-lib-smoke.test.ts.
 */
#include <alsa/asoundlib.h>
#include <stdio.h>

int main(void)
{
    snd_pcm_t *pcm = NULL;
    int err = snd_pcm_open(&pcm, "default", SND_PCM_STREAM_PLAYBACK, 0);
    if (err < 0) {
        fprintf(stderr, "FAIL: snd_pcm_open(default): %s\n", snd_strerror(err));
        return 1;
    }

    snd_pcm_hw_params_t *hw = NULL;
    err = snd_pcm_hw_params_malloc(&hw);
    if (err < 0 || hw == NULL) {
        fprintf(stderr, "FAIL: snd_pcm_hw_params_malloc: %s\n", snd_strerror(err));
        return 1;
    }

    err = snd_pcm_hw_params_any(pcm, hw);
    if (err < 0) {
        fprintf(stderr, "FAIL: snd_pcm_hw_params_any: %s\n", snd_strerror(err));
        return 1;
    }

    err = snd_pcm_hw_params_set_access(pcm, hw, SND_PCM_ACCESS_RW_INTERLEAVED);
    if (err < 0) {
        fprintf(stderr, "FAIL: set_access: %s\n", snd_strerror(err));
        return 1;
    }

    err = snd_pcm_hw_params_set_format(pcm, hw, SND_PCM_FORMAT_S16_LE);
    if (err < 0) {
        fprintf(stderr, "FAIL: set_format: %s\n", snd_strerror(err));
        return 1;
    }

    err = snd_pcm_hw_params_set_channels(pcm, hw, 2);
    if (err < 0) {
        fprintf(stderr, "FAIL: set_channels: %s\n", snd_strerror(err));
        return 1;
    }

    unsigned rate = 48000;
    err = snd_pcm_hw_params_set_rate_near(pcm, hw, &rate, NULL);
    if (err < 0) {
        fprintf(stderr, "FAIL: set_rate_near: %s\n", snd_strerror(err));
        return 1;
    }

    err = snd_pcm_hw_params(pcm, hw);
    if (err < 0) {
        fprintf(stderr, "FAIL: snd_pcm_hw_params: %s\n", snd_strerror(err));
        return 1;
    }

    /* snd_pcm_status drives SNDRV_PCM_IOCTL_STATUS, which marshals the
     * 128 B WpkAlsaPcmStatus struct end-to-end. The kernel populates
     * `state` from the OFD; readback verifies the struct layout agrees
     * between kernel-side Rust and alsa-lib's wasm32-compiled UAPI. */
    snd_pcm_status_t *status = NULL;
    err = snd_pcm_status_malloc(&status);
    if (err < 0 || status == NULL) {
        fprintf(stderr, "FAIL: snd_pcm_status_malloc: %s\n", snd_strerror(err));
        return 1;
    }
    err = snd_pcm_status(pcm, status);
    if (err < 0) {
        fprintf(stderr, "FAIL: snd_pcm_status: %s\n", snd_strerror(err));
        return 1;
    }
    /* alsa-lib's snd_pcm_hw_params() calls snd_pcm_prepare() internally,
     * so the OFD reaches PREPARED before our snd_pcm_status() call. */
    snd_pcm_state_t st = snd_pcm_status_get_state(status);
    if (st != SND_PCM_STATE_PREPARED) {
        fprintf(stderr, "FAIL: status state expected PREPARED (%d), got %d\n",
                (int)SND_PCM_STATE_PREPARED, (int)st);
        return 1;
    }
    printf("STATUS state=%d\n", (int)st);

    printf("OK rate=%u\n", rate);

    snd_pcm_status_free(status);
    snd_pcm_hw_params_free(hw);
    snd_pcm_close(pcm);
    return 0;
}
