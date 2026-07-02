/* modeset — Pavel's WebGL fluid sim with bloom + sunrays + shading.
 *
 * Full port of github.com/PavelDoGreat/WebGL-Fluid-Simulation/script.js
 * to GLES2 + EGL on wasm-posix-kernel. All shader sources, default
 * config values, and pass ordering match Pavel's repo exactly; the
 * only deliberate omissions are (a) the dithering noise PNG (would
 * add an asset dep for negligible visual gain — banding is well below
 * 8-bit perception on dark backgrounds) and (b) the MANUAL_FILTERING
 * advect fallback (we always have `OES_texture_float_linear` via the
 * host's WebGL2 context, so the simple path always wins).
 *
 * Pipeline per frame:
 *   1. drain_mouse        — read PS/2 packets from /dev/input/mice
 *   2. apply_inputs       — splat velocity + dye on pointer motion
 *   3. step               — curl, vorticity, divergence,
 *                           pressure-clear, Jacobi×20, gradient-sub,
 *                           advect velocity, advect dye
 *   4. apply_bloom        — prefilter + N-level Gaussian pyramid
 *                           (down + additive up) + final intensity
 *   5. apply_sunrays      — mask alpha + 16-step radial sweep
 *   6. blur sunrays       — 1 horizontal + 1 vertical separable pass
 *   7. render             — display with #defines for SHADING +
 *                           BLOOM + SUNRAYS, additive composite
 *   8. eglSwapBuffers + KMS PAGE_FLIP wait
 *
 * Resolutions are derived from Pavel's getResolution(N) for landscape
 * 1920×1080 (CANVAS_W/H), hardcoded to keep the C side allocation-free:
 *     SIM_RESOLUTION      = 128  → 228×128   velocity, pressure, curl, div
 *     DYE_RESOLUTION      = 1024 → 1820×1024 dye
 *     BLOOM_RESOLUTION    = 256  → 456×256   bloom base + chain
 *     SUNRAYS_RESOLUTION  = 196  → 349×196   sunrays + sunraysTemp
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

/* GLES2 headers don't carry the WebGL2 internal-format / type
 * constants Pavel needs. The host bridge forwards the GLenum value
 * verbatim to the underlying WebGL2 context, so the value is what
 * matters. */
#define GL_RGBA16F                 0x881A
#define GL_HALF_FLOAT              0x140B
#define GL_COLOR_ATTACHMENT0_EXT   0x8CE0   /* same as GL_COLOR_ATTACHMENT0 */

/* Canvas dims hardcoded to match the Modeset.tsx pane (1920×1080).
 * drain_mouse() clamps the accumulated cursor against these; the
 * display pass viewport is also CANVAS_W/H. */
#define CANVAS_W 1920
#define CANVAS_H 1080

/* Pavel's getResolution(N) for landscape 1920×1080:
 *   aspect  = 1920/1080 = 1.7778
 *   width   = round(N * aspect)        (landscape: long axis)
 *   height  = N                        (landscape: short axis)
 *
 *   SIM_RESOLUTION    = 128  → 228×128
 *   DYE_RESOLUTION    = 1024 → 1820×1024  (Math.round(1024 * 16/9))
 *   BLOOM_RESOLUTION  = 256  → 456×256
 *   SUNRAYS_RESOLUTION= 196  → 349×196
 */
#define SIM_W   228
#define SIM_H   128
#define DYE_W   1820
#define DYE_H   1024
#define BLOOM_W 456
#define BLOOM_H 256
#define SUN_W   349
#define SUN_H   196

/* Pavel's config{} defaults (same names, prefixed). */
/* g_dt is the wall-clock delta from the previous frame (see main loop).
 * Only the max is clamped (matching Pavel) so a stalled frame can't
 * blow up integration. */
#define DT_MAX               (1.0f / 15.0f)
static float g_dt = 1.0f / 60.0f;
#define VEL_DISSIPATION      0.2f
#define DEN_DISSIPATION      2.0f
#define PRESSURE_RETENTION   0.8f
#define PRESSURE_ITERS       20
#define VORT_CURL            30.0f
#define SPLAT_FORCE          6000.0f
/* Pavel uses SPLAT_RADIUS = 0.25 then `correctRadius(SPLAT_RADIUS / 100)`
 * = 0.0025 * aspect (aspect > 1). The aspect factor is applied at
 * runtime in apply_inputs. */
#define SPLAT_RADIUS_BASE    0.0025f
#define BLOOM_ITERS          8
#define BLOOM_INTENSITY      0.8f
#define BLOOM_THRESHOLD      0.6f
#define BLOOM_SOFT_KNEE      0.7f
#define SUNRAYS_WEIGHT       1.0f
/* COLOR_UPDATE_SPEED = 10 means colors cycle 10/sec. At 60Hz that's
 * one new color every 6 frames; matches Pavel's `dt * 10 >= 1`. */
#define COLOR_PERIOD_FRAMES  6

