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
#include <dirent.h>    /* readdir for the Ctrl+L preset list */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>  /* mkdir for Ctrl+S parent-dir creation */

#include "audio.h"
#include "editor.h"
#include "renderer.h"
#include "sound_shader.h"

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
/* Phase 7 boot default: the image preset leg points at "Trailing the
 * Twinkling Tunnelwisp" (CC0, ported from shadertoy.com/view/WfcGWj).
 * plasma.frag is still staged as a loadable preset; it just isn't what
 * boots. */
static const char *PRESET_IMAGE_PATH  = "/usr/share/shaders/image/tunnelwisp.frag";

/* Phase 6 sound-shader source chain — mirror of the image chain. Phase 7
 * repoints the preset leg to the Tunnelwisp track (sine.frag stays a
 * loadable preset). */
static const char *USER_SOUND_PATH    = "/home/shaders/sound/current.frag";
static const char *PRESET_SOUND_PATH  = "/usr/share/shaders/sound/tunnelwisp.frag";

static const unsigned int AUTO_RECOMPILE_DEBOUNCE_MS = 250;

/* Lines the editor viewport moves per mouse-wheel notch. */
static const int MOUSE_WHEEL_SCROLL_LINES = 3;

/* Boot splash duration over the render pane (ms). The backdrop fades out
 * over the tail; the title persists in the render-pane corner afterward. */
static const unsigned int SPLASH_MS = 2600;

/* Editor target: F1 edits the image shader, F2 the sound shader. Only
 * one buffer lives in the editor at a time; the other is parked in
 * g_image_text / g_sound_text (main owns those strings). */
typedef enum { MODE_IMAGE = 0, MODE_SOUND = 1 } EditMode;
static EditMode g_mode       = MODE_IMAGE;
static char    *g_image_text = NULL;
static char    *g_sound_text = NULL;
static int      g_audio_rate = 48000;

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

/* Built-in sound shader — kept in sync with
 * programs/sdl2/presets/sound/sine.frag. Last-resort fallback when no
 * VFS sound preset is staged (e.g. the Node test harness). */
static const char *BUILTIN_SOUND_SRC =
    "vec2 mainSound(in float time) {\n"
    "  float v = 0.3 * sin(6.2831853 * 220.0 * time);\n"
    "  return vec2(v, v);\n"
    "}\n";

/* Phase 5: the callback renders the chip synth (audio.c) directly. Under
 * SDL_THREADS_DISABLED + the polling-audio patch this fires synchronously
 * from SDL_PumpAudioDevices() in the main loop, so there is no writer
 * thread — the synth produces samples here and also feeds the FFT
 * analysis ring that drives the iAudio uniform. Phase 6 will swap the
 * synth source for a sound-shader-fed buffer behind the same callback. */
static void audio_cb(void *user, Uint8 *stream, int len) {
    (void) user;
    audio_synth_render((Uint8 *) stream, len);
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
    src = read_text_file(PRESET_IMAGE_PATH);
    if (src) {
        printf("sdl2: shader-source=%s\n", PRESET_IMAGE_PATH);
        return src;
    }
    printf("sdl2: shader-source=builtin-plasma\n");
    return strdup(BUILTIN_PLASMA_SRC);
}

/* Sound-shader equivalent of load_initial_shader_source: user file →
 * Tunnelwisp preset → built-in sine. */
static char *load_initial_sound_source(void) {
    char *src = read_text_file(USER_SOUND_PATH);
    if (src) {
        printf("sdl2: sound-source=%s\n", USER_SOUND_PATH);
        return src;
    }
    src = read_text_file(PRESET_SOUND_PATH);
    if (src) {
        printf("sdl2: sound-source=%s\n", PRESET_SOUND_PATH);
        return src;
    }
    printf("sdl2: sound-source=builtin-sine\n");
    return strdup(BUILTIN_SOUND_SRC);
}

