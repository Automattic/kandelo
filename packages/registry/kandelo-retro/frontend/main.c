/*
 * kandelo-retro: a minimal libretro frontend for Kandelo.
 *
 * Drives a statically-linked libretro core and maps its three outputs onto
 * Kandelo's raw Linux device contracts, exactly as fbDOOM does:
 *
 *   video  -> /dev/fb0        (640x400 BGRA32 mmap; host RAF loop presents it)
 *   audio  -> /dev/dsp        (OSS PCM sink, S16_LE stereo -> Web Audio)
 *   input  -> stdin           (Linux MEDIUMRAW keycodes -> RETRO_DEVICE_JOYPAD)
 *
 * The core is single-threaded: retro_run() emulates one whole frame on the
 * calling thread. The frontend uses no threads, no SDL and no GL; pixel
 * conversion and frame pacing happen here.
 *
 * Usage: kandelo-retro <rom-path> [--state <state-path>]
 *
 * SIGUSR1 (or F5) writes a save state to /tmp/kandelo-retro.state; see the
 * save-request protocol below.
 */

#define _DEFAULT_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdarg.h>
#include <ctype.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <linux/fb.h>

#include "libretro.h"

/* ---- Framebuffer (matches crates/kernel/src/syscalls.rs FB_* constants) ---- */
#define FB_W        640
#define FB_H        400
#define FB_BPP      4
#define FB_STRIDE   (FB_W * FB_BPP)      /* 2560 */
#define FB_SMEM_LEN (FB_STRIDE * FB_H)   /* 1,024,000 */

static uint8_t *g_fb = NULL;             /* mmap of /dev/fb0 (BGRA32) */
static int      g_fb_fd = -1;

/* ---- OSS /dev/dsp (hardcoded ioctl numbers; kernel audio.rs contract). ----
 * We deliberately avoid <sys/soundcard.h> and use the same magic numbers the
 * fbDOOM sound patch uses, which the Kandelo kernel recognizes. */
#define SNDCTL_DSP_SPEED  0xc0045002u
#define SNDCTL_DSP_STEREO 0xc0045003u
#define SNDCTL_DSP_SETFMT 0xc0045005u
#define AFMT_S16_LE       0x10

static int g_dsp_fd = -1;

/* ---- libretro state ---- */
static enum retro_pixel_format g_pixfmt = RETRO_PIXEL_FORMAT_0RGB1555; /* default */
static struct retro_system_av_info g_av;
static bool g_have_av = false;

/* Keyboard: held state indexed by 7-bit Linux keycode, plus a latch for
 * each key pressed since the core last ran. The core samples input once per
 * frame, so a press and its release that both arrive between two frames
 * would otherwise cancel out before the core ever saw the key: a quick tap
 * (and every tap on the touch controls) would do nothing. A latched key
 * reads as pressed for the next frame, then the latch clears. */
static uint8_t g_keystate[128];
static uint8_t g_keylatch[128];

/* A save is requested by SIGUSR1 (or F5 at the keyboard) and performed after
 * the current retro_run() completes. The requester first writes a fresh
 * 16-byte nonce to SAVE_REQUEST_PATH, and treats the snapshot as its own only
 * once SAVE_DONE_PATH holds that same nonce: the state file is renamed into
 * place before the marker, so a matching marker proves a complete state newer
 * than the request. /usr/local/bin/retro-checkpoint is the normal requester;
 * it finds this process through PID_PATH. */
#define KEY_F5            63
#define PID_PATH          "/tmp/kandelo-retro.pid"
#define SAVE_STATE_PATH   "/tmp/kandelo-retro.state"
#define SAVE_STATE_TMP    "/tmp/kandelo-retro.state.tmp"
#define SAVE_REQUEST_PATH "/tmp/kandelo-retro.request"
#define SAVE_DONE_PATH    "/tmp/kandelo-retro.complete"
#define SAVE_DONE_TMP     "/tmp/kandelo-retro.complete.tmp"
#define SAVE_REQUEST_SIZE 16u
#define MAX_STATE_BYTES   (2u * 1024u * 1024u)
static volatile sig_atomic_t g_save_requested = 0;