/* ────────────────────────────────────────────────────────────────────
 * Shaders — Pavel's GLSL, verbatim. Display gets its #defines for
 * SHADING / BLOOM / SUNRAYS prepended at compile time via the
 * `link_program_with_defines` helper.
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

/* Blur uses its own vertex shader: only horizontal/vertical varyings,
 * `offset = 1.33333333` matches Pavel's 3-tap linear-sampled Gaussian
 * (Sigurd Lerstad / Jam3 blur weights 0.29411764 / 0.35294117). */
static const char blur_vs_src[] =
    "precision highp float;\n"
    "attribute vec2 aPosition;\n"
    "varying vec2 vUv;\n"
    "varying vec2 vL;\n"
    "varying vec2 vR;\n"
    "uniform vec2 texelSize;\n"
    "void main () {\n"
    "    vUv = aPosition * 0.5 + 0.5;\n"
    "    float offset = 1.33333333;\n"
    "    vL = vUv - texelSize * offset;\n"
    "    vR = vUv + texelSize * offset;\n"
    "    gl_Position = vec4(aPosition, 0.0, 1.0);\n"
    "}\n";

static const char blur_fs_src[] =
    "precision mediump float;\n"
    "precision mediump sampler2D;\n"
    "varying vec2 vUv;\n"
    "varying vec2 vL;\n"
    "varying vec2 vR;\n"
    "uniform sampler2D uTexture;\n"
    "void main () {\n"
    "    vec4 sum = texture2D(uTexture, vUv) * 0.29411764;\n"
    "    sum += texture2D(uTexture, vL) * 0.35294117;\n"
    "    sum += texture2D(uTexture, vR) * 0.35294117;\n"
    "    gl_FragColor = sum;\n"
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

/* Advect uses the simple (linear-filtered) path — `OES_texture_float_linear`
 * is required by our host bridge so MANUAL_FILTERING is dead code. */
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

static const char bloom_prefilter_fs_src[] =
    "precision mediump float;\n"
    "precision mediump sampler2D;\n"
    "varying vec2 vUv;\n"
    "uniform sampler2D uTexture;\n"
    "uniform vec3 curve;\n"
    "uniform float threshold;\n"
    "void main () {\n"
    "    vec3 c = texture2D(uTexture, vUv).rgb;\n"
    "    float br = max(c.r, max(c.g, c.b));\n"
    "    float rq = clamp(br - curve.x, 0.0, curve.y);\n"
    "    rq = curve.z * rq * rq;\n"
    "    c *= max(rq, br - threshold) / max(br, 0.0001);\n"
    "    gl_FragColor = vec4(c, 0.0);\n"
    "}\n";

static const char bloom_blur_fs_src[] =
    "precision mediump float;\n"
    "precision mediump sampler2D;\n"
    "varying vec2 vL;\n"
    "varying vec2 vR;\n"
    "varying vec2 vT;\n"
    "varying vec2 vB;\n"
    "uniform sampler2D uTexture;\n"
    "void main () {\n"
    "    vec4 sum = vec4(0.0);\n"
    "    sum += texture2D(uTexture, vL);\n"
    "    sum += texture2D(uTexture, vR);\n"
    "    sum += texture2D(uTexture, vT);\n"
    "    sum += texture2D(uTexture, vB);\n"
    "    sum *= 0.25;\n"
    "    gl_FragColor = sum;\n"
    "}\n";

static const char bloom_final_fs_src[] =
    "precision mediump float;\n"
    "precision mediump sampler2D;\n"
    "varying vec2 vL;\n"
    "varying vec2 vR;\n"
    "varying vec2 vT;\n"
    "varying vec2 vB;\n"
    "uniform sampler2D uTexture;\n"
    "uniform float intensity;\n"
    "void main () {\n"
    "    vec4 sum = vec4(0.0);\n"
    "    sum += texture2D(uTexture, vL);\n"
    "    sum += texture2D(uTexture, vR);\n"
    "    sum += texture2D(uTexture, vT);\n"
    "    sum += texture2D(uTexture, vB);\n"
    "    sum *= 0.25;\n"
    "    gl_FragColor = sum * intensity;\n"
    "}\n";

static const char sunrays_mask_fs_src[] =
    "precision highp float;\n"
    "precision highp sampler2D;\n"
    "varying vec2 vUv;\n"
    "uniform sampler2D uTexture;\n"
    "void main () {\n"
    "    vec4 c = texture2D(uTexture, vUv);\n"
    "    float br = max(c.r, max(c.g, c.b));\n"
    "    c.a = 1.0 - min(max(br * 20.0, 0.0), 0.8);\n"
    "    gl_FragColor = c;\n"
    "}\n";

