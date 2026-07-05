/*
 * libGLESv2 stub for wasm-posix-kernel.
 *
 * Encodes GL calls as TLV records `{u16 op, u16 payload_len, payload}`
 * into the cmdbuf mapped by libEGL's eglMakeCurrent. `_wpk_gl_flush()`
 * issues GLIO_SUBMIT for the accumulated bytes; `eglSwapBuffers` flushes
 * before GLIO_PRESENT so the host bridge sees the frame in order.
 *
 * Object names (buffers, shaders, programs) are picked client-side with
 * a monotonic counter; OP_GEN_BUFFERS / OP_CREATE_SHADER / OP_CREATE_PROGRAM
 * carry the chosen u32 to the host so it can register the matching
 * WebGL2 handle in `GlBinding.{buffers, shaders, programs}`.
 */

#include <GLES2/gl2.h>
#include <errno.h>
#include <stdio.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>

#include "gl_abi.h"

static uint8_t *g_cursor = NULL;

enum { WPK_GL_MAX_TLV_PAYLOAD = 0xffffu };

static int g_submit_error_logs = 0;
static int g_query_error_logs = 0;

static inline void w_u16(uint8_t **c, uint16_t v) { memcpy(*c, &v, 2); *c += 2; }
static inline void w_u32(uint8_t **c, uint32_t v) { memcpy(*c, &v, 4); *c += 4; }
static inline void w_i32(uint8_t **c, int32_t v)  { memcpy(*c, &v, 4); *c += 4; }
static inline void w_f32(uint8_t **c, float v)    { memcpy(*c, &v, 4); *c += 4; }

void _wpk_gl_flush(void) {
    int fd = _wpk_gl_fd();
    uint8_t *base = _wpk_gl_cmdbuf_base();
    if (fd < 0 || base == NULL || g_cursor == NULL || g_cursor == base) return;

    struct gl_submit_info si = { .offset = 0,
                                 .length = (uint32_t)(g_cursor - base) };
    int rc = ioctl(fd, GLIO_SUBMIT, &si);
    if (rc != 0 && g_submit_error_logs < 20) {
        uint16_t first_op = 0;
        uint16_t first_len = 0;
        if (si.length >= 4) {
            memcpy(&first_op, base, 2);
            memcpy(&first_len, base + 2, 2);
        }
        fprintf(stderr, "love: GL submit failed rc=%d errno=%d length=%u first_op=0x%04x first_len=%u\n",
                rc, errno, si.length, first_op, first_len);
        g_submit_error_logs++;
    }
    g_cursor = base;
}

/* Reserve `bytes` of cmdbuf space and return a write cursor for the
 * caller to fill. Flushes if the next op would overflow CMDBUF_LEN.
 * Returns NULL when the EGL session hasn't run eglMakeCurrent yet, in
 * which case every op silently no-ops. */
static uint8_t *reserve(size_t bytes) {
    uint8_t *base = _wpk_gl_cmdbuf_base();
    if (base == NULL) return NULL;
    if (g_cursor == NULL) g_cursor = base;
    if ((size_t)(g_cursor - base) + bytes > WPK_GL_CMDBUF_LEN) {
        _wpk_gl_flush();
        if (bytes > WPK_GL_CMDBUF_LEN) return NULL;
    }
    return g_cursor;
}

#define EMIT_BEGIN(op_, payload_len_)                                   \
    uint8_t *_c = reserve(4u + (payload_len_));                         \
    if (_c == NULL) return;                                             \
    w_u16(&_c, (uint16_t)(op_));                                        \
    w_u16(&_c, (uint16_t)(payload_len_));

#define EMIT_END() g_cursor = _c;

/* ----- state -------------------------------------------------------- */

void glClearColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a) {
    EMIT_BEGIN(OP_CLEAR_COLOR, 16)
    w_f32(&_c, r); w_f32(&_c, g); w_f32(&_c, b); w_f32(&_c, a);
    EMIT_END()
}

void glClear(GLbitfield mask) {
    EMIT_BEGIN(OP_CLEAR, 4)
    w_u32(&_c, (uint32_t)mask);
    EMIT_END()
}

void glViewport(GLint x, GLint y, GLsizei w, GLsizei h) {
    EMIT_BEGIN(OP_VIEWPORT, 16)
    w_i32(&_c, x); w_i32(&_c, y); w_i32(&_c, w); w_i32(&_c, h);
    EMIT_END()
}

void glScissor(GLint x, GLint y, GLsizei w, GLsizei h) {
    EMIT_BEGIN(OP_SCISSOR, 16)
    w_i32(&_c, x); w_i32(&_c, y); w_i32(&_c, w); w_i32(&_c, h);
    EMIT_END()
}

void glEnable(GLenum cap)  { EMIT_BEGIN(OP_ENABLE,  4) w_u32(&_c, (uint32_t)cap); EMIT_END() }
void glDisable(GLenum cap) { EMIT_BEGIN(OP_DISABLE, 4) w_u32(&_c, (uint32_t)cap); EMIT_END() }

void glPixelStorei(GLenum pname, GLint param) {
    EMIT_BEGIN(OP_PIXEL_STOREI, 8)
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_END()
}

void glBlendFuncSeparate(GLenum srcRGB, GLenum dstRGB, GLenum srcAlpha, GLenum dstAlpha) {
    EMIT_BEGIN(OP_BLEND_FUNC_SEPARATE, 16)
    w_u32(&_c, (uint32_t)srcRGB);
    w_u32(&_c, (uint32_t)dstRGB);
    w_u32(&_c, (uint32_t)srcAlpha);
    w_u32(&_c, (uint32_t)dstAlpha);
    EMIT_END()
}

void glBlendEquation(GLenum mode) {
    EMIT_BEGIN(OP_BLEND_EQUATION, 4)
    w_u32(&_c, (uint32_t)mode);
    EMIT_END()
}

void glBlendEquationSeparate(GLenum modeRGB, GLenum modeAlpha) {
    EMIT_BEGIN(OP_BLEND_EQUATION_SEPARATE, 8)
    w_u32(&_c, (uint32_t)modeRGB);
    w_u32(&_c, (uint32_t)modeAlpha);
    EMIT_END()
}

void glBlendColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a) {
    EMIT_BEGIN(OP_BLEND_COLOR, 16)
    w_f32(&_c, r); w_f32(&_c, g); w_f32(&_c, b); w_f32(&_c, a);
    EMIT_END()
}

void glClearDepthf(GLfloat d) {
    EMIT_BEGIN(OP_CLEAR_DEPTHF, 4)
    w_f32(&_c, d);
    EMIT_END()
}

void glClearStencil(GLint s) {
    EMIT_BEGIN(OP_CLEAR_STENCIL, 4)
    w_i32(&_c, s);
    EMIT_END()
}

void glColorMask(GLboolean r, GLboolean g, GLboolean b, GLboolean a) {
    EMIT_BEGIN(OP_COLOR_MASK, 16)
    w_u32(&_c, r ? 1u : 0u);
    w_u32(&_c, g ? 1u : 0u);
    w_u32(&_c, b ? 1u : 0u);
    w_u32(&_c, a ? 1u : 0u);
    EMIT_END()
}

void glDepthMask(GLboolean flag) {
    EMIT_BEGIN(OP_DEPTH_MASK, 4)
    w_u32(&_c, flag ? 1u : 0u);
    EMIT_END()
}

void glDepthFunc(GLenum func) {
    EMIT_BEGIN(OP_DEPTH_FUNC, 4)
    w_u32(&_c, (uint32_t)func);
    EMIT_END()
}

void glCullFace(GLenum mode) {
    EMIT_BEGIN(OP_CULL_FACE, 4)
    w_u32(&_c, (uint32_t)mode);
    EMIT_END()
}

void glFrontFace(GLenum mode) {
    EMIT_BEGIN(OP_FRONT_FACE, 4)
    w_u32(&_c, (uint32_t)mode);
    EMIT_END()
}

void glLineWidth(GLfloat width) {
    EMIT_BEGIN(OP_LINE_WIDTH, 4)
    w_f32(&_c, width);
    EMIT_END()
}

void glStencilFunc(GLenum func, GLint ref, GLuint mask) {
    EMIT_BEGIN(OP_STENCIL_FUNC, 12)
    w_u32(&_c, (uint32_t)func);
    w_i32(&_c, ref);
    w_u32(&_c, mask);
    EMIT_END()
}

void glStencilFuncSeparate(GLenum face, GLenum func, GLint ref, GLuint mask) {
    EMIT_BEGIN(OP_STENCIL_FUNC_SEPARATE, 16)
    w_u32(&_c, (uint32_t)face);
    w_u32(&_c, (uint32_t)func);
    w_i32(&_c, ref);
    w_u32(&_c, mask);
    EMIT_END()
}

