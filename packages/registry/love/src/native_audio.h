#pragma once

struct lua_State;

// Register the guest audio API. SDL opens the device lazily on first play.
void kandelo_love_register_audio(lua_State *L, const char *root);
// Join SDL's callback thread before releasing source data or quitting SDL.
void kandelo_love_shutdown_audio();