static const char sunrays_fs_src[] =
    "precision highp float;\n"
    "precision highp sampler2D;\n"
    "varying vec2 vUv;\n"
    "uniform sampler2D uTexture;\n"
    "uniform float weight;\n"
    "#define ITERATIONS 16\n"
    "void main () {\n"
    "    float Density = 0.3;\n"
    "    float Decay = 0.95;\n"
    "    float Exposure = 0.7;\n"
    "    vec2 coord = vUv;\n"
    "    vec2 dir = vUv - 0.5;\n"
    "    dir *= 1.0 / float(ITERATIONS) * Density;\n"
    "    float illuminationDecay = 1.0;\n"
    "    float color = texture2D(uTexture, vUv).a;\n"
    "    for (int i = 0; i < ITERATIONS; i++) {\n"
    "        coord -= dir;\n"
    "        float col = texture2D(uTexture, coord).a;\n"
    "        color += col * illuminationDecay * weight;\n"
    "        illuminationDecay *= Decay;\n"
    "    }\n"
    "    gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);\n"
    "}\n";

/* Display shader: SHADING / BLOOM / SUNRAYS are enabled via prepended
 * #defines at compile time. Dithering is omitted — the noise was a
 * single texture-sample anti-banding pass that needed a 64×64 LUT PNG. */
static const char display_fs_src[] =
    "precision highp float;\n"
    "precision highp sampler2D;\n"
    "varying vec2 vUv;\n"
    "varying vec2 vL;\n"
    "varying vec2 vR;\n"
    "varying vec2 vT;\n"
    "varying vec2 vB;\n"
    "uniform sampler2D uTexture;\n"
    "uniform sampler2D uBloom;\n"
    "uniform sampler2D uSunrays;\n"
    "uniform vec2 texelSize;\n"
    "vec3 linearToGamma (vec3 color) {\n"
    "    color = max(color, vec3(0));\n"
    "    return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));\n"
    "}\n"
    "void main () {\n"
    "    vec3 c = texture2D(uTexture, vUv).rgb;\n"
    "#ifdef SHADING\n"
    "    vec3 lc = texture2D(uTexture, vL).rgb;\n"
    "    vec3 rc = texture2D(uTexture, vR).rgb;\n"
    "    vec3 tc = texture2D(uTexture, vT).rgb;\n"
    "    vec3 bc = texture2D(uTexture, vB).rgb;\n"
    "    float dx = length(rc) - length(lc);\n"
    "    float dy = length(tc) - length(bc);\n"
    "    vec3 n = normalize(vec3(dx, dy, length(texelSize)));\n"
    "    vec3 l = vec3(0.0, 0.0, 1.0);\n"
    "    float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);\n"
    "    c *= diffuse;\n"
    "#endif\n"
    "#ifdef BLOOM\n"
    "    vec3 bloom = texture2D(uBloom, vUv).rgb;\n"
    "#endif\n"
    "#ifdef SUNRAYS\n"
    "    float sunrays = texture2D(uSunrays, vUv).r;\n"
    "    c *= sunrays;\n"
    "#ifdef BLOOM\n"
    "    bloom *= sunrays;\n"
    "#endif\n"
    "#endif\n"
    "#ifdef BLOOM\n"
    "    bloom = linearToGamma(bloom);\n"
    "    c += bloom;\n"
    "#endif\n"
    "    float a = max(c.r, max(c.g, c.b));\n"
    "    gl_FragColor = vec4(c, a);\n"
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

/* Compile a fragment shader with the given `#define` keywords prepended.
 * Used for the display program — Pavel's Material.setKeywords analog. */
static GLuint compile_fragment_with_defines(const char *src,
                                            const char *defines,
                                            const char *label) {
    /* Combine defines + src into a heap buffer so glShaderSource sees
     * one contiguous string. The combined length is small (<8 KiB). */
    size_t dlen = defines ? strlen(defines) : 0;
    size_t slen = strlen(src);
    char *combined = (char *)malloc(dlen + slen + 1);
    if (!combined) {
        fprintf(stderr, "compile_fragment_with_defines: OOM\n");
        return 0;
    }
    if (dlen) memcpy(combined, defines, dlen);
    memcpy(combined + dlen, src, slen + 1);
    GLuint sh = compile_shader(GL_FRAGMENT_SHADER, combined, label);
    free(combined);
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

static GLuint compile_link(const char *vs_src, const char *fs_src, const char *label) {
    GLuint vs = compile_shader(GL_VERTEX_SHADER,   vs_src, label);
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER, fs_src, label);
    GLuint p  = link_program(vs, fs, label);
    glDeleteShader(vs);
    glDeleteShader(fs);
    return p;
}

static GLuint compile_link_with_defines(const char *vs_src,
                                        const char *fs_src,
                                        const char *defines,
                                        const char *label) {
    GLuint vs = compile_shader(GL_VERTEX_SHADER, vs_src, label);
    GLuint fs = compile_fragment_with_defines(fs_src, defines, label);
    GLuint p  = link_program(vs, fs, label);
    glDeleteShader(vs);
    glDeleteShader(fs);
    return p;
}