/* Write the editor's buffer to `path`, mkdir-ing /home/shaders and
 * `subdir` first in case the host never created them. Returns 1 on
 * success. Shared by the image (Ctrl+S in F1) and sound (F2) save paths. */
static int save_editor_to(const char *path, const char *subdir) {
    /* Best-effort directory creation. fopen below surfaces the real
     * problem if the path can't be reached; we just ensure the
     * parents exist on a fresh boot. EEXIST and similar are ignored. */
    (void) mkdir("/home/shaders", 0755);
    (void) mkdir(subdir, 0755);

    char *text = editor_dup_text();
    if (!text) {
        fprintf(stderr, "WARN: save: editor_dup_text() returned NULL\n");
        return 0;
    }
    FILE *f = fopen(path, "wb");
    if (!f) {
        fprintf(stderr, "WARN: save: fopen(%s) failed\n", path);
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
    fprintf(stderr, "WARN: save: wrote %zu bytes to %s\n", n, path);
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
        int line = renderer_last_error_line();
        editor_set_error_line(line > 0 ? line - 1 : -1);
        return;
    }
    renderer_set_error_visible(0);
    editor_set_error_line(-1);
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
    int line = real_failure ? renderer_last_error_line() : -1;
    editor_set_error_line(line > 0 ? line - 1 : -1);
    fprintf(stdout, "sdl2: editor recompile (real_failure=%d)\n",
            real_failure);
}

/* Recompile the sound shader from the editor's in-memory buffer, then
 * re-render the full multi-tile track and hand the decoded PCM to the
 * audio source. On a real compile failure keep the last-good program +
 * audio and raise the error strip. */
static void recompile_sound_from_editor(const char *trigger) {
    char *src = editor_dup_text();
    if (!src) return;
    int real_failure = sound_shader_recompile(src);
    free(src);
    renderer_set_error_visible(real_failure ? 1 : 0);
    int line = real_failure ? sound_shader_last_error_line() : -1;
    editor_set_error_line(line > 0 ? line - 1 : -1);
    if (!real_failure) {
        int frames = sound_shader_render(g_audio_rate);
        const int16_t *pcm = sound_shader_pcm(&frames);
        audio_set_sound_pcm(pcm, frames);
    }
    fprintf(stdout, "sdl2: sound recompile via %s (real_failure=%d)\n",
            trigger, real_failure);
}

/* Park the editor's current text into the slot for the active mode, then
 * load the other slot. The editor is re-initialized, so the cursor resets
 * to the top (the two slots persist text, not cursor position). main owns
 * the two parked strings; editor_init copies from them. */
static void switch_mode(EditMode target) {
    if (target == g_mode) return;
    char *cur = editor_dup_text();
    if (g_mode == MODE_IMAGE) { free(g_image_text); g_image_text = cur; }
    else                      { free(g_sound_text); g_sound_text = cur; }
    editor_shutdown();
    g_mode = target;
    const char *load = (g_mode == MODE_IMAGE) ? g_image_text : g_sound_text;
    editor_init(load ? load : "");
    fprintf(stdout, "sdl2: edit-mode=%s\n",
            g_mode == MODE_IMAGE ? "image" : "sound");

    /* Entering sound mode compiles + renders the sound buffer and makes
     * it the audio source — so the first F2 starts the sound shader even
     * before the user edits. Switching back to image leaves that audio
     * playing (the picture's iAudio keeps reacting to it). The synth is
     * the boot default until this first activation. */
    if (g_mode == MODE_SOUND) {
        recompile_sound_from_editor("F2");
    }
}

/* ----- clipboard (Ctrl+C / Ctrl+X / Ctrl+V) ---------------------- *
 *
 * Prefer the SDL clipboard so copy/paste interop with the surrounding
 * environment, but keep an in-app fallback copy: under KMSDRM the SDL
 * clipboard bridge may be a no-op, and we still want copy/paste to work
 * within the editor. */
static char *g_clip = NULL;

