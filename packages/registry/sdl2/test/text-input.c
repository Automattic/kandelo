/* Exercise the public SDL event API against real guest evdev devices. */
#include <SDL2/SDL.h>
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <linux/input.h>

int main(void)
{
    SDL_setenv("SDL_VIDEODRIVER", "kmsdrm", 1);
    SDL_setenv("SDL_EVDEV_DEVICES", "2:/dev/input/event0,1:/dev/input/event1", 1);
    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        fprintf(stderr, "SDL_Init: %s\n", SDL_GetError());
        return 1;
    }
    int observer = open("/dev/input/event1", O_RDONLY | O_NONBLOCK);
    if (observer < 0) return 3;
    SDL_StartTextInput();
    for (int phase = 0; phase < 6; ++phase) {
        printf("READY:%d\n", phase);
        fflush(stdout);
        if (getchar() == EOF) return 2;
        SDL_PumpEvents();
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_TEXTINPUT) printf("TEXT:%d:%s\n", phase, event.text.text);
            if (event.type == SDL_KEYDOWN) printf("KEY:%d:%d\n", phase, event.key.keysym.sym);
            if (phase >= 2 && event.type == SDL_MOUSEBUTTONDOWN) printf("MOUSE:%d:%d:1\n", phase, event.button.button);
            if (phase >= 2 && event.type == SDL_MOUSEBUTTONUP) printf("MOUSE:%d:%d:0\n", phase, event.button.button);
        }
        if (phase >= 3) {
            printf("BUTTONS:%d:%u\n", phase, SDL_GetMouseState(NULL, NULL));
            fflush(stdout);
        }
        if (phase == 4) {
            struct input_event dropped;
            struct input_absinfo abs;
            unsigned char keys[(KEY_MAX + 8) / 8] = {0};
            if (read(observer, &dropped, sizeof(dropped)) != sizeof(dropped)) return 4;
            if (ioctl(observer, EVIOCGABS(ABS_X), &abs) < 0) return 5;
            if (ioctl(observer, EVIOCGKEY(sizeof(keys)), keys) < 0) return 6;
            printf("DEVICE:%u:%u:%d:%u\n", dropped.type, dropped.code, abs.value,
                   !!(keys[BTN_LEFT / 8] & (1 << (BTN_LEFT % 8))));
        }
        SDL_StopTextInput();
    }
    close(observer);
    puts("DONE");
    SDL_Quit();
    return 0;
}