/* Fullscreen quad: two triangles in clip space [-1,1]^2; base_vs and
 * blur_vs both derive vUv = aPosition * 0.5 + 0.5. */
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
 * Render targets — FBO + texture + dimensions + texel size
 * ──────────────────────────────────────────────────────────────────── */

typedef struct {
    GLuint tex;
    GLuint fbo;
    int    w;
    int    h;
    float  tx;   /* 1.0 / w */
    float  ty;   /* 1.0 / h */
} RT;

typedef struct {
    RT read;
    RT write;
} DoubleRT;

static RT create_rt(int w, int h, GLint filter) {
    RT r = { 0, 0, w, h, 1.0f / (float)w, 1.0f / (float)h };
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
    /* Per the GL spec, glTexImage2D(NULL) leaves texture content
     * undefined. Without this clear, pressure/curl/divergence start
     * with arbitrary bits — often Inf/NaN under the half-float
     * interpretation — and the pressure solver propagates those into
     * velocity, after which advect_dye samples dye at NaN coords and
     * the canvas stays blank. */
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

static void bind_target(RT target) {
    glBindFramebuffer(GL_FRAMEBUFFER, target.fbo);
    glViewport(0, 0, target.w, target.h);
}

/* ────────────────────────────────────────────────────────────────────
 * Programs — labelled uniform locations cached per shader so the
 * frame loop never re-runs glGetUniformLocation
 * ──────────────────────────────────────────────────────────────────── */

struct prog_simple { GLuint id; GLint texelSize, uTexture; };
struct prog_curl   { GLuint id; GLint texelSize, uVelocity; };
struct prog_vort   { GLuint id; GLint texelSize, uVelocity, uCurl, curl, dt; };
struct prog_div    { GLuint id; GLint texelSize, uVelocity; };
struct prog_clear  { GLuint id; GLint uTexture, value; };
struct prog_press  { GLuint id; GLint texelSize, uPressure, uDivergence; };
struct prog_grad   { GLuint id; GLint texelSize, uPressure, uVelocity; };
struct prog_advect { GLuint id; GLint texelSize, uVelocity, uSource, dt, dissipation; };
struct prog_splat  { GLuint id; GLint uTarget, aspectRatio, color, point, radius; };
struct prog_bpre   { GLuint id; GLint uTexture, curve, threshold; };
struct prog_bblur  { GLuint id; GLint texelSize, uTexture; };
struct prog_bfin   { GLuint id; GLint texelSize, uTexture, intensity; };
struct prog_smask  { GLuint id; GLint uTexture; };
struct prog_sunr   { GLuint id; GLint uTexture, weight; };
struct prog_blur   { GLuint id; GLint texelSize, uTexture; };
struct prog_disp   {
    GLuint id;
    GLint texelSize, uTexture, uBloom, uSunrays;
};

static struct prog_curl   curl_prog;
static struct prog_vort   vort_prog;
static struct prog_div    div_prog;
static struct prog_clear  clear_prog;
static struct prog_press  press_prog;
static struct prog_grad   grad_prog;
static struct prog_advect advect_prog;
static struct prog_splat  splat_prog;
static struct prog_bpre   bpre_prog;
static struct prog_bblur  bblur_prog;
static struct prog_bfin   bfin_prog;
static struct prog_smask  smask_prog;
static struct prog_sunr   sunr_prog;
static struct prog_blur   blur_prog;
static struct prog_disp   disp_prog;

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
    splat_prog.uTarget     = glGetUniformLocation(splat_prog.id, "uTarget");
    splat_prog.aspectRatio = glGetUniformLocation(splat_prog.id, "aspectRatio");
    splat_prog.color       = glGetUniformLocation(splat_prog.id, "color");
    splat_prog.point       = glGetUniformLocation(splat_prog.id, "point");
    splat_prog.radius      = glGetUniformLocation(splat_prog.id, "radius");

    bpre_prog.id = compile_link(base_vs_src, bloom_prefilter_fs_src, "bloom-prefilter");
    bpre_prog.uTexture = glGetUniformLocation(bpre_prog.id, "uTexture");
    bpre_prog.curve    = glGetUniformLocation(bpre_prog.id, "curve");
    bpre_prog.threshold = glGetUniformLocation(bpre_prog.id, "threshold");

    bblur_prog.id = compile_link(base_vs_src, bloom_blur_fs_src, "bloom-blur");
    bblur_prog.texelSize = glGetUniformLocation(bblur_prog.id, "texelSize");
    bblur_prog.uTexture  = glGetUniformLocation(bblur_prog.id, "uTexture");

    bfin_prog.id = compile_link(base_vs_src, bloom_final_fs_src, "bloom-final");
    bfin_prog.texelSize = glGetUniformLocation(bfin_prog.id, "texelSize");
    bfin_prog.uTexture  = glGetUniformLocation(bfin_prog.id, "uTexture");
    bfin_prog.intensity = glGetUniformLocation(bfin_prog.id, "intensity");

    smask_prog.id = compile_link(base_vs_src, sunrays_mask_fs_src, "sunrays-mask");
    smask_prog.uTexture = glGetUniformLocation(smask_prog.id, "uTexture");

    sunr_prog.id = compile_link(base_vs_src, sunrays_fs_src, "sunrays");
    sunr_prog.uTexture = glGetUniformLocation(sunr_prog.id, "uTexture");
    sunr_prog.weight   = glGetUniformLocation(sunr_prog.id, "weight");

    blur_prog.id = compile_link(blur_vs_src, blur_fs_src, "blur");
    blur_prog.texelSize = glGetUniformLocation(blur_prog.id, "texelSize");
    blur_prog.uTexture  = glGetUniformLocation(blur_prog.id, "uTexture");

    /* Display: SHADING + BLOOM + SUNRAYS all enabled (Pavel's defaults).
     * The newline after each define matters — GLSL preprocessor needs
     * each directive on its own line. */
    static const char display_defines[] =
        "#define SHADING\n"
        "#define BLOOM\n"
        "#define SUNRAYS\n";
    disp_prog.id = compile_link_with_defines(
        base_vs_src, display_fs_src, display_defines, "display");
    disp_prog.texelSize = glGetUniformLocation(disp_prog.id, "texelSize");
    disp_prog.uTexture  = glGetUniformLocation(disp_prog.id, "uTexture");
    disp_prog.uBloom    = glGetUniformLocation(disp_prog.id, "uBloom");
    disp_prog.uSunrays  = glGetUniformLocation(disp_prog.id, "uSunrays");
}

