#include <SDL2/SDL.h>
#include <SDL2/SDL_test_harness.h>

SDL_TimerID SDLCALL __real_SDL_AddTimer(Uint32 interval, SDL_TimerCallback callback, void *param);

/* The harness's one-hour deadline is private. Shorten it only in this
   executable, leaving dispatch to the real SDL timer thread. */
SDL_TimerID SDLCALL __wrap_SDL_AddTimer(Uint32 interval, SDL_TimerCallback callback, void *param)
{
    return __real_SDL_AddTimer(interval == 3600000 ? 100 : interval, callback, param);
}

static int run_past_deadline(void *arg)
{
    (void)arg;
    SDL_Delay(5000);
    return TEST_COMPLETED;
}

int main(void)
{
    const SDLTest_TestCaseReference test = { run_past_deadline, "timeout", "Exercise the harness timeout", TEST_ENABLED };
    const SDLTest_TestCaseReference *cases[] = { &test, NULL };
    SDLTest_TestSuiteReference suite = { "timer", NULL, cases, NULL };
    SDLTest_TestSuiteReference *suites[] = { &suite, NULL };

    return SDLTest_RunSuites(suites, "timeout", 1, NULL, 1);
}
