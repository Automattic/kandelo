/*
 * programs/sdl2/main.c — entry point for the SDL2 GLSL playground
 * (`sdl2.wasm`, installed at /usr/local/bin/sdl2). Phase 4 introduces
 * the editor: keystrokes typed into the left pane edit a gap buffer
 * (`editor.c`), 250 ms of keystroke-idle triggers a recompile of the
 * user shader, and Ctrl+S writes the editor's contents to
 * `/home/shaders/image/current.frag` and force-reloads.
 *
 * The previous monolithic main.c got split per the plan's
 * "File layout" table — main.c now stays at orchestration: SDL/GL/audio
 * init, the main event loop, key routing, the auto-recompile timer,
 * F5/Ctrl+S, ESC quit. All GL drawing (user shader, error strip,
 * editor text, font atlas) lives in `renderer.c`; all gap-buffer +
 * cursor + line navigation lives in `editor.c`.
 *
 * Startup shader-source chain (unchanged from Phase 3):
 *   1. /home/shaders/image/current.frag   (user-editable, primary)
 *   2. /usr/share/shaders/image/plasma.frag (preset shipped in VFS)
 *   3. built-in PLASMA_SRC string (handed off to renderer.c)
 *
 * F5 still re-reads ONLY (1). Auto-recompile after typing pulls from
 * the editor's in-memory buffer, NOT the file — so the user sees their
 * edits reflected in the right pane even before they save. Ctrl+S
 * persists the editor's buffer to (1) and triggers an F5-equivalent
 * reload so the live image matches the on-disk state.
 *
 * Single-threaded under SDL_THREADS_DISABLED — see the polling
 * audio patch at packages/registry/sdl2/patches/
 * 0002-polling-audio-eagain.patch.
 */

#include <SDL2/SDL.h>
#include <SDL2/SDL_opengles2.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>  /* mkdir for Ctrl+S parent-dir creation */

#include "editor.h"
#include "renderer.h"

/* Used only when SDL_GetCurrentDisplayMode fails (headless harness).
 * In the browser path we honor the kernel-reported display size as-is
 * so the GL framebuffer matches the kandelo canvas dimensions and
 * nothing gets letterboxed inside the pane. */
static const int WINDOW_FALLBACK_W = 1280;
static const int WINDOW_FALLBACK_H = 720;

/* Editor : render split, left-to-right. The render pane houses the
 * live image shader; the editor takes the rest. Phase 4 picks 2/3
 * editor + 1/3 render — the editor is the surface the user is
 * actually working in, and the render pane is a preview. */
static const int EDITOR_NUMERATOR   = 2;
static const int EDITOR_DENOMINATOR = 3;

static const char *USER_CURRENT_PATH  = "/home/shaders/image/current.frag";
static const char *PRESET_PLASMA_PATH = "/usr/share/shaders/image/plasma.frag";

static const unsigned int AUTO_RECOMPILE_DEBOUNCE_MS = 250;

/* Built-in plasma — kept in sync with
 * programs/sdl2/presets/image/plasma.frag. Last-resort fallback for
 * test harnesses that don't stage a VFS shader file. */
static const char *BUILTIN_PLASMA_SRC =
    "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n"
    "  vec2 uv = fragCoord / iResolution.xy;\n"
    "  float r = 0.5 + 0.5 * sin(iTime + uv.x * 6.2831);\n"
    "  float g = 0.5 + 0.5 * sin(iTime * 1.3 + uv.y * 6.2831);\n"
    "  float b = 0.5 + 0.5 * sin(iTime * 0.7 + (uv.x + uv.y) * 6.2831);\n"
    "  fragColor = vec4(r, g, b, 1.0);\n"
    "}\n";

/* Audio is silent by default. Phase 5/6 of the playground plan will
 * replace the callback contents with a sound-shader-driven mixer; for
 * now we keep the device open + the polling pump exercised so that
 * later phase can drop in without reshaping the loop, but we feed
 * zeros — a constant 440 Hz tone was a Phase 0 bring-up signal, not a
 * desired playground behavior. */