/* ────────────────────────────────────────────────────────────────────
 * Pipeline state
 * ──────────────────────────────────────────────────────────────────── */

static DoubleRT velocity;
static DoubleRT dye;
static DoubleRT pressure;
static RT       divergence_rt;
static RT       curl_rt;

static RT       bloom_rt;                /* prefiltered + final composite */
static RT       bloom_chain[BLOOM_ITERS];
static int      bloom_chain_count = 0;

static RT       sunrays_rt;
static RT       sunrays_temp_rt;

static void setup_pipeline(void) {
    velocity      = create_doublert(SIM_W, SIM_H, GL_LINEAR);
    dye           = create_doublert(DYE_W, DYE_H, GL_LINEAR);
    pressure      = create_doublert(SIM_W, SIM_H, GL_NEAREST);
    divergence_rt = create_rt(SIM_W, SIM_H, GL_NEAREST);
    curl_rt       = create_rt(SIM_W, SIM_H, GL_NEAREST);

    bloom_rt = create_rt(BLOOM_W, BLOOM_H, GL_LINEAR);
    bloom_chain_count = 0;
    for (int i = 0; i < BLOOM_ITERS; i++) {
        int w = BLOOM_W >> (i + 1);
        int h = BLOOM_H >> (i + 1);
        if (w < 2 || h < 2) break;
        bloom_chain[i] = create_rt(w, h, GL_LINEAR);
        bloom_chain_count++;
    }

    sunrays_rt      = create_rt(SUN_W, SUN_H, GL_LINEAR);
    sunrays_temp_rt = create_rt(SUN_W, SUN_H, GL_LINEAR);
}

/* ────────────────────────────────────────────────────────────────────
 * Pass functions — direct translations of Pavel's step() / render()
 * ──────────────────────────────────────────────────────────────────── */

static void pass_curl(void) {
    glUseProgram(curl_prog.id);
    glUniform2f(curl_prog.texelSize, velocity.read.tx, velocity.read.ty);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(curl_prog.uVelocity, 0);
    bind_target(curl_rt);
    blit_quad();
}

static void pass_vorticity(void) {
    glUseProgram(vort_prog.id);
    glUniform2f(vort_prog.texelSize, velocity.read.tx, velocity.read.ty);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(vort_prog.uVelocity, 0);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, curl_rt.tex);
    glUniform1i(vort_prog.uCurl, 1);
    glUniform1f(vort_prog.curl, VORT_CURL);
    glUniform1f(vort_prog.dt, g_dt);
    bind_target(velocity.write);
    blit_quad();
    swap_rt(&velocity);
}

static void pass_divergence(void) {
    glUseProgram(div_prog.id);
    glUniform2f(div_prog.texelSize, velocity.read.tx, velocity.read.ty);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(div_prog.uVelocity, 0);
    bind_target(divergence_rt);
    blit_quad();
}

static void pass_pressure_decay(void) {
    glUseProgram(clear_prog.id);
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
    glUniform2f(press_prog.texelSize, velocity.read.tx, velocity.read.ty);
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
    glUniform2f(grad_prog.texelSize, velocity.read.tx, velocity.read.ty);
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
    /* Pavel uses velocity.texelSize for BOTH advect calls — it scales
     * the per-sample velocity in `coord = vUv - dt*vel*texelSize`. */
    glUniform2f(advect_prog.texelSize, velocity.read.tx, velocity.read.ty);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(advect_prog.uVelocity, 0);
    glUniform1i(advect_prog.uSource, 0);
    glUniform1f(advect_prog.dt, g_dt);
    glUniform1f(advect_prog.dissipation, VEL_DISSIPATION);
    bind_target(velocity.write);
    blit_quad();
    swap_rt(&velocity);
}

