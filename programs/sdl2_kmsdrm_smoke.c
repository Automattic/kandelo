/*
 * sdl2_kmsdrm_smoke — exercise SDL2's KMSDRM video backend against
 * the kandelo /dev/dri/card0 device. Prints "OK kmsdrm <driver>" on
 * success, where <driver> is the name SDL2 selected for the video
 * subsystem (expected: "KMSDRM").
 *
 * Verifies, at minimum:
 *   * libSDL2.a + libdrm.a + libgbm.a link in one pass.
 *   * SDL_Init(SDL_INIT_VIDEO) reaches the KMSDRM probe and returns
 *     successfully against kandelo's libdrm-KMS subset.
 *   * SDL_GetCurrentVideoDriver() reports "KMSDRM" — confirms the
 *     backend wasn't silently downgraded to "dummy".
 *
 * Window creation is deliberately skipped: gbm_surface_create needs
 * the GL stubs (libegl-stub + libgles2-stub + libgbm-extended) that
 * land in the same PR. This smoke test runs the link + init path; the
 * sdl2 playground binary runs the create-window + page-flip path.
 *
 * Used by host/test/sdl2-kmsdrm-smoke.test.ts.
 */
#include <SDL2/SDL.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        fprintf(stderr, "FAIL: SDL_Init(VIDEO): %s\n", SDL_GetError());
        return 1;
    }

    const char *driver = SDL_GetCurrentVideoDriver();
    if (driver == NULL) {
        fprintf(stderr, "FAIL: SDL_GetCurrentVideoDriver returned NULL\n");
        SDL_Quit();
        return 1;
    }
    if (strcmp(driver, "KMSDRM") != 0) {
        fprintf(stderr, "FAIL: video driver = %s, expected KMSDRM\n", driver);
        SDL_Quit();
        return 1;
    }

    int n = SDL_GetNumVideoDisplays();
    if (n < 1) {
        fprintf(stderr, "FAIL: SDL_GetNumVideoDisplays = %d (expected >= 1)\n", n);
        SDL_Quit();
        return 1;
    }

    printf("OK kmsdrm %s displays=%d\n", driver, n);
    SDL_Quit();
    return 0;
}