void glStencilMask(GLuint mask) {
    EMIT_BEGIN(OP_STENCIL_MASK, 4)
    w_u32(&_c, mask);
    EMIT_END()
}

void glStencilMaskSeparate(GLenum face, GLuint mask) {
    EMIT_BEGIN(OP_STENCIL_MASK_SEPARATE, 8)
    w_u32(&_c, (uint32_t)face);
    w_u32(&_c, mask);
    EMIT_END()
}

void glStencilOp(GLenum fail, GLenum zfail, GLenum zpass) {
    EMIT_BEGIN(OP_STENCIL_OP, 12)
    w_u32(&_c, (uint32_t)fail);
    w_u32(&_c, (uint32_t)zfail);
    w_u32(&_c, (uint32_t)zpass);
    EMIT_END()
}

void glStencilOpSeparate(GLenum face, GLenum fail, GLenum zfail, GLenum zpass) {
    EMIT_BEGIN(OP_STENCIL_OP_SEPARATE, 16)
    w_u32(&_c, (uint32_t)face);
    w_u32(&_c, (uint32_t)fail);
    w_u32(&_c, (uint32_t)zfail);
    w_u32(&_c, (uint32_t)zpass);
    EMIT_END()
}

void glPolygonOffset(GLfloat factor, GLfloat units) {
    EMIT_BEGIN(OP_POLYGON_OFFSET, 8)
    w_f32(&_c, factor);
    w_f32(&_c, units);
    EMIT_END()
}

void glDepthRangef(GLfloat n, GLfloat f) {
    EMIT_BEGIN(OP_DEPTH_RANGEF, 8)
    w_f32(&_c, n);
    w_f32(&_c, f);
    EMIT_END()
}

void glSampleCoverage(GLfloat value, GLboolean invert) {
    EMIT_BEGIN(OP_SAMPLE_COVERAGE, 8)
    w_f32(&_c, value);
    w_u32(&_c, invert ? 1u : 0u);
    EMIT_END()
}

void glHint(GLenum target, GLenum mode) { (void)target; (void)mode; }
void glReleaseShaderCompiler(void) {}

/* ----- buffers ------------------------------------------------------ */

static uint32_t g_next_buffer  = 1;
static uint32_t g_next_shader  = 1;
static uint32_t g_next_program = 1;

enum { WPK_GL_MAX_VERTEX_ATTRIBS = 32 };

struct wpk_vertex_attrib_state {
    GLint size;
    GLenum type;
    GLboolean normalized;
    GLsizei stride;
    uintptr_t pointer;
    GLuint buffer;
    GLboolean enabled;
};

static struct wpk_vertex_attrib_state g_vertex_attribs[WPK_GL_MAX_VERTEX_ATTRIBS];
static GLuint g_bound_array_buffer = 0;
static GLuint g_bound_element_array_buffer = 0;
static GLuint g_client_attrib_buffers[WPK_GL_MAX_VERTEX_ATTRIBS];
static GLuint g_client_element_buffer = 0;

static uint32_t attrib_component_size(GLenum type) {
    switch (type) {
    case GL_BYTE:
    case GL_UNSIGNED_BYTE:
        return 1;
    case GL_SHORT:
    case GL_UNSIGNED_SHORT:
#ifdef GL_HALF_FLOAT
    case GL_HALF_FLOAT:
#endif
        return 2;
    case GL_INT:
    case GL_UNSIGNED_INT:
    case GL_FLOAT:
#ifdef GL_FIXED
    case GL_FIXED:
#endif
#ifdef GL_INT_2_10_10_10_REV
    case GL_INT_2_10_10_10_REV:
#endif
#ifdef GL_UNSIGNED_INT_2_10_10_10_REV
    case GL_UNSIGNED_INT_2_10_10_10_REV:
#endif
        return 4;
    default:
        return 0;
    }
}

static uint32_t attrib_element_size(const struct wpk_vertex_attrib_state *a) {
#ifdef GL_INT_2_10_10_10_REV
    if (a->type == GL_INT_2_10_10_10_REV) return 4;
#endif
#ifdef GL_UNSIGNED_INT_2_10_10_10_REV
    if (a->type == GL_UNSIGNED_INT_2_10_10_10_REV) return 4;
#endif
    return (uint32_t)a->size * attrib_component_size(a->type);
}

static uint32_t index_component_size(GLenum type) {
    switch (type) {
    case GL_UNSIGNED_BYTE:
        return 1;
    case GL_UNSIGNED_SHORT:
        return 2;
    case GL_UNSIGNED_INT:
        return 4;
    default:
        return 0;
    }
}

static uint32_t max_client_index(GLenum type, const void *indices, GLsizei count) {
    if (!indices || count <= 0) return 0;
    uint32_t max = 0;
    if (type == GL_UNSIGNED_BYTE) {
        const uint8_t *p = (const uint8_t *)indices;
        for (GLsizei i = 0; i < count; i++) if (p[i] > max) max = p[i];
    } else if (type == GL_UNSIGNED_SHORT) {
        const uint16_t *p = (const uint16_t *)indices;
        for (GLsizei i = 0; i < count; i++) if (p[i] > max) max = p[i];
    } else if (type == GL_UNSIGNED_INT) {
        const uint32_t *p = (const uint32_t *)indices;
        for (GLsizei i = 0; i < count; i++) if (p[i] > max) max = p[i];
    }
    return max;
}

static int has_client_vertex_attribs(void) {
    for (uint32_t i = 0; i < WPK_GL_MAX_VERTEX_ATTRIBS; i++) {
        if (g_vertex_attribs[i].enabled && g_vertex_attribs[i].buffer == 0)
            return 1;
    }
    return 0;
}

void glGenBuffers(GLsizei n, GLuint *out) {
    if (n <= 0 || !out) return;
    /* Payload: u32 n, u32 names[n]. */
    EMIT_BEGIN(OP_GEN_BUFFERS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) {
        out[i] = g_next_buffer++;
        w_u32(&_c, out[i]);
    }
    EMIT_END()
}

void glDeleteBuffers(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    EMIT_BEGIN(OP_DELETE_BUFFERS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) {
        GLuint name = names[i];
        if (g_bound_array_buffer == name) g_bound_array_buffer = 0;
        if (g_bound_element_array_buffer == name) g_bound_element_array_buffer = 0;
        for (uint32_t a = 0; a < WPK_GL_MAX_VERTEX_ATTRIBS; a++) {
            if (g_vertex_attribs[a].buffer == name) g_vertex_attribs[a].buffer = 0;
            if (g_client_attrib_buffers[a] == name) g_client_attrib_buffers[a] = 0;
        }
        if (g_client_element_buffer == name) g_client_element_buffer = 0;
        w_u32(&_c, name);
    }
    EMIT_END()
}

void glBindBuffer(GLenum target, GLuint buf) {
    EMIT_BEGIN(OP_BIND_BUFFER, 8)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)buf);
    EMIT_END()
    if (target == GL_ARRAY_BUFFER) g_bound_array_buffer = buf;
    else if (target == GL_ELEMENT_ARRAY_BUFFER) g_bound_element_array_buffer = buf;
}

void glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, const void *data);

void glBufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage) {
    if (size < 0) return;
    /* With data: u32 target, u32 dataLen, u8 data[dataLen], u32 usage.
     * Without data: u32 target, u32 byteLength, u32 usage. */
    uint32_t dlen = (uint32_t)size;
    if (data == NULL || dlen == 0) {
        EMIT_BEGIN(OP_BUFFER_DATA, 12u)
        w_u32(&_c, (uint32_t)target);
        w_u32(&_c, dlen);
        w_u32(&_c, (uint32_t)usage);
        EMIT_END()
        return;
    }

    if (dlen > WPK_GL_MAX_TLV_PAYLOAD - 12u) {
        glBufferData(target, size, NULL, usage);
        glBufferSubData(target, 0, size, data);
        return;
    }

    EMIT_BEGIN(OP_BUFFER_DATA, 12u + dlen)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, dlen);
    memcpy(_c, data, dlen);
    _c += dlen;
    w_u32(&_c, (uint32_t)usage);
    EMIT_END()
}

void glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, const void *data) {
    if (size <= 0 || data == NULL) return;
    const uint8_t *src = (const uint8_t *)data;
    GLsizeiptr remaining = size;
    GLintptr dst = offset;
    const uint32_t max_chunk = WPK_GL_MAX_TLV_PAYLOAD - 12u;
    while (remaining > 0) {
        uint32_t dlen = remaining > (GLsizeiptr)max_chunk
            ? max_chunk
            : (uint32_t)remaining;
        EMIT_BEGIN(OP_BUFFER_SUB_DATA, 12u + dlen)
        w_u32(&_c, (uint32_t)target);
        w_i32(&_c, (int32_t)dst);
        w_u32(&_c, dlen);
        memcpy(_c, src, dlen);
        _c += dlen;
        EMIT_END()
        src += dlen;
        dst += dlen;
        remaining -= dlen;
    }
}