static void clip_copy(void) {
    char *s = editor_selection_dup();
    if (!s) return;
    SDL_SetClipboardText(s);
    free(g_clip);
    g_clip = s;  /* retain as the fallback source for paste */
}

static void clip_cut(Uint32 *edit_ts) {
    if (!editor_has_selection()) return;
    clip_copy();
    editor_delete_back();        /* removes the selection + records undo */
    if (edit_ts) *edit_ts = SDL_GetTicks();
}

static void clip_paste(Uint32 *edit_ts) {
    char *sdl_text = SDL_HasClipboardText() ? SDL_GetClipboardText() : NULL;
    const char *use = (sdl_text && *sdl_text) ? sdl_text : g_clip;
    if (use && *use) {
        editor_insert_text(use, strlen(use));
        if (edit_ts) *edit_ts = SDL_GetTicks();
    }
    if (sdl_text) SDL_free(sdl_text);
}

/* ----- preset browser (Ctrl+L cycle / Ctrl+Shift+L overlay) ------ */

#define MAX_PRESETS     32
#define PRESET_NAME_MAX 64

static char g_preset_names[MAX_PRESETS][PRESET_NAME_MAX];
static int  g_preset_count   = 0;
static int  g_preset_mode    = -1;  /* EditMode the cached list reflects */
static int  g_preset_current = -1;  /* last-loaded index, -1 = none yet */
static int  g_preset_overlay = 0;   /* list overlay open */
static int  g_preset_sel     = 0;   /* highlighted row in the overlay */

static const char *preset_dir(EditMode m) {
    return (m == MODE_IMAGE) ? "/usr/share/shaders/image"
                             : "/usr/share/shaders/sound";
}

/* Rebuild the cached preset list for `m` from its VFS directory: *.frag
 * basenames, sorted, capped at MAX_PRESETS. Cached per-mode so repeated
 * Ctrl+L doesn't re-scan. */
static void preset_refresh(EditMode m) {
    if (g_preset_mode == (int) m && g_preset_count > 0) return;
    g_preset_count = 0;
    g_preset_mode  = (int) m;
    DIR *d = opendir(preset_dir(m));
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d)) != NULL && g_preset_count < MAX_PRESETS) {
        const char *n = e->d_name;
        size_t len = strlen(n);
        if (len < 6 || len >= PRESET_NAME_MAX) continue;
        if (strcmp(n + len - 5, ".frag") != 0) continue;
        strcpy(g_preset_names[g_preset_count++], n);
    }
    closedir(d);
    /* Insertion sort by name — the list is tiny. */
    for (int i = 1; i < g_preset_count; i++) {
        char tmp[PRESET_NAME_MAX];
        strcpy(tmp, g_preset_names[i]);
        int j = i - 1;
        while (j >= 0 && strcmp(g_preset_names[j], tmp) > 0) {
            strcpy(g_preset_names[j + 1], g_preset_names[j]);
            j--;
        }
        strcpy(g_preset_names[j + 1], tmp);
    }
}

/* Load preset `idx` into the editor as one undo step and recompile the
 * active pipeline. */
static void preset_load(int idx, Uint32 *edit_ts) {
    if (idx < 0 || idx >= g_preset_count) return;
    char path[256];
    snprintf(path, sizeof path, "%s/%s",
             preset_dir(g_mode), g_preset_names[idx]);
    char *text = read_text_file(path);
    if (!text) {
        fprintf(stderr, "WARN: preset: %s not readable\n", path);
        return;
    }
    editor_replace_all(text);
    free(text);
    g_preset_current = idx;
    if (g_mode == MODE_IMAGE) recompile_from_editor();
    else                      recompile_sound_from_editor("preset");
    if (edit_ts) *edit_ts = 0;  /* compiled now — cancel any pending debounce */
    fprintf(stdout, "sdl2: preset load=%s\n", g_preset_names[idx]);
}