static void on_save_signal(int signo)
{
    (void)signo;
    g_save_requested = 1;
}

/* Extended game info handed to the core via GET_GAME_INFO_EXT. Providing the
 * ROM as an in-memory buffer lets the core skip its own file I/O (FCEUmm's
 * default need_fullpath path), which is both the recommended libretro behavior
 * and avoids driving the core's filestream through the guest VFS. */
static struct retro_game_info_ext g_info_ext;
static bool g_have_info_ext = false;
static char g_ge_dir[1024], g_ge_name[256], g_ge_ext[64];

static void setup_info_ext(const char *path, const void *data, size_t size)
{
    const char *slash = strrchr(path, '/');
    if (slash == path) {
        g_ge_dir[0] = '/'; g_ge_dir[1] = '\0';
    } else if (slash) {
        size_t dl = (size_t)(slash - path);
        if (dl >= sizeof g_ge_dir) dl = sizeof g_ge_dir - 1;
        memcpy(g_ge_dir, path, dl); g_ge_dir[dl] = '\0';
    } else {
        g_ge_dir[0] = '.'; g_ge_dir[1] = '\0';
    }

    const char *base = slash ? slash + 1 : path;
    const char *dot  = strrchr(base, '.');
    size_t nl = dot ? (size_t)(dot - base) : strlen(base);
    if (nl >= sizeof g_ge_name) nl = sizeof g_ge_name - 1;
    memcpy(g_ge_name, base, nl); g_ge_name[nl] = '\0';

    g_ge_ext[0] = '\0';
    if (dot && dot[1]) {
        size_t i = 0;
        for (; dot[1 + i] && i < sizeof g_ge_ext - 1; i++)
            g_ge_ext[i] = (char)tolower((unsigned char)dot[1 + i]);
        g_ge_ext[i] = '\0';
    }

    memset(&g_info_ext, 0, sizeof g_info_ext);
    g_info_ext.full_path       = path;
    g_info_ext.dir             = g_ge_dir;
    g_info_ext.name            = g_ge_name;
    g_info_ext.ext             = g_ge_ext;
    g_info_ext.data            = data;
    g_info_ext.size            = size;
    g_info_ext.file_in_archive = false;
    g_info_ext.persistent_data = true;   /* we never free the ROM buffer */
    g_have_info_ext = true;
}

/* Last presented geometry, so we only clear borders on change. */
/* Last presented output rectangle (post-scale), to clear borders only on change. */
static unsigned g_last_w = 0, g_last_h = 0;

/* ---------------------------------------------------------------------------
 * Device setup
 * ------------------------------------------------------------------------- */

static int fb_open(void)
{
    g_fb_fd = open("/dev/fb0", O_RDWR);
    if (g_fb_fd < 0) { perror("open /dev/fb0"); return -1; }

    struct fb_var_screeninfo vinfo;
    struct fb_fix_screeninfo finfo;
    if (ioctl(g_fb_fd, FBIOGET_VSCREENINFO, &vinfo) < 0) { perror("FBIOGET_VSCREENINFO"); return -1; }
    if (ioctl(g_fb_fd, FBIOGET_FSCREENINFO, &finfo) < 0) { perror("FBIOGET_FSCREENINFO"); return -1; }

    fprintf(stderr, "[retro] fb %ux%u %ubpp stride=%u smem=%u\n",
            vinfo.xres, vinfo.yres, vinfo.bits_per_pixel, finfo.line_length, finfo.smem_len);

    /* Kernel pins 640x400x32; mmap must request exactly smem_len. */
    g_fb = mmap(NULL, FB_SMEM_LEN, PROT_READ | PROT_WRITE, MAP_SHARED, g_fb_fd, 0);
    if (g_fb == MAP_FAILED) { perror("mmap /dev/fb0"); g_fb = NULL; return -1; }
    memset(g_fb, 0, FB_SMEM_LEN);
    return 0;
}

