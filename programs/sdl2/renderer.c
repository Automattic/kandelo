/*
 * programs/sdl2/renderer.c — GLES2 drawing facade for the SDL2 GLSL
 * playground. See renderer.h for the public surface. This translation
 * unit is the *only* place where stb_truetype's implementation is
 * realized — the rest of the playground gets it as a pure header.
 *
 * Three programs live here:
 *   prog_user   - the live image-shader (PLASMA_SRC or user-supplied).
 *   prog_strip  - the translucent red error strip.
 *   prog_text   - a textured-quad program reading the Inconsolata atlas.
 *
 * The atlas is baked once at init via stb_truetype's `BakeFontBitmap`
 * over the printable ASCII range (32..126). One static GL_LUMINANCE
 * 2D texture; one CPU-side `stbtt_bakedchar` table for per-glyph UV +
 * size + xadvance lookup. We bake at a height that matches Phase 4's
 * editor needs (TEXT_PIXEL_HEIGHT).
 *
 * Drawing text issues one `glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)` per
 * glyph — sub-optimal but trivial to verify. Per-frame the editor will
 * draw on the order of ~1500 glyphs; that's well within the headroom
 * even with the GLES2 channel-syscall draw overhead.
 */

#include "renderer.h"

#include <SDL2/SDL_opengles2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define STB_TRUETYPE_IMPLEMENTATION
#define STBTT_STATIC
#include "third_party/stb_truetype.h"
#include "third_party/inconsolata_ttf.h"

/* ----- font / atlas configuration -------------------------------- */

/* The atlas uploads as a single GL_LUMINANCE texture in one
 * OP_TEX_IMAGE_2D TLV record. libglesv2_stub.c packs the payload
 * length into a u16, so the largest single-call upload is ≈65499
 * bytes. ATLAS_W*ATLAS_H = 61440 stays under the cap and holds 95
 * glyphs at 28 px height.
 *
 * We use stbtt_Pack* (not the older BakeFontBitmap) so glyphs carry
 * grayscale-coverage antialiasing and sample back with bilinear
 * filtering at display time. At 28 px the glyphs hold enough detail
 * that 1× oversampling already looks smooth — and 2× horizontal
 * oversampling at this height would push the atlas past the
 * single-upload payload cap (256×360 ≈ 92 KB > 65499). The render
 * target is the full 1920×1080 framebuffer, which the kandelo Modeset
 * pane down-samples to its CSS width; a larger bake (28 px vs the
 * prior 20 px) therefore reads as a crisp modern editor font instead
 * of the thin, aliased "MS-DOS" look the 20 px atlas produced once
 * down-sampled. */
#define TEXT_PIXEL_HEIGHT     28  /* glyph render height in pixels    */
#define TEXT_LINE_STRIDE      34  /* baseline-to-baseline px          */
#define TEXT_OVERSAMPLE_X      1
#define TEXT_OVERSAMPLE_Y      1
#define ATLAS_W              256
#define ATLAS_H              240
#define ATLAS_FIRST           32
#define ATLAS_COUNT           95  /* 32..126 inclusive */

static stbtt_packedchar g_atlas_chars[ATLAS_COUNT];
static GLuint           g_atlas_tex     = 0;
static int              g_glyph_advance = 0;
static int              g_glyph_ascent  = 0;

/* ----- screen state ---------------------------------------------- */
static int g_screen_w = 1280;
static int g_screen_h = 720;

/* ----- error state (shared with main + editor via accessors) ----- */
static char g_last_error[4096];
static int  g_error_visible = 0;

void renderer_set_error_visible(int v) { g_error_visible = v ? 1 : 0; }

/* ----- shared compile helper ------------------------------------- */

/* `real_failure_out` is OR'd in: we leave it untouched on success and
 * set it to 1 only when the compile actually produced an info-log
 * entry. Empty-log failures are the headless-GL stub described in
 * handoff-2 §C — they get a WARN but are treated as a no-op so the
 * Node test path can still run the binary end-to-end. */