/* ----- shaders / programs ------------------------------------------ */

GLuint glCreateShader(GLenum type) {
    uint32_t name = g_next_shader++;
    uint8_t *_c = reserve(4u + 8u);
    if (_c == NULL) return name;
    w_u16(&_c, (uint16_t)OP_CREATE_SHADER);
    w_u16(&_c, 8);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, name);
    g_cursor = _c;
    return name;
}

void glShaderSource(GLuint shader, GLsizei count,
                    const GLchar *const *string, const GLint *length) {
    if (count <= 0 || !string) return;
    /* Concatenate all source strings (length[i] < 0 → strlen) and emit
     * one OP_SHADER_SOURCE with the combined UTF-8 blob. */
    size_t total = 0;
    for (GLsizei i = 0; i < count; i++) {
        size_t li = (length && length[i] >= 0)
            ? (size_t)length[i] : strlen(string[i]);
        total += li;
    }
    if (total > 0xFFFFu - 8u) return;

    EMIT_BEGIN(OP_SHADER_SOURCE, 8u + (uint32_t)total)
    w_u32(&_c, shader);
    w_u32(&_c, (uint32_t)total);
    for (GLsizei i = 0; i < count; i++) {
        size_t li = (length && length[i] >= 0)
            ? (size_t)length[i] : strlen(string[i]);
        memcpy(_c, string[i], li);
        _c += li;
    }
    EMIT_END()
}

void glCompileShader(GLuint shader) {
    EMIT_BEGIN(OP_COMPILE_SHADER, 4) w_u32(&_c, shader); EMIT_END()
}

void glDeleteShader(GLuint shader) {
    EMIT_BEGIN(OP_DELETE_SHADER, 4) w_u32(&_c, shader); EMIT_END()
}

void glDetachShader(GLuint program, GLuint shader) {
    (void)program;
    (void)shader;
}

GLuint glCreateProgram(void) {
    uint32_t name = g_next_program++;
    uint8_t *_c = reserve(4u + 4u);
    if (_c == NULL) return name;
    w_u16(&_c, (uint16_t)OP_CREATE_PROGRAM);
    w_u16(&_c, 4);
    w_u32(&_c, name);
    g_cursor = _c;
    return name;
}

void glAttachShader(GLuint program, GLuint shader) {
    EMIT_BEGIN(OP_ATTACH_SHADER, 8)
    w_u32(&_c, program); w_u32(&_c, shader);
    EMIT_END()
}

void glLinkProgram(GLuint program) {
    EMIT_BEGIN(OP_LINK_PROGRAM, 4) w_u32(&_c, program); EMIT_END()
}

void glUseProgram(GLuint program) {
    EMIT_BEGIN(OP_USE_PROGRAM, 4) w_u32(&_c, program); EMIT_END()
}

void glDeleteProgram(GLuint program) {
    EMIT_BEGIN(OP_DELETE_PROGRAM, 4) w_u32(&_c, program); EMIT_END()
}

void glBindAttribLocation(GLuint program, GLuint index, const GLchar *name) {
    if (!name) return;
    size_t nlen = strlen(name);
    if (nlen > 0xFFFFu - 12u) return;
    EMIT_BEGIN(OP_BIND_ATTRIB_LOCATION, 12u + (uint32_t)nlen)
    w_u32(&_c, program);
    w_u32(&_c, (uint32_t)index);
    w_u32(&_c, (uint32_t)nlen);
    memcpy(_c, name, nlen); _c += nlen;
    EMIT_END()
}

/* ----- vertex attribs / draws -------------------------------------- */

static void emit_vertex_attrib_pointer(GLuint index, GLint size, GLenum type,
                                       GLboolean normalized, GLsizei stride,
                                       const void *pointer) {
    EMIT_BEGIN(OP_VERTEX_ATTRIB_POINTER, 24)
    w_u32(&_c, (uint32_t)index);
    w_i32(&_c, (int32_t)size);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, normalized ? 1u : 0u);
    w_i32(&_c, (int32_t)stride);
    w_i32(&_c, (int32_t)(uintptr_t)pointer);
    EMIT_END()
}

void glEnableVertexAttribArray(GLuint index) {
    EMIT_BEGIN(OP_ENABLE_VERTEX_ATTRIB_ARRAY, 4) w_u32(&_c, (uint32_t)index); EMIT_END()
    if (index < WPK_GL_MAX_VERTEX_ATTRIBS) g_vertex_attribs[index].enabled = GL_TRUE;
}

void glDisableVertexAttribArray(GLuint index) {
    EMIT_BEGIN(OP_DISABLE_VERTEX_ATTRIB_ARRAY, 4) w_u32(&_c, (uint32_t)index); EMIT_END()
    if (index < WPK_GL_MAX_VERTEX_ATTRIBS) g_vertex_attribs[index].enabled = GL_FALSE;
}

void glVertexAttribPointer(GLuint index, GLint size, GLenum type,
                           GLboolean normalized, GLsizei stride,
                           const void *pointer) {
    /* `pointer` is a buffer offset when a VBO is bound (the only mode
     * WebGL2 supports — client arrays aren't part of the WebGL surface). */
    emit_vertex_attrib_pointer(index, size, type, normalized, stride, pointer);
    if (index < WPK_GL_MAX_VERTEX_ATTRIBS) {
        g_vertex_attribs[index].size = size;
        g_vertex_attribs[index].type = type;
        g_vertex_attribs[index].normalized = normalized;
        g_vertex_attribs[index].stride = stride;
        g_vertex_attribs[index].pointer = (uintptr_t)pointer;
        g_vertex_attribs[index].buffer = g_bound_array_buffer;
    }
}

static void upload_client_vertex_attribs(uint32_t max_vertex_index) {
    if (!has_client_vertex_attribs()) return;

    GLuint restore_array_buffer = g_bound_array_buffer;
    for (uint32_t i = 0; i < WPK_GL_MAX_VERTEX_ATTRIBS; i++) {
        struct wpk_vertex_attrib_state *a = &g_vertex_attribs[i];
        if (!a->enabled || a->buffer != 0) continue;

        uint32_t elem_size = attrib_element_size(a);
        uint32_t stride = a->stride == 0 ? elem_size : (uint32_t)a->stride;
        if (elem_size == 0 || stride == 0 || a->pointer == 0) continue;

        size_t byte_len = (size_t)max_vertex_index * (size_t)stride + elem_size;
        if (g_client_attrib_buffers[i] == 0)
            glGenBuffers(1, &g_client_attrib_buffers[i]);

        glBindBuffer(GL_ARRAY_BUFFER, g_client_attrib_buffers[i]);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)byte_len, (const void *)a->pointer, GL_STREAM_DRAW);
        emit_vertex_attrib_pointer(i, a->size, a->type, a->normalized, a->stride, NULL);
    }
    glBindBuffer(GL_ARRAY_BUFFER, restore_array_buffer);
}

static uintptr_t upload_client_element_array(GLenum type, GLsizei count,
                                             const void *indices,
                                             uint32_t *max_vertex_index,
                                             GLuint *restore_element_buffer,
                                             int force_client_memory) {
    *restore_element_buffer = g_bound_element_array_buffer;
    if (!force_client_memory && g_bound_element_array_buffer != 0) {
        *max_vertex_index = count > 0 ? (uint32_t)(count - 1) : 0;
        return (uintptr_t)indices;
    }

    uint32_t index_size = index_component_size(type);
    if (index_size == 0 || indices == NULL || count <= 0) {
        *max_vertex_index = 0;
        return (uintptr_t)indices;
    }

    *max_vertex_index = max_client_index(type, indices, count);
    if (g_client_element_buffer == 0)
        glGenBuffers(1, &g_client_element_buffer);

    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g_client_element_buffer);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)((size_t)count * index_size), indices, GL_STREAM_DRAW);
    return 0;
}

void glDrawArrays(GLenum mode, GLint first, GLsizei count) {
    if (has_client_vertex_attribs() && count > 0)
        upload_client_vertex_attribs((uint32_t)(first + count - 1));

    EMIT_BEGIN(OP_DRAW_ARRAYS, 12)
    w_u32(&_c, (uint32_t)mode);
    w_i32(&_c, first);
    w_i32(&_c, (int32_t)count);
    EMIT_END()
}

void glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices) {
    uint32_t max_vertex_index = count > 0 ? (uint32_t)(count - 1) : 0;
    GLuint restore_element_buffer = g_bound_element_array_buffer;
    /* When a draw uses client vertex arrays, guest memory must be copied while
     * the process is still inside glDrawElements. Otherwise a later GLIO_SUBMIT
     * may replay from memory that the renderer's stream buffer has already
     * reused. Large `indices` values are Kandelo linear-memory addresses here;
     * small values remain valid element-buffer offsets. */
    int force_client_memory = has_client_vertex_attribs()
        && indices != NULL
        && (uintptr_t)indices >= 65536u;
    uintptr_t draw_offset = upload_client_element_array(type, count, indices,
                                                        &max_vertex_index,
                                                        &restore_element_buffer,
                                                        force_client_memory);
    upload_client_vertex_attribs(max_vertex_index);

    EMIT_BEGIN(OP_DRAW_ELEMENTS, 16)
    w_u32(&_c, (uint32_t)mode);
    w_i32(&_c, (int32_t)count);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, (uint32_t)draw_offset);
    EMIT_END()

    if (g_bound_element_array_buffer != restore_element_buffer)
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, restore_element_buffer);
}

void glVertexAttrib4f(GLuint index, GLfloat x, GLfloat y, GLfloat z, GLfloat w) {
    EMIT_BEGIN(OP_VERTEX_ATTRIB4F, 20)
    w_u32(&_c, index);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z); w_f32(&_c, w);
    EMIT_END()
}

void glVertexAttrib4fv(GLuint index, const GLfloat *v) {
    if (!v) return;
    EMIT_BEGIN(OP_VERTEX_ATTRIB4FV, 20)
    w_u32(&_c, index);
    w_f32(&_c, v[0]); w_f32(&_c, v[1]); w_f32(&_c, v[2]); w_f32(&_c, v[3]);
    EMIT_END()
}

void glVertexAttrib1f(GLuint index, GLfloat x) { glVertexAttrib4f(index, x, 0.0f, 0.0f, 1.0f); }
void glVertexAttrib2f(GLuint index, GLfloat x, GLfloat y) { glVertexAttrib4f(index, x, y, 0.0f, 1.0f); }
void glVertexAttrib3f(GLuint index, GLfloat x, GLfloat y, GLfloat z) { glVertexAttrib4f(index, x, y, z, 1.0f); }
void glVertexAttrib1fv(GLuint index, const GLfloat *v) { if (v) glVertexAttrib1f(index, v[0]); }
void glVertexAttrib2fv(GLuint index, const GLfloat *v) { if (v) glVertexAttrib2f(index, v[0], v[1]); }
void glVertexAttrib3fv(GLuint index, const GLfloat *v) { if (v) glVertexAttrib3f(index, v[0], v[1], v[2]); }

/* ----- sync queries ------------------------------------------------- */

/* GLIO_QUERY response buffers MUST be heap-allocated, not stack-local.
 * The kernel writes the result via Uint8Array.set on the shared memory,
 * but V8's wasm engine fails to surface that write to a subsequent
 * stack-local i32.load at the same address — even with volatile or
 * __atomic_load_n. Heap pointers from malloc evade whatever store-
 * forwarding heuristic suppresses the cross-thread invalidation, so a
 * tiny heap round-trip + memcpy into the caller's destination is the
 * only pattern observed to work in practice. */
static int _wpk_gl_query_into(uint32_t op,
                              const void *in, uint32_t in_len,
                              void *dst, uint32_t dst_len) {
    int fd = _wpk_gl_fd();
    if (fd < 0) return -1;
    _wpk_gl_flush();
    void *heap = malloc(dst_len ? dst_len : 1);
    if (!heap) return -1;
    if (dst_len) memset(heap, 0, dst_len);
    struct gl_query_info qi = {
        .op = op,
        .in_buf_ptr  = (uint32_t)(uintptr_t)in,   .in_buf_len  = in_len,
        .out_buf_ptr = (uint32_t)(uintptr_t)heap, .out_buf_len = dst_len,
        .reserved = 0,
    };
    int rc = ioctl(fd, GLIO_QUERY, &qi);
    if (rc != 0 && g_query_error_logs < 20) {
        fprintf(stderr, "love: GL query failed op=%u rc=%d errno=%d in=%u out=%u\n",
                op, rc, errno, in_len, dst_len);
        g_query_error_logs++;
    }
    if (rc == 0 && dst_len) memcpy(dst, heap, dst_len);
    free(heap);
    return rc;
}

GLenum glGetError(void) {
    uint32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_ERROR, NULL, 0, &out, 4) != 0) return GL_NO_ERROR;
    return (GLenum)out;
}

const GLubyte *glGetString(GLenum name) {
    static uint8_t out[4096];
    uint32_t n = (uint32_t)name;
    memset(out, 0, sizeof out);
    if (_wpk_gl_query_into(QOP_GET_STRING, &n, 4, out, sizeof out) != 0) return (const GLubyte *)"";
    uint32_t slen = 0;
    memcpy(&slen, out, 4);
    if (slen > sizeof out - 5) slen = sizeof out - 5;
    memmove(out, out + 4, slen);
    out[slen] = '\0';
    return out;
}

static uint32_t query_value_count(GLenum pname) {
    switch (pname) {
    case GL_VIEWPORT:
    case GL_SCISSOR_BOX:
    case GL_COLOR_CLEAR_VALUE:
    case GL_BLEND_COLOR:
        return 4;
    case GL_ALIASED_POINT_SIZE_RANGE:
    case GL_ALIASED_LINE_WIDTH_RANGE:
    case GL_DEPTH_RANGE:
        return 2;
    default:
        return 1;
    }
}

void glGetIntegerv(GLenum pname, GLint *data) {
    if (!data) return;
    uint32_t p = (uint32_t)pname;
    uint32_t count = query_value_count(pname);
    memset(data, 0, count * sizeof(GLint));
    (void)_wpk_gl_query_into(QOP_GET_INTEGERV, &p, 4, data, count * sizeof(GLint));
}

void glGetFloatv(GLenum pname, GLfloat *data) {
    if (!data) return;
    uint32_t p = (uint32_t)pname;
    uint32_t count = query_value_count(pname);
    memset(data, 0, count * sizeof(GLfloat));
    (void)_wpk_gl_query_into(QOP_GET_FLOATV, &p, 4, data, count * sizeof(GLfloat));
}

void glGetBooleanv(GLenum pname, GLboolean *data) {
    if (!data) return;
    GLint iv[4] = {0, 0, 0, 0};
    uint32_t count = query_value_count(pname);
    glGetIntegerv(pname, iv);
    for (uint32_t i = 0; i < count; i++) data[i] = iv[i] ? GL_TRUE : GL_FALSE;
}

void glGetShaderPrecisionFormat(GLenum shadertype, GLenum precisiontype,
                                GLint *range, GLint *precision) {
    (void)shadertype;
    (void)precisiontype;
    if (range) {
        range[0] = 127;
        range[1] = 127;
    }
    if (precision) *precision = 23;
}

GLint glGetAttribLocation(GLuint program, const GLchar *name) {
    if (!name) return -1;
    uint8_t in[256];
    size_t nlen = strlen(name);
    if (8 + nlen > sizeof in) return -1;
    uint32_t prog_u32 = program, nlen_u32 = (uint32_t)nlen;
    memcpy(in,     &prog_u32, 4);
    memcpy(in + 4, &nlen_u32, 4);
    memcpy(in + 8, name, nlen);
    int32_t loc = -1;
    if (_wpk_gl_query_into(QOP_GET_ATTRIB_LOC, in, (uint32_t)(8 + nlen), &loc, 4) != 0) return -1;
    return loc;
}

void glGetActiveAttrib(GLuint program, GLuint index, GLsizei bufSize,
                       GLsizei *length, GLint *size, GLenum *type, GLchar *name) {
    (void)program; (void)index;
    if (length) *length = 0;
    if (size) *size = 0;
    if (type) *type = 0;
    if (name && bufSize > 0) name[0] = '\0';
}

void glGetAttachedShaders(GLuint program, GLsizei maxCount, GLsizei *count, GLuint *shaders) {
    (void)program; (void)maxCount; (void)shaders;
    if (count) *count = 0;
}

/* ----- textures ----------------------------------------------------- */

static uint32_t g_next_texture     = 1;
static uint32_t g_next_framebuffer = 1;
static uint32_t g_next_renderbuffer = 1;
static uint32_t g_next_vertex_array = 1;

#define WPK_GL_MAX_UNIFORM_META 512
#define WPK_GL_UNIFORM_NAME_MAX 128

struct uniform_meta {
    GLuint program;
    GLint location;
    uint32_t values;
    char name[WPK_GL_UNIFORM_NAME_MAX];
};

static struct uniform_meta g_uniform_meta[WPK_GL_MAX_UNIFORM_META];
static uint32_t g_uniform_meta_count = 0;