static void audio_cb(void *user, Uint8 *stream, int len) {
    (void) user;
    memset(stream, 0, (size_t) len);
}

/* Slurp a text file into a malloc'd null-terminated buffer. Returns
 * NULL if open or read fails (caller treats that as "not present").
 * Capped at 1 MiB so a runaway pipe in /home/shaders can't OOM us. */
static char *read_text_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long n = ftell(f);
    if (n < 0 || n > (1 << 20)) { fclose(f); return NULL; }
    if (fseek(f, 0, SEEK_SET) != 0) { fclose(f); return NULL; }
    char *buf = malloc((size_t) n + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t) n, f);
    fclose(f);
    if (got != (size_t) n) { free(buf); return NULL; }
    buf[n] = '\0';
    return buf;
}

/* Walk the source-resolution chain: user file → preset → built-in.
 * The label we print into stdout lets the test harnesses confirm which
 * leg of the chain was taken without reaching into the kernel. */
static char *load_initial_shader_source(void) {
    char *src = read_text_file(USER_CURRENT_PATH);
    if (src) {
        printf("sdl2: shader-source=%s\n", USER_CURRENT_PATH);
        return src;
    }
    src = read_text_file(PRESET_PLASMA_PATH);
    if (src) {
        printf("sdl2: shader-source=%s\n", PRESET_PLASMA_PATH);
        return src;
    }
    printf("sdl2: shader-source=builtin-plasma\n");
    return strdup(BUILTIN_PLASMA_SRC);
}

/* Write the editor's buffer to USER_CURRENT_PATH. Returns 1 on
 * success. mkdir -p the parent on first save in case the path was
 * never created by the host. */
static int save_editor_to_user_path(void) {
    /* Best-effort directory creation. fopen below surfaces the real
     * problem if the path can't be reached; we just ensure the
     * parents exist on a fresh boot. EEXIST and similar are ignored. */
    (void) mkdir("/home/shaders", 0755);
    (void) mkdir("/home/shaders/image", 0755);

    char *text = editor_dup_text();
    if (!text) {
        fprintf(stderr, "WARN: save: editor_dup_text() returned NULL\n");
        return 0;
    }
    FILE *f = fopen(USER_CURRENT_PATH, "wb");
    if (!f) {
        fprintf(stderr, "WARN: save: fopen(%s) failed\n", USER_CURRENT_PATH);
        free(text);
        return 0;
    }
    size_t n = strlen(text);
    size_t wrote = fwrite(text, 1, n, f);
    fclose(f);
    free(text);
    if (wrote != n) {
        fprintf(stderr,
                "WARN: save: fwrite wrote %zu of %zu bytes\n", wrote, n);
        return 0;
    }
    fprintf(stderr, "WARN: save: wrote %zu bytes to %s\n", n,
            USER_CURRENT_PATH);
    return 1;
}

/* F5 / Ctrl+S reload path: re-read the user-editable shader file
 * (NOT the preset — that's first-boot-only). On read or compile
 * failure, keep the last-good program and raise the red strip. */
static void reload_user_shader_from_file(const char *trigger) {
    char *src = read_text_file(USER_CURRENT_PATH);
    if (!src) {
        fprintf(stderr,
                "WARN: %s: %s not readable\n", trigger, USER_CURRENT_PATH);
        renderer_set_error_visible(1);
        return;
    }
    int real_failure = renderer_recompile_user_shader(src);
    free(src);
    if (real_failure) {
        renderer_set_error_visible(1);
        return;
    }
    renderer_set_error_visible(0);
    fprintf(stderr, "WARN: %s: reloaded %s\n", trigger, USER_CURRENT_PATH);
}

/* Auto-recompile from the editor's in-memory buffer. Same outcome as
 * an F5 reload but without the file round-trip — so the user sees
 * their edits reflected the moment they stop typing for 250 ms. */