static GLuint compile_shader(GLenum type, const char *src, const char *tag,
                             int *real_failure_out) {
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
            if (real_failure_out) *real_failure_out = 1;
        } else {
            snprintf(g_last_error, sizeof g_last_error,
                     "(empty info log; headless GL?)");
        }
        fprintf(stderr, "WARN: %s compile: %s\n", tag, g_last_error);
    }
    return s;
}

static GLuint link_program(GLuint vs, GLuint fs, const char *tag,
                           int *real_failure_out) {
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
            if (real_failure_out) *real_failure_out = 1;
        } else {
            snprintf(g_last_error, sizeof g_last_error,
                     "(empty link log; headless GL?)");
        }
        fprintf(stderr, "WARN: %s link: %s\n", tag, g_last_error);
    }
    return prog;
}

/* ===== user image-shader program ================================ */

static const char *USER_VS_SRC =
    "attribute vec2 a_pos;\n"
    "void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n";

/* GLSL ES 1.0 wrapper around the user's `mainImage`. `iAudio` is a
 * 128×1 GL_LUMINANCE texture holding the live FFT magnitude spectrum
 * (see audio.c). Shaders that don't sample it link fine — the uniform
 * just drops out and renderer_draw_user_shader's location check skips
 * the bind. */
static const char *USER_FRAG_PREFIX =
    "#version 100\n"
    "precision highp float;\n"
    "uniform vec2 iResolution;\n"
    "uniform vec2 iViewportOrigin;\n"
    "uniform float iTime;\n"
    "uniform float iTimeDelta;\n"
    "uniform vec2 iMouse;\n"
    "uniform int iFrame;\n"
    "uniform sampler2D iAudio;\n";

static const char *USER_FRAG_SUFFIX =
    "\nvoid main() {\n"
    "  vec4 c;\n"
    "  mainImage(c, gl_FragCoord.xy - iViewportOrigin);\n"
    "  gl_FragColor = c;\n"
    "}\n";

/* Parse the GLSL info log for the 1-indexed source line of the first
 * error — ANGLE/Mesa format "ERROR: 0:<line>: ..." — and map it back to
 * the user's editor coordinates by subtracting the template prefix's line
 * count (the wrapper lines the user never sees). Returns the 1-indexed
 * user line, or -1 if the log has no parseable line or the error sits in
 * the template prefix itself. */
static int parse_error_line(const char *log, const char *prefix) {
    const char *p = strstr(log, "0:");
    if (!p) return -1;
    p += 2;
    if (*p < '0' || *p > '9') return -1;
    int combined = 0;
    while (*p >= '0' && *p <= '9') combined = combined * 10 + (*p++ - '0');
    int prefix_lines = 0;
    for (const char *q = prefix; *q; q++) if (*q == '\n') prefix_lines++;
    int user_line = combined - prefix_lines;
    return user_line >= 1 ? user_line : -1;
}

int renderer_last_error_line(void) {
    return parse_error_line(g_last_error, USER_FRAG_PREFIX);
}

static GLuint g_user_prog        = 0;
static GLuint g_user_vbo         = 0;
static GLint  g_user_a_pos       = -1;
static GLint  g_user_u_iRes      = -1;
static GLint  g_user_u_iVpOrigin = -1;
static GLint  g_user_u_iTime     = -1;
static GLint  g_user_u_iTimeDt   = -1;
static GLint  g_user_u_iMouse    = -1;
static GLint  g_user_u_iFrame    = -1;
static GLint  g_user_u_iAudio    = -1;

/* The FFT spectrum texture sampled by `iAudio`. Created lazily on the
 * first renderer_set_audio_spectrum so headless test runs (no audio
 * uploads) never allocate it. */
static GLuint g_audio_tex = 0;