static uint32_t uniform_value_count(GLenum type) {
    switch (type) {
    case GL_FLOAT:
    case GL_INT:
    case GL_BOOL:
    case GL_SAMPLER_2D:
    case GL_SAMPLER_CUBE:
        return 1;
    case GL_FLOAT_VEC2:
    case GL_INT_VEC2:
    case GL_BOOL_VEC2:
        return 2;
    case GL_FLOAT_VEC3:
    case GL_INT_VEC3:
    case GL_BOOL_VEC3:
        return 3;
    case GL_FLOAT_VEC4:
    case GL_INT_VEC4:
    case GL_BOOL_VEC4:
    case GL_FLOAT_MAT2:
        return 4;
    case GL_FLOAT_MAT3:
        return 9;
    case GL_FLOAT_MAT4:
        return 16;
    default:
        return 1;
    }
}

static int uniform_meta_name_equals(const char *a, const char *b) {
    return strncmp(a, b, WPK_GL_UNIFORM_NAME_MAX) == 0;
}

static struct uniform_meta *find_uniform_meta_by_name(GLuint program, const char *name) {
    if (!name) return NULL;
    for (uint32_t i = 0; i < g_uniform_meta_count; i++) {
        if (g_uniform_meta[i].program == program && uniform_meta_name_equals(g_uniform_meta[i].name, name))
            return &g_uniform_meta[i];
    }

    char base[WPK_GL_UNIFORM_NAME_MAX];
    size_t len = strnlen(name, sizeof base - 1);
    if (len >= sizeof base) len = sizeof base - 1;
    memcpy(base, name, len);
    base[len] = '\0';
    char *bracket = strchr(base, '[');
    if (!bracket) return NULL;
    *bracket = '\0';

    for (uint32_t i = 0; i < g_uniform_meta_count; i++) {
        if (g_uniform_meta[i].program == program && uniform_meta_name_equals(g_uniform_meta[i].name, base))
            return &g_uniform_meta[i];
    }
    return NULL;
}

static struct uniform_meta *find_uniform_meta_by_location(GLuint program, GLint location) {
    for (uint32_t i = 0; i < g_uniform_meta_count; i++) {
        if (g_uniform_meta[i].program == program && g_uniform_meta[i].location == location)
            return &g_uniform_meta[i];
    }
    return NULL;
}

static struct uniform_meta *alloc_uniform_meta(GLuint program, const char *name) {
    struct uniform_meta *m = find_uniform_meta_by_name(program, name);
    if (m) return m;
    uint32_t slot = g_uniform_meta_count < WPK_GL_MAX_UNIFORM_META
        ? g_uniform_meta_count++
        : (program + (uint32_t)(uintptr_t)name) % WPK_GL_MAX_UNIFORM_META;
    m = &g_uniform_meta[slot];
    memset(m, 0, sizeof *m);
    m->program = program;
    m->location = -1;
    if (name) {
        strncpy(m->name, name, sizeof m->name - 1);
        m->name[sizeof m->name - 1] = '\0';
    }
    return m;
}

static void remember_uniform_meta(GLuint program, const char *name, GLenum type) {
    if (!name || name[0] == '\0') return;
    uint32_t values = uniform_value_count(type);
    struct uniform_meta *m = alloc_uniform_meta(program, name);
    m->values = values;

    size_t len = strnlen(name, WPK_GL_UNIFORM_NAME_MAX - 1);
    if (len > 3 && strcmp(name + len - 3, "[0]") == 0) {
        char base[WPK_GL_UNIFORM_NAME_MAX];
        size_t base_len = len - 3;
        if (base_len >= sizeof base) base_len = sizeof base - 1;
        memcpy(base, name, base_len);
        base[base_len] = '\0';
        m = alloc_uniform_meta(program, base);
        m->values = values;
    }
}

static void link_uniform_location(GLuint program, const char *name, GLint location) {
    if (location < 0) return;
    struct uniform_meta *m = find_uniform_meta_by_name(program, name);
    if (!m) m = alloc_uniform_meta(program, name);
    if (m->values == 0) m->values = 1;
    m->location = location;
}

static uint32_t uniform_values_for_location(GLuint program, GLint location) {
    struct uniform_meta *m = find_uniform_meta_by_location(program, location);
    if (!m || m->values == 0) return 1;
    return m->values;
}

void glGenTextures(GLsizei n, GLuint *out) {
    if (n <= 0 || !out) return;
    EMIT_BEGIN(OP_GEN_TEXTURES, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) {
        out[i] = g_next_texture++;
        w_u32(&_c, out[i]);
    }
    EMIT_END()
}

void glDeleteTextures(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    EMIT_BEGIN(OP_DELETE_TEXTURES, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) w_u32(&_c, names[i]);
    EMIT_END()
}

void glBindTexture(GLenum target, GLuint tex) {
    EMIT_BEGIN(OP_BIND_TEXTURE, 8)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, tex);
    EMIT_END()
}

void glActiveTexture(GLenum unit) {
    EMIT_BEGIN(OP_ACTIVE_TEXTURE, 4)
    w_u32(&_c, (uint32_t)unit);
    EMIT_END()
}

void glGenerateMipmap(GLenum target) {
    EMIT_BEGIN(OP_GENERATE_MIPMAP, 4)
    w_u32(&_c, (uint32_t)target);
    EMIT_END()
}

static uint32_t pixel_component_count(GLenum format) {
    uint32_t channels = 0;
    switch (format) {
    case GL_ALPHA:
    case GL_LUMINANCE:
        channels = 1;
        break;
    case GL_LUMINANCE_ALPHA:
        channels = 2;
        break;
    case GL_RGB:
        channels = 3;
        break;
    case GL_RGBA:
        channels = 4;
        break;
    default:
        return 0;
    }
    return channels;
}

static uint32_t pixel_bytes_per_pixel(GLenum format, GLenum type) {
    uint32_t channels = pixel_component_count(format);
    uint32_t bytes_per_channel = 0;
    if (channels == 0) return 0;
    switch (type) {
    case GL_UNSIGNED_BYTE:
        bytes_per_channel = 1;
        break;
    case GL_UNSIGNED_SHORT:
#ifdef GL_HALF_FLOAT
    case GL_HALF_FLOAT:
#endif
        bytes_per_channel = 2;
        break;
    case GL_UNSIGNED_SHORT_5_6_5:
    case GL_UNSIGNED_SHORT_4_4_4_4:
    case GL_UNSIGNED_SHORT_5_5_5_1:
        channels = 1;
        bytes_per_channel = 2;
        break;
    case GL_UNSIGNED_INT:
    case GL_FLOAT:
        bytes_per_channel = 4;
        break;
#ifdef GL_UNSIGNED_INT_2_10_10_10_REV
    case GL_UNSIGNED_INT_2_10_10_10_REV:
        channels = 1;
        bytes_per_channel = 4;
        break;
#endif
#ifdef GL_UNSIGNED_INT_10F_11F_11F_REV
    case GL_UNSIGNED_INT_10F_11F_11F_REV:
        channels = 1;
        bytes_per_channel = 4;
        break;
#endif
#ifdef GL_UNSIGNED_INT_24_8
    case GL_UNSIGNED_INT_24_8:
        channels = 1;
        bytes_per_channel = 4;
        break;
#endif
    default:
        return 0;
    }
    return channels * bytes_per_channel;
}

static uint32_t pixel_data_len(GLsizei width, GLsizei height,
                               GLenum format, GLenum type) {
    if (width <= 0 || height <= 0) return 0;
    uint32_t bpp = pixel_bytes_per_pixel(format, type);
    if (bpp == 0) return 0;
    uint64_t len = (uint64_t)(uint32_t)width * (uint64_t)(uint32_t)height *
                   (uint64_t)bpp;
    if (len > UINT32_MAX) return 0;
    return (uint32_t)len;
}

void glTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset,
                     GLsizei width, GLsizei height, GLenum format, GLenum type,
                     const void *pixels);

static void emit_tex_sub_image_2d(GLenum target, GLint level,
                                  GLint xoffset, GLint yoffset,
                                  GLsizei width, GLsizei height,
                                  GLenum format, GLenum type,
                                  const uint8_t *pixels, uint32_t dlen) {
    EMIT_BEGIN(OP_TEX_SUB_IMAGE_2D, 36u + dlen)
    w_u32(&_c, (uint32_t)target);
    w_i32(&_c, level);
    w_i32(&_c, xoffset);
    w_i32(&_c, yoffset);
    w_i32(&_c, width);
    w_i32(&_c, height);
    w_u32(&_c, (uint32_t)format);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, dlen);
    memcpy(_c, pixels, dlen);
    _c += dlen;
    EMIT_END()
}