static void recompile_from_editor(void) {
    char *src = editor_dup_text();
    if (!src) return;
    int real_failure = renderer_recompile_user_shader(src);
    free(src);
    renderer_set_error_visible(real_failure ? 1 : 0);
    fprintf(stdout, "sdl2: editor recompile (real_failure=%d)\n",
            real_failure);
}

/* Translate an SDL keysym + modifier set into a printable ASCII byte,
 * or 0 if the keystroke should not type a character. Specific to the
 * US-QWERTY layout that SDL_evdev defaults to in our SDL2 stack — we
 * don't have xkbcommon, so SDL_TEXTINPUT can't be relied on. */
static char sym_to_ascii(SDL_Keycode sym, Uint16 mod) {
    int shift = (mod & KMOD_SHIFT) != 0;
    /* Lowercase a..z (matches the SDLK_* numeric layout). */
    if (sym >= SDLK_a && sym <= SDLK_z) {
        char base = (char) ('a' + (sym - SDLK_a));
        return shift ? (char) (base - ('a' - 'A')) : base;
    }
    if (sym >= SDLK_0 && sym <= SDLK_9) {
        static const char shifted[10] = {
            ')', '!', '@', '#', '$', '%', '^', '&', '*', '('
        };
        return shift ? shifted[sym - SDLK_0] : (char) ('0' + (sym - SDLK_0));
    }
    /* Numeric keypad. SDL emits separate SDLK_KP_* symbols regardless
     * of NumLock state on most stacks — the user reported KP_0..9 not
     * inserting on their keyboard. Shift doesn't apply to the numpad
     * digits. KP_PERIOD/PLUS/MINUS/etc. cover the surrounding keys. */
    if (sym >= SDLK_KP_1 && sym <= SDLK_KP_9) {
        return (char) ('1' + (sym - SDLK_KP_1));
    }
    /* Punctuation table — keysym → (unshifted, shifted). */
    switch (sym) {
        case SDLK_SPACE:        return ' ';
        case SDLK_MINUS:        return shift ? '_' : '-';
        case SDLK_EQUALS:       return shift ? '+' : '=';
        case SDLK_LEFTBRACKET:  return shift ? '{' : '[';
        case SDLK_RIGHTBRACKET: return shift ? '}' : ']';
        case SDLK_BACKSLASH:    return shift ? '|' : '\\';
        case SDLK_SEMICOLON:    return shift ? ':' : ';';
        case SDLK_QUOTE:        return shift ? '"' : '\'';
        case SDLK_BACKQUOTE:    return shift ? '~' : '`';
        case SDLK_COMMA:        return shift ? '<' : ',';
        case SDLK_PERIOD:       return shift ? '>' : '.';
        case SDLK_SLASH:        return shift ? '?' : '/';
        case SDLK_KP_0:         return '0';
        case SDLK_KP_PERIOD:    return '.';
        case SDLK_KP_DIVIDE:    return '/';
        case SDLK_KP_MULTIPLY:  return '*';
        case SDLK_KP_MINUS:     return '-';
        case SDLK_KP_PLUS:      return '+';
        case SDLK_KP_EQUALS:    return '=';
        default: return 0;
    }
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

    int window_w, window_h;
    SDL_DisplayMode mode;
    if (SDL_GetCurrentDisplayMode(0, &mode) == 0
        && mode.w > 0 && mode.h > 0) {
        /* Take the kernel-reported display size verbatim so the
         * framebuffer fills the entire kandelo canvas. The earlier
         * 1280×720 clamp left the bottom of the pane letterboxed
         * whenever the canvas was taller than 720 px. */
        window_w = mode.w;
        window_h = mode.h;
        printf("sdl2: display=%dx%d\n", window_w, window_h);
    } else {
        window_w = WINDOW_FALLBACK_W;
        window_h = WINDOW_FALLBACK_H;
        printf("sdl2: display=unknown using default=%dx%d\n",
               window_w, window_h);
    }

    SDL_Window *win = SDL_CreateWindow(
        "sdl2", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
        window_w, window_h, SDL_WINDOW_OPENGL);
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

    int gl_w, gl_h;
    SDL_GL_GetDrawableSize(win, &gl_w, &gl_h);
    renderer_init(gl_w, gl_h);

    /* Resolve the startup shader source and compile it once. The
     * renderer's `recompile_user_shader` returns the same headless-vs-
     * real-failure discrimination main used to have inline. */
    char *initial_src = load_initial_shader_source();
    int initial_real_failure =
        renderer_recompile_user_shader(initial_src);
    renderer_set_error_visible(initial_real_failure ? 1 : 0);

    /* The editor takes ownership of a copy of the initial source so
     * the user can immediately type over it. We free the loader's
     * malloc'd buffer ourselves. */
    editor_init(initial_src);
    free(initial_src);

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
        renderer_shutdown();
        editor_shutdown();
        SDL_GL_DeleteContext(glctx);
        SDL_DestroyWindow(win);
        SDL_Quit();
        return 1;
    }
    SDL_PauseAudioDevice(audio, 0);

    glEnable(GL_SCISSOR_TEST);

    Uint32 start = SDL_GetTicks();
    Uint32 prev_ticks = start;
    Uint32 last_edit_ts = 0;  /* 0 = no pending edit */
    int running = 1;
    int frames = 0;
    float mouse_x_norm = 0.0f;
    float mouse_y_norm = 0.0f;

    while (running) {
        SDL_Event ev;
        SDL_PumpEvents();
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) {
                running = 0;
                continue;
            }
            if (ev.type == SDL_MOUSEMOTION) {
                int gw, gh;
                SDL_GL_GetDrawableSize(win, &gw, &gh);
                int editor_w = gw * EDITOR_NUMERATOR / EDITOR_DENOMINATOR;
                int render_w = gw - editor_w;
                if (render_w > 0 && gh > 0) {
                    float mx = (float)(ev.motion.x - editor_w) / (float) render_w;
                    float my = (float)(gh - ev.motion.y) / (float) gh;
                    if (mx < 0.0f) mx = 0.0f; else if (mx > 1.0f) mx = 1.0f;
                    if (my < 0.0f) my = 0.0f; else if (my > 1.0f) my = 1.0f;
                    mouse_x_norm = mx;
                    mouse_y_norm = my;
                }
                continue;
            }
            if (ev.type == SDL_MOUSEBUTTONDOWN
                && ev.button.button == SDL_BUTTON_LEFT) {
                int gw, gh;
                SDL_GL_GetDrawableSize(win, &gw, &gh);
                int editor_w = gw * EDITOR_NUMERATOR / EDITOR_DENOMINATOR;
                if (ev.button.x < editor_w) {
                    editor_pointer_set_cursor(ev.button.x, ev.button.y,
                                              0, 0, editor_w, gh);
                }
                continue;
            }
            if (ev.type != SDL_KEYDOWN) continue;

            SDL_Keycode sym = ev.key.keysym.sym;
            Uint16     mod = ev.key.keysym.mod;
            int        ctrl = (mod & KMOD_CTRL) != 0;

            /* Window/playground control keys first — these never feed
             * into the editor. */
            if (sym == SDLK_ESCAPE) {
                running = 0;
                continue;
            }
            if (sym == SDLK_F5) {
                reload_user_shader_from_file("F5");
                continue;
            }
            if (ctrl && sym == SDLK_s) {
                if (save_editor_to_user_path()) {
                    reload_user_shader_from_file("Ctrl+S");
                }
                continue;
            }

            /* Editor navigation. */
            switch (sym) {
                case SDLK_LEFT:      editor_move_left();      continue;
                case SDLK_RIGHT:     editor_move_right();     continue;
                case SDLK_UP:        editor_move_up();        continue;
                case SDLK_DOWN:      editor_move_down();      continue;
                case SDLK_HOME:      editor_move_home();      continue;
                case SDLK_END:       editor_move_end();       continue;
                case SDLK_PAGEUP:    editor_move_page_up(20); continue;
                case SDLK_PAGEDOWN:  editor_move_page_down(20); continue;
                case SDLK_BACKSPACE: editor_delete_back();
                                     last_edit_ts = SDL_GetTicks();
                                     continue;
                case SDLK_DELETE:    editor_delete_forward();
                                     last_edit_ts = SDL_GetTicks();
                                     continue;
                case SDLK_RETURN:
                case SDLK_KP_ENTER:
                    editor_insert_newline();
                    last_edit_ts = SDL_GetTicks();
                    continue;
                case SDLK_TAB:
                    editor_insert_tab();
                    last_edit_ts = SDL_GetTicks();
                    continue;
                default: break;
            }

            /* Ignore other Ctrl/Alt chords for now. */
            if (mod & (KMOD_CTRL | KMOD_ALT | KMOD_GUI)) continue;

            char ch = sym_to_ascii(sym, mod);
            if (ch != 0) {
                editor_insert_char(ch);
                last_edit_ts = SDL_GetTicks();
            }
        }

        /* Polled mode: only this call pulls samples through audio_cb
         * (see packages/registry/sdl2/patches/0002-polling-audio-eagain.patch). */
        SDL_PumpAudioDevices();

        SDL_GL_GetDrawableSize(win, &gl_w, &gl_h);
        renderer_set_screen_size(gl_w, gl_h);
        int editor_w = gl_w * EDITOR_NUMERATOR / EDITOR_DENOMINATOR;
        int render_w = gl_w - editor_w;

        Uint32 now = SDL_GetTicks();
        float t  = (float)(now - start) / 1000.0f;
        float dt = (float)(now - prev_ticks) / 1000.0f;
        prev_ticks = now;

        /* Debounced auto-recompile — fires once 250 ms after the last
         * keystroke. last_edit_ts == 0 means "nothing pending". */
        if (last_edit_ts != 0
            && (now - last_edit_ts) >= AUTO_RECOMPILE_DEBOUNCE_MS) {
            recompile_from_editor();
            last_edit_ts = 0;
        }

        /* Whole window: background clear (avoids flicker outside the
         * scissor regions while we swap viewports). */
        glViewport(0, 0, gl_w, gl_h);
        glScissor (0, 0, gl_w, gl_h);
        glClearColor(0.10f, 0.10f, 0.13f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);

        /* Right pane: user shader. */
        renderer_draw_user_shader(editor_w, 0, render_w, gl_h,
                                  t, dt, mouse_x_norm, mouse_y_norm,
                                  frames);
        renderer_draw_error_strip(editor_w, 0, render_w, gl_h);

        /* Left pane: editor. Scissor + viewport reset so the
         * coordinate space matches the renderer's window-pixel model. */
        glViewport(0, 0, gl_w, gl_h);
        glScissor (0, 0, editor_w, gl_h);
        editor_render(0, 0, editor_w, gl_h, now, /*has_focus=*/1);

        SDL_GL_SwapWindow(win);
        frames++;
    }

    /* Capture elapsed BEFORE SDL_Quit — SDL_QuitSubSystem(TIMER) tears
     * down the start_ts cache, so a post-Quit SDL_GetTicks() would
     * re-init from a fresh base and the subtraction would wrap. */
    Uint32 elapsed = SDL_GetTicks() - start;

    SDL_PauseAudioDevice(audio, 1);
    SDL_CloseAudioDevice(audio);
    renderer_shutdown();
    editor_shutdown();
    SDL_GL_DeleteContext(glctx);
    SDL_DestroyWindow(win);
    SDL_Quit();

    printf("sdl2: OK frames=%d elapsed=%u ms exit=esc\n",
           frames, (unsigned) elapsed);
    return 0;
}