static void dsp_open(double sample_rate)
{
    g_dsp_fd = open("/dev/dsp", O_WRONLY | O_NONBLOCK);
    if (g_dsp_fd < 0) { perror("open /dev/dsp (continuing muted)"); return; }

    int speed  = (int)(sample_rate + 0.5);
    int stereo = 1;
    int fmt    = AFMT_S16_LE;
    if (ioctl(g_dsp_fd, SNDCTL_DSP_SETFMT, &fmt) < 0 ||
        ioctl(g_dsp_fd, SNDCTL_DSP_STEREO, &stereo) < 0 ||
        ioctl(g_dsp_fd, SNDCTL_DSP_SPEED, &speed) < 0) {
        perror("dsp ioctl (continuing muted)");
        close(g_dsp_fd);
        g_dsp_fd = -1;
        return;
    }
    fprintf(stderr, "[retro] dsp S16_LE stereo %d Hz\n", speed);
}

/* Raw, non-blocking stdin so injected MEDIUMRAW keycode bytes arrive
 * immediately and reads never block the emulation loop. */
static void input_open(void)
{
    struct termios t;
    if (tcgetattr(STDIN_FILENO, &t) == 0) {
        t.c_lflag &= ~(ICANON | ECHO | ISIG);
        t.c_iflag &= ~(IXON | ICRNL);
        t.c_cc[VMIN]  = 0;
        t.c_cc[VTIME] = 0;
        tcsetattr(STDIN_FILENO, TCSANOW, &t);
    }
    int fl = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (fl >= 0) fcntl(STDIN_FILENO, F_SETFL, fl | O_NONBLOCK);
}

static void input_drain(void)
{
    uint8_t buf[64];
    ssize_t n;
    while ((n = read(STDIN_FILENO, buf, sizeof buf)) > 0) {
        for (ssize_t i = 0; i < n; i++) {
            uint8_t b  = buf[i];
            uint8_t kc = b & 0x7f;
            if (kc == KEY_F5) {
                bool pressed = !(b & 0x80);
                if (pressed && !g_keystate[kc]) g_save_requested = 1;
                g_keystate[kc] = pressed ? 1 : 0;
                continue;
            }
            if (b & 0x80) {                          /* bit7 set => release */
                g_keystate[kc] = 0;
            } else {
                g_keystate[kc] = 1;
                g_keylatch[kc] = 1;
            }
        }
    }
}

/* ---------------------------------------------------------------------------
 * Video: convert core frame -> 640x400 BGRA32, integer-scaled and centered.
 * ------------------------------------------------------------------------- */

static inline uint32_t conv_pixel(const void *src, unsigned i)
{
    /* Returns a little-endian BGRA word: byte0=B,1=G,2=R,3=A. The host forces
     * alpha to 0xff, so we leave A=0. */
    switch (g_pixfmt) {
    case RETRO_PIXEL_FORMAT_XRGB8888: {
        /* src word is 0x00RRGGBB -> memory bytes B,G,R,00 == our dest layout. */
        return ((const uint32_t *)src)[i];
    }
    case RETRO_PIXEL_FORMAT_RGB565: {
        uint16_t p = ((const uint16_t *)src)[i];
        uint32_t r = (p >> 11) & 0x1f, g = (p >> 5) & 0x3f, b = p & 0x1f;
        r = (r << 3) | (r >> 2);
        g = (g << 2) | (g >> 4);
        b = (b << 3) | (b >> 2);
        return b | (g << 8) | (r << 16);
    }
    case RETRO_PIXEL_FORMAT_0RGB1555:
    default: {
        uint16_t p = ((const uint16_t *)src)[i];
        uint32_t r = (p >> 10) & 0x1f, g = (p >> 5) & 0x1f, b = p & 0x1f;
        r = (r << 3) | (r >> 2);
        g = (g << 3) | (g >> 2);
        b = (b << 3) | (b >> 2);
        return b | (g << 8) | (r << 16);
    }
    }
}

