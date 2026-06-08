/* modeset — Pavel's WebGL fluid sim, ported to wasm-posix-kernel via GLES2.
 *
 * Every pass is a fragment shader. The fluid pipeline lives in
 * ping-pong RGBA16F framebuffers; the only CPU work per frame is
 * draining /dev/input/mice for the pointer state and uploading the
 * splat uniforms. Reference:
 *   https://github.com/PavelDoGreat/WebGL-Fluid-Simulation/blob/master/script.js
 *
 * Pipeline (per frame, identical structure to Pavel's step()):
 *   1. curl                velocity → curl
 *   2. vorticity           curl → injected back into velocity
 *   3. divergence          velocity → divergence
 *   4. pressure decay      pressure *= PRESSURE
 *   5. pressure Jacobi×20  relax pressure against divergence
 *   6. gradient subtract   velocity -= ∇pressure
 *   7. advect velocity     velocity = sample(velocity, vUv - dt*v*texelSize)
 *   8. advect dye          dye      = sample(dye, vUv - dt*v*dyeTexelSize)
 *   9. display             scanout: dye → canvas
 *
 * Bloom and sunrays are not in this pass — added on top once the core
 * sim is verified rendering on the GPU. Without them the dye trails
 * look subdued vs paveldogreat.github.io but the fluid physics matches.
 *
 * Sim resolution 256×256, dye resolution 1024×1024 (Pavel's defaults
 * for SIM_RESOLUTION=256, DYE_RESOLUTION=1024; the GPU can keep up
 * with full-res unlike the previous CPU port).
 *
 * argv: ignored; the canvas size is driven by the EGL surface. The
 * host's gldemo registry binds the canvas the page attached via
 * kernel.attachGlCanvas(pid, canvas).
 */

#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <drm/drm.h>
#include <drm/drm_fourcc.h>
#include <drm/drm_mode.h>
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

#define FAIL(msg) do { perror(msg); return 1; } while (0)

/* GLES2 headers don't carry the WebGL2 internal-format / type constants
 * Pavel needs. The host bridge passes the GLenum value through to the
 * underlying WebGL2 context, so the value is what matters. */
#define GL_RGBA16F                 0x881A
#define GL_HALF_FLOAT              0x140B
#define GL_COLOR_ATTACHMENT0_EXT   0x8CE0   /* same as GL_COLOR_ATTACHMENT0 */

/* Must match the page's <canvas id="modeset-canvas"> dimensions —
 * drain_mouse() clamps the accumulated cursor at CANVAS_W-1, and the
 * display pass uses CANVAS_W/H as the final viewport. A robust answer
 * is eglQuerySurface (or glGetIntegerv(GL_VIEWPORT)), but neither is
 * stubbed yet; the page canvas is hardcoded 1920×1080 so we match
 * here. See docs/plans/2026-06-05-dri-session-handoff-75.md
 * §"Secondary bug: CANVAS_W=1024 vs page canvas 1920×1080". */
#define CANVAS_W 1920
#define CANVAS_H 1080
#define SIM_W    256
#define SIM_H    256
#define DYE_W    1024
#define DYE_H    1024

/* Pavel's defaults from script.js config{}. Tuned for ~60Hz at SIM=256. */
#define DT                  (1.0f / 60.0f)
#define VEL_DISSIPATION     0.2f
#define DEN_DISSIPATION     1.0f
#define PRESSURE_RETENTION  0.8f
#define PRESSURE_ITERS      20
#define VORT_CURL           30.0f
#define SPLAT_FORCE         6000.0f
#define SPLAT_RADIUS_BASE   0.0025f
#define COLOR_PERIOD_FRAMES 6
#define COLOR_BRIGHTNESS    0.15f

/* ────────────────────────────────────────────────────────────────────
 * Shaders — Pavel's GLSL, mostly verbatim. Precision qualifiers are
 * explicit on every fragment input because GLES 1.00 requires them.
 * ──────────────────────────────────────────────────────────────────── */

static const char base_vs_src[] =
    "precision highp float;\n"
    "attribute vec2 aPosition;\n"
    "varying vec2 vUv;\n"
    "varying vec2 vL;\n"
    "varying vec2 vR;\n"
    "varying vec2 vT;\n"
    "varying vec2 vB;\n"
    "uniform vec2 texelSize;\n"
    "void main () {\n"
    "    vUv = aPosition * 0.5 + 0.5;\n"
    "    vL = vUv - vec2(texelSize.x, 0.0);\n"
    "    vR = vUv + vec2(texelSize.x, 0.0);\n"
    "    vT = vUv + vec2(0.0, texelSize.y);\n"
    "    vB = vUv - vec2(0.0, texelSize.y);\n"
    "    gl_Position = vec4(aPosition, 0.0, 1.0);\n"
    "}\n";

