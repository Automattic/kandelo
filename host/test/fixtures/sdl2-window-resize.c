#include <SDL.h>
#include <stdio.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "%s: %s\n", #x, SDL_GetError()); return 1; } } while (0)

int main(void) {
    CHECK(SDL_Init(SDL_INIT_VIDEO) == 0);
    SDL_Window *window = SDL_CreateWindow("EGL native window resize", 0, 0, 960, 540, 0);
    CHECK(window);
    SDL_Renderer *renderer = NULL;
    const int sizes[][2] = {{960, 540}, {800, 600}, {1280, 720}};
    const Uint8 colors[][3] = {{220, 30, 40}, {30, 210, 50}, {40, 60, 220}};
    for (int i = 0; i < 3; i++) {
        SDL_DisplayMode mode = {.w = sizes[i][0], .h = sizes[i][1]};
        CHECK(SDL_SetWindowDisplayMode(window, &mode) == 0);
        CHECK(SDL_SetWindowFullscreen(window, SDL_WINDOW_FULLSCREEN) == 0);
        if (renderer) SDL_DestroyRenderer(renderer);
        renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
        CHECK(renderer);
        CHECK(SDL_SetRenderDrawColor(renderer, colors[i][0], colors[i][1], colors[i][2], 255) == 0);
        CHECK(SDL_RenderClear(renderer) == 0);
        SDL_RenderPresent(renderer);
        printf("READY:%dx%d\n", sizes[i][0], sizes[i][1]);
        fflush(stdout);
        SDL_Event event;
        do { CHECK(SDL_WaitEvent(&event)); } while (event.type != SDL_KEYDOWN);
    }
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    puts("sdl2-window-resize: ok");
    return 0;
}