static void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch)
{
    if (!g_fb || !data || width == 0 || height == 0) return;

    /* Aspect-preserving scale-to-fit within the 640x400 framebuffer: fill the
     * limiting dimension and center on the other (letterbox / pillarbox), so
     * the game fills the pane like fbDOOM's 2x fill rather than sitting small
     * and centered. Integer math only; nearest-neighbor sampling.
     *
     * Pick the limiting axis by comparing width/height against FB_W/FB_H
     * without division: width*FB_H <= height*FB_W  =>  height is the limit. */
    unsigned out_w, out_h;
    if ((unsigned long long)width * FB_H <= (unsigned long long)height * FB_W) {
        out_h = FB_H;
        out_w = (unsigned)((unsigned long long)width * FB_H / height);
    } else {
        out_w = FB_W;
        out_h = (unsigned)((unsigned long long)height * FB_W / width);
    }
    if (out_w == 0) out_w = 1;
    if (out_h == 0) out_h = 1;
    if (out_w > FB_W) out_w = FB_W;
    if (out_h > FB_H) out_h = FB_H;
    unsigned x0 = (FB_W - out_w) / 2, y0 = (FB_H - out_h) / 2;

    /* Clear the borders once when the output rectangle changes (e.g. the core
     * switches resolution), not every frame. */
    if (out_w != g_last_w || out_h != g_last_h) {
        memset(g_fb, 0, FB_SMEM_LEN);
        g_last_w = out_w; g_last_h = out_h;
    }

    /* Precompute the source column for each destination column (nearest). */
    unsigned xmap[FB_W];
    for (unsigned dx = 0; dx < out_w; dx++)
        xmap[dx] = dx * width / out_w;

    const uint8_t *base = (const uint8_t *)data;
    for (unsigned dy = 0; dy < out_h; dy++) {
        unsigned sy = dy * height / out_h;
        const uint8_t *srow = base + (size_t)sy * pitch;
        uint32_t *drow = (uint32_t *)(g_fb + (y0 + dy) * FB_STRIDE) + x0;
        for (unsigned dx = 0; dx < out_w; dx++)
            drow[dx] = conv_pixel(srow, xmap[dx]);
    }
}

/* ---------------------------------------------------------------------------
 * Audio
 * ------------------------------------------------------------------------- */

/* Audio normally paces the emulator: a write waits for room in the device's
 * short queue, which keeps the core in step with the sound card's clock.
 *
 * That only works while something is draining the queue. A device that is
 * open but not playing (in a browser, audio stays suspended until the user
 * interacts with the page) never makes room, and a blocking write would then
 * freeze the emulator on its first frame. So the wait is bounded: if no room
 * appears for DSP_STALL_MS the sink is treated as stalled, and samples are
 * dropped instead of waited for until a write gets through again. Video and
 * input keep running either way.
 *
 * Samples are S16 stereo, 4 bytes a frame, and the device's byte stream has
 * no frame markers. Dropping must therefore never leave half a frame written:
 * the unwritten tail of a split frame is carried over and sent first. */
#define DSP_FRAME_BYTES 4u
#define DSP_STALL_MS    100

static bool    g_dsp_stalled = false;
static uint8_t g_dsp_carry[DSP_FRAME_BYTES];
static size_t  g_dsp_carry_len = 0;

static void dsp_disable(const char *what)
{
    perror(what);
    fprintf(stderr, "[retro] audio disabled\n");
    close(g_dsp_fd);
    g_dsp_fd = -1;
}

/* Write as much of [data, data+len) as the device takes. Returns the number
 * of bytes written; stops early only when the sink is stalled. */
