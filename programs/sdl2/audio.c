/*
 * programs/sdl2/audio.c — chip-synth + FFT analysis. See audio.h for the
 * public surface and the threading model (single-threaded, polled).
 */

#include "audio.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ----- analysis ring --------------------------------------------- */

/* Power-of-two FFT window. The ring holds exactly one window of the most
 * recent mono samples; `g_ring_pos` is the index the next sample writes
 * to, so the oldest sample is at g_ring_pos and the newest at
 * g_ring_pos-1 (mod N). */
#define FFT_N 1024

static float g_ring[FFT_N];
static int   g_ring_pos = 0;

/* ----- device config --------------------------------------------- */

static int g_rate     = 48000;
static int g_channels = 2;
static int g_muted    = 0;

/* ----- sound-shader playback source (Phase 6) -------------------- */

/* When g_sound_pcm is non-NULL the callback plays this looped S16 stereo
 * buffer instead of the chip synth. Owned by sound_shader.c; we only read
 * it. g_sound_pos is the current frame cursor into it. */
static const int16_t *g_sound_pcm    = NULL;
static int            g_sound_frames  = 0;
static int            g_sound_pos     = 0;

/* ----- synth state ----------------------------------------------- */

/* 16-row looping pattern. Entries are MIDI note numbers; 0 = rest /
 * continue. The noise row uses 1 = hit, 0 = silent. The four voices are
 * a square lead, a square/triangle-ish bass, a saw pad, and a noise hat
 * — the classic 4-op chiptune palette. */
#define PATTERN_ROWS 16

static const int PAT_LEAD[PATTERN_ROWS] = {
    72, 0, 76, 0,  79, 0, 76, 0,  74, 0, 71, 0,  67, 0, 0, 0,
};
static const int PAT_BASS[PATTERN_ROWS] = {
    48, 0, 0, 0,  53, 0, 0, 0,  55, 0, 0, 0,  53, 0, 48, 0,
};
static const int PAT_PAD[PATTERN_ROWS] = {
    60, 0, 0, 0,  0, 0, 0, 0,  55, 0, 0, 0,  0, 0, 0, 0,
};
static const int PAT_HAT[PATTERN_ROWS] = {
    1, 0, 1, 0,  1, 0, 1, 0,  1, 0, 1, 0,  1, 0, 1, 1,
};

/* Per-voice oscillator + envelope state. `phase` is in [0,1); `amp` is
 * the current envelope level, reset to `gain` on a note trigger and
 * decayed multiplicatively each sample by `decay`. */
typedef struct {
    float phase;
    float inc;    /* phase increment per sample = freq / rate */
    float amp;
    float gain;   /* peak level on trigger */
    float decay;  /* per-sample multiplier (set from a decay time) */
} Voice;

enum { V_LEAD, V_BASS, V_PAD, V_HAT, V_COUNT };
static Voice g_voice[V_COUNT];

static int   g_row             = 0;
static int   g_samples_in_row  = 0;
static int   g_samples_per_row = 6000;

/* 15-bit LFSR for the noise voice (Galois form). */
static uint16_t g_lfsr = 0xACE1u;

static int g_render_logged = 0;

static float midi_to_freq(int note) {
    /* A4 (MIDI 69) = 440 Hz. */
    return 440.0f * powf(2.0f, (float)(note - 69) / 12.0f);
}

/* Set a voice's per-sample decay multiplier from a decay time in seconds:
 * amp falls to ~37% (1/e) after `seconds`. */
static float decay_per_sample(float seconds) {
    if (seconds <= 0.0f || g_rate <= 0) return 0.0f;
    return expf(-1.0f / (seconds * (float)g_rate));
}

static void trigger_voice(Voice *v, int note, float gain, float decay_sec) {
    v->inc   = midi_to_freq(note) / (float)g_rate;
    v->amp   = gain;
    v->gain  = gain;
    v->decay = decay_per_sample(decay_sec);
}

