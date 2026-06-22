/*
 * sdl2_alsa_smoke — exercise SDL2's ALSA audio backend against the
 * kandelo /dev/snd/pcmC0D0p PCM-direct device. Prints
 * "OK alsa <driver>" on success.
 *
 * Verifies, at minimum:
 *   * libSDL2.a + libasound.a link in one pass.
 *   * SDL_Init(SDL_INIT_AUDIO) initialises the audio subsystem
 *     against the wasm32-shaped WpkAlsaPcm* structs (catches the
 *     struct-marshalling drift class that handoff-53's session-b fix
 *     also addressed in alsa_lib_smoke).
 *   * SDL_GetCurrentAudioDriver() reports "alsa".
 *
 * Open-arch #1 (polling-audio rewrite of SDL_RunAudio) is not on this
 * path — SDL_OpenAudioDevice is *not* called here; SDL2's audio
 * subsystem only spawns SDL_CreateThread when a device is opened.
 * The actual SDL_OpenAudioDevice + write-loop is exercised by the
 * sdl2 playground binary once open-arch #1 lands.
 *
 * Used by host/test/sdl2-alsa-smoke.test.ts.
 */
#include <SDL2/SDL.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    if (SDL_Init(SDL_INIT_AUDIO) != 0) {
        fprintf(stderr, "FAIL: SDL_Init(AUDIO): %s\n", SDL_GetError());
        return 1;
    }

    const char *driver = SDL_GetCurrentAudioDriver();
    if (driver == NULL) {
        fprintf(stderr, "FAIL: SDL_GetCurrentAudioDriver returned NULL\n");
        SDL_Quit();
        return 1;
    }
    if (strcmp(driver, "alsa") != 0) {
        fprintf(stderr, "FAIL: audio driver = %s, expected alsa\n", driver);
        SDL_Quit();
        return 1;
    }

    int n = SDL_GetNumAudioDevices(0 /* iscapture=false */);
    /* `-1` is a valid return when the backend cannot enumerate.
     * SDL2's ALSA backend returns -1 against our PCM-direct surface
     * (no /proc/asound/cards), but the smoke only checks SDL_Init
     * + the driver-name probe — the enumerate path is unused. */

    printf("OK alsa %s capture_devices=%d\n", driver, n);
    SDL_Quit();
    return 0;
}