static size_t dsp_write_some(const uint8_t *data, size_t len)
{
    size_t done = 0;
    while (done < len && g_dsp_fd >= 0) {
        ssize_t n = write(g_dsp_fd, data + done, len - done);
        if (n > 0) {
            done += (size_t)n;
            if (g_dsp_stalled) {
                g_dsp_stalled = false;
                fprintf(stderr, "[retro] audio sink is playing again\n");
            }
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && errno != EAGAIN) { dsp_disable("write /dev/dsp"); break; }
        if (g_dsp_stalled) break;

        struct pollfd pfd = { .fd = g_dsp_fd, .events = POLLOUT };
        int ready = poll(&pfd, 1, DSP_STALL_MS);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0) { dsp_disable("poll /dev/dsp"); break; }
        if (ready == 0) {
            g_dsp_stalled = true;
            fprintf(stderr, "[retro] audio sink is not playing; "
                            "dropping samples until it resumes\n");
            break;
        }
    }
    return done;
}

static void dsp_write_frames(const void *samples, size_t len)
{
    const uint8_t *data = samples;
    if (g_dsp_fd < 0) return;

    if (g_dsp_carry_len > 0) {
        size_t sent = dsp_write_some(g_dsp_carry, g_dsp_carry_len);
        memmove(g_dsp_carry, g_dsp_carry + sent, g_dsp_carry_len - sent);
        g_dsp_carry_len -= sent;
        if (g_dsp_carry_len > 0) return;  /* still stalled: drop this batch */
    }

    size_t done = dsp_write_some(data, len);
    size_t split = done % DSP_FRAME_BYTES;
    if (done < len && split != 0 && g_dsp_fd >= 0) {
        g_dsp_carry_len = DSP_FRAME_BYTES - split;
        memcpy(g_dsp_carry, data + done, g_dsp_carry_len);
    }
}

static void audio_sample(int16_t left, int16_t right)
{
    int16_t frame[2] = { left, right };
    dsp_write_frames(frame, sizeof frame);
}

static size_t audio_sample_batch(const int16_t *data, size_t frames)
{
    dsp_write_frames(data, frames * 2 * sizeof(int16_t));
    return frames;
}

/* ---------------------------------------------------------------------------
 * Input callbacks
 * ------------------------------------------------------------------------- */

static void input_poll(void) { input_drain(); }

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id)
{
    (void)index;
    if (port != 0 || device != RETRO_DEVICE_JOYPAD) return 0;

    /* RETRO_DEVICE_ID_JOYPAD_* -> Linux 7-bit keycode (browser-controls.ts map). */
    static const int8_t map[16] = {
        [RETRO_DEVICE_ID_JOYPAD_B]      = 44,  /* Z */
        [RETRO_DEVICE_ID_JOYPAD_Y]      = 30,  /* A */
        [RETRO_DEVICE_ID_JOYPAD_SELECT] = 54,  /* RightShift */
        [RETRO_DEVICE_ID_JOYPAD_START]  = 28,  /* Enter */
        [RETRO_DEVICE_ID_JOYPAD_UP]     = 103, /* ArrowUp */
        [RETRO_DEVICE_ID_JOYPAD_DOWN]   = 108, /* ArrowDown */
        [RETRO_DEVICE_ID_JOYPAD_LEFT]   = 105, /* ArrowLeft */
        [RETRO_DEVICE_ID_JOYPAD_RIGHT]  = 106, /* ArrowRight */
        [RETRO_DEVICE_ID_JOYPAD_A]      = 45,  /* X */
        [RETRO_DEVICE_ID_JOYPAD_X]      = 31,  /* S */
        [RETRO_DEVICE_ID_JOYPAD_L]      = 16,  /* Q */
        [RETRO_DEVICE_ID_JOYPAD_R]      = 17,  /* W */
    };
    if (id >= 16) return 0;
    int8_t kc = map[id];
    if (kc <= 0) return 0;
    return (g_keystate[(uint8_t)kc] || g_keylatch[(uint8_t)kc]) ? 1 : 0;
}