static const char curl_fs_src[] =
    "precision mediump float;\n"
    "precision mediump sampler2D;\n"
    "varying highp vec2 vUv;\n"
    "varying highp vec2 vL;\n"
    "varying highp vec2 vR;\n"
    "varying highp vec2 vT;\n"
    "varying highp vec2 vB;\n"
    "uniform sampler2D uVelocity;\n"
    "void main () {\n"
    "    float L = texture2D(uVelocity, vL).y;\n"
    "    float R = texture2D(uVelocity, vR).y;\n"
    "    float T = texture2D(uVelocity, vT).x;\n"
    "    float B = texture2D(uVelocity, vB).x;\n"
    "    float vorticity = R - L - T + B;\n"
    "    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);\n"
    "}\n";

static const char vorticity_fs_src[] =
    "precision highp float;\n"
    "precision highp sampler2D;\n"
    "varying vec2 vUv;\n"
    "varying vec2 vL;\n"
    "varying vec2 vR;\n"
    "varying vec2 vT;\n"
    "varying vec2 vB;\n"
    "uniform sampler2D uVelocity;\n"
    "uniform sampler2D uCurl;\n"
    "uniform float curl;\n"
    "uniform float dt;\n"
    "void main () {\n"
    "    float L = texture2D(uCurl, vL).x;\n"
    "    float R = texture2D(uCurl, vR).x;\n"
    "    float T = texture2D(uCurl, vT).x;\n"
    "    float B = texture2D(uCurl, vB).x;\n"
    "    float C = texture2D(uCurl, vUv).x;\n"
    "    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));\n"
    "    force /= length(force) + 0.0001;\n"
    "    force *= curl * C;\n"
    "    force.y *= -1.0;\n"
    "    vec2 velocity = texture2D(uVelocity, vUv).xy;\n"
    "    velocity += force * dt;\n"
    "    velocity = min(max(velocity, -1000.0), 1000.0);\n"
    "    gl_FragColor = vec4(velocity, 0.0, 1.0);\n"
    "}\n";

static const char divergence_fs_src[] =
    "precision mediump float;\n"
    "precision mediump sampler2D;\n"
    "varying highp vec2 vUv;\n"
    "varying highp vec2 vL;\n"
    "varying highp vec2 vR;\n"
    "varying highp vec2 vT;\n"
    "varying highp vec2 vB;\n"
    "uniform sampler2D uVelocity;\n"
    "void main () {\n"
    "    float L = texture2D(uVelocity, vL).x;\n"
    "    float R = texture2D(uVelocity, vR).x;\n"
    "    float T = texture2D(uVelocity, vT).y;\n"
    "    float B = texture2D(uVelocity, vB).y;\n"
    "    vec2 C = texture2D(uVelocity, vUv).xy;\n"
    "    if (vL.x < 0.0) { L = -C.x; }\n"
    "    if (vR.x > 1.0) { R = -C.x; }\n"
    "    if (vT.y > 1.0) { T = -C.y; }\n"
    "    if (vB.y < 0.0) { B = -C.y; }\n"
    "    float div = 0.5 * (R - L + T - B);\n"
    "    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);\n"
    "}\n";

static const char clear_fs_src[] =
    "precision mediump float;\n"
    "precision mediump sampler2D;\n"
    "varying highp vec2 vUv;\n"
    "uniform sampler2D uTexture;\n"
    "uniform float value;\n"
    "void main () {\n"
    "    gl_FragColor = value * texture2D(uTexture, vUv);\n"
    "}\n";

static const char pressure_fs_src[] =
    "precision mediump float;\n"
    "precision mediump sampler2D;\n"
    "varying highp vec2 vUv;\n"
    "varying highp vec2 vL;\n"
    "varying highp vec2 vR;\n"
    "varying highp vec2 vT;\n"
    "varying highp vec2 vB;\n"
    "uniform sampler2D uPressure;\n"
    "uniform sampler2D uDivergence;\n"
    "void main () {\n"
    "    float L = texture2D(uPressure, vL).x;\n"
    "    float R = texture2D(uPressure, vR).x;\n"
    "    float T = texture2D(uPressure, vT).x;\n"
    "    float B = texture2D(uPressure, vB).x;\n"
    "    float divergence = texture2D(uDivergence, vUv).x;\n"
    "    float pressure = (L + R + B + T - divergence) * 0.25;\n"
    "    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);\n"
    "}\n";

