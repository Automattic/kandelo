/*
 * programs/sdl2/main.c — entry point for the SDL2 playground binary
 * (`sdl2.wasm`, installed at /usr/local/bin/sdl2). At Phase 0 it is
 * still the original 5 s spinning-quad + 440 Hz tone + ESC demo from
 * Plan 7 §C1; phases 1–9 of the GLSL playground plan grow it into a
 * split-pane live editor.
 *
 * Single-threaded under SDL_THREADS_DISABLED: SDL2's audio callback
 * normally runs on a SDL_CreateThread worker, but with threads off
 * the polling-audio patch (packages/registry/sdl2/patches/
 * 0002-polling-audio-eagain.patch) registers the device with the
 * `wpk_polled_audio_devices` table and the main loop drives it via
 * `SDL_PumpAudioDevices()` each frame.
 *
 * Exits cleanly on either:
 *   - 5 s timeout (`SDL_GetTicks() - start >= 5000`); OR
 *   - ESC keydown delivered by the evdev backend.
 *
 * Build wiring lives in scripts/build-programs.sh — the post-loop
 * `build_sdl2_app` block globs every .c under programs/sdl2/ and
 * links to sdl2.wasm. The linker pulls in libSDL2.a + libasound.a +
 * libinput.a + libgbm.a + libdrm.a + libEGL.a + libGLESv2.a;
 * libEGL/libGLESv2 are explicit because the SDL_opengles2 header
 * bundle transitively pulls <GLES2/gl2.h> but the auto-detector only
 * matches direct top-level EGL/GLES includes.
 */

#include <SDL2/SDL.h>
#include <SDL2/SDL_opengles2.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static double g_audio_phase = 0.0;

static void audio_cb(void *user, Uint8 *stream, int len) {
    (void) user;
    int16_t *out = (int16_t *) stream;
    int frames = len / 4;
    for (int f = 0; f < frames; f++) {
        int16_t s = (int16_t) (sin(g_audio_phase) * 4000.0);
        out[f * 2 + 0] = s;
        out[f * 2 + 1] = s;
        g_audio_phase += 2.0 * 3.14159265358979 * 440.0 / 48000.0;
        if (g_audio_phase > 2.0 * 3.14159265358979) {
            g_audio_phase -= 2.0 * 3.14159265358979;
        }
    }
}

/* ----- video: GLES2 vertex/fragment shaders ---------------------- */
static const char *VERT_SRC =
    "attribute vec2 a_pos;\n"
    "uniform float u_angle;\n"
    "void main() {\n"
    "  float c = cos(u_angle);\n"
    "  float s = sin(u_angle);\n"
    "  gl_Position = vec4(c * a_pos.x - s * a_pos.y,\n"
    "                     s * a_pos.x + c * a_pos.y, 0.0, 1.0);\n"
    "}\n";

static const char *FRAG_SRC =
    "precision mediump float;\n"
    "uniform float u_t;\n"
    "void main() {\n"
    "  gl_FragColor = vec4(0.5 + 0.5 * sin(u_t), 0.5, 0.5, 1.0);\n"
    "}\n";

static GLuint compile_shader(GLenum type, const char *src) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, NULL);
    glCompileShader(s);
    return s;
}