static void user_rebind_uniforms(void) {
    g_user_a_pos       = glGetAttribLocation (g_user_prog, "a_pos");
    g_user_u_iRes      = glGetUniformLocation(g_user_prog, "iResolution");
    g_user_u_iVpOrigin = glGetUniformLocation(g_user_prog, "iViewportOrigin");
    g_user_u_iTime     = glGetUniformLocation(g_user_prog, "iTime");
    g_user_u_iTimeDt   = glGetUniformLocation(g_user_prog, "iTimeDelta");
    g_user_u_iMouse    = glGetUniformLocation(g_user_prog, "iMouse");
    g_user_u_iFrame    = glGetUniformLocation(g_user_prog, "iFrame");
    g_user_u_iAudio    = glGetUniformLocation(g_user_prog, "iAudio");
}

int renderer_recompile_user_shader(const char *user_src) {
    size_t pre = strlen(USER_FRAG_PREFIX);
    size_t usr = strlen(user_src);
    size_t suf = strlen(USER_FRAG_SUFFIX);
    char *frag = malloc(pre + usr + suf + 1);
    if (!frag) return 0;
    memcpy(frag, USER_FRAG_PREFIX, pre);
    memcpy(frag + pre, user_src, usr);
    memcpy(frag + pre + usr, USER_FRAG_SUFFIX, suf + 1);

    int real_failure = 0;
    GLuint vs = compile_shader(GL_VERTEX_SHADER, USER_VS_SRC,
                               "user-vertex", &real_failure);
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER, frag,
                               "user-fragment", &real_failure);
    free(frag);
    GLuint new_prog = link_program(vs, fs, "user-program", &real_failure);

    if (real_failure) {
        glDeleteProgram(new_prog);
        return 1;
    }
    if (g_user_prog) glDeleteProgram(g_user_prog);
    g_user_prog = new_prog;
    user_rebind_uniforms();
    return 0;
}

void renderer_set_audio_spectrum(const unsigned char *bins, int n) {
    if (!bins || n <= 0) return;
    if (!g_audio_tex) {
        glGenTextures(1, &g_audio_tex);
        glBindTexture(GL_TEXTURE_2D, g_audio_tex);
        /* LINEAR so the 128 bins read as smooth bars; clamp so the edge
         * texels don't wrap. */
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    } else {
        glBindTexture(GL_TEXTURE_2D, g_audio_tex);
    }
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    /* One-row (n×1) GL_LUMINANCE texture — 128 bytes, far under the
     * OP_TEX_IMAGE_2D single-call payload cap. */
    glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE,
                 n, 1, 0, GL_LUMINANCE, GL_UNSIGNED_BYTE, bins);
}

void renderer_draw_user_shader(int vp_x, int vp_y, int vp_w, int vp_h,
                               float t, float dt,
                               float mouse_x, float mouse_y, int frame) {
    if (!g_user_prog) return;
    glViewport(vp_x, vp_y, vp_w, vp_h);
    glScissor (vp_x, vp_y, vp_w, vp_h);
    glUseProgram(g_user_prog);
    glBindBuffer(GL_ARRAY_BUFFER, g_user_vbo);
    if (g_user_a_pos >= 0) {
        glVertexAttribPointer((GLuint) g_user_a_pos, 2, GL_FLOAT,
                              GL_FALSE, 0, NULL);
        glEnableVertexAttribArray((GLuint) g_user_a_pos);
    }
    if (g_user_u_iRes      >= 0) glUniform2f(g_user_u_iRes,
                                             (float) vp_w, (float) vp_h);
    if (g_user_u_iVpOrigin >= 0) glUniform2f(g_user_u_iVpOrigin,
                                             (float) vp_x, (float) vp_y);
    if (g_user_u_iTime     >= 0) glUniform1f(g_user_u_iTime, t);
    if (g_user_u_iTimeDt   >= 0) glUniform1f(g_user_u_iTimeDt, dt);
    if (g_user_u_iMouse    >= 0) glUniform2f(g_user_u_iMouse,
                                             mouse_x, mouse_y);
    if (g_user_u_iFrame    >= 0) glUniform1i(g_user_u_iFrame, frame);
    /* Bind the FFT texture to unit 0 for the iAudio sampler. The text
     * program also uses unit 0, but each draw rebinds its own texture, so
     * sharing the unit is safe. */
    if (g_user_u_iAudio >= 0 && g_audio_tex) {
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, g_audio_tex);
        glUniform1i(g_user_u_iAudio, 0);
    }
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}