static const char gradsub_fs_src[] =
    "precision mediump float;\n"
    "precision mediump sampler2D;\n"
    "varying highp vec2 vUv;\n"
    "varying highp vec2 vL;\n"
    "varying highp vec2 vR;\n"
    "varying highp vec2 vT;\n"
    "varying highp vec2 vB;\n"
    "uniform sampler2D uPressure;\n"
    "uniform sampler2D uVelocity;\n"
    "void main () {\n"
    "    float L = texture2D(uPressure, vL).x;\n"
    "    float R = texture2D(uPressure, vR).x;\n"
    "    float T = texture2D(uPressure, vT).x;\n"
    "    float B = texture2D(uPressure, vB).x;\n"
    "    vec2 velocity = texture2D(uVelocity, vUv).xy;\n"
    "    velocity.xy -= vec2(R - L, T - B);\n"
    "    gl_FragColor = vec4(velocity, 0.0, 1.0);\n"
    "}\n";

static const char advect_fs_src[] =
    "precision highp float;\n"
    "precision highp sampler2D;\n"
    "varying vec2 vUv;\n"
    "uniform sampler2D uVelocity;\n"
    "uniform sampler2D uSource;\n"
    "uniform vec2 texelSize;\n"
    "uniform float dt;\n"
    "uniform float dissipation;\n"
    "void main () {\n"
    "    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;\n"
    "    vec4 result = texture2D(uSource, coord);\n"
    "    float decay = 1.0 + dissipation * dt;\n"
    "    gl_FragColor = result / decay;\n"
    "}\n";

static const char splat_fs_src[] =
    "precision highp float;\n"
    "precision highp sampler2D;\n"
    "varying vec2 vUv;\n"
    "uniform sampler2D uTarget;\n"
    "uniform float aspectRatio;\n"
    "uniform vec3 color;\n"
    "uniform vec2 point;\n"
    "uniform float radius;\n"
    "void main () {\n"
    "    vec2 p = vUv - point.xy;\n"
    "    p.x *= aspectRatio;\n"
    "    vec3 splat = exp(-dot(p, p) / radius) * color;\n"
    "    vec3 base = texture2D(uTarget, vUv).xyz;\n"
    "    gl_FragColor = vec4(base + splat, 1.0);\n"
    "}\n";

static const char display_fs_src[] =
    "precision highp float;\n"
    "precision highp sampler2D;\n"
    "varying vec2 vUv;\n"
    "uniform sampler2D uTexture;\n"
    "void main () {\n"
    "    vec3 c = texture2D(uTexture, vUv).rgb;\n"
    "    gl_FragColor = vec4(c, 1.0);\n"
    "}\n";

/* ────────────────────────────────────────────────────────────────────
 * GL helpers
 * ──────────────────────────────────────────────────────────────────── */

static GLuint compile_shader(GLenum type, const char *src, const char *label) {
    GLuint sh = glCreateShader(type);
    const char *p = src;
    glShaderSource(sh, 1, &p, NULL);
    glCompileShader(sh);
    GLint ok = 0;
    glGetShaderiv(sh, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[1024];
        GLsizei len = 0;
        glGetShaderInfoLog(sh, sizeof log, &len, log);
        fprintf(stderr, "shader compile FAILED [%s]: %s\n", label, log);
    }
    return sh;
}

static GLuint link_program(GLuint vs, GLuint fs, const char *label) {
    GLuint p = glCreateProgram();
    glAttachShader(p, vs);
    glAttachShader(p, fs);
    glBindAttribLocation(p, 0, "aPosition");
    glLinkProgram(p);
    GLint ok = 0;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) {
        char log[1024];
        GLsizei len = 0;
        glGetProgramInfoLog(p, sizeof log, &len, log);
        fprintf(stderr, "program link FAILED [%s]: %s\n", label, log);
    }
    return p;
}

/* The fullscreen quad: two triangles in clip space [-1,1]^2. Pavel's
 * base_vs_src derives vUv = aPosition * 0.5 + 0.5 so the quad maps to
 * a unit-square texcoord domain. */
static GLuint quad_vbo = 0;

static void setup_quad(void) {
    static const float verts[] = {
        -1.0f, -1.0f,
         1.0f, -1.0f,
        -1.0f,  1.0f,
         1.0f,  1.0f,
    };
    glGenBuffers(1, &quad_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, quad_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof verts, verts, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, (const void *)0);
}

static void blit_quad(void) {
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}

/* ────────────────────────────────────────────────────────────────────
 * Render targets (FBO + texture) and ping-pong wrappers
 * ──────────────────────────────────────────────────────────────────── */

typedef struct {
    GLuint tex;
    GLuint fbo;
    int    w;
    int    h;
} RT;

typedef struct {
    RT read;
    RT write;
} DoubleRT;