static void advance_row(void) {
    g_row = (g_row + 1) % PATTERN_ROWS;

    if (PAT_LEAD[g_row]) trigger_voice(&g_voice[V_LEAD], PAT_LEAD[g_row],
                                       0.28f, 0.18f);
    if (PAT_BASS[g_row]) trigger_voice(&g_voice[V_BASS], PAT_BASS[g_row],
                                       0.30f, 0.30f);
    if (PAT_PAD[g_row])  trigger_voice(&g_voice[V_PAD],  PAT_PAD[g_row],
                                       0.18f, 0.45f);
    if (PAT_HAT[g_row]) {
        /* The hat is pitch-less noise; only its envelope matters. */
        g_voice[V_HAT].amp   = 0.22f;
        g_voice[V_HAT].decay = decay_per_sample(0.05f);
    }
}

void audio_synth_init(int sample_rate, int channels) {
    g_rate     = sample_rate > 0 ? sample_rate : 48000;
    g_channels = channels    > 0 ? channels    : 2;

    /* ~8.7 rows/sec ≈ 130 BPM at 4 rows/beat — a brisk chiptune feel. */
    g_samples_per_row = (int)((float)g_rate * 60.0f / (130.0f * 4.0f));
    if (g_samples_per_row < 1) g_samples_per_row = 1;

    memset(g_voice, 0, sizeof g_voice);
    memset(g_ring, 0, sizeof g_ring);
    g_ring_pos       = 0;
    g_row            = PATTERN_ROWS - 1;  /* so the first advance lands row 0 */
    g_samples_in_row = g_samples_per_row;  /* force an immediate advance */
    g_lfsr           = 0xACE1u;
    g_muted          = 0;
    g_render_logged  = 0;

    printf("sdl2: audio synth rate=%d ch=%d rows/loop=%d\n",
           g_rate, g_channels, PATTERN_ROWS);
}

/* Produce one mono sample, advancing all oscillator/envelope state. */
static float synth_next_sample(void) {
    if (g_samples_in_row >= g_samples_per_row) {
        g_samples_in_row = 0;
        advance_row();
    }
    g_samples_in_row++;

    /* Square lead. */
    Voice *lead = &g_voice[V_LEAD];
    float lead_s = (lead->phase < 0.5f ? 1.0f : -1.0f) * lead->amp;
    lead->phase += lead->inc;
    if (lead->phase >= 1.0f) lead->phase -= 1.0f;
    lead->amp *= lead->decay;

    /* Square bass (narrower 25% duty for a punchier low end). */
    Voice *bass = &g_voice[V_BASS];
    float bass_s = (bass->phase < 0.25f ? 1.0f : -1.0f) * bass->amp;
    bass->phase += bass->inc;
    if (bass->phase >= 1.0f) bass->phase -= 1.0f;
    bass->amp *= bass->decay;

    /* Saw pad. */
    Voice *pad = &g_voice[V_PAD];
    float pad_s = (2.0f * pad->phase - 1.0f) * pad->amp;
    pad->phase += pad->inc;
    if (pad->phase >= 1.0f) pad->phase -= 1.0f;
    pad->amp *= pad->decay;

    /* Noise hat: Galois LFSR, one step per sample. */
    Voice *hat = &g_voice[V_HAT];
    unsigned lsb = g_lfsr & 1u;
    g_lfsr >>= 1;
    if (lsb) g_lfsr ^= 0xB400u;
    float hat_s = ((g_lfsr & 1u) ? 1.0f : -1.0f) * hat->amp;
    hat->amp *= hat->decay;

    float mix = (lead_s + bass_s + pad_s + hat_s) * 0.6f;
    if (mix >  1.0f) mix =  1.0f;
    if (mix < -1.0f) mix = -1.0f;
    return mix;
}

void audio_synth_render(uint8_t *stream, int len) {
    int16_t *out = (int16_t *)stream;
    int frames = len / (int)(sizeof(int16_t) * (size_t)g_channels);

    if (!g_render_logged) {
        printf("sdl2: audio render first-callback frames=%d\n", frames);
        g_render_logged = 1;
    }

    int use_sound = (g_sound_pcm != NULL && g_sound_frames > 0);

    for (int f = 0; f < frames; f++) {
        float left, right;
        if (use_sound) {
            /* Loop the rendered sound-shader buffer. The synth pattern is
             * not advanced while the sound source is active. */
            left  = (float) g_sound_pcm[g_sound_pos * 2 + 0] / 32768.0f;
            right = (float) g_sound_pcm[g_sound_pos * 2 + 1] / 32768.0f;
            g_sound_pos++;
            if (g_sound_pos >= g_sound_frames) g_sound_pos = 0;
        } else {
            left = right = synth_next_sample();
        }
        if (g_muted) { left = 0.0f; right = 0.0f; }

        /* Feed the analysis ring with the (possibly muted) mono mix so the
         * visualizer reflects what is actually audible. */
        g_ring[g_ring_pos] = 0.5f * (left + right);
        g_ring_pos = (g_ring_pos + 1) % FFT_N;

        int16_t lv = (int16_t)(left  * 32767.0f);
        int16_t rv = (int16_t)(right * 32767.0f);
        for (int c = 0; c < g_channels; c++) {
            out[f * g_channels + c] = (c == 0) ? lv : rv;
        }
    }
}