void glTexImage2D(GLenum target, GLint level, GLint internalFormat,
                  GLsizei width, GLsizei height, GLint border,
                  GLenum format, GLenum type, const void *data) {
    uint32_t dlen = data ? pixel_data_len(width, height, format, type) : 0u;
    if (data && dlen == 0) return;
    if (data && 36u + dlen > WPK_GL_MAX_TLV_PAYLOAD) {
        glTexImage2D(target, level, internalFormat, width, height, border,
                     format, type, NULL);
        glTexSubImage2D(target, level, 0, 0, width, height, format, type, data);
        return;
    }
    EMIT_BEGIN(OP_TEX_IMAGE_2D, 36u + dlen)
    w_u32(&_c, (uint32_t)target);
    w_i32(&_c, level);
    w_i32(&_c, internalFormat);
    w_i32(&_c, width);
    w_i32(&_c, height);
    w_i32(&_c, border);
    w_u32(&_c, (uint32_t)format);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, dlen);
    if (data && dlen > 0) {
        memcpy(_c, data, dlen);
        _c += dlen;
    }
    EMIT_END()
}

void glTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset,
                     GLsizei width, GLsizei height, GLenum format, GLenum type,
                     const void *pixels) {
    uint32_t dlen = pixels ? pixel_data_len(width, height, format, type) : 0u;
    if (!pixels || dlen == 0) return;
    if (36u + dlen <= WPK_GL_MAX_TLV_PAYLOAD) {
        emit_tex_sub_image_2d(target, level, xoffset, yoffset, width, height,
                              format, type, (const uint8_t *)pixels, dlen);
        return;
    }

    uint32_t row_len = pixel_data_len(width, 1, format, type);
    if (row_len == 0 || 36u + row_len > WPK_GL_MAX_TLV_PAYLOAD) return;
    uint32_t max_rows = (WPK_GL_MAX_TLV_PAYLOAD - 36u) / row_len;
    if (max_rows == 0) return;

    const uint8_t *src = (const uint8_t *)pixels;
    GLsizei row = 0;
    while (row < height) {
        GLsizei rows = (GLsizei)max_rows;
        if (rows > height - row) rows = height - row;
        uint32_t chunk_len = row_len * (uint32_t)rows;
        emit_tex_sub_image_2d(target, level, xoffset, yoffset + row, width, rows,
                              format, type, src + (size_t)row_len * (size_t)row,
                              chunk_len);
        row += rows;
    }
}

void glTexParameteri(GLenum target, GLenum pname, GLint param) {
    EMIT_BEGIN(OP_TEX_PARAMETERI, 12)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_END()
}

void glTexParameterf(GLenum target, GLenum pname, GLfloat param) {
    EMIT_BEGIN(OP_TEX_PARAMETERF, 12)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)pname);
    w_f32(&_c, param);
    EMIT_END()
}

void glTexParameteriv(GLenum target, GLenum pname, const GLint *params) {
    if (params) glTexParameteri(target, pname, params[0]);
}

void glTexParameterfv(GLenum target, GLenum pname, const GLfloat *params) {
    if (params) glTexParameterf(target, pname, params[0]);
}

void glCompressedTexImage2D(GLenum target, GLint level, GLenum internalformat,
                            GLsizei width, GLsizei height, GLint border,
                            GLsizei imageSize, const void *data) {
    if (imageSize < 0 || (imageSize > 0 && !data)) return;
    uint32_t dlen = (uint32_t)imageSize;
    if (28u + dlen > WPK_GL_MAX_TLV_PAYLOAD) return;
    EMIT_BEGIN(OP_COMPRESSED_TEX_IMAGE_2D, 28u + dlen)
    w_u32(&_c, (uint32_t)target);
    w_i32(&_c, level);
    w_u32(&_c, (uint32_t)internalformat);
    w_i32(&_c, width);
    w_i32(&_c, height);
    w_i32(&_c, border);
    w_u32(&_c, dlen);
    if (dlen > 0) { memcpy(_c, data, dlen); _c += dlen; }
    EMIT_END()
}

void glCompressedTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset,
                               GLsizei width, GLsizei height, GLenum format,
                               GLsizei imageSize, const void *data) {
    if (imageSize <= 0 || !data) return;
    uint32_t dlen = (uint32_t)imageSize;
    if (32u + dlen > WPK_GL_MAX_TLV_PAYLOAD) return;
    EMIT_BEGIN(OP_COMPRESSED_TEX_SUB_IMAGE_2D, 32u + dlen)
    w_u32(&_c, (uint32_t)target);
    w_i32(&_c, level);
    w_i32(&_c, xoffset);
    w_i32(&_c, yoffset);
    w_i32(&_c, width);
    w_i32(&_c, height);
    w_u32(&_c, (uint32_t)format);
    w_u32(&_c, dlen);
    memcpy(_c, data, dlen); _c += dlen;
    EMIT_END()
}

void glCopyTexImage2D(GLenum target, GLint level, GLenum internalformat,
                      GLint x, GLint y, GLsizei width, GLsizei height, GLint border) {
    EMIT_BEGIN(OP_COPY_TEX_IMAGE_2D, 32)
    w_u32(&_c, (uint32_t)target);
    w_i32(&_c, level);
    w_u32(&_c, (uint32_t)internalformat);
    w_i32(&_c, x); w_i32(&_c, y); w_i32(&_c, width); w_i32(&_c, height); w_i32(&_c, border);
    EMIT_END()
}

void glCopyTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset,
                         GLint x, GLint y, GLsizei width, GLsizei height) {
    EMIT_BEGIN(OP_COPY_TEX_SUB_IMAGE_2D, 32)
    w_u32(&_c, (uint32_t)target);
    w_i32(&_c, level);
    w_i32(&_c, xoffset);
    w_i32(&_c, yoffset);
    w_i32(&_c, x);
    w_i32(&_c, y);
    w_i32(&_c, width);
    w_i32(&_c, height);
    EMIT_END()
}

/* ----- uniforms ----------------------------------------------------- */

void glUniform1i(GLint location, GLint v) {
    if (location < 0) return;
    EMIT_BEGIN(OP_UNIFORM1I, 8)
    w_i32(&_c, location);
    w_i32(&_c, v);
    EMIT_END()
}
void glUniform1f(GLint location, GLfloat v) {
    if (location < 0) return;
    EMIT_BEGIN(OP_UNIFORM1F, 8)
    w_i32(&_c, location);
    w_f32(&_c, v);
    EMIT_END()
}
void glUniform2f(GLint location, GLfloat x, GLfloat y) {
    if (location < 0) return;
    EMIT_BEGIN(OP_UNIFORM2F, 12)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y);
    EMIT_END()
}
void glUniform3f(GLint location, GLfloat x, GLfloat y, GLfloat z) {
    if (location < 0) return;
    EMIT_BEGIN(OP_UNIFORM3F, 16)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z);
    EMIT_END()
}
void glUniform4f(GLint location, GLfloat x, GLfloat y, GLfloat z, GLfloat w) {
    if (location < 0) return;
    EMIT_BEGIN(OP_UNIFORM4F, 20)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z); w_f32(&_c, w);
    EMIT_END()
}

static void emit_uniform_fv(uint16_t op, GLint location, GLsizei count,
                            const GLfloat *value, uint32_t components) {
    if (location < 0) return;
    if (count <= 0 || !value) return;
    uint32_t n = (uint32_t)count * components;
    EMIT_BEGIN(op, 8u + n * 4u)
    w_i32(&_c, location);
    w_u32(&_c, (uint32_t)count);
    for (uint32_t i = 0; i < n; i++) w_f32(&_c, value[i]);
    EMIT_END()
}

static void emit_uniform_iv(uint16_t op, GLint location, GLsizei count,
                            const GLint *value, uint32_t components) {
    if (location < 0) return;
    if (count <= 0 || !value) return;
    uint32_t n = (uint32_t)count * components;
    EMIT_BEGIN(op, 8u + n * 4u)
    w_i32(&_c, location);
    w_u32(&_c, (uint32_t)count);
    for (uint32_t i = 0; i < n; i++) w_i32(&_c, value[i]);
    EMIT_END()
}

static void emit_uniform_matrix(uint16_t op, GLint location, GLsizei count,
                                GLboolean transpose, const GLfloat *value,
                                uint32_t components) {
    if (location < 0) return;
    if (count <= 0 || !value) return;
    uint32_t n = (uint32_t)count * components;
    EMIT_BEGIN(op, 12u + n * 4u)
    w_i32(&_c, location);
    w_u32(&_c, (uint32_t)count);
    w_u32(&_c, transpose ? 1u : 0u);
    for (uint32_t i = 0; i < n; i++) w_f32(&_c, value[i]);
    EMIT_END()
}

