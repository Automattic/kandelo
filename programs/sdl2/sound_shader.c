/*
 * programs/sdl2/sound_shader.c — see sound_shader.h for the model.
 *
 * The render path is deliberately separate from renderer.c's image
 * pipeline: its own program, FBO, attachment texture, and quad VBO. The
 * only shared GL state we must be careful about is GL_SCISSOR_TEST, which
 * main.c leaves enabled for the split-pane layout — we disable it around
 * the off-screen render so the full FBO is written, then restore it.
 */

#include "sound_shader.h"

#include <SDL2/SDL_opengles2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ----- shader template ------------------------------------------- */

static const char *SOUND_VS_SRC =
    "attribute vec2 a_pos;\n"
    "void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n";

/* The fragment turns its pixel into one stereo frame. iResolution.x is
 * the FBO width, so `idx` walks 0..frames-1 row-major, matching the
 * row-major glReadPixels decode on the CPU side. mainSound's vec2 is
 * encoded as two 16-bit values split low/high byte across RGBA. */
static const char *SOUND_FRAG_PREFIX =
    "#version 100\n"
    "precision highp float;\n"
    "uniform float iSampleRate;\n"
    "uniform float iBufferOffset;\n"
    "uniform vec2  iResolution;\n";

static const char *SOUND_FRAG_SUFFIX =
    "\nvoid main() {\n"
    "  float idx = floor(gl_FragCoord.x)\n"
    "            + floor(gl_FragCoord.y) * iResolution.x;\n"
    "  float t = iBufferOffset + idx / iSampleRate;\n"
    "  vec2 s = clamp(mainSound(t), -1.0, 1.0);\n"
    "  vec2 v16 = floor((s * 0.5 + 0.5) * 65535.0 + 0.5);\n"
    "  vec2 hi = floor(v16 / 256.0);\n"
    "  vec2 lo = v16 - hi * 256.0;\n"
    "  gl_FragColor = vec4(lo.x, hi.x, lo.y, hi.y) / 255.0;\n"
    "}\n";

/* Default shader compiled at init — a quiet 220 Hz sine so the module is
 * always in a renderable state even before a preset loads. */
static const char *SOUND_DEFAULT_SRC =
    "vec2 mainSound(in float time) {\n"
    "  float v = 0.3 * sin(6.2831853 * 220.0 * time);\n"
    "  return vec2(v, v);\n"
    "}\n";

/* ----- GL objects + state ---------------------------------------- */

static GLuint g_prog        = 0;
static GLuint g_vbo         = 0;
static GLuint g_fbo         = 0;
static GLuint g_fbo_tex     = 0;
static GLint  g_a_pos       = -1;
static GLint  g_u_rate      = -1;
static GLint  g_u_offset    = -1;
static GLint  g_u_res       = -1;

static char   g_last_error[4096];

/* Decoded playback buffer (interleaved S16 stereo) + the frame count from
 * the last render. Malloc'd once at init (≈54 MiB for the full track —
 * too large for static BSS); NULL if the allocation failed, in which case
 * render reports 0 frames and audio.c falls back to the chip synth. */
static int16_t *g_pcm = NULL;
static int      g_pcm_frames = 0;

const char *sound_shader_last_error(void) { return g_last_error; }

/* Map the GLSL info log's first "ERROR: 0:<line>:" back to the user's
 * editor coordinates by subtracting the SOUND_FRAG_PREFIX line count.
 * Returns the 1-indexed user line, or -1 if none/unmappable. */
int sound_shader_last_error_line(void) {
    const char *p = strstr(g_last_error, "0:");
    if (!p) return -1;
    p += 2;
    if (*p < '0' || *p > '9') return -1;
    int combined = 0;
    while (*p >= '0' && *p <= '9') combined = combined * 10 + (*p++ - '0');
    int prefix_lines = 0;
    for (const char *q = SOUND_FRAG_PREFIX; *q; q++)
        if (*q == '\n') prefix_lines++;
    int user_line = combined - prefix_lines;
    return user_line >= 1 ? user_line : -1;
}

/* ----- compile helpers (same discrimination as renderer.c) ------- */

static GLuint sc_compile(GLenum type, const char *src, const char *tag,
                         int *real_failure) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, NULL);
    glCompileShader(s);
    GLint status = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &status);
    if (!status) {
        GLint loglen = 0;
        glGetShaderiv(s, GL_INFO_LOG_LENGTH, &loglen);
        if (loglen > 0 && loglen < (GLint) sizeof g_last_error) {
            glGetShaderInfoLog(s, loglen, NULL, g_last_error);
            if (real_failure) *real_failure = 1;
        } else {
            snprintf(g_last_error, sizeof g_last_error,
                     "(empty info log; headless GL?)");
        }
        fprintf(stderr, "WARN: sound-%s compile: %s\n", tag, g_last_error);
    }
    return s;
}

