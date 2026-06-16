/*
 * programs/sdl2_demo.c — combined SDL2 video + audio + input demo.
 *
 * Plan 7 §C1 (docs/plans/2026-06-29-sdl2-port-plan.md). A 320×240
 * spinning OpenGL ES 2.0 quad rendered via SDL2's KMSDRM backend, a
 * continuous 440 Hz tone via SDL2's ALSA backend, ESC exits via
 * SDL2's evdev backend.
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
 * Build wiring lives in scripts/build-programs.sh (sdl2_demo.c
 * case).  The linker pulls in libSDL2.a + libasound.a + libinput.a +
 * libgbm.a + libdrm.a + libEGL.a + libGLESv2.a; libEGL/libGLESv2 are
 * explicit because the SDL_opengles2 header bundle transitively
 * pulls <GLES2/gl2.h> but the auto-detector only matches direct
 * top-level EGL/GLES includes.
 */

#include <SDL2/SDL.h>
#include <SDL2/SDL_opengles2.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

/* Public from the polling-audio patch; declared in SDL_audio.h only
 * when SDL_THREADS_DISABLED is defined.  On our wasm build it is, so
 * the symbol is in libSDL2.a — keep an extern fallback for the
 * header configurations that haven't picked it up yet. */
extern void SDL_PumpAudioDevices(void);

/* ----- audio: continuous 440 Hz sine generator ------------------- */
static double g_audio_phase = 0.0;

static void audio_cb(void *user, Uint8 *stream, int len) {
    (void) user;
    int16_t *out = (int16_t *) stream;
    int frames = len / 4;  /* int16 stereo: 4 bytes per frame */
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
    /* Force the KMSDRM backend even if SDL2 later adds a different
     * default — belt + suspenders. */
    setenv("SDL_VIDEODRIVER", "kmsdrm", 1);
    setenv("SDL_AUDIODRIVER", "alsa", 1);
    /* Without libudev, src/core/linux/SDL_evdev.c::SDL_EVDEV_Init
     * leaves the device list empty (its no-udev branch is a literal
     * `TODO: scan like a caveman`).  The SDL_EVDEV_DEVICES env var
     * (format: `<class>:<path>[,<class>:<path>…]`, class 2=keyboard,
     * 1=mouse) is the upstream-blessed escape hatch.  We hard-code
     * event0=keyboard + event1=mouse to match the kandelo kernel's
     * two virtual input devices (input-evdev-smoke.test.ts §"Phase
     * 1/2"). */
    setenv("SDL_EVDEV_DEVICES",
           "2:/dev/input/event0,1:/dev/input/event1", 1);

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_EVENTS) < 0) {
        fprintf(stderr, "FAIL: SDL_Init: %s\n", SDL_GetError());
        return 1;
    }
    printf("sdl2_demo: SDL_Init OK (video=%s, audio=%s)\n",
           SDL_GetCurrentVideoDriver() ? SDL_GetCurrentVideoDriver() : "(none)",
           SDL_GetCurrentAudioDriver() ? SDL_GetCurrentAudioDriver() : "(none)");

    SDL_Window *win = SDL_CreateWindow(
        "sdl2_demo", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
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

        /* Polling-audio: drive the registered audio device(s) once
         * per frame.  When SDL_THREADS_DISABLED is set, this is the
         * ONLY thing that pulls samples through the audio_cb. */
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

    printf("sdl2_demo: OK frames=%d elapsed=%u ms exit=%s\n",
           frames, (unsigned) elapsed, reason);
    return 0;
}