/* ===== error-strip program ====================================== */

static const char *STRIP_VS_SRC =
    "attribute vec2 a_pos;\n"
    "void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n";

static const char *STRIP_FS_SRC =
    "#version 100\n"
    "precision mediump float;\n"
    "void main() { gl_FragColor = vec4(1.0, 0.1, 0.1, 0.55); }\n";

static GLuint g_strip_prog  = 0;
static GLuint g_strip_vbo   = 0;
static GLint  g_strip_a_pos = -1;

void renderer_draw_error_strip(int vp_x, int vp_y, int vp_w, int vp_h) {
    if (!g_error_visible || !g_strip_prog) return;
    glViewport(vp_x, vp_y, vp_w, vp_h);
    glScissor (vp_x, vp_y, vp_w, vp_h);
    glUseProgram(g_strip_prog);
    glBindBuffer(GL_ARRAY_BUFFER, g_strip_vbo);
    if (g_strip_a_pos >= 0) {
        glVertexAttribPointer((GLuint) g_strip_a_pos, 2, GL_FLOAT,
                              GL_FALSE, 0, NULL);
        glEnableVertexAttribArray((GLuint) g_strip_a_pos);
    }
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glDisable(GL_BLEND);
}

/* ===== text / fill-rect program ================================= */

/* Both `renderer_draw_text` and `renderer_fill_rect` share one
 * textured-quad program. `fill_rect` binds a 1×1 white texture so the
 * fragment color is purely the per-draw uniform color. `draw_text`
 * binds the atlas. Vertex data: 2D pos + 2D uv, written per-quad
 * into a STREAM_DRAW VBO; we issue 4 verts via TRIANGLE_STRIP. */

static const char *TEXT_VS_SRC =
    "attribute vec2 a_pos;\n"
    "attribute vec2 a_uv;\n"
    "varying vec2 v_uv;\n"
    "void main() {\n"
    "  v_uv = a_uv;\n"
    "  gl_Position = vec4(a_pos, 0.0, 1.0);\n"
    "}\n";

/* The atlas is GL_LUMINANCE, so .r carries the only meaningful
 * channel. Multiply by the per-draw u_color (with .a alpha) and
 * blend additively so a fully-transparent texel contributes nothing.
 * The 1×1 white texture used by fill_rect makes that .r be 1.0 across
 * the quad, so the color uniform drives the result. */
static const char *TEXT_FS_SRC =
    "#version 100\n"
    "precision mediump float;\n"
    "varying vec2 v_uv;\n"
    "uniform sampler2D u_tex;\n"
    "uniform vec4 u_color;\n"
    "void main() {\n"
    "  float a = texture2D(u_tex, v_uv).r;\n"
    "  gl_FragColor = vec4(u_color.rgb, u_color.a * a);\n"
    "}\n";

static GLuint g_text_prog    = 0;
static GLuint g_text_vbo     = 0;
static GLuint g_white_tex    = 0;
static GLint  g_text_a_pos   = -1;
static GLint  g_text_a_uv    = -1;
static GLint  g_text_u_tex   = -1;
static GLint  g_text_u_color = -1;

/* Convert a window-pixel rectangle to NDC. Origin (0,0) is top-left
 * in pixel space; (-1,-1) is bottom-left in NDC. The vbo layout is
 * 4 verts × (x, y, u, v), arranged as a triangle strip. */