int main(void) {
    setenv("SDL_VIDEODRIVER", "kmsdrm", 1);
    setenv("SDL_AUDIODRIVER", "alsa", 1);
    /* Without libudev, src/core/linux/SDL_evdev.c::SDL_EVDEV_Init
     * leaves the device list empty (its no-udev branch is a literal
     * `TODO: scan like a caveman`). SDL_EVDEV_DEVICES is the
     * upstream-blessed escape hatch — class 2 = keyboard, class
     * 1 = mouse — matching the kernel's two virtual input devices
     * (host/test/input-evdev.test.ts). */
    setenv("SDL_EVDEV_DEVICES",
           "2:/dev/input/event0,1:/dev/input/event1", 1);

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_EVENTS) < 0) {
        fprintf(stderr, "FAIL: SDL_Init: %s\n", SDL_GetError());
        return 1;
    }
    printf("sdl2: SDL_Init OK (video=%s, audio=%s)\n",
           SDL_GetCurrentVideoDriver() ? SDL_GetCurrentVideoDriver() : "(none)",
           SDL_GetCurrentAudioDriver() ? SDL_GetCurrentAudioDriver() : "(none)");

    SDL_Window *win = SDL_CreateWindow(
        "sdl2", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
        320, 240, SDL_WINDOW_OPENGL);
    if (!win) {
        fprintf(stderr, "FAIL: SDL_CreateWindow: %s\n", SDL_GetError());
        SDL_Quit();
        return 1;
    }

    SDL_GLContext glctx = SDL_GL_CreateContext(win);
    if (!glctx) {
        fprintf(stderr, "FAIL: SDL_GL_CreateContext: %s\n", SDL_GetError());
        SDL_DestroyWindow(win);
        SDL_Quit();
        return 1;
    }
    SDL_GL_MakeCurrent(win, glctx);

    GLuint prog = glCreateProgram();
    glAttachShader(prog, compile_shader(GL_VERTEX_SHADER, VERT_SRC));
    glAttachShader(prog, compile_shader(GL_FRAGMENT_SHADER, FRAG_SRC));
    glLinkProgram(prog);
    glUseProgram(prog);

    float quad[8] = {
        -0.5f, -0.5f,
         0.5f, -0.5f,
        -0.5f,  0.5f,
         0.5f,  0.5f,
    };
    GLuint vbo;
    glGenBuffers(1, &vbo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof quad, quad, GL_STATIC_DRAW);

    GLint a_pos = glGetAttribLocation(prog, "a_pos");
    glVertexAttribPointer((GLuint) a_pos, 2, GL_FLOAT, GL_FALSE, 0, NULL);
    glEnableVertexAttribArray((GLuint) a_pos);
    GLint u_angle = glGetUniformLocation(prog, "u_angle");
    GLint u_t = glGetUniformLocation(prog, "u_t");

    SDL_AudioSpec want, have;
    SDL_zero(want);
    want.freq = 48000;
    want.format = AUDIO_S16LSB;
    want.channels = 2;
    want.samples = 1024;
    want.callback = audio_cb;
    SDL_AudioDeviceID audio =
        SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
    if (audio == 0) {
        fprintf(stderr, "FAIL: SDL_OpenAudioDevice: %s\n", SDL_GetError());
        SDL_GL_DeleteContext(glctx);
        SDL_DestroyWindow(win);
        SDL_Quit();
        return 1;
    }
    SDL_PauseAudioDevice(audio, 0);

    Uint32 start = SDL_GetTicks();
    int running = 1;
    int frames = 0;

    while (running && SDL_GetTicks() - start < 5000) {
        SDL_Event ev;
        SDL_PumpEvents();
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) {
                running = 0;
            } else if (ev.type == SDL_KEYDOWN
                    && ev.key.keysym.sym == SDLK_ESCAPE) {
                running = 0;
            }
        }

        /* Polled mode: only this call pulls samples through audio_cb
         * (see packages/registry/sdl2/patches/0002-polling-audio-eagain.patch). */
        SDL_PumpAudioDevices();

        float t = (float) (SDL_GetTicks() - start) / 1000.0f;
        glUniform1f(u_angle, t);
        glUniform1f(u_t, t * 2.0f);
        glClearColor(0.1f, 0.1f, 0.1f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
        SDL_GL_SwapWindow(win);
        frames++;
    }

    /* Capture elapsed BEFORE SDL_Quit — SDL_QuitSubSystem(TIMER) tears
     * down the start_ts cache, so a post-Quit SDL_GetTicks() would
     * re-init from a fresh base and the subtraction would wrap. */
    Uint32 elapsed = SDL_GetTicks() - start;
    const char *reason = running ? "timeout" : "esc";

    SDL_PauseAudioDevice(audio, 1);
    SDL_CloseAudioDevice(audio);
    SDL_GL_DeleteContext(glctx);
    SDL_DestroyWindow(win);
    SDL_Quit();

    printf("sdl2: OK frames=%d elapsed=%u ms exit=%s\n",
           frames, (unsigned) elapsed, reason);
    return 0;
}
