#include <SDL3/SDL.h>

#ifndef SDL_PLATFORM_UNIX
#error "Kandelo's SDK must expose its Unix platform identity to SDL3 consumers"
#endif

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

enum { RUN_MS = 900, FRAME_BYTES = 4, CHUNK_BYTES = 8192 };

struct playback_state {
    uint64_t callbacks;
    uint64_t frames;
    uint32_t phase;
    int failed;
    Uint8 chunk[CHUNK_BYTES];
};

static uint64_t monotonic_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return 0;
    }
    return (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u;
}

static void fill_s16le_stereo(struct playback_state *state, int bytes) {
    int offset;

    for (offset = 0; offset < bytes; offset += FRAME_BYTES) {
        int sample = ((int)(state->phase++ % 200u) - 100) * 240;
        int right = -sample;
        state->chunk[offset + 0] = (Uint8)(sample & 0xff);
        state->chunk[offset + 1] = (Uint8)((sample >> 8) & 0xff);
        state->chunk[offset + 2] = (Uint8)(right & 0xff);
        state->chunk[offset + 3] = (Uint8)((right >> 8) & 0xff);
    }
}

static void SDLCALL provide_audio(void *userdata, SDL_AudioStream *stream,
                                  int additional_amount, int total_amount) {
    struct playback_state *state = userdata;
    int remaining;
    (void)total_amount;

    state->callbacks++;
    remaining = additional_amount;
    while (remaining > 0) {
        int bytes = remaining < CHUNK_BYTES ? remaining : CHUNK_BYTES;
        bytes = (bytes + FRAME_BYTES - 1) & ~(FRAME_BYTES - 1);
        fill_s16le_stereo(state, bytes);
        if (!SDL_PutAudioStreamData(stream, state->chunk, bytes)) {
            state->failed = 1;
            return;
        }
        state->frames += (uint64_t)bytes / FRAME_BYTES;
        remaining -= bytes;
    }
}

static const char *format_name(SDL_AudioFormat format) {
    return format == SDL_AUDIO_S16LE ? "S16LE" : "OTHER";
}

static void report_direct_dsp_probe(void) {
    struct stat status;
    int fd;

    errno = 0;
    fd = open("/dev/dsp", O_WRONLY | O_NONBLOCK | O_CLOEXEC, 0);
    if (fd < 0) {
        fprintf(stderr, "SDL3 direct /dev/dsp probe: open failed: %s (%d)\n",
                strerror(errno), errno);
        return;
    }
    errno = 0;
    if (fstat(fd, &status) != 0) {
        fprintf(stderr, "SDL3 direct /dev/dsp probe: fstat failed: %s (%d)\n",
                strerror(errno), errno);
    } else {
        fprintf(stderr,
                "SDL3 direct /dev/dsp probe: mode=%#o character_device=%d\n",
                (unsigned)status.st_mode, S_ISCHR(status.st_mode) ? 1 : 0);
    }
    if (close(fd) != 0) {
        fprintf(stderr, "SDL3 direct /dev/dsp probe: close failed: %s (%d)\n",
                strerror(errno), errno);
    }
}

int main(void) {
    SDL_AudioSpec requested;
    SDL_AudioSpec source_spec;
    SDL_AudioSpec device_spec;
    SDL_AudioStream *stream;
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

    SDL_zero(requested);
    SDL_zero(source_spec);
    SDL_zero(device_spec);
    SDL_zero(state);

    if (setenv("SDL_AUDIODRIVER", "dsp", 1) != 0) {
        perror("setenv SDL_AUDIODRIVER");
        return 1;
    }
    if (!SDL_Init(SDL_INIT_AUDIO)) {
        fprintf(stderr, "SDL3 init failed: %s\n", SDL_GetError());
        report_direct_dsp_probe();
        return 1;
    }

    driver = SDL_GetCurrentAudioDriver();
    if (driver == NULL || strcmp(driver, "dsp") != 0) {
        fprintf(stderr, "SDL3 selected unexpected audio driver: %s\n",
                driver == NULL ? "(null)" : driver);
        SDL_Quit();
        return 1;
    }

    requested.freq = 48000;
    requested.format = SDL_AUDIO_S16LE;
    requested.channels = 2;
    stream = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,
                                       &requested, provide_audio, &state);
    if (stream == NULL) {
        fprintf(stderr, "SDL3 open failed: %s\n", SDL_GetError());
        SDL_Quit();
        return 1;
    }
    if (!SDL_GetAudioStreamFormat(stream, &source_spec, &device_spec)) {
        fprintf(stderr, "SDL3 format query failed: %s\n", SDL_GetError());
        SDL_DestroyAudioStream(stream);
        SDL_Quit();
        return 1;
    }
    if (source_spec.freq != requested.freq ||
        source_spec.format != requested.format ||
        source_spec.channels != requested.channels ||
        device_spec.freq != requested.freq ||
        device_spec.format != requested.format ||
        device_spec.channels != requested.channels) {
        fprintf(stderr,
                "SDL3 changed an exactly supported spec: %d/%#x/%u -> %d/%#x/%u\n",
                requested.freq, requested.format, (unsigned)requested.channels,
                device_spec.freq, device_spec.format,
                (unsigned)device_spec.channels);
        SDL_DestroyAudioStream(stream);
        SDL_Quit();
        return 1;
    }

    start_ms = monotonic_ms();
    if (!SDL_ResumeAudioStreamDevice(stream)) {
        fprintf(stderr, "SDL3 resume failed: %s\n", SDL_GetError());
        SDL_DestroyAudioStream(stream);
        SDL_Quit();
        return 1;
    }
    SDL_Delay(RUN_MS);
    end_ms = monotonic_ms();
    close_start_ms = end_ms;
    SDL_DestroyAudioStream(stream);
    close_end_ms = monotonic_ms();

    SDL_Quit();

    elapsed_ms = end_ms >= start_ms ? end_ms - start_ms : 0;
    close_ms = close_end_ms >= close_start_ms ? close_end_ms - close_start_ms : 0;
    expected_frames = source_spec.freq > 0 ?
        ((uint64_t)source_spec.freq * elapsed_ms) / 1000u : 0;
    paced = !state.failed && state.callbacks >= 2 && expected_frames > 0 &&
            state.frames >= expected_frames / 2u &&
            state.frames <= expected_frames * 2u + 4096u;

    if (!paced) {
        fprintf(stderr,
                "SDL3 callback pacing failed: frames=%llu expected=%llu elapsed=%llu ms\n",
                (unsigned long long)state.frames,
                (unsigned long long)expected_frames,
                (unsigned long long)elapsed_ms);
        return 1;
    }

    printf("SDL_DSP_RESULT {\"sdl_major\":3,\"requested_rate\":48000,"
           "\"requested_format\":\"S16LE\",\"requested_channels\":2,"
           "\"actual_rate\":%d,\"actual_format\":\"%s\","
           "\"actual_channels\":%u,\"callbacks\":%llu,\"frames\":%llu,"
           "\"pcm_bytes\":%llu,\"elapsed_ms\":%llu,\"close_ms\":%llu,"
           "\"paced\":%s}\n",
           device_spec.freq, format_name(device_spec.format),
           (unsigned)device_spec.channels,
           (unsigned long long)state.callbacks,
           (unsigned long long)state.frames,
           (unsigned long long)state.frames * FRAME_BYTES,
           (unsigned long long)elapsed_ms,
           (unsigned long long)close_ms,
           "true");
    fflush(stdout);
    return 0;
}
