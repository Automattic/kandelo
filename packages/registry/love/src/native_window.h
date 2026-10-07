#pragma once
#include <SDL.h>

// Null on the standalone KMS backend. The presenter owns this window.
SDL_Window *kandelo_love_sdl_window();
extern "C" void kandelo_love_set_native_window_size(int width, int height);