static RT create_rt(int w, int h, GLint filter) {
    RT r = { 0, 0, w, h };
    glGenTextures(1, &r.tex);
    glBindTexture(GL_TEXTURE_2D, r.tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S,     GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T,     GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, w, h, 0, GL_RGBA, GL_HALF_FLOAT, NULL);

    glGenFramebuffers(1, &r.fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, r.fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0_EXT,
                           GL_TEXTURE_2D, r.tex, 0);
    GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    if (status != GL_FRAMEBUFFER_COMPLETE) {
        fprintf(stderr, "FBO incomplete: 0x%x (size %dx%d)\n", status, w, h);
    }
    /* glTexImage2D(NULL) leaves texture content undefined per GL spec.
     * Without this clear, pressure/curl/divergence FBOs start with
     * arbitrary bits — often Inf/NaN under the half-float interpretation
     * — and the pressure solver propagates those into velocity, after
     * which advect_dye samples dye at NaN coords and returns 0, leaving
     * the canvas permanently blank. */
    glViewport(0, 0, w, h);
    glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    return r;
}

static DoubleRT create_doublert(int w, int h, GLint filter) {
    DoubleRT d;
    d.read  = create_rt(w, h, filter);
    d.write = create_rt(w, h, filter);
    return d;
}

static void swap_rt(DoubleRT *d) {
    RT t = d->read;
    d->read = d->write;
    d->write = t;
}

/* ────────────────────────────────────────────────────────────────────
 * Program structs — bind a program and feed it uniforms via labelled
 * fields rather than re-running glGetUniformLocation per frame.
 * ──────────────────────────────────────────────────────────────────── */

struct prog_simple { GLuint id; GLint texelSize, uTexture; };
struct prog_curl   { GLuint id; GLint texelSize, uVelocity; };
struct prog_vort   { GLuint id; GLint texelSize, uVelocity, uCurl, curl, dt; };
struct prog_div    { GLuint id; GLint texelSize, uVelocity; };
struct prog_clear  { GLuint id; GLint texelSize, uTexture, value; };
struct prog_press  { GLuint id; GLint texelSize, uPressure, uDivergence; };
struct prog_grad   { GLuint id; GLint texelSize, uPressure, uVelocity; };
struct prog_advect { GLuint id; GLint texelSize, uVelocity, uSource, dt, dissipation; };
struct prog_splat  { GLuint id; GLint texelSize, uTarget, aspectRatio, color, point, radius; };

static struct prog_curl   curl_prog;
static struct prog_vort   vort_prog;
static struct prog_div    div_prog;
static struct prog_clear  clear_prog;
static struct prog_press  press_prog;
static struct prog_grad   grad_prog;
static struct prog_advect advect_prog;
static struct prog_splat  splat_prog;
static struct prog_simple display_prog;

static GLuint compile_link(const char *vs_src, const char *fs_src, const char *label) {
    GLuint vs = compile_shader(GL_VERTEX_SHADER,   vs_src, label);
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER, fs_src, label);
    GLuint p  = link_program(vs, fs, label);
    glDeleteShader(vs);
    glDeleteShader(fs);
    return p;
}