static GLuint sc_link(GLuint vs, GLuint fs, int *real_failure) {
    GLuint prog = glCreateProgram();
    glAttachShader(prog, vs);
    glAttachShader(prog, fs);
    glLinkProgram(prog);
    glDeleteShader(vs);
    glDeleteShader(fs);
    GLint status = 0;
    glGetProgramiv(prog, GL_LINK_STATUS, &status);
    if (!status) {
        GLint loglen = 0;
        glGetProgramiv(prog, GL_INFO_LOG_LENGTH, &loglen);
        if (loglen > 0 && loglen < (GLint) sizeof g_last_error) {
            glGetProgramInfoLog(prog, loglen, NULL, g_last_error);
            if (real_failure) *real_failure = 1;
        } else {
            snprintf(g_last_error, sizeof g_last_error,
                     "(empty link log; headless GL?)");
        }
        fprintf(stderr, "WARN: sound-program link: %s\n", g_last_error);
    }
    return prog;
}

static void rebind_uniforms(void) {
    g_a_pos    = glGetAttribLocation (g_prog, "a_pos");
    g_u_rate   = glGetUniformLocation(g_prog, "iSampleRate");
    g_u_offset = glGetUniformLocation(g_prog, "iBufferOffset");
    g_u_res    = glGetUniformLocation(g_prog, "iResolution");
}

int sound_shader_recompile(const char *user_src) {
    size_t pre = strlen(SOUND_FRAG_PREFIX);
    size_t usr = strlen(user_src);
    size_t suf = strlen(SOUND_FRAG_SUFFIX);
    char *frag = malloc(pre + usr + suf + 1);
    if (!frag) return 0;
    memcpy(frag, SOUND_FRAG_PREFIX, pre);
    memcpy(frag + pre, user_src, usr);
    memcpy(frag + pre + usr, SOUND_FRAG_SUFFIX, suf + 1);

    int real_failure = 0;
    GLuint vs = sc_compile(GL_VERTEX_SHADER, SOUND_VS_SRC, "vertex",
                           &real_failure);
    GLuint fs = sc_compile(GL_FRAGMENT_SHADER, frag, "fragment",
                           &real_failure);
    free(frag);
    GLuint new_prog = sc_link(vs, fs, &real_failure);

    if (real_failure) {
        glDeleteProgram(new_prog);
        return 1;
    }
    if (g_prog) glDeleteProgram(g_prog);
    g_prog = new_prog;
    rebind_uniforms();
    return 0;
}

/* ----- init / shutdown ------------------------------------------- */