static void quad_pixels_to_ndc(int x, int y, int w, int h,
                               float u0, float v0, float u1, float v1,
                               float verts[16]) {
    float sx = g_screen_w > 0 ? (float) g_screen_w : 1.0f;
    float sy = g_screen_h > 0 ? (float) g_screen_h : 1.0f;
    float x0n =  (float) x         / sx * 2.0f - 1.0f;
    float x1n =  (float)(x + w)    / sx * 2.0f - 1.0f;
    float y0n = -((float) y        / sy * 2.0f - 1.0f);
    float y1n = -((float)(y + h)   / sy * 2.0f - 1.0f);
    /* TRIANGLE_STRIP order: (x0,y0)(x1,y0)(x0,y1)(x1,y1).
     * y1n < y0n in NDC because we flipped. */
    verts[ 0] = x0n; verts[ 1] = y0n; verts[ 2] = u0; verts[ 3] = v0;
    verts[ 4] = x1n; verts[ 5] = y0n; verts[ 6] = u1; verts[ 7] = v0;
    verts[ 8] = x0n; verts[ 9] = y1n; verts[10] = u0; verts[11] = v1;
    verts[12] = x1n; verts[13] = y1n; verts[14] = u1; verts[15] = v1;
}

static void text_bind_pointers(void) {
    if (g_text_a_pos >= 0) {
        glVertexAttribPointer((GLuint) g_text_a_pos, 2, GL_FLOAT, GL_FALSE,
                              sizeof(float) * 4, (void *) 0);
        glEnableVertexAttribArray((GLuint) g_text_a_pos);
    }
    if (g_text_a_uv >= 0) {
        glVertexAttribPointer((GLuint) g_text_a_uv, 2, GL_FLOAT, GL_FALSE,
                              sizeof(float) * 4,
                              (void *)(uintptr_t) (sizeof(float) * 2));
        glEnableVertexAttribArray((GLuint) g_text_a_uv);
    }
}

void renderer_fill_rect(int x, int y, int w, int h,
                        float r, float g, float b, float a) {
    if (!g_text_prog || w <= 0 || h <= 0) return;
    glUseProgram(g_text_prog);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, g_white_tex);
    if (g_text_u_tex   >= 0) glUniform1i(g_text_u_tex, 0);
    if (g_text_u_color >= 0) glUniform4f(g_text_u_color, r, g, b, a);
    float verts[16];
    quad_pixels_to_ndc(x, y, w, h, 0.0f, 0.0f, 1.0f, 1.0f, verts);
    glBindBuffer(GL_ARRAY_BUFFER, g_text_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof verts, verts, GL_STREAM_DRAW);
    text_bind_pointers();
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glDisable(GL_BLEND);
}

int renderer_draw_text(int x, int y, const char *s, size_t n,
                       float r, float g, float b) {
    if (!g_text_prog || !g_atlas_tex || g_glyph_advance == 0) return 0;
    glUseProgram(g_text_prog);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, g_atlas_tex);
    if (g_text_u_tex   >= 0) glUniform1i(g_text_u_tex, 0);
    if (g_text_u_color >= 0) glUniform4f(g_text_u_color, r, g, b, 1.0f);

    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

    float pen_x = (float) x;
    float pen_y = (float) y + (float) g_glyph_ascent;
    glBindBuffer(GL_ARRAY_BUFFER, g_text_vbo);
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char) s[i];
        if (c < ATLAS_FIRST || c >= ATLAS_FIRST + ATLAS_COUNT) {
            pen_x += (float) g_glyph_advance;
            continue;
        }
        stbtt_aligned_quad q;
        float px = pen_x;
        float py = pen_y;
        stbtt_GetPackedQuad(g_atlas_chars, ATLAS_W, ATLAS_H,
                            c - ATLAS_FIRST, &px, &py, &q,
                            /*align_to_integer=*/1);
        /* Monospace: force the advance to the cell width regardless of
         * what the font says. Inconsolata's per-glyph xadvance is
         * already constant within rounding, but pinning it here also
         * keeps the cursor column math (in editor.c) exact. */
        pen_x += (float) g_glyph_advance;
        if (q.x1 <= q.x0 || q.y1 <= q.y0) continue;
        int gx = (int) q.x0;
        int gy = (int) q.y0;
        int gw = (int)(q.x1 - q.x0);
        int gh = (int)(q.y1 - q.y0);
        float verts[16];
        quad_pixels_to_ndc(gx, gy, gw, gh, q.s0, q.t0, q.s1, q.t1, verts);
        glBufferData(GL_ARRAY_BUFFER, sizeof verts, verts, GL_STREAM_DRAW);
        text_bind_pointers();
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    }

    glDisable(GL_BLEND);
    return (int)(pen_x - (float) x);
}