void glUniform1fv(GLint location, GLsizei count, const GLfloat *value) { emit_uniform_fv(OP_UNIFORM1FV, location, count, value, 1); }
void glUniform2fv(GLint location, GLsizei count, const GLfloat *value) { emit_uniform_fv(OP_UNIFORM2FV, location, count, value, 2); }
void glUniform3fv(GLint location, GLsizei count, const GLfloat *value) { emit_uniform_fv(OP_UNIFORM3FV, location, count, value, 3); }
void glUniform4fv(GLint location, GLsizei count, const GLfloat *value) { emit_uniform_fv(OP_UNIFORM4FV, location, count, value, 4); }
void glUniform1iv(GLint location, GLsizei count, const GLint *value) { emit_uniform_iv(OP_UNIFORM1IV, location, count, value, 1); }
void glUniform2iv(GLint location, GLsizei count, const GLint *value) { emit_uniform_iv(OP_UNIFORM2IV, location, count, value, 2); }
void glUniform3iv(GLint location, GLsizei count, const GLint *value) { emit_uniform_iv(OP_UNIFORM3IV, location, count, value, 3); }
void glUniform4iv(GLint location, GLsizei count, const GLint *value) { emit_uniform_iv(OP_UNIFORM4IV, location, count, value, 4); }
void glUniform2i(GLint location, GLint x, GLint y) { GLint v[2] = {x, y}; glUniform2iv(location, 1, v); }
void glUniform3i(GLint location, GLint x, GLint y, GLint z) { GLint v[3] = {x, y, z}; glUniform3iv(location, 1, v); }
void glUniform4i(GLint location, GLint x, GLint y, GLint z, GLint w) { GLint v[4] = {x, y, z, w}; glUniform4iv(location, 1, v); }
void glUniformMatrix2fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) { emit_uniform_matrix(OP_UNIFORM_MATRIX2FV, location, count, transpose, value, 4); }
void glUniformMatrix3fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) { emit_uniform_matrix(OP_UNIFORM_MATRIX3FV, location, count, transpose, value, 9); }
void glUniformMatrix4fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) { emit_uniform_matrix(OP_UNIFORM_MATRIX4FV, location, count, transpose, value, 16); }

/* ----- framebuffers ------------------------------------------------- */

void glGenFramebuffers(GLsizei n, GLuint *out) {
    if (n <= 0 || !out) return;
    EMIT_BEGIN(OP_GEN_FRAMEBUFFERS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) {
        out[i] = g_next_framebuffer++;
        w_u32(&_c, out[i]);
    }
    EMIT_END()
}

void glDeleteFramebuffers(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    EMIT_BEGIN(OP_DELETE_FRAMEBUFFERS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) w_u32(&_c, names[i]);
    EMIT_END()
}

void glBindFramebuffer(GLenum target, GLuint fb) {
    EMIT_BEGIN(OP_BIND_FRAMEBUFFER, 8)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, fb);
    EMIT_END()
}

void glGenRenderbuffers(GLsizei n, GLuint *out) {
    if (n <= 0 || !out) return;
    EMIT_BEGIN(OP_GEN_RENDERBUFFERS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) {
        out[i] = g_next_renderbuffer++;
        w_u32(&_c, out[i]);
    }
    EMIT_END()
}

void glDeleteRenderbuffers(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    EMIT_BEGIN(OP_DELETE_RENDERBUFFERS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) w_u32(&_c, names[i]);
    EMIT_END()
}

void glBindRenderbuffer(GLenum target, GLuint rb) {
    EMIT_BEGIN(OP_BIND_RENDERBUFFER, 8)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, rb);
    EMIT_END()
}

void glRenderbufferStorage(GLenum target, GLenum internalformat, GLsizei width, GLsizei height) {
    EMIT_BEGIN(OP_RENDERBUFFER_STORAGE, 16)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)internalformat);
    w_i32(&_c, width);
    w_i32(&_c, height);
    EMIT_END()
}

void glFramebufferRenderbuffer(GLenum target, GLenum attachment,
                               GLenum renderbuffertarget, GLuint renderbuffer) {
    EMIT_BEGIN(OP_FRAMEBUFFER_RENDERBUFFER, 16)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)attachment);
    w_u32(&_c, (uint32_t)renderbuffertarget);
    w_u32(&_c, renderbuffer);
    EMIT_END()
}

void glDrawBuffer(GLenum buf) {
    EMIT_BEGIN(OP_DRAW_BUFFER, 4)
    w_u32(&_c, (uint32_t)buf);
    EMIT_END()
}

void glDrawBuffers(GLsizei n, const GLenum *bufs) {
    if (n <= 0 || !bufs) return;
    EMIT_BEGIN(OP_DRAW_BUFFERS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) w_u32(&_c, (uint32_t)bufs[i]);
    EMIT_END()
}

void glReadBuffer(GLenum src) {
    EMIT_BEGIN(OP_READ_BUFFER, 4)
    w_u32(&_c, (uint32_t)src);
    EMIT_END()
}

void glGenVertexArrays(GLsizei n, GLuint *out) {
    if (n <= 0 || !out) return;
    EMIT_BEGIN(OP_GEN_VERTEX_ARRAYS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) {
        out[i] = g_next_vertex_array++;
        w_u32(&_c, out[i]);
    }
    EMIT_END()
}

void glDeleteVertexArrays(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    EMIT_BEGIN(OP_DELETE_VERTEX_ARRAYS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) w_u32(&_c, names[i]);
    EMIT_END()
}

void glBindVertexArray(GLuint array) {
    EMIT_BEGIN(OP_BIND_VERTEX_ARRAY, 4)
    w_u32(&_c, array);
    EMIT_END()
}

void glFramebufferTexture2D(GLenum target, GLenum attachment,
                            GLenum textarget, GLuint texture, GLint level) {
    EMIT_BEGIN(OP_FRAMEBUFFER_TEXTURE_2D, 20)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)attachment);
    w_u32(&_c, (uint32_t)textarget);
    w_u32(&_c, texture);
    w_i32(&_c, level);
    EMIT_END()
}

/* ----- blend -------------------------------------------------------- */

void glBlendFunc(GLenum sfactor, GLenum dfactor) {
    EMIT_BEGIN(OP_BLEND_FUNC, 8)
    w_u32(&_c, (uint32_t)sfactor);
    w_u32(&_c, (uint32_t)dfactor);
    EMIT_END()
}

/* ----- queries: locations, shader/program info --------------------- */

GLint glGetUniformLocation(GLuint program, const GLchar *name) {
    if (!name) return -1;
    uint8_t in[256];
    size_t nlen = strlen(name);
    if (8 + nlen > sizeof in) return -1;
    uint32_t prog_u32 = program, nlen_u32 = (uint32_t)nlen;
    memcpy(in,     &prog_u32, 4);
    memcpy(in + 4, &nlen_u32, 4);
    memcpy(in + 8, name, nlen);
    int32_t loc = -1;
    if (_wpk_gl_query_into(QOP_GET_UNIFORM_LOC, in, (uint32_t)(8 + nlen), &loc, 4) != 0) return -1;
    link_uniform_location(program, name, loc);
    return loc;
}

GLenum glCheckFramebufferStatus(GLenum target) {
    uint32_t t = (uint32_t)target;
    uint32_t status = 0;
    if (_wpk_gl_query_into(QOP_CHECK_FB_STATUS, &t, 4, &status, 4) != 0) return GL_FRAMEBUFFER_COMPLETE;
    return (GLenum)status;
}

void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height,
                  GLenum format, GLenum type, void *pixels) {
    if (!pixels || width <= 0 || height <= 0) return;
    uint32_t bpp = pixel_bytes_per_pixel(format, type);
    if (bpp == 0) return;
    const uint32_t max_query_out_len = 64u * 1024u;
    uint32_t row_len = (uint32_t)width * bpp;
    uint8_t *dst = (uint8_t *)pixels;

    for (int32_t yoff = 0; yoff < height;) {
        uint32_t rows = row_len > 0 ? max_query_out_len / row_len : 0;
        if (rows == 0) rows = 1;
        if (rows > (uint32_t)(height - yoff)) rows = (uint32_t)(height - yoff);

        if (row_len <= max_query_out_len) {
            uint8_t in[24];
            int32_t xi = x, yi = y + yoff;
            int32_t wi = width, hi = (int32_t)rows;
            uint32_t fmt = (uint32_t)format, t = (uint32_t)type;
            uint32_t len = row_len * rows;
            memcpy(in,      &xi,  4);
            memcpy(in + 4,  &yi,  4);
            memcpy(in + 8,  &wi,  4);
            memcpy(in + 12, &hi,  4);
            memcpy(in + 16, &fmt, 4);
            memcpy(in + 20, &t,   4);
            if (_wpk_gl_query_into(QOP_READ_PIXELS, in, sizeof in,
                                    dst + (uint32_t)yoff * row_len, len) != 0)
                return;
            yoff += (int32_t)rows;
            continue;
        }

        uint32_t max_cols = max_query_out_len / bpp;
        if (max_cols == 0) return;
        for (int32_t xoff = 0; xoff < width; xoff += (int32_t)max_cols) {
            uint32_t cols = max_cols;
            if (cols > (uint32_t)(width - xoff)) cols = (uint32_t)(width - xoff);
            uint8_t in[24];
            int32_t xi = x + xoff, yi = y + yoff;
            int32_t wi = (int32_t)cols, hi = 1;
            uint32_t fmt = (uint32_t)format, t = (uint32_t)type;
            uint32_t len = cols * bpp;
            memcpy(in,      &xi,  4);
            memcpy(in + 4,  &yi,  4);
            memcpy(in + 8,  &wi,  4);
            memcpy(in + 12, &hi,  4);
            memcpy(in + 16, &fmt, 4);
            memcpy(in + 20, &t,   4);
            if (_wpk_gl_query_into(QOP_READ_PIXELS, in, sizeof in,
                                    dst + (uint32_t)yoff * row_len + (uint32_t)xoff * bpp, len) != 0)
                return;
        }
        yoff++;
    }
}