void sound_shader_init(void) {
    static const float quad[8] = {
        -1.0f, -1.0f,  1.0f, -1.0f,
        -1.0f,  1.0f,  1.0f,  1.0f,
    };
    glGenBuffers(1, &g_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof quad, quad, GL_STATIC_DRAW);

    /* RGBA8 color target. NULL pixels → allocate without upload (dodges
     * the OP_TEX_IMAGE_2D single-call payload cap; a 1024×1024 RGBA upload
     * would be 4 MiB). */
    glGenTextures(1, &g_fbo_tex);
    glBindTexture(GL_TEXTURE_2D, g_fbo_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA,
                 SOUND_SHADER_TEX_W, SOUND_SHADER_TEX_H, 0,
                 GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    glGenFramebuffers(1, &g_fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                           GL_TEXTURE_2D, g_fbo_tex, 0);
    GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    if (st != GL_FRAMEBUFFER_COMPLETE) {
        /* Non-fatal: the headless stub returns COMPLETE by default, and a
         * real incomplete FBO just yields silence (0 frames). */
        fprintf(stderr, "WARN: sound FBO status=0x%x\n", (unsigned) st);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    /* Playback buffer for the full multi-tile track. malloc (not static)
     * because it's ~54 MiB; on failure g_pcm stays NULL and render bails to
     * the synth fallback rather than crashing. */
    g_pcm = malloc((size_t) SOUND_SHADER_FRAMES * 2 * sizeof(int16_t));
    if (!g_pcm) {
        fprintf(stderr, "WARN: sound pcm malloc(%zu bytes) failed\n",
                (size_t) SOUND_SHADER_FRAMES * 2 * sizeof(int16_t));
    }

    sound_shader_recompile(SOUND_DEFAULT_SRC);
    fprintf(stdout, "sdl2: sound-shader init fbo=%dx%d tiles=%d frames=%d\n",
            SOUND_SHADER_TEX_W, SOUND_SHADER_TEX_H, SOUND_SHADER_TILES,
            SOUND_SHADER_FRAMES);
}

void sound_shader_shutdown(void) {
    if (g_prog)    { glDeleteProgram(g_prog);        g_prog = 0; }
    if (g_vbo)     { glDeleteBuffers(1, &g_vbo);      g_vbo = 0; }
    if (g_fbo_tex) { glDeleteTextures(1, &g_fbo_tex); g_fbo_tex = 0; }
    /* The GLES stub exposes no glDeleteFramebuffers op; the FBO name is
     * released when the GL context tears down at process exit. */
    g_fbo = 0;
    free(g_pcm);
    g_pcm = NULL;
    g_pcm_frames = 0;
}

/* ----- render + readback ----------------------------------------- */

int sound_shader_render(int sample_rate) {
    if (!g_prog || !g_pcm) { g_pcm_frames = 0; return 0; }
    if (sample_rate <= 0) sample_rate = 48000;

    const int W = SOUND_SHADER_TEX_W;
    const int H = SOUND_SHADER_TEX_H;
    const int tile_frames = SOUND_SHADER_TILE_FRAMES;

    /* main.c enables GL_SCISSOR_TEST once and leaves it on for the split-
     * pane layout; the stub has no glIsEnabled, so we unconditionally
     * disable it for the off-screen renders and re-enable it after. */
    glDisable(GL_SCISSOR_TEST);

    /* One reusable staging band-buffer for the whole FBO. calloc (not
     * malloc): under the headless GL stub glReadPixels is a no-op that
     * leaves the buffer untouched, so zero-init guarantees an all-zero
     * "silent" decode there rather than feeding uninitialized garbage to
     * the audio source. Real GL fully overwrites every band of every tile. */
    uint8_t *staging = calloc((size_t) W * H * 4, 1);
    if (!staging) {
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glEnable(GL_SCISSOR_TEST);
        g_pcm_frames = 0;
        return 0;
    }
    /* 60 KB target → 15 rows/band at W=1024; stays under the kernel cap
     * (MAX_QUERY_OUT_LEN = 64 KB) while minimizing readback round-trips. */
    int rows_per_band = (60 * 1024) / (W * 4);
    if (rows_per_band < 1) rows_per_band = 1;

    /* Render the track as SOUND_SHADER_TILES consecutive time-windows. Each
     * tile is a full FBO dispatch (kept light to dodge the GPU watchdog);
     * iBufferOffset advances by one tile's duration so the windows are
     * contiguous in `time`, and the decoded frames land back-to-back in
     * g_pcm. */
    int any_nonzero = 0;
    for (int tile = 0; tile < SOUND_SHADER_TILES; tile++) {
        float offset = (float) ((double) tile * tile_frames / sample_rate);

        glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
        glViewport(0, 0, W, H);
        glUseProgram(g_prog);
        glBindBuffer(GL_ARRAY_BUFFER, g_vbo);
        if (g_a_pos >= 0) {
            glVertexAttribPointer((GLuint) g_a_pos, 2, GL_FLOAT, GL_FALSE,
                                  0, NULL);
            glEnableVertexAttribArray((GLuint) g_a_pos);
        }
        if (g_u_rate   >= 0) glUniform1f(g_u_rate, (float) sample_rate);
        if (g_u_offset >= 0) glUniform1f(g_u_offset, offset);
        if (g_u_res    >= 0) glUniform2f(g_u_res, (float) W, (float) H);
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);

        /* Read back in <=64 KB row-bands. */
        for (int y0 = 0; y0 < H; y0 += rows_per_band) {
            int rows = rows_per_band;
            if (y0 + rows > H) rows = H - y0;
            glReadPixels(0, y0, W, rows, GL_RGBA, GL_UNSIGNED_BYTE,
                         staging + (size_t) y0 * W * 4);
        }

        /* Decode RGBA8 → S16 stereo into this tile's slice of g_pcm; track
         * whether anything is non-zero so a headless (all-zero) run falls
         * back to the synth. */
        size_t base = (size_t) tile * tile_frames;
        for (int i = 0; i < tile_frames; i++) {
            unsigned lo_l = staging[i * 4 + 0];
            unsigned hi_l = staging[i * 4 + 1];
            unsigned lo_r = staging[i * 4 + 2];
            unsigned hi_r = staging[i * 4 + 3];
            if (lo_l | hi_l | lo_r | hi_r) any_nonzero = 1;
            unsigned l16 = (hi_l << 8) | lo_l;
            unsigned r16 = (hi_r << 8) | lo_r;
            /* [0,65535] → [-1,1] → S16. */
            float lf = (float) l16 / 65535.0f * 2.0f - 1.0f;
            float rf = (float) r16 / 65535.0f * 2.0f - 1.0f;
            g_pcm[(base + i) * 2 + 0] = (int16_t) (lf * 32767.0f);
            g_pcm[(base + i) * 2 + 1] = (int16_t) (rf * 32767.0f);
        }
    }
    free(staging);

    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glEnable(GL_SCISSOR_TEST);

    const int frames = tile_frames * SOUND_SHADER_TILES;
    g_pcm_frames = any_nonzero ? frames : 0;
    fprintf(stdout, "sdl2: sound-shader render frames=%d tiles=%d audible=%d\n",
            frames, SOUND_SHADER_TILES, any_nonzero);
    return g_pcm_frames;
}

const int16_t *sound_shader_pcm(int *out_frames) {
    if (out_frames) *out_frames = g_pcm_frames;
    return g_pcm_frames > 0 ? g_pcm : NULL;
}