static void pass_advect_dye(void) {
    glUseProgram(advect_prog.id);
    glUniform2f(advect_prog.texelSize, velocity.read.tx, velocity.read.ty);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(advect_prog.uVelocity, 0);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, dye.read.tex);
    glUniform1i(advect_prog.uSource, 1);
    glUniform1f(advect_prog.dt, g_dt);
    glUniform1f(advect_prog.dissipation, DEN_DISSIPATION);
    bind_target(dye.write);
    blit_quad();
    swap_rt(&dye);
}

static void splat_velocity(float u, float v, float dx, float dy, float aspect, float radius) {
    glUseProgram(splat_prog.id);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, velocity.read.tex);
    glUniform1i(splat_prog.uTarget, 0);
    glUniform1f(splat_prog.aspectRatio, aspect);
    glUniform2f(splat_prog.point, u, v);
    glUniform3f(splat_prog.color, dx, dy, 0.0f);
    glUniform1f(splat_prog.radius, radius);
    bind_target(velocity.write);
    blit_quad();
    swap_rt(&velocity);
}

static void splat_dye(float u, float v, float r, float g, float b, float aspect, float radius) {
    glUseProgram(splat_prog.id);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, dye.read.tex);
    glUniform1i(splat_prog.uTarget, 0);
    glUniform1f(splat_prog.aspectRatio, aspect);
    glUniform2f(splat_prog.point, u, v);
    glUniform3f(splat_prog.color, r, g, b);
    glUniform1f(splat_prog.radius, radius);
    bind_target(dye.write);
    blit_quad();
    swap_rt(&dye);
}

static void demo_splat(float u, float v,
                       float dx, float dy,
                       float r, float g, float b,
                       float aspect, float radius) {
    splat_velocity(u, v, dx, dy, aspect, radius);
    splat_dye(u, v, r, g, b, aspect, radius);
}

/* Direct translation of Pavel's applyBloom: prefilter dye into
 * bloom_rt → Gaussian-blur downsample chain (last → chain[0]..[n-1])
 * → additive upsample (chain[n-2]..[0]) → final intensity-scaled
 * 4-tap blur back into bloom_rt. */
static void apply_bloom(void) {
    if (bloom_chain_count < 2) return;

    glDisable(GL_BLEND);

    /* Prefilter: extract bright pixels above BLOOM_THRESHOLD with a
     * soft knee, write into bloom_rt. */
    glUseProgram(bpre_prog.id);
    float knee = BLOOM_THRESHOLD * BLOOM_SOFT_KNEE + 0.0001f;
    float curve0 = BLOOM_THRESHOLD - knee;
    float curve1 = knee * 2.0f;
    float curve2 = 0.25f / knee;
    glUniform3f(bpre_prog.curve, curve0, curve1, curve2);
    glUniform1f(bpre_prog.threshold, BLOOM_THRESHOLD);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, dye.read.tex);
    glUniform1i(bpre_prog.uTexture, 0);
    bind_target(bloom_rt);
    blit_quad();

    /* Downsample: blur bloom_rt → chain[0], then chain[i-1] → chain[i].
     * texelSize is set from the SOURCE FBO so the blur taps land on
     * neighboring source texels. `last_*` tracks the current source. */
    glUseProgram(bblur_prog.id);
    GLuint last_tex = bloom_rt.tex;
    float last_tx = bloom_rt.tx, last_ty = bloom_rt.ty;
    for (int i = 0; i < bloom_chain_count; i++) {
        glUniform2f(bblur_prog.texelSize, last_tx, last_ty);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, last_tex);
        glUniform1i(bblur_prog.uTexture, 0);
        bind_target(bloom_chain[i]);
        blit_quad();
        last_tex = bloom_chain[i].tex;
        last_tx  = bloom_chain[i].tx;
        last_ty  = bloom_chain[i].ty;
    }

    /* Upsample additively: chain[n-1] adds onto chain[n-2], etc. */
    glBlendFunc(GL_ONE, GL_ONE);
    glEnable(GL_BLEND);
    for (int i = bloom_chain_count - 2; i >= 0; i--) {
        glUniform2f(bblur_prog.texelSize, last_tx, last_ty);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, last_tex);
        glUniform1i(bblur_prog.uTexture, 0);
        bind_target(bloom_chain[i]);
        blit_quad();
        last_tex = bloom_chain[i].tex;
        last_tx  = bloom_chain[i].tx;
        last_ty  = bloom_chain[i].ty;
    }

    glDisable(GL_BLEND);

    /* Final pass: 4-tap blur of chain[0] back into bloom_rt, scaled
     * by BLOOM_INTENSITY. */
    glUseProgram(bfin_prog.id);
    glUniform2f(bfin_prog.texelSize, last_tx, last_ty);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, last_tex);
    glUniform1i(bfin_prog.uTexture, 0);
    glUniform1f(bfin_prog.intensity, BLOOM_INTENSITY);
    bind_target(bloom_rt);
    blit_quad();
}