static void build_programs(void) {
    curl_prog.id = compile_link(base_vs_src, curl_fs_src, "curl");
    curl_prog.texelSize = glGetUniformLocation(curl_prog.id, "texelSize");
    curl_prog.uVelocity = glGetUniformLocation(curl_prog.id, "uVelocity");

    vort_prog.id = compile_link(base_vs_src, vorticity_fs_src, "vorticity");
    vort_prog.texelSize = glGetUniformLocation(vort_prog.id, "texelSize");
    vort_prog.uVelocity = glGetUniformLocation(vort_prog.id, "uVelocity");
    vort_prog.uCurl     = glGetUniformLocation(vort_prog.id, "uCurl");
    vort_prog.curl      = glGetUniformLocation(vort_prog.id, "curl");
    vort_prog.dt        = glGetUniformLocation(vort_prog.id, "dt");

    div_prog.id = compile_link(base_vs_src, divergence_fs_src, "divergence");
    div_prog.texelSize = glGetUniformLocation(div_prog.id, "texelSize");
    div_prog.uVelocity = glGetUniformLocation(div_prog.id, "uVelocity");

    clear_prog.id = compile_link(base_vs_src, clear_fs_src, "clear");
    clear_prog.texelSize = glGetUniformLocation(clear_prog.id, "texelSize");
    clear_prog.uTexture  = glGetUniformLocation(clear_prog.id, "uTexture");
    clear_prog.value     = glGetUniformLocation(clear_prog.id, "value");

    press_prog.id = compile_link(base_vs_src, pressure_fs_src, "pressure");
    press_prog.texelSize   = glGetUniformLocation(press_prog.id, "texelSize");
    press_prog.uPressure   = glGetUniformLocation(press_prog.id, "uPressure");
    press_prog.uDivergence = glGetUniformLocation(press_prog.id, "uDivergence");

    grad_prog.id = compile_link(base_vs_src, gradsub_fs_src, "gradsub");
    grad_prog.texelSize = glGetUniformLocation(grad_prog.id, "texelSize");
    grad_prog.uPressure = glGetUniformLocation(grad_prog.id, "uPressure");
    grad_prog.uVelocity = glGetUniformLocation(grad_prog.id, "uVelocity");

    advect_prog.id = compile_link(base_vs_src, advect_fs_src, "advect");
    advect_prog.texelSize   = glGetUniformLocation(advect_prog.id, "texelSize");
    advect_prog.uVelocity   = glGetUniformLocation(advect_prog.id, "uVelocity");
    advect_prog.uSource     = glGetUniformLocation(advect_prog.id, "uSource");
    advect_prog.dt          = glGetUniformLocation(advect_prog.id, "dt");
    advect_prog.dissipation = glGetUniformLocation(advect_prog.id, "dissipation");

    splat_prog.id = compile_link(base_vs_src, splat_fs_src, "splat");
    splat_prog.texelSize   = glGetUniformLocation(splat_prog.id, "texelSize");
    splat_prog.uTarget     = glGetUniformLocation(splat_prog.id, "uTarget");
    splat_prog.aspectRatio = glGetUniformLocation(splat_prog.id, "aspectRatio");
    splat_prog.color       = glGetUniformLocation(splat_prog.id, "color");
    splat_prog.point       = glGetUniformLocation(splat_prog.id, "point");
    splat_prog.radius      = glGetUniformLocation(splat_prog.id, "radius");

    display_prog.id = compile_link(base_vs_src, display_fs_src, "display");
    display_prog.texelSize = glGetUniformLocation(display_prog.id, "texelSize");
    display_prog.uTexture  = glGetUniformLocation(display_prog.id, "uTexture");
}

/* ────────────────────────────────────────────────────────────────────
 * Pipeline state and per-pass functions
 * ──────────────────────────────────────────────────────────────────── */

static DoubleRT velocity;
static DoubleRT dye;
static DoubleRT pressure;
static RT       divergence_rt;
static RT       curl_rt;

static const float SIM_TEXEL_X = 1.0f / (float)SIM_W;
static const float SIM_TEXEL_Y = 1.0f / (float)SIM_H;
static const float DYE_TEXEL_X = 1.0f / (float)DYE_W;
static const float DYE_TEXEL_Y = 1.0f / (float)DYE_H;

static void bind_target(RT target) {
    glBindFramebuffer(GL_FRAMEBUFFER, target.fbo);
    glViewport(0, 0, target.w, target.h);
}

static void pass_curl(void) {
    glUseProgram(curl_prog.id);
    glUniform2f(curl_prog.texelSize, SIM_TEXEL_X, SIM_TEXEL_Y);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(curl_prog.uVelocity, 0);
    bind_target(curl_rt);
    blit_quad();
}

static void pass_vorticity(void) {
    glUseProgram(vort_prog.id);
    glUniform2f(vort_prog.texelSize, SIM_TEXEL_X, SIM_TEXEL_Y);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(vort_prog.uVelocity, 0);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, curl_rt.tex);
    glUniform1i(vort_prog.uCurl, 1);
    glUniform1f(vort_prog.curl, VORT_CURL);
    glUniform1f(vort_prog.dt, DT);
    bind_target(velocity.write);
    blit_quad();
    swap_rt(&velocity);
}

static void pass_divergence(void) {
    glUseProgram(div_prog.id);
    glUniform2f(div_prog.texelSize, SIM_TEXEL_X, SIM_TEXEL_Y);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(div_prog.uVelocity, 0);
    bind_target(divergence_rt);
    blit_quad();
}

static void pass_pressure_decay(void) {
    glUseProgram(clear_prog.id);
    glUniform2f(clear_prog.texelSize, SIM_TEXEL_X, SIM_TEXEL_Y);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, pressure.read.tex);
    glUniform1i(clear_prog.uTexture, 0);
    glUniform1f(clear_prog.value, PRESSURE_RETENTION);
    bind_target(pressure.write);
    blit_quad();
    swap_rt(&pressure);
}

static void pass_pressure_jacobi(void) {
    glUseProgram(press_prog.id);
    glUniform2f(press_prog.texelSize, SIM_TEXEL_X, SIM_TEXEL_Y);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, divergence_rt.tex);
    glUniform1i(press_prog.uDivergence, 0);
    for (int i = 0; i < PRESSURE_ITERS; i++) {
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, pressure.read.tex);
        glUniform1i(press_prog.uPressure, 1);
        bind_target(pressure.write);
        blit_quad();
        swap_rt(&pressure);
    }
}