int renderer_draw_textz(int x, int y, const char *s,
                        float r, float g, float b) {
    return renderer_draw_text(x, y, s, strlen(s), r, g, b);
}

int renderer_text_advance(void)    { return g_glyph_advance ? g_glyph_advance : 9; }
int renderer_text_line_height(void){ return TEXT_LINE_STRIDE; }

/* ===== init / shutdown ========================================== */

static void build_user_program_initial(void) {
    /* Bake a known-good shader at startup. The caller (main) will
     * overwrite this immediately with the VFS-resolved source. */
    static const char *PLASMA_SRC =
        "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n"
        "  vec2 uv = fragCoord / iResolution.xy;\n"
        "  float r = 0.5 + 0.5 * sin(iTime + uv.x * 6.2831);\n"
        "  float g = 0.5 + 0.5 * sin(iTime * 1.3 + uv.y * 6.2831);\n"
        "  float b = 0.5 + 0.5 * sin(iTime * 0.7 + (uv.x + uv.y) * 6.2831);\n"
        "  fragColor = vec4(r, g, b, 1.0);\n"
        "}\n";
    renderer_recompile_user_shader(PLASMA_SRC);

    static const float user_quad[8] = {
        -1.0f, -1.0f,
         1.0f, -1.0f,
        -1.0f,  1.0f,
         1.0f,  1.0f,
    };
    glGenBuffers(1, &g_user_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g_user_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof user_quad, user_quad,
                 GL_STATIC_DRAW);
}

static void build_strip_program(void) {
    int rf = 0;
    GLuint vs = compile_shader(GL_VERTEX_SHADER, STRIP_VS_SRC,
                               "strip-vertex", &rf);
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER, STRIP_FS_SRC,
                               "strip-fragment", &rf);
    g_strip_prog = link_program(vs, fs, "strip-program", &rf);
    g_strip_a_pos = glGetAttribLocation(g_strip_prog, "a_pos");
    static const float strip_quad[8] = {
        -1.0f, -1.0f,
         1.0f, -1.0f,
        -1.0f, -0.92f,
         1.0f, -0.92f,
    };
    glGenBuffers(1, &g_strip_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g_strip_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof strip_quad, strip_quad,
                 GL_STATIC_DRAW);
}

static void build_text_program(void) {
    int rf = 0;
    GLuint vs = compile_shader(GL_VERTEX_SHADER, TEXT_VS_SRC,
                               "text-vertex", &rf);
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER, TEXT_FS_SRC,
                               "text-fragment", &rf);
    g_text_prog = link_program(vs, fs, "text-program", &rf);
    g_text_a_pos   = glGetAttribLocation (g_text_prog, "a_pos");
    g_text_a_uv    = glGetAttribLocation (g_text_prog, "a_uv");
    g_text_u_tex   = glGetUniformLocation(g_text_prog, "u_tex");
    g_text_u_color = glGetUniformLocation(g_text_prog, "u_color");
    glGenBuffers(1, &g_text_vbo);

    /* 1×1 opaque white texture used by fill_rect. */
    glGenTextures(1, &g_white_tex);
    glBindTexture(GL_TEXTURE_2D, g_white_tex);
    unsigned char white = 0xff;
    glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE,
                 1, 1, 0, GL_LUMINANCE, GL_UNSIGNED_BYTE, &white);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
}