/* ---------------------------------------------------------------------------
 * Environment
 * ------------------------------------------------------------------------- */

static void core_log(enum retro_log_level level, const char *fmt, ...)
{
    (void)level;
    va_list ap; va_start(ap, fmt);
    fprintf(stderr, "[core] ");
    vfprintf(stderr, fmt, ap);
    va_end(ap);
}

static bool environ_cb(unsigned cmd, void *data)
{
    switch (cmd) {
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
        if (data) *(bool *)data = true;
        return true;

    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
        enum retro_pixel_format fmt = *(const enum retro_pixel_format *)data;
        if (fmt != RETRO_PIXEL_FORMAT_0RGB1555 &&
            fmt != RETRO_PIXEL_FORMAT_XRGB8888 &&
            fmt != RETRO_PIXEL_FORMAT_RGB565)
            return false;
        g_pixfmt = fmt;
        fprintf(stderr, "[retro] pixel format = %d\n", (int)fmt);
        return true;
    }

    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        if (data) *(const char **)data = "/tmp";
        return true;

    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        if (data) ((struct retro_log_callback *)data)->log = core_log;
        return true;

    case RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS: {
        if (!data) return false;
        uint64_t requested = *(uint64_t *)data;
        const uint64_t supported =
            RETRO_SERIALIZATION_QUIRK_INCOMPLETE |
            RETRO_SERIALIZATION_QUIRK_CORE_VARIABLE_SIZE |
            RETRO_SERIALIZATION_QUIRK_ENDIAN_DEPENDENT |
            RETRO_SERIALIZATION_QUIRK_PLATFORM_DEPENDENT;
        *(uint64_t *)data = (requested & supported) |
            RETRO_SERIALIZATION_QUIRK_FRONT_VARIABLE_SIZE;
        fprintf(stderr, "[retro] serialization quirks requested=0x%llx accepted=0x%llx\n",
                (unsigned long long)requested, (unsigned long long)*(uint64_t *)data);
        return true;
    }

    case RETRO_ENVIRONMENT_SET_VARIABLES:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
        return true;  /* acknowledged; core uses its own defaults */

    case RETRO_ENVIRONMENT_SET_CONTENT_INFO_OVERRIDE:
        /* We support handing content as an in-memory buffer via
         * GET_GAME_INFO_EXT, so acknowledge overrides. */
        return true;

    case RETRO_ENVIRONMENT_GET_GAME_INFO_EXT:
        if (!g_have_info_ext) return false;
        *(const struct retro_game_info_ext **)data = &g_info_ext;
        return true;

    case RETRO_ENVIRONMENT_GET_VARIABLE:
        if (data) ((struct retro_variable *)data)->value = NULL;
        return false; /* not found -> core keeps default */

    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        if (data) *(bool *)data = false;
        return true;

    case RETRO_ENVIRONMENT_SET_GEOMETRY:
        if (data) g_av.geometry = ((const struct retro_system_av_info *)data)->geometry;
        return true;

    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
        if (data) { g_av = *(const struct retro_system_av_info *)data; g_have_av = true; }
        return true;

    default:
        return false;
    }
}

/* ---------------------------------------------------------------------------
 * Frame pacing
 * ------------------------------------------------------------------------- */

static void now_ts(struct timespec *ts) { clock_gettime(CLOCK_MONOTONIC, ts); }

static int64_t ns_since(const struct timespec *a, const struct timespec *b)
{
    return (int64_t)(b->tv_sec - a->tv_sec) * 1000000000LL + (b->tv_nsec - a->tv_nsec);
}