/* Pavel uses dye.write as the mask scratch — we've just swapped after
 * advect, so dye.read is the new dye and dye.write is the previous
 * frame's dye texture, which is fine to clobber (apply_bloom doesn't
 * touch it; the next step's first write to dye is splat or advect
 * which both overwrite it). */
static void apply_sunrays(void) {
    glDisable(GL_BLEND);

    /* Mask: dye → dye.write, alpha = 1 - clamp(20*brightness, 0, 0.8). */
    glUseProgram(smask_prog.id);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, dye.read.tex);
    glUniform1i(smask_prog.uTexture, 0);
    bind_target(dye.write);
    blit_quad();

    /* Radial sweep: 16-step march from each pixel toward the center,
     * sampling mask alpha. Writes brightness into sunrays.r. */
    glUseProgram(sunr_prog.id);
    glUniform1f(sunr_prog.weight, SUNRAYS_WEIGHT);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, dye.write.tex);
    glUniform1i(sunr_prog.uTexture, 0);
    bind_target(sunrays_rt);
    blit_quad();
}

/* Separable Gaussian blur: `iterations` rounds of horizontal then
 * vertical via sunrays_temp_rt as the intermediate. */
static void blur_sunrays(int iterations) {
    glUseProgram(blur_prog.id);
    for (int i = 0; i < iterations; i++) {
        /* Horizontal pass: sunrays_rt → sunrays_temp_rt. */
        glUniform2f(blur_prog.texelSize, sunrays_rt.tx, 0.0f);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, sunrays_rt.tex);
        glUniform1i(blur_prog.uTexture, 0);
        bind_target(sunrays_temp_rt);
        blit_quad();

        /* Vertical pass: sunrays_temp_rt → sunrays_rt. */
        glUniform2f(blur_prog.texelSize, 0.0f, sunrays_rt.ty);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, sunrays_temp_rt.tex);
        glUniform1i(blur_prog.uTexture, 0);
        bind_target(sunrays_rt);
        blit_quad();
    }
}

static void pass_display(void) {
    glUseProgram(disp_prog.id);
    /* SHADING uses texelSize for the sobel-style normal estimation;
     * dye resolution because dye is what we sample. */
    glUniform2f(disp_prog.texelSize, dye.read.tx, dye.read.ty);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, dye.read.tex);
    glUniform1i(disp_prog.uTexture, 0);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, bloom_rt.tex);
    glUniform1i(disp_prog.uBloom, 1);
    glActiveTexture(GL_TEXTURE2);
    glBindTexture(GL_TEXTURE_2D, sunrays_rt.tex);
    glUniform1i(disp_prog.uSunrays, 2);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, CANVAS_W, CANVAS_H);
    glDisable(GL_BLEND);
    blit_quad();
}

/* ────────────────────────────────────────────────────────────────────
 * Mouse, color cycling, splats
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

/* Pavel's generateColor: random hue at s=1, v=1, then × 0.15. */
static void regenerate_color(void) {
    float h = frand();
    float s = 1.0f, v = 1.0f;
    float i = floorf(h * 6.0f);
    float f = h * 6.0f - i;
    float p = v * (1.0f - s);
    float q = v * (1.0f - f * s);
    float t = v * (1.0f - (1.0f - f) * s);
    float r, g, b;
    switch ((int)i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        default: r = v; g = p; b = q; break;
    }
    cur_r = r * 0.15f;
    cur_g = g * 0.15f;
    cur_b = b * 0.15f;
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
 * KMS setup — drives PAGE_FLIP gating; rendering still flows through
 * EGL_DEFAULT_DISPLAY.
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

    int prime_fd = gbm_bo_get_fd(kms_bos[0]);
    if (prime_fd >= 0) close(prime_fd);

    if (drmModeSetCrtc(kms_drm_fd, kms_crtc_id, kms_fb_ids[0],
                       0, 0, &kms_conn_id, 1, &kms_mode) != 0) {
        perror("drmModeSetCrtc"); return 1;
    }

    return 0;
}

/* O_NONBLOCK + read+usleep(1000) instead of poll(): sys_poll's
 * 50 ms host-retry would clamp this loop to ~20 FPS when no other
 * syscall traffic triggers a broad wake. */
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