static void build_font_atlas(void) {
    /* Bake the printable ASCII subset of Inconsolata into an
     * ATLAS_W×ATLAS_H GL_LUMINANCE texture. stbtt_PackFontRange returns
     * non-zero on success; the 28 px range fits the 95 glyphs into
     * 256×240 (under the single-upload payload cap, see above). */
    unsigned char *pixels = (unsigned char *) calloc(ATLAS_W * ATLAS_H, 1);
    if (!pixels) {
        fprintf(stderr, "WARN: text atlas: out of memory\n");
        return;
    }
    stbtt_pack_context pc;
    int packed = 0;
    if (stbtt_PackBegin(&pc, pixels, ATLAS_W, ATLAS_H,
                        /*stride=*/0, /*padding=*/1, NULL)) {
        stbtt_PackSetOversampling(&pc,
                                  TEXT_OVERSAMPLE_X, TEXT_OVERSAMPLE_Y);
        packed = stbtt_PackFontRange(&pc, inconsolata_ttf, 0,
                                     (float) TEXT_PIXEL_HEIGHT,
                                     ATLAS_FIRST, ATLAS_COUNT,
                                     g_atlas_chars);
        stbtt_PackEnd(&pc);
    }
    if (!packed) {
        fprintf(stderr,
                "WARN: text atlas: pack failed (atlas may be partial)\n");
    }
    glGenTextures(1, &g_atlas_tex);
    glBindTexture(GL_TEXTURE_2D, g_atlas_tex);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE,
                 ATLAS_W, ATLAS_H, 0,
                 GL_LUMINANCE, GL_UNSIGNED_BYTE, pixels);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    free(pixels);

    /* Use the lowercase 'm' (index 'm' - ATLAS_FIRST) advance as the
     * monospace cell width — Inconsolata is constant-width and 'm' is
     * present. Round up: stbtt returns fractional pixels. The ascent
     * is derived from the bake's t0/t1 of 'M'. */
    if ('m' - ATLAS_FIRST < ATLAS_COUNT) {
        float xad = g_atlas_chars['m' - ATLAS_FIRST].xadvance;
        g_glyph_advance = (int)(xad + 0.5f);
        if (g_glyph_advance < 1) g_glyph_advance = 1;
    }
    if ('M' - ATLAS_FIRST < ATLAS_COUNT) {
        /* For stbtt baked quads, y0 is the negative of the ascent. */
        float yoff = -g_atlas_chars['M' - ATLAS_FIRST].yoff;
        g_glyph_ascent = (int)(yoff + 0.5f);
        if (g_glyph_ascent < 1) g_glyph_ascent = TEXT_PIXEL_HEIGHT - 4;
    }
    /* Diagnostic line — the test harness uses it to confirm atlas
     * baking completed. */
    fprintf(stdout, "sdl2: text-atlas baked=%d advance=%dpx ascent=%dpx\n",
            packed, g_glyph_advance, g_glyph_ascent);
}

void renderer_init(int screen_w, int screen_h) {
    g_screen_w = screen_w;
    g_screen_h = screen_h;
    /* Confirms the GL drawable the renderer actually paints into. If
     * this prints smaller than the SDL window (sdl2: display=WxH), the
     * framebuffer is being scaled up by the pane and text will look
     * coarse regardless of the atlas bake size. */
    fprintf(stdout, "sdl2: renderer drawable=%dx%d\n", screen_w, screen_h);
    build_user_program_initial();
    build_strip_program();
    build_text_program();
    build_font_atlas();
}

void renderer_set_screen_size(int w, int h) {
    g_screen_w = w;
    g_screen_h = h;
}

void renderer_shutdown(void) {
    if (g_user_prog)  { glDeleteProgram(g_user_prog);  g_user_prog  = 0; }
    if (g_strip_prog) { glDeleteProgram(g_strip_prog); g_strip_prog = 0; }
    if (g_text_prog)  { glDeleteProgram(g_text_prog);  g_text_prog  = 0; }
    if (g_user_vbo)   { glDeleteBuffers(1, &g_user_vbo);  g_user_vbo  = 0; }
    if (g_strip_vbo)  { glDeleteBuffers(1, &g_strip_vbo); g_strip_vbo = 0; }
    if (g_text_vbo)   { glDeleteBuffers(1, &g_text_vbo);  g_text_vbo  = 0; }
    if (g_white_tex)  { glDeleteTextures(1, &g_white_tex); g_white_tex = 0; }
    if (g_atlas_tex)  { glDeleteTextures(1, &g_atlas_tex); g_atlas_tex = 0; }
    if (g_audio_tex)  { glDeleteTextures(1, &g_audio_tex); g_audio_tex = 0; }
}