static void pace_to(const struct timespec *frame_start, int64_t target_ns)
{
    struct timespec now;
    now_ts(&now);
    int64_t elapsed = ns_since(frame_start, &now);
    int64_t remain  = target_ns - elapsed;
    if (remain <= 0) return;

    struct timespec req = { remain / 1000000000LL, remain % 1000000000LL };
    if (nanosleep(&req, NULL) == 0) return;

    /* Fallback: nanosleep unsupported/interrupted -> spin on the clock. */
    do { now_ts(&now); } while (ns_since(frame_start, &now) < target_ns);
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */

static long load_file_limited(const char *path, void **out, size_t max_size)
{
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); return -1; }
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }
    long sz = ftell(f);
    if (sz <= 0 || (unsigned long)sz > max_size) { fclose(f); return -1; }
    if (fseek(f, 0, SEEK_SET) != 0) { fclose(f); return -1; }
    void *buf = malloc((size_t)sz);
    if (!buf) { fclose(f); return -1; }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) { free(buf); fclose(f); return -1; }
    fclose(f);
    *out = buf;
    return sz;
}

static long load_file(const char *path, void **out)
{
    return load_file_limited(path, out, SIZE_MAX);
}

static int write_atomic_file(const char *path, const char *tmp_path,
                             const void *data, size_t size)
{
    FILE *file = fopen(tmp_path, "wb");
    if (!file) {
        perror(tmp_path);
        return -1;
    }
    bool written = fwrite(data, 1, size, file) == size;
    if (fclose(file) != 0) written = false;
    if (!written) {
        fprintf(stderr, "[retro] failed to write complete file: %s\n", tmp_path);
        unlink(tmp_path);
        return -1;
    }
    if (rename(tmp_path, path) != 0) {
        perror(path);
        unlink(tmp_path);
        return -1;
    }
    return 0;
}

static int write_save_state(void)
{
    void *request = NULL;
    long request_size = load_file_limited(
        SAVE_REQUEST_PATH, &request, SAVE_REQUEST_SIZE);
    if (request_size != SAVE_REQUEST_SIZE) {
        fprintf(stderr, "[retro] cannot save state: missing %u-byte request at %s\n",
                SAVE_REQUEST_SIZE, SAVE_REQUEST_PATH);
        free(request);
        return -1;
    }

    size_t size = retro_serialize_size();
    if (size == 0 || size > MAX_STATE_BYTES) {
        fprintf(stderr, "[retro] cannot save state: core requested %zu bytes (max %u)\n",
                size, MAX_STATE_BYTES);
        free(request);
        return -1;
    }

    /* Some cores intentionally leave unused tail bytes untouched. Zero the
     * complete advertised buffer before retro_serialize so a shared state can
     * never contain stale heap contents and remains highly compressible. */
    void *state = calloc(1, size);
    if (!state) {
        fprintf(stderr, "[retro] cannot save state: allocation failed\n");
        free(request);
        return -1;
    }
    if (!retro_serialize(state, size)) {
        fprintf(stderr, "[retro] retro_serialize failed\n");
        free(state);
        free(request);
        return -1;
    }

    int state_result = write_atomic_file(
        SAVE_STATE_PATH, SAVE_STATE_TMP, state, size);
    free(state);
    if (state_result != 0) {
        free(request);
        return -1;
    }

    /* Publish completion only after the state rename. An older marker remains
     * harmless because the browser waits for this request's exact nonce. */
    if (write_atomic_file(
            SAVE_DONE_PATH, SAVE_DONE_TMP, request, SAVE_REQUEST_SIZE) != 0) {
        free(request);
        return -1;
    }
    free(request);
    fprintf(stderr, "[retro] saved state: %s (%zu bytes)\n", SAVE_STATE_PATH, size);
    return 0;
}