static void pass_gradient_subtract(void) {
    glUseProgram(grad_prog.id);
    glUniform2f(grad_prog.texelSize, SIM_TEXEL_X, SIM_TEXEL_Y);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, pressure.read.tex);
    glUniform1i(grad_prog.uPressure, 0);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(grad_prog.uVelocity, 1);
    bind_target(velocity.write);
    blit_quad();
    swap_rt(&velocity);
}

static void pass_advect_velocity(void) {
    glUseProgram(advect_prog.id);
    glUniform2f(advect_prog.texelSize, SIM_TEXEL_X, SIM_TEXEL_Y);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(advect_prog.uVelocity, 0);
    glUniform1i(advect_prog.uSource, 0);   /* same texture as source */
    glUniform1f(advect_prog.dt, DT);
    glUniform1f(advect_prog.dissipation, VEL_DISSIPATION);
    bind_target(velocity.write);
    blit_quad();
    swap_rt(&velocity);
}

static void pass_advect_dye(void) {
    glUseProgram(advect_prog.id);
    glUniform2f(advect_prog.texelSize, SIM_TEXEL_X, SIM_TEXEL_Y);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(advect_prog.uVelocity, 0);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, dye.read.tex);
    glUniform1i(advect_prog.uSource, 1);
    glUniform1f(advect_prog.dt, DT);
    glUniform1f(advect_prog.dissipation, DEN_DISSIPATION);
    bind_target(dye.write);
    blit_quad();
    swap_rt(&dye);
}

static void splat_velocity(float u, float v, float dx, float dy, float aspect, float radius_sq) {
    glUseProgram(splat_prog.id);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(splat_prog.uTarget, 0);
    glUniform1f(splat_prog.aspectRatio, aspect);
    glUniform2f(splat_prog.point, u, v);
    glUniform3f(splat_prog.color, dx, -dy, 0.0f);  /* y flip — sim space is y-down */
    glUniform1f(splat_prog.radius, radius_sq);
    bind_target(velocity.write);
    blit_quad();
    swap_rt(&velocity);
}

static void splat_dye(float u, float v, float r, float g, float b, float aspect, float radius_sq) {
    glUseProgram(splat_prog.id);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, dye.read.tex);
    glUniform1i(splat_prog.uTarget, 0);
    glUniform1f(splat_prog.aspectRatio, aspect);
    glUniform2f(splat_prog.point, u, v);
    glUniform3f(splat_prog.color, r, g, b);
    glUniform1f(splat_prog.radius, radius_sq);
    bind_target(dye.write);
    blit_quad();
    swap_rt(&dye);
}

static void pass_display(int canvas_w, int canvas_h) {
    glUseProgram(display_prog.id);
    glUniform2f(display_prog.texelSize, 1.0f / (float)canvas_w, 1.0f / (float)canvas_h);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, dye.read.tex);
    glUniform1i(display_prog.uTexture, 0);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, canvas_w, canvas_h);
    blit_quad();
}

/* ────────────────────────────────────────────────────────────────────
 * Mouse, color cycling, splat trigger
 * ──────────────────────────────────────────────────────────────────── */

static uint32_t rng_state = 0xdeadbeefu;
static uint32_t xs32(void) {
    uint32_t s = rng_state;
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    rng_state = s;
    return s;
}
static float frand(void) { return (float)xs32() / 4294967295.0f; }

static float cur_r = 0.0f, cur_g = 0.0f, cur_b = 0.0f;

/* Pavel's generateColor(): random hue at constant value=COLOR_BRIGHTNESS. */
static void regenerate_color(void) {
    float h = frand();   /* hue ∈ [0, 1) */
    float s = 1.0f, v = COLOR_BRIGHTNESS;
    float i = floorf(h * 6.0f);
    float f = h * 6.0f - i;
    float p = v * (1.0f - s);
    float q = v * (1.0f - f * s);
    float t = v * (1.0f - (1.0f - f) * s);
    switch ((int)i % 6) {
        case 0: cur_r = v; cur_g = t; cur_b = p; break;
        case 1: cur_r = q; cur_g = v; cur_b = p; break;
        case 2: cur_r = p; cur_g = v; cur_b = t; break;
        case 3: cur_r = p; cur_g = q; cur_b = v; break;
        case 4: cur_r = t; cur_g = p; cur_b = v; break;
        default: cur_r = v; cur_g = p; cur_b = q; break;
    }
}

static void drain_mouse(int fd, int *cx, int *cy, uint8_t *buttons, int W, int H) {
    uint8_t pkt[3];
    for (;;) {
        ssize_t n = read(fd, pkt, sizeof pkt);
        if (n != 3) break;
        *buttons = pkt[0] & 0x07;
        *cx += (int)(int8_t)pkt[1];
        *cy -= (int)(int8_t)pkt[2];
        if (*cx < 0) *cx = 0; else if (*cx >= W) *cx = W - 1;
        if (*cy < 0) *cy = 0; else if (*cy >= H) *cy = H - 1;
    }
}

