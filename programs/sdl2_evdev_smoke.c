/*
 * sdl2_evdev_smoke — exercise SDL2's evdev input backend against
 * the kandelo /dev/input/event[0-31] devices. Prints "OK evdev" on
 * success.
 *
 * Verifies, at minimum:
 *   * libSDL2.a + libinput.a (the no-op stub) link in one pass.
 *     Linking libinput.a here is mostly to verify that SDL2's
 *     udev-fallback detection branch — the one that calls
 *     `libinput_udev_create_context` and expects NULL — finds the
 *     stub at link time. With --disable-libudev SDL2 falls through
 *     to direct /dev/input/event* scan instead.
 *   * SDL_Init(SDL_INIT_EVENTS) sets up the event queue without
 *     spawning a thread (open-arch #1 — no pthread_create on wasm32).
 *   * SDL_PumpEvents() is callable; on an empty event queue it must
 *     not block, hang, or trap.
 *
 * Used by host/test/sdl2-evdev-smoke.test.ts.
 */
#include <SDL2/SDL.h>
#include <stdio.h>

int main(void)
{
    if (SDL_Init(SDL_INIT_EVENTS) != 0) {
        fprintf(stderr, "FAIL: SDL_Init(EVENTS): %s\n", SDL_GetError());
        return 1;
    }

    /* Two pump iterations — one to flush any startup events, one to
     * verify the second call doesn't blow up against stale state. */
    SDL_PumpEvents();
    SDL_PumpEvents();

    SDL_Event ev;
    int polled = SDL_PollEvent(&ev);
    /* polled may be 0 (no events) or 1 (a startup event such as
     * window-shown — both are acceptable as long as PollEvent itself
     * returns and doesn't trap). */

    printf("OK evdev polled=%d\n", polled);
    SDL_Quit();
    return 0;
}