/* ────────────────────────────────────────────────────────────────────
 * main: EGL + GLES2 setup, build sim, run loop
 * ──────────────────────────────────────────────────────────────────── */

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
    setup_pipeline();

    float aspect = (float)CANVAS_W / (float)CANVAS_H;
    /* Pavel's correctRadius: multiply by aspect when > 1. */
    float splat_radius = SPLAT_RADIUS_BASE * (aspect > 1.0f ? aspect : 1.0f);
    float demo_seed_radius = splat_radius * 7.0f;

    int cursor_x = CANVAS_W / 2;
    int cursor_y = CANVAS_H / 2;
    int prev_cursor_x = cursor_x;
    int prev_cursor_y = cursor_y;
    int color_timer = 0;
    uint8_t buttons = 0;

    /* The kernel-side vblank pump currently retires PAGE_FLIP events
     * immediately (Q4), so kms_pageflip_wait() returns at ~2 kHz instead
     * of monitor refresh. We throttle the loop ourselves at 60 Hz and
     * drive the sim from a wall-clock dt. */
    struct timespec t_prev;
    clock_gettime(CLOCK_MONOTONIC, &t_prev);
    const long FRAME_NS = 16666667L;
    struct timespec t_next = t_prev;

    for (uint64_t frame = 0; ; frame++) {
        struct timespec t_now;
        clock_gettime(CLOCK_MONOTONIC, &t_now);
        double dt_s = (double)(t_now.tv_sec - t_prev.tv_sec)
                    + (double)(t_now.tv_nsec - t_prev.tv_nsec) / 1e9;
        t_prev = t_now;
        if (dt_s < 0.0) dt_s = 0.0;
        if (dt_s > (double)DT_MAX) dt_s = (double)DT_MAX;
        g_dt = (float)dt_s;

        drain_mouse(mouse, &cursor_x, &cursor_y, &buttons, CANVAS_W, CANVAS_H);

        if (frame == 0) {
            demo_splat(0.25f, 0.36f,
                       900.0f, 250.0f, 2.80f, 0.05f, 0.05f,
                       aspect, demo_seed_radius);
            demo_splat(0.72f, 0.62f,
                       -720.0f, -340.0f, 0.05f, 0.05f, 2.80f,
                       aspect, demo_seed_radius);
        }

        /* Splat on drag (button held + motion). Pavel triggers from
         * `pointer.moved` while `pointer.down` — same effect. The
         * `jdist < 320` clamp guards against teleport (mouseenter
         * after pointer-leave). */
        int jdx = cursor_x - prev_cursor_x;
        int jdy = cursor_y - prev_cursor_y;
        int jdist = (jdx < 0 ? -jdx : jdx) + (jdy < 0 ? -jdy : jdy);
        if (buttons && jdist > 0 && jdist < 320) {
            float u = (float)cursor_x / (float)CANVAS_W;
            float v = 1.0f - (float)cursor_y / (float)CANVAS_H;
            float dx_norm = (float)jdx / (float)CANVAS_W;
            float dy_norm = (float)jdy / (float)CANVAS_H;
            /* Pavel's correctDeltaX/Y: scale by aspect for the
             * non-dominant axis so a circular motion stays circular. */
            if (aspect < 1.0f) dx_norm *= aspect; else dy_norm /= aspect;
            float vx = dx_norm * SPLAT_FORCE;
            float vy = dy_norm * SPLAT_FORCE;
            /* Browser dy positive-down; sim y positive-up — flip
             * once at the splat boundary. */
            splat_velocity(u, v, vx, -vy, aspect, splat_radius);
            splat_dye(u, v, cur_r, cur_g, cur_b, aspect, splat_radius);
        }
        prev_cursor_x = cursor_x;
        prev_cursor_y = cursor_y;

        if (++color_timer >= COLOR_PERIOD_FRAMES) {
            color_timer = 0;
            regenerate_color();
        }

        /* step() — Pavel's order. */
        pass_curl();
        pass_vorticity();
        pass_divergence();
        pass_pressure_decay();
        pass_pressure_jacobi();
        pass_gradient_subtract();
        pass_advect_velocity();
        pass_advect_dye();

        /* render() — bloom + sunrays + composite. */
        apply_bloom();
        apply_sunrays();
        blur_sunrays(1);
        pass_display();

        if (!eglSwapBuffers(dpy, surf)) return 7;
        if (kms_pageflip_wait() != 0) return 9;

        /* Resync if we fell more than 100 ms behind (backgrounded tab,
         * heavy host stall) so we don't burn the next second sprinting
         * to catch up. */
        t_next.tv_nsec += FRAME_NS;
        while (t_next.tv_nsec >= 1000000000L) {
            t_next.tv_sec += 1;
            t_next.tv_nsec -= 1000000000L;
        }
        struct timespec t_after;
        clock_gettime(CLOCK_MONOTONIC, &t_after);
        long behind_ns = (t_after.tv_sec - t_next.tv_sec) * 1000000000L
                       + (t_after.tv_nsec - t_next.tv_nsec);
        if (behind_ns > 100000000L) {
            t_next = t_after;
        } else if (behind_ns < 0) {
            usleep((useconds_t)((-behind_ns) / 1000L));
        }
    }
}