/* ────────────────────────────────────────────────────────────────────
 * main: EGL + GLES2 setup, build sim, run loop
 * ──────────────────────────────────────────────────────────────────── */

#define KMS_BO_COUNT 2

static int kms_drm_fd = -1;
static struct gbm_device *kms_gbm = NULL;
static struct gbm_bo *kms_bos[KMS_BO_COUNT] = { 0 };
static uint32_t kms_fb_ids[KMS_BO_COUNT] = { 0 };
static uint32_t kms_crtc_id = 0;
static uint32_t kms_conn_id = 0;
static drmModeModeInfo kms_mode;
static int kms_current_fb = 0;

/* GL rendering still flows through EGL_DEFAULT_DISPLAY; this only
 * stands up the page-flip pacing channel. */
static int setup_kms(void) {
    kms_drm_fd = open("/dev/dri/card0", O_RDWR | O_NONBLOCK);
    if (kms_drm_fd < 0) { perror("open /dev/dri/card0"); return 1; }

    if (drmSetMaster(kms_drm_fd) != 0) {
        perror("drmSetMaster"); return 1;
    }

    drmModeResPtr res = drmModeGetResources(kms_drm_fd);
    if (!res || res->count_crtcs < 1 || res->count_connectors < 1) {
        fprintf(stderr, "drmModeGetResources: empty\n");
        return 1;
    }
    kms_crtc_id = res->crtcs[0];
    kms_conn_id = res->connectors[0];

    drmModeConnectorPtr conn = drmModeGetConnector(kms_drm_fd, kms_conn_id);
    if (!conn || conn->connection != DRM_MODE_CONNECTED ||
        conn->count_modes < 1) {
        fprintf(stderr, "drmModeGetConnector: no usable connector\n");
        return 1;
    }
    kms_mode = conn->modes[0];

    drmModeFreeConnector(conn);
    drmModeFreeResources(res);

    kms_gbm = gbm_create_device(kms_drm_fd);
    if (!kms_gbm) { perror("gbm_create_device"); return 1; }

    for (int i = 0; i < KMS_BO_COUNT; i++) {
        kms_bos[i] = gbm_bo_create(kms_gbm, CANVAS_W, CANVAS_H,
                                   GBM_FORMAT_XRGB8888,
                                   GBM_BO_USE_SCANOUT);
        if (!kms_bos[i]) { perror("gbm_bo_create"); return 1; }

        uint32_t handle = gbm_bo_get_handle(kms_bos[i]).u32;
        uint32_t stride = gbm_bo_get_stride(kms_bos[i]);
        uint32_t handles[4] = { handle, 0, 0, 0 };
        uint32_t pitches[4] = { stride, 0, 0, 0 };
        uint32_t offsets[4] = { 0, 0, 0, 0 };
        if (drmModeAddFB2(kms_drm_fd, CANVAS_W, CANVAS_H,
                          DRM_FORMAT_XRGB8888,
                          handles, pitches, offsets,
                          &kms_fb_ids[i], 0) != 0) {
            perror("drmModeAddFB2"); return 1;
        }
    }

    /* PRIME-export the front BO once so the page description is
     * accurate — the fd itself is unused. */
    int prime_fd = gbm_bo_get_fd(kms_bos[0]);
    if (prime_fd >= 0) close(prime_fd);

    if (drmModeSetCrtc(kms_drm_fd, kms_crtc_id, kms_fb_ids[0],
                       0, 0, &kms_conn_id, 1, &kms_mode) != 0) {
        perror("drmModeSetCrtc"); return 1;
    }

    return 0;
}

/* O_NONBLOCK + read+usleep(1000) instead of poll(): see handoff
 * #79 Finding 1. sys_poll's 50 ms host-retry would clamp this loop
 * to ~20 FPS when no other syscall traffic triggers a broad wake. */
static int kms_pageflip_wait(void) {
    int next_fb = kms_current_fb ^ 1;
    if (drmModePageFlip(kms_drm_fd, kms_crtc_id, kms_fb_ids[next_fb],
                        DRM_MODE_PAGE_FLIP_EVENT, NULL) != 0) {
        perror("drmModePageFlip");
        return 1;
    }

    struct drm_event_vblank ev;
    for (;;) {
        ssize_t n = read(kms_drm_fd, &ev, sizeof(ev));
        if (n == (ssize_t)sizeof(ev)) break;
        if (n < 0 && errno == EAGAIN) {
            usleep(1000);
            continue;
        }
        fprintf(stderr, "drm event read failed: n=%zd errno=%d\n",
                n, errno);
        return 1;
    }

    kms_current_fb = next_fb;
    return 0;
}

