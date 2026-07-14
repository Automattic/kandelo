#include <SDL.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum { RUN_MS = 900 };

struct playback_state {
    uint64_t callbacks;
    uint64_t frames;
    uint32_t phase;
};

static uint64_t monotonic_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return 0;
    }
    return (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u;
}

static void SDLCALL fill_audio(void *userdata, Uint8 *stream, int len) {
    struct playback_state *state = userdata;
    int i;

    /* Deterministic unsigned 8-bit mono sawtooth. */
    for (i = 0; i < len; ++i) {
        stream[i] = (Uint8)(32u + (state->phase++ % 192u));
    }
    state->callbacks++;
    state->frames += (uint64_t)len;
}

static const char *format_name(SDL_AudioFormat format) {
    return format == AUDIO_U8 ? "U8" : "OTHER";
}

int main(void) {
    SDL_AudioSpec requested;
    SDL_AudioSpec actual;
    SDL_AudioDeviceID device;
    struct playback_state state;
    const char *driver;
    uint64_t start_ms;
    uint64_t end_ms;
    uint64_t close_start_ms;
    uint64_t close_end_ms;
    uint64_t elapsed_ms;
    uint64_t close_ms;
    uint64_t expected_frames;
    int paced;

    memset(&requested, 0, sizeof(requested));
    memset(&actual, 0, sizeof(actual));
    memset(&state, 0, sizeof(state));

    if (setenv("SDL_AUDIODRIVER", "dsp", 1) != 0) {
        perror("setenv SDL_AUDIODRIVER");
        return 1;
    }
    if (SDL_Init(SDL_INIT_AUDIO | SDL_INIT_TIMER) != 0) {
        fprintf(stderr, "SDL2 init failed: %s\n", SDL_GetError());
        return 1;
    }

    driver = SDL_GetCurrentAudioDriver();
    if (driver == NULL || strcmp(driver, "dsp") != 0) {
        fprintf(stderr, "SDL2 selected unexpected audio driver: %s\n",
                driver == NULL ? "(null)" : driver);
        SDL_Quit();
        return 1;
    }

    requested.freq = 22050;
    requested.format = AUDIO_U8;
    requested.channels = 1;
    requested.samples = 512;
    requested.callback = fill_audio;
    requested.userdata = &state;

    device = SDL_OpenAudioDevice(NULL, 0, &requested, &actual, 0);
    if (device == 0) {
        fprintf(stderr, "SDL2 open failed: %s\n", SDL_GetError());
        SDL_Quit();
        return 1;
    }
    if (actual.freq != requested.freq || actual.format != requested.format ||
        actual.channels != requested.channels) {
        fprintf(stderr,
                "SDL2 changed an exactly supported spec: %d/%#x/%u -> %d/%#x/%u\n",
                requested.freq, requested.format, (unsigned)requested.channels,
                actual.freq, actual.format, (unsigned)actual.channels);
        SDL_CloseAudioDevice(device);
        SDL_Quit();
        return 1;
    }

    start_ms = monotonic_ms();
    SDL_PauseAudioDevice(device, 0);
    SDL_Delay(RUN_MS);
    end_ms = monotonic_ms();
    close_start_ms = end_ms;
    SDL_CloseAudioDevice(device);
    close_end_ms = monotonic_ms();

    SDL_Quit();

    elapsed_ms = end_ms >= start_ms ? end_ms - start_ms : 0;
    close_ms = close_end_ms >= close_start_ms ? close_end_ms - close_start_ms : 0;
    expected_frames = actual.freq > 0 ?
        ((uint64_t)actual.freq * elapsed_ms) / 1000u : 0;
    paced = state.callbacks >= 2 && expected_frames > 0 &&
            state.frames >= expected_frames / 2u &&
            state.frames <= expected_frames * 2u + (uint64_t)actual.samples * 2u;

    if (!paced) {
        fprintf(stderr,
                "SDL2 callback pacing failed: frames=%llu expected=%llu elapsed=%llu ms\n",
                (unsigned long long)state.frames,
                (unsigned long long)expected_frames,
                (unsigned long long)elapsed_ms);
        return 1;
    }

    printf("SDL_DSP_RESULT {\"sdl_major\":2,\"requested_rate\":22050,"
           "\"requested_format\":\"U8\",\"requested_channels\":1,"
           "\"actual_rate\":%d,\"actual_format\":\"%s\","
           "\"actual_channels\":%u,\"callbacks\":%llu,\"frames\":%llu,"
           "\"pcm_bytes\":%llu,\"period_frames\":%u,"
           "\"elapsed_ms\":%llu,\"close_ms\":%llu,\"paced\":%s}\n",
           actual.freq, format_name(actual.format), (unsigned)actual.channels,
           (unsigned long long)state.callbacks,
           (unsigned long long)state.frames,
           (unsigned long long)state.frames,
           (unsigned)actual.samples,
           (unsigned long long)elapsed_ms,
           (unsigned long long)close_ms,
           "true");
    fflush(stdout);
    return 0;
}
