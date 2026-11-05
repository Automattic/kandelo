#pragma once
#include <SDL.h>

// SDL owns the window on both Wayland and standalone KMSDRM.
SDL_Window *kandelo_love_sdl_window();
extern "C" void kandelo_love_set_native_window_size(int width, int height);