int main(int argc, char **argv) {
    (void)argc; (void)argv;

    int mouse = open("/dev/input/mice", O_RDONLY | O_NONBLOCK);
    if (mouse < 0) FAIL("open /dev/input/mice");

    if (setup_kms() != 0) return 8;

    EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    EGLint maj = 0, min = 0;
    if (!eglInitialize(dpy, &maj, &min)) return 1;

    EGLint cfg_attribs[] = {
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_NONE,
    };
    EGLConfig cfg;
    EGLint num_cfg = 0;
    if (!eglChooseConfig(dpy, cfg_attribs, &cfg, 1, &num_cfg) || num_cfg < 1) return 2;
    if (!eglBindAPI(EGL_OPENGL_ES_API)) return 3;

    EGLint ctx_attribs[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    EGLContext ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, ctx_attribs);
    if (ctx == EGL_NO_CONTEXT) return 4;

    EGLSurface surf = eglCreateWindowSurface(dpy, cfg, 0, 0);
    if (surf == EGL_NO_SURFACE) return 5;
    if (!eglMakeCurrent(dpy, surf, surf, ctx)) return 6;

    setup_quad();
    build_programs();

    velocity      = create_doublert(SIM_W, SIM_H, GL_LINEAR);
    dye           = create_doublert(DYE_W, DYE_H, GL_LINEAR);
    pressure      = create_doublert(SIM_W, SIM_H, GL_NEAREST);
    divergence_rt = create_rt(SIM_W, SIM_H, GL_NEAREST);
    curl_rt       = create_rt(SIM_W, SIM_H, GL_NEAREST);

    float aspect = (float)CANVAS_W / (float)CANVAS_H;
    float splat_radius_sq = SPLAT_RADIUS_BASE * (aspect > 1.0f ? aspect : 1.0f);

    int cursor_x = CANVAS_W / 2;
    int cursor_y = CANVAS_H / 2;
    int prev_cursor_x = cursor_x;
    int prev_cursor_y = cursor_y;
    int color_timer = 0;
    uint8_t buttons = 0, prev_buttons = 0;

    for (uint64_t frame = 0; ; frame++) {
        drain_mouse(mouse, &cursor_x, &cursor_y, &buttons, CANVAS_W, CANVAS_H);

        uint8_t click_edge = buttons & ~prev_buttons;
        prev_buttons = buttons;

        if (click_edge) {
            regenerate_color();
            float u = (float)cursor_x / (float)CANVAS_W;
            float v = 1.0f - (float)cursor_y / (float)CANVAS_H;
            float dx = 600.0f * (frand() - 0.5f);
            float dy = 600.0f * (frand() - 0.5f);
            splat_velocity(u, v, dx, dy, aspect, splat_radius_sq);
            splat_dye(u, v, cur_r * 3.0f, cur_g * 3.0f, cur_b * 3.0f,
                      aspect, splat_radius_sq);
            prev_cursor_x = cursor_x;
            prev_cursor_y = cursor_y;
        }

        int jdx = cursor_x - prev_cursor_x;
        int jdy = cursor_y - prev_cursor_y;
        int jdist = (jdx < 0 ? -jdx : jdx) + (jdy < 0 ? -jdy : jdy);
        if (buttons && jdist > 0 && jdist < 320) {
            float u = (float)cursor_x / (float)CANVAS_W;
            float v = 1.0f - (float)cursor_y / (float)CANVAS_H;
            float dx_norm = (float)jdx / (float)CANVAS_W;
            float dy_norm = (float)jdy / (float)CANVAS_H;
            if (aspect < 1.0f) dx_norm *= aspect; else dy_norm /= aspect;
            float vx = dx_norm * SPLAT_FORCE;
            float vy = dy_norm * SPLAT_FORCE;
            splat_velocity(u, v, vx, vy, aspect, splat_radius_sq);
            splat_dye(u, v, cur_r, cur_g, cur_b, aspect, splat_radius_sq);
        }
        prev_cursor_x = cursor_x;
        prev_cursor_y = cursor_y;

        if (++color_timer >= COLOR_PERIOD_FRAMES) {
            color_timer = 0;
            regenerate_color();
        }

        pass_curl();
        pass_vorticity();
        pass_divergence();
        pass_pressure_decay();
        pass_pressure_jacobi();
        pass_gradient_subtract();
        pass_advect_velocity();
        pass_advect_dye();
        pass_display(CANVAS_W, CANVAS_H);

        if (!eglSwapBuffers(dpy, surf)) return 7;
        if (kms_pageflip_wait() != 0) return 9;
    }
}