static void preset_cycle(Uint32 *edit_ts) {
    preset_refresh(g_mode);
    if (g_preset_count == 0) { fprintf(stdout, "sdl2: preset list empty\n"); return; }
    preset_load((g_preset_current + 1) % g_preset_count, edit_ts);
}

static void preset_overlay_open(void) {
    preset_refresh(g_mode);
    if (g_preset_count == 0) { fprintf(stdout, "sdl2: preset list empty\n"); return; }
    g_preset_overlay = 1;
    g_preset_sel = g_preset_current >= 0 ? g_preset_current : 0;
}

/* Draw the centered preset list over the editor pane (pane_w × pane_h).
 * No-op when the overlay is closed. */
static void preset_overlay_render(int pane_w, int pane_h) {
    if (!g_preset_overlay) return;
    int line_h = renderer_text_line_height();
    int adv    = renderer_text_advance();
    if (line_h <= 0 || adv <= 0) return;

    int panel_w = 360;
    if (panel_w > pane_w - 40) panel_w = pane_w - 40;
    int panel_h = line_h * (g_preset_count + 1) + 16;
    int px = (pane_w - panel_w) / 2;
    int py = (pane_h - panel_h) / 2;
    if (px < 0) px = 0;
    if (py < 0) py = 0;

    renderer_fill_rect(0, 0, pane_w, pane_h, 0.0f, 0.0f, 0.0f, 0.45f);
    renderer_fill_rect(px, py, panel_w, panel_h, 0.12f, 0.12f, 0.16f, 0.98f);

    int ty = py + 8;
    renderer_draw_textz(px + 10, ty,
                        g_mode == MODE_IMAGE ? "Load image preset"
                                             : "Load sound preset",
                        0.85f, 0.85f, 0.55f);
    ty += line_h;
    for (int i = 0; i < g_preset_count; i++) {
        if (i == g_preset_sel) {
            renderer_fill_rect(px + 4, ty, panel_w - 8, line_h,
                               0.27f, 0.28f, 0.35f, 0.95f);
        }
        renderer_draw_textz(px + 10, ty, g_preset_names[i],
                            0.92f, 0.92f, 0.94f);
        ty += line_h;
    }
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
     * the user can immediately type over it. We also park a copy as the
     * image slot so switching away and back (F1/F2) restores it. We free
     * the loader's malloc'd buffer ourselves. */
    g_image_text = strdup(initial_src);
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
    /* Initialize the synth against what the device actually granted (the
     * driver may have changed freq/channels from `want`) so the sample
     * rate the pattern timing uses matches the playback rate. */
    g_audio_rate = have.freq;
    audio_synth_init(have.freq, have.channels);

    /* Phase 6: stand up the sound-shader pipeline and compile the
     * resolved sound source. Phase 7 makes the Tunnelwisp track the
     * boot default: we render it and hand the decoded PCM to the audio
     * source immediately, instead of waiting for the first F2. On the
     * headless Node harness glReadPixels is a no-op, so sound_shader_render
     * reports 0 audible frames and audio_set_sound_pcm falls back to the
     * chip synth — real GL (the browser) plays the rendered track on boot. */
    sound_shader_init();
    g_sound_text = load_initial_sound_source();
    if (sound_shader_recompile(g_sound_text) == 0) {
        int boot_frames = sound_shader_render(g_audio_rate);
        const int16_t *boot_pcm = sound_shader_pcm(&boot_frames);
        audio_set_sound_pcm(boot_pcm, boot_frames);
        fprintf(stdout, "sdl2: boot sound render frames=%d\n", boot_frames);
    } else {
        /* Real compile failure of the boot sound shader: the synth stays
         * the audio source. Log it so a silent fall-through to the chip
         * synth is diagnosable rather than mistaken for "no sound shader". */
        fprintf(stdout, "sdl2: boot sound recompile FAILED — synth fallback: %s\n",
                sound_shader_last_error());
    }

    SDL_PauseAudioDevice(audio, 0);

    glEnable(GL_SCISSOR_TEST);

    Uint32 start = SDL_GetTicks();
    Uint32 prev_ticks = start;
    Uint32 last_edit_ts = 0;  /* 0 = no pending edit */
    int running = 1;
    int frames = 0;
    int spectrum_logged = 0;
    float mouse_x_norm = 0.0f;
    float mouse_y_norm = 0.0f;
    int last_mouse_x = 0;  /* window-pixel x, for wheel pane hit-test */
    int dragging = 0;      /* left button held in the editor pane → drag-select */

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
                last_mouse_x = ev.motion.x;
                if (render_w > 0 && gh > 0) {
                    float mx = (float)(ev.motion.x - editor_w) / (float) render_w;
                    float my = (float)(gh - ev.motion.y) / (float) gh;
                    if (mx < 0.0f) mx = 0.0f; else if (mx > 1.0f) mx = 1.0f;
                    if (my < 0.0f) my = 0.0f; else if (my > 1.0f) my = 1.0f;
                    mouse_x_norm = mx;
                    mouse_y_norm = my;
                }
                /* Drag-select: extend the selection to the pointer while
                 * the left button is held over the editor pane. */
                if (dragging && (ev.motion.state & SDL_BUTTON_LMASK)) {
                    editor_pointer_extend_select(ev.motion.x, ev.motion.y,
                                                 0, 0, editor_w, gh);
                }
                continue;
            }
            if (ev.type == SDL_MOUSEWHEEL) {
                /* Scroll the editor only when the pointer is over the
                 * editor pane (left). SDL gives wheel.y > 0 for scroll-up
                 * (away from the user) → move the viewport toward the top
                 * of the file (negative line delta). FLIPPED inverts it. */
                int gw, gh;
                SDL_GL_GetDrawableSize(win, &gw, &gh);
                int editor_w = gw * EDITOR_NUMERATOR / EDITOR_DENOMINATOR;
                if (last_mouse_x < editor_w) {
                    int dir = (ev.wheel.direction == SDL_MOUSEWHEEL_FLIPPED)
                                  ? -1 : 1;
                    int notches = ev.wheel.y * dir;
                    editor_scroll(-notches * MOUSE_WHEEL_SCROLL_LINES);
                    fprintf(stdout, "sdl2: editor scroll wheel=%d\n", notches);
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
                    dragging = 1;  /* begin a potential drag-selection */
                }
                continue;
            }
            if (ev.type == SDL_MOUSEBUTTONUP
                && ev.button.button == SDL_BUTTON_LEFT) {
                dragging = 0;
                continue;
            }
            if (ev.type != SDL_KEYDOWN) continue;

            SDL_Keycode sym = ev.key.keysym.sym;
            Uint16     mod = ev.key.keysym.mod;
            int        ctrl  = (mod & KMOD_CTRL) != 0;
            int        shift = (mod & KMOD_SHIFT) != 0;

            /* Preset overlay is modal: while open it swallows keys (arrows
             * choose, Enter loads, Esc closes) and never reaches the editor
             * or the ESC-quit path. */
            if (g_preset_overlay) {
                if (sym == SDLK_UP) {
                    g_preset_sel = (g_preset_sel - 1 + g_preset_count)
                                   % g_preset_count;
                } else if (sym == SDLK_DOWN) {
                    g_preset_sel = (g_preset_sel + 1) % g_preset_count;
                } else if (sym == SDLK_RETURN || sym == SDLK_KP_ENTER) {
                    preset_load(g_preset_sel, &last_edit_ts);
                    g_preset_overlay = 0;
                } else if (sym == SDLK_ESCAPE) {
                    g_preset_overlay = 0;
                }
                continue;
            }

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
            /* F1 / F2 switch the editor between the image and sound
             * shaders; Ctrl+1 / Ctrl+2 are equivalents for keyboards where
             * the function row is hijacked by the OS (e.g. a MacBook's
             * F1/F2 are brightness keys without Fn). Entering sound mode
             * activates the sound shader as the audio source (switch_mode). */
            if (sym == SDLK_F1 || (ctrl && sym == SDLK_1)) {
                switch_mode(MODE_IMAGE);
                last_edit_ts = 0;
                continue;
            }
            if (sym == SDLK_F2 || (ctrl && sym == SDLK_2)) {
                switch_mode(MODE_SOUND);
                last_edit_ts = 0;
                continue;
            }
            if (ctrl && sym == SDLK_s) {
                if (g_mode == MODE_IMAGE) {
                    if (save_editor_to(USER_CURRENT_PATH,
                                       "/home/shaders/image")) {
                        reload_user_shader_from_file("Ctrl+S");
                    }
                } else {
                    if (save_editor_to(USER_SOUND_PATH,
                                       "/home/shaders/sound")) {
                        recompile_sound_from_editor("Ctrl+S");
                    }
                }
                continue;
            }
            if (ctrl && sym == SDLK_m) {
                int muted = !audio_muted();
                audio_set_muted(muted);
                fprintf(stdout, "sdl2: audio %s\n",
                        muted ? "muted" : "unmuted");
                continue;
            }
            /* Preset browser: Ctrl+L cycles to the next preset for the
             * active mode; Ctrl+Shift+L opens the chooser overlay. */
            if (ctrl && sym == SDLK_l) {
                if (shift) preset_overlay_open();
                else       preset_cycle(&last_edit_ts);
                continue;
            }
            /* Clipboard + undo/redo + select-all. */
            if (ctrl && sym == SDLK_c) { clip_copy();            continue; }
            if (ctrl && sym == SDLK_x) { clip_cut(&last_edit_ts);  continue; }
            if (ctrl && sym == SDLK_v) { clip_paste(&last_edit_ts); continue; }
            if (ctrl && sym == SDLK_a) { editor_select_all();     continue; }
            if (ctrl && sym == SDLK_z) {
                editor_undo();
                last_edit_ts = SDL_GetTicks();  /* re-sync the preview */
                continue;
            }
            if (ctrl && sym == SDLK_y) {
                editor_redo();
                last_edit_ts = SDL_GetTicks();
                continue;
            }

            /* Shift + a navigation key extends the selection; the same key
             * without Shift drops it. Applied before the move runs. */
            switch (sym) {
                case SDLK_LEFT: case SDLK_RIGHT: case SDLK_UP: case SDLK_DOWN:
                case SDLK_HOME: case SDLK_END:
                case SDLK_PAGEUP: case SDLK_PAGEDOWN:
                    if (shift) editor_selection_begin();
                    else       editor_selection_clear();
                    break;
                default: break;
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
            if (g_mode == MODE_IMAGE) recompile_from_editor();
            else                      recompile_sound_from_editor("auto");
            last_edit_ts = 0;
        }

        /* Whole window: background clear (avoids flicker outside the
         * scissor regions while we swap viewports). */
        glViewport(0, 0, gl_w, gl_h);
        glScissor (0, 0, gl_w, gl_h);
        glClearColor(0.10f, 0.10f, 0.13f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);

        /* Update the iAudio FFT texture from the latest synth output.
         * Computed every frame regardless of whether the audio callback
         * pulled samples this tick — on a silent ring the bins are simply
         * zero, so the upload path (and the iAudio binding) still runs
         * under the headless Node harness. */
        unsigned char spectrum[AUDIO_SPECTRUM_BINS];
        audio_compute_spectrum(spectrum);
        renderer_set_audio_spectrum(spectrum, AUDIO_SPECTRUM_BINS);
        if (!spectrum_logged) {
            printf("sdl2: audio spectrum uploaded bins=%d\n",
                   AUDIO_SPECTRUM_BINS);
            spectrum_logged = 1;
        }

        /* Right pane: user shader. */
        renderer_draw_user_shader(editor_w, 0, render_w, gl_h,
                                  t, dt, mouse_x_norm, mouse_y_norm,
                                  frames);
        renderer_draw_error_strip(editor_w, 0, render_w, gl_h);

        /* Render-pane chrome: a persistent title in the corner, plus a
         * boot splash that fades out. Scissor to the render pane so the
         * text isn't clipped by the editor pass that follows. */
        {
            glViewport(0, 0, gl_w, gl_h);
            glScissor (editor_w, 0, render_w, gl_h);
            int lh  = renderer_text_line_height();
            int adv = renderer_text_advance();
            const char *title = "SDL2 GLSL Playground";
            renderer_draw_textz(editor_w + 10, gl_h - lh - 8, title,
                                0.72f, 0.76f, 0.86f);

            unsigned int age = now - start;
            if (age < SPLASH_MS && adv > 0) {
                /* Backdrop holds, then fades over the final ~40%. */
                float frac = (float) age / (float) SPLASH_MS;
                float a = frac < 0.6f ? 0.6f : 0.6f * (1.0f - (frac - 0.6f) / 0.4f);
                if (a < 0.0f) a = 0.0f;
                renderer_fill_rect(editor_w, 0, render_w, gl_h,
                                   0.05f, 0.05f, 0.08f, a);
                const char *hint = "F1 image | F2 sound | Ctrl+L presets | ESC quit";
                int tx = editor_w + (render_w - (int) strlen(title) * adv) / 2;
                int hx = editor_w + (render_w - (int) strlen(hint) * adv) / 2;
                if (tx < editor_w) tx = editor_w;
                if (hx < editor_w) hx = editor_w;
                int cy = gl_h / 2;
                renderer_draw_textz(tx, cy - lh, title, 0.93f, 0.93f, 0.78f);
                renderer_draw_textz(hx, cy + 6, hint, 0.78f, 0.81f, 0.85f);
            }
        }

        /* Left pane: editor. Scissor + viewport reset so the
         * coordinate space matches the renderer's window-pixel model. */
        glViewport(0, 0, gl_w, gl_h);
        glScissor (0, 0, editor_w, gl_h);
        editor_render(0, 0, editor_w, gl_h, now, /*has_focus=*/1);

        /* Mode badge in the top-right of the editor pane: the shader being
         * edited + the key to switch to the other (Ctrl+1/Ctrl+2, which
         * also work as F1/F2). Drawn over the editor after its own pass so
         * it sits on top of the gutter/text. */
        {
            const char *badge = (g_mode == MODE_IMAGE)
                ? "image  [Ctrl+2: sound]"
                : "sound  [Ctrl+1: image]";
            int adv = renderer_text_advance();
            int badge_px = (int) strlen(badge) * adv;
            int bx = editor_w - badge_px - 10;
            if (bx < 0) bx = 0;
            renderer_draw_textz(bx, 6, badge, 0.75f, 0.80f, 0.55f);
        }

        /* Preset chooser overlay (Ctrl+Shift+L) — drawn last, over the
         * editor pane, still under the editor-pane scissor. */
        preset_overlay_render(editor_w, gl_h);

        SDL_GL_SwapWindow(win);
        frames++;
    }

    /* Capture elapsed BEFORE SDL_Quit — SDL_QuitSubSystem(TIMER) tears
     * down the start_ts cache, so a post-Quit SDL_GetTicks() would
     * re-init from a fresh base and the subtraction would wrap. */
    Uint32 elapsed = SDL_GetTicks() - start;

    SDL_PauseAudioDevice(audio, 1);
    SDL_CloseAudioDevice(audio);
    sound_shader_shutdown();
    renderer_shutdown();
    editor_shutdown();
    free(g_image_text);
    free(g_sound_text);
    free(g_clip);
    SDL_GL_DeleteContext(glctx);
    SDL_DestroyWindow(win);
    SDL_Quit();

    printf("sdl2: OK frames=%d elapsed=%u ms exit=esc\n",
           frames, (unsigned) elapsed);
    return 0;
}