/* ----- FFT (iterative radix-2 Cooley–Tukey, in place) ------------ */

static void fft_radix2(float *re, float *im, int n) {
    /* Bit-reversal permutation. */
    for (int i = 1, j = 0; i < n; i++) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            float tr = re[i]; re[i] = re[j]; re[j] = tr;
            float ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }
    /* Butterflies. */
    for (int len = 2; len <= n; len <<= 1) {
        float ang = -2.0f * (float)M_PI / (float)len;
        float wr = cosf(ang), wi = sinf(ang);
        for (int i = 0; i < n; i += len) {
            float cwr = 1.0f, cwi = 0.0f;
            for (int k = 0; k < len / 2; k++) {
                int a = i + k;
                int b = i + k + len / 2;
                float vr = re[b] * cwr - im[b] * cwi;
                float vi = re[b] * cwi + im[b] * cwr;
                re[b] = re[a] - vr; im[b] = im[a] - vi;
                re[a] += vr;        im[a] += vi;
                float ncwr = cwr * wr - cwi * wi;
                cwi = cwr * wi + cwi * wr;
                cwr = ncwr;
            }
        }
    }
}

void audio_compute_spectrum(uint8_t bins[AUDIO_SPECTRUM_BINS]) {
    float re[FFT_N];
    float im[FFT_N];

    /* Copy the ring oldest→newest and apply a Hann window to suppress
     * spectral leakage from the rectangular frame. */
    for (int i = 0; i < FFT_N; i++) {
        int idx = (g_ring_pos + i) % FFT_N;
        float w = 0.5f - 0.5f * cosf(2.0f * (float)M_PI * (float)i
                                     / (float)(FFT_N - 1));
        re[i] = g_ring[idx] * w;
        im[i] = 0.0f;
    }

    fft_radix2(re, im, FFT_N);

    /* Usable spectrum is bins 1..N/2. Map the 128 output bins
     * logarithmically across that range — log spacing matches both human
     * pitch perception and the spread of energy in the chiptune. Each
     * output bin takes the peak magnitude across its source range. */
    const int half = FFT_N / 2;
    for (int b = 0; b < AUDIO_SPECTRUM_BINS; b++) {
        float t0 = (float)b       / (float)AUDIO_SPECTRUM_BINS;
        float t1 = (float)(b + 1) / (float)AUDIO_SPECTRUM_BINS;
        int lo = (int)powf((float)half, t0);
        int hi = (int)powf((float)half, t1);
        if (lo < 1) lo = 1;
        if (hi <= lo) hi = lo + 1;
        if (hi > half) hi = half;

        float peak = 0.0f;
        for (int k = lo; k < hi; k++) {
            float mag = sqrtf(re[k] * re[k] + im[k] * im[k]);
            if (mag > peak) peak = mag;
        }
        /* Normalize against the window's coherent gain (~N/4 after Hann)
         * and compress with a square root so quiet detail stays visible. */
        float v = peak / (float)(FFT_N / 4);
        v = sqrtf(v);
        if (v > 1.0f) v = 1.0f;
        bins[b] = (uint8_t)(v * 255.0f);
    }
}

void audio_set_muted(int muted) { g_muted = muted ? 1 : 0; }
int  audio_muted(void)          { return g_muted; }

void audio_set_sound_pcm(const int16_t *pcm, int frames) {
    if (pcm && frames > 0) {
        g_sound_pcm    = pcm;
        g_sound_frames = frames;
        g_sound_pos    = 0;
    } else {
        g_sound_pcm    = NULL;
        g_sound_frames = 0;
        g_sound_pos    = 0;
    }
}