int main(int argc, char **argv)
{
    const char *state_path = NULL;
    if (argc == 4 && strcmp(argv[2], "--state") == 0) {
        state_path = argv[3];
    } else if (argc != 2) {
        fprintf(stderr, "usage: %s <rom> [--state <state-path>]\n", argv[0]);
        return 2;
    }

    setvbuf(stderr, NULL, _IONBF, 0);
    fprintf(stderr, "[retro] kandelo-retro starting, rom=%s\n", argv[1]);

    retro_set_environment(environ_cb);
    retro_set_video_refresh(video_refresh);
    retro_set_audio_sample(audio_sample);
    retro_set_audio_sample_batch(audio_sample_batch);
    retro_set_input_poll(input_poll);
    retro_set_input_state(input_state);

    retro_init();

    struct retro_system_info sysinfo;
    memset(&sysinfo, 0, sizeof sysinfo);
    retro_get_system_info(&sysinfo);
    fprintf(stderr, "[retro] core: %s %s (need_fullpath=%d)\n",
            sysinfo.library_name ? sysinfo.library_name : "?",
            sysinfo.library_version ? sysinfo.library_version : "?",
            sysinfo.need_fullpath);

    void *rom = NULL;
    long romsz = load_file(argv[1], &rom);
    if (romsz < 0) return 1;

    /* Offer the ROM both as an in-memory buffer (GET_GAME_INFO_EXT) and via
     * path, so the core can load from memory and never touch the guest VFS. */
    setup_info_ext(argv[1], rom, (size_t)romsz);

    struct retro_game_info game;
    memset(&game, 0, sizeof game);
    game.path = argv[1];
    game.data = rom;
    game.size = (size_t)romsz;
    if (!retro_load_game(&game)) {
        fprintf(stderr, "[retro] retro_load_game failed\n");
        return 1;
    }

    if (state_path) {
        void *state = NULL;
        long state_size = load_file_limited(state_path, &state, MAX_STATE_BYTES);
        if (state_size < 0) {
            fprintf(stderr, "[retro] invalid save state size for %s (max %u bytes)\n",
                    state_path, MAX_STATE_BYTES);
            free(state);
            return 1;
        }
        if (!retro_unserialize(state, (size_t)state_size)) {
            fprintf(stderr, "[retro] retro_unserialize failed for %s (%ld bytes)\n",
                    state_path, state_size);
            free(state);
            return 1;
        }
        fprintf(stderr, "[retro] restored save state: %s (%ld bytes)\n",
                state_path, state_size);
        free(state);
    }

    memset(&g_av, 0, sizeof g_av);
    retro_get_system_av_info(&g_av);
    g_have_av = true;
    double fps = g_av.timing.fps > 1.0 ? g_av.timing.fps : 60.0;
    double srate = g_av.timing.sample_rate > 1.0 ? g_av.timing.sample_rate : 44100.0;
    fprintf(stderr, "[retro] av: %ux%u fps=%.3f rate=%.0f\n",
            g_av.geometry.base_width, g_av.geometry.base_height, fps, srate);

    if (fb_open() < 0) return 1;
    dsp_open(srate);
    input_open();

    /* Publish the pid only once a save can actually be served. */
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_save_signal;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_RESTART;
    if (sigaction(SIGUSR1, &sa, NULL) != 0) perror("sigaction(SIGUSR1)");
    char pid_text[32];
    int pid_len = snprintf(pid_text, sizeof pid_text, "%ld\n", (long)getpid());
    if (write_atomic_file(PID_PATH, PID_PATH ".tmp", pid_text, (size_t)pid_len) != 0)
        fprintf(stderr, "[retro] could not publish %s; checkpoints unavailable\n", PID_PATH);

    int64_t target_ns = (int64_t)(1e9 / fps);
    fprintf(stderr, "[retro] running (%.3f fps, %lld ns/frame)\n", fps, (long long)target_ns);

    for (;;) {
        struct timespec frame_start;
        now_ts(&frame_start);
        retro_run();
        memset(g_keylatch, 0, sizeof g_keylatch);
        if (g_save_requested) {
            g_save_requested = 0;
            (void)write_save_state();
        }
        pace_to(&frame_start, target_ns);
    }

    /* not reached */
    retro_unload_game();
    retro_deinit();
    free(rom);
    return 0;
}