void glGetShaderiv(GLuint shader, GLenum pname, GLint *params) {
    if (!params) return;
    uint8_t in[8];
    uint32_t s = shader, p = (uint32_t)pname;
    memcpy(in, &s, 4); memcpy(in + 4, &p, 4);
    int32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_SHADERIV, in, 8, &out, 4) != 0) { *params = 0; return; }
    *params = out;
}

void glGetShaderInfoLog(GLuint shader, GLsizei bufSize, GLsizei *length, GLchar *infoLog) {
    if (length) *length = 0;
    if (!infoLog || bufSize <= 0) return;
    infoLog[0] = '\0';
    uint32_t s = shader;
    uint8_t out[1024 + 4];
    if (_wpk_gl_query_into(QOP_GET_SHADER_INFO_LOG, &s, 4, out, sizeof out) != 0) return;
    uint32_t slen;
    memcpy(&slen, out, 4);
    if (slen > sizeof out - 4) slen = sizeof out - 4;
    GLsizei copy = (GLsizei)slen;
    if (copy > bufSize - 1) copy = bufSize - 1;
    memcpy(infoLog, out + 4, (size_t)copy);
    infoLog[copy] = '\0';
    if (length) *length = copy;
}

void glGetProgramiv(GLuint program, GLenum pname, GLint *params) {
    if (!params) return;
    uint8_t in[8];
    uint32_t s = program, p = (uint32_t)pname;
    memcpy(in, &s, 4); memcpy(in + 4, &p, 4);
    int32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_PROGRAMIV, in, 8, &out, 4) != 0) { *params = 0; return; }
    *params = out;
}

void glGetProgramInfoLog(GLuint program, GLsizei bufSize, GLsizei *length, GLchar *infoLog) {
    if (length) *length = 0;
    if (!infoLog || bufSize <= 0) return;
    infoLog[0] = '\0';
    uint32_t s = program;
    uint8_t out[1024 + 4];
    if (_wpk_gl_query_into(QOP_GET_PROGRAM_INFO_LOG, &s, 4, out, sizeof out) != 0) return;
    uint32_t slen;
    memcpy(&slen, out, 4);
    if (slen > sizeof out - 4) slen = sizeof out - 4;
    GLsizei copy = (GLsizei)slen;
    if (copy > bufSize - 1) copy = bufSize - 1;
    memcpy(infoLog, out + 4, (size_t)copy);
    infoLog[copy] = '\0';
    if (length) *length = copy;
}

void glGetActiveUniform(GLuint program, GLuint index, GLsizei bufSize,
                        GLsizei *length, GLint *size, GLenum *type, GLchar *name) {
    if (length) *length = 0;
    if (size) *size = 0;
    if (type) *type = 0;
    if (name && bufSize > 0) name[0] = '\0';
    if (!name || bufSize <= 0) return;

    uint8_t in[12];
    uint32_t p = program, i = index, cap = (uint32_t)(bufSize - 1);
    memcpy(in, &p, 4);
    memcpy(in + 4, &i, 4);
    memcpy(in + 8, &cap, 4);

    uint8_t out[12 + 256];
    if (_wpk_gl_query_into(QOP_GET_ACTIVE_UNIFORM, in, sizeof in, out, sizeof out) != 0) return;

    uint32_t name_len = 0;
    int32_t uniform_size = 0;
    uint32_t uniform_type = 0;
    memcpy(&name_len, out, 4);
    memcpy(&uniform_size, out + 4, 4);
    memcpy(&uniform_type, out + 8, 4);
    if (name_len > sizeof out - 12) name_len = sizeof out - 12;
    if (name_len > (uint32_t)(bufSize - 1)) name_len = (uint32_t)(bufSize - 1);
    memcpy(name, out + 12, name_len);
    name[name_len] = '\0';
    remember_uniform_meta(program, name, (GLenum)uniform_type);
    if (length) *length = (GLsizei)name_len;
    if (size) *size = uniform_size;
    if (type) *type = (GLenum)uniform_type;
}

void glGetUniformfv(GLuint program, GLint location, GLfloat *params) {
    if (!params) return;
    uint8_t in[8];
    uint32_t p = program;
    int32_t loc = location;
    memcpy(in, &p, 4);
    memcpy(in + 4, &loc, 4);
    uint32_t values = uniform_values_for_location(program, location);
    memset(params, 0, values * sizeof(GLfloat));
    (void)_wpk_gl_query_into(QOP_GET_UNIFORMFV, in, sizeof in, params, values * sizeof(GLfloat));
}

void glGetUniformiv(GLuint program, GLint location, GLint *params) {
    if (!params) return;
    uint8_t in[8];
    uint32_t p = program;
    int32_t loc = location;
    memcpy(in, &p, 4);
    memcpy(in + 4, &loc, 4);
    uint32_t values = uniform_values_for_location(program, location);
    memset(params, 0, values * sizeof(GLint));
    (void)_wpk_gl_query_into(QOP_GET_UNIFORMIV, in, sizeof in, params, values * sizeof(GLint));
}

void glGetTexParameterfv(GLenum target, GLenum pname, GLfloat *params) {
    (void)target; (void)pname;
    if (params) *params = 0.0f;
}

void glGetTexParameteriv(GLenum target, GLenum pname, GLint *params) {
    (void)target; (void)pname;
    if (params) *params = 0;
}

void glGetBufferParameteriv(GLenum target, GLenum pname, GLint *params) {
    (void)target; (void)pname;
    if (params) *params = 0;
}

void glGetFramebufferAttachmentParameteriv(GLenum target, GLenum attachment,
                                           GLenum pname, GLint *params) {
    (void)target; (void)attachment; (void)pname;
    if (params) *params = 0;
}

void glGetRenderbufferParameteriv(GLenum target, GLenum pname, GLint *params) {
    (void)target; (void)pname;
    if (params) *params = 0;
}

void glGetVertexAttribfv(GLuint index, GLenum pname, GLfloat *params) {
    (void)index; (void)pname;
    if (params) *params = 0.0f;
}

void glGetVertexAttribiv(GLuint index, GLenum pname, GLint *params) {
    (void)index; (void)pname;
    if (params) *params = 0;
}

void glGetVertexAttribPointerv(GLuint index, GLenum pname, void **pointer) {
    (void)index; (void)pname;
    if (pointer) *pointer = NULL;
}

void glGetShaderSource(GLuint shader, GLsizei bufSize, GLsizei *length, GLchar *source) {
    (void)shader;
    if (length) *length = 0;
    if (source && bufSize > 0) source[0] = '\0';
}

void glValidateProgram(GLuint program) { (void)program; }
void glShaderBinary(GLsizei count, const GLuint *shaders, GLenum binaryFormat,
                    const void *binary, GLsizei length) {
    (void)count; (void)shaders; (void)binaryFormat; (void)binary; (void)length;
}

GLboolean glIsBuffer(GLuint buffer) { return buffer != 0 ? GL_TRUE : GL_FALSE; }
GLboolean glIsEnabled(GLenum cap) { (void)cap; return GL_FALSE; }
GLboolean glIsFramebuffer(GLuint framebuffer) { return framebuffer != 0 ? GL_TRUE : GL_FALSE; }
GLboolean glIsProgram(GLuint program) { return program != 0 ? GL_TRUE : GL_FALSE; }
GLboolean glIsRenderbuffer(GLuint renderbuffer) { return renderbuffer != 0 ? GL_TRUE : GL_FALSE; }
GLboolean glIsShader(GLuint shader) { return shader != 0 ? GL_TRUE : GL_FALSE; }
GLboolean glIsTexture(GLuint texture) { return texture != 0 ? GL_TRUE : GL_FALSE; }

void glFinish(void) { _wpk_gl_flush(); }
void glFlush(void) { _wpk_gl_flush(); }
