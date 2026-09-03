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
 *
 * v1 scope is what `programs/gltri.c` exercises — clear, viewport,
 * shader compile/link, vertex attribs, drawArrays. Texture/FBO/VAO/RBO
 * ops live in shared::gl but are deliberately not encoded here yet;
 * they land alongside the demos that need them.
 */

#include <GLES2/gl2.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>

#include "gl_abi.h"

static uint8_t *g_cursor = NULL;

/* Client-side mirror of GL_UNPACK_ALIGNMENT so glTexImage2D /
 * glTexSubImage2D can size source rows when splitting an upload into
 * u16-payload records. */
static GLint g_unpack_alignment = 4;

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
    ioctl(fd, GLIO_SUBMIT, &si);
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

/* ----- buffers ------------------------------------------------------ */

static uint32_t g_next_buffer  = 1;
static uint32_t g_next_shader  = 1;
static uint32_t g_next_program = 1;

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

void glBindBuffer(GLenum target, GLuint buf) {
    EMIT_BEGIN(OP_BIND_BUFFER, 8)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)buf);
    EMIT_END()
}

void glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size,
                     const void *data) {
    if (size <= 0 || !data) return;
    /* Payload: u32 target, i32 dstOffset, u32 dataLen, u8 data[dataLen].
     * The TLV payload-length field is u16, so larger updates split into
     * consecutive records with the destination offset advanced. */
    const uint8_t *src = (const uint8_t *)data;
    uint32_t remaining = (uint32_t)size;
    uint32_t dst = (uint32_t)offset;
    while (remaining > 0) {
        uint32_t dlen = remaining;
        if (dlen > 0xFFFFu - 12u) dlen = 0xFFFFu - 12u;
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

void glBufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage) {
    if (size < 0) return;
    /* Payload: u32 target, u32 dataLen, u8 data[dataLen], u32 usage. */
    uint32_t dlen = (uint32_t)size;
    EMIT_BEGIN(OP_BUFFER_DATA, 12u + dlen)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, dlen);
    if (dlen > 0) {
        /* NULL data allocates an uninitialized store; WebGL zero-fills a
         * sized allocation, so ship zeros to keep the TLV framing and the
         * store size aligned. */
        if (data) memcpy(_c, data, dlen);
        else memset(_c, 0, dlen);
        _c += dlen;
    }
    w_u32(&_c, (uint32_t)usage);
    EMIT_END()
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

void glDetachShader(GLuint program, GLuint shader) {
    EMIT_BEGIN(OP_DETACH_SHADER, 8)
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

void glEnableVertexAttribArray(GLuint index) {
    EMIT_BEGIN(OP_ENABLE_VERTEX_ATTRIB_ARRAY, 4) w_u32(&_c, (uint32_t)index); EMIT_END()
}

void glDisableVertexAttribArray(GLuint index) {
    EMIT_BEGIN(OP_DISABLE_VERTEX_ATTRIB_ARRAY, 4) w_u32(&_c, (uint32_t)index); EMIT_END()
}

void glVertexAttribPointer(GLuint index, GLint size, GLenum type,
                           GLboolean normalized, GLsizei stride,
                           const void *pointer) {
    /* `pointer` is a buffer offset when a VBO is bound (the only mode
     * WebGL2 supports — client arrays aren't part of the WebGL surface). */
    EMIT_BEGIN(OP_VERTEX_ATTRIB_POINTER, 24)
    w_u32(&_c, (uint32_t)index);
    w_i32(&_c, (int32_t)size);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, normalized ? 1u : 0u);
    w_i32(&_c, (int32_t)stride);
    w_i32(&_c, (int32_t)(uintptr_t)pointer);
    EMIT_END()
}

void glVertexAttrib4fv(GLuint index, const GLfloat *values) {
    if (!values) return;
    EMIT_BEGIN(OP_VERTEX_ATTRIB_4FV, 20)
    w_u32(&_c, (uint32_t)index);
    w_f32(&_c, values[0]); w_f32(&_c, values[1]);
    w_f32(&_c, values[2]); w_f32(&_c, values[3]);
    EMIT_END()
}

void glDrawArrays(GLenum mode, GLint first, GLsizei count) {
    EMIT_BEGIN(OP_DRAW_ARRAYS, 12)
    w_u32(&_c, (uint32_t)mode);
    w_i32(&_c, first);
    w_i32(&_c, (int32_t)count);
    EMIT_END()
}

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
    if (rc == 0 && dst_len) memcpy(dst, heap, dst_len);
    free(heap);
    return rc;
}

GLenum glGetError(void) {
    uint32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_ERROR, NULL, 0, &out, 4) != 0) return GL_NO_ERROR;
    return (GLenum)out;
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

/* ----- textures ----------------------------------------------------- */

static uint32_t g_next_texture     = 1;
static uint32_t g_next_framebuffer = 1;

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

/* Bytes-per-pixel for the GL (format,type) pairs we know how to
 * marshal. Returns 0 for unknown combos so glTexImage2D / glTexSubImage2D
 * drops the upload rather than emit a garbled record. Extend when a
 * demo needs a new combo. */
static uint32_t bytes_per_pixel(GLenum format, GLenum type) {
    if (type == GL_UNSIGNED_BYTE) {
        switch (format) {
            case GL_ALPHA:           return 1;
            case GL_LUMINANCE:       return 1;
            case GL_LUMINANCE_ALPHA: return 2;
            case GL_RGB:             return 3;
            case GL_RGBA:            return 4;
            default: break;
        }
    } else if (type == GL_UNSIGNED_SHORT_5_6_5
            || type == GL_UNSIGNED_SHORT_4_4_4_4
            || type == GL_UNSIGNED_SHORT_5_5_5_1) {
        return 2;
    }
    return 0;
}

/* Source row stride under the current GL_UNPACK_ALIGNMENT. */
static uint32_t unpack_row_stride(GLsizei width, uint32_t bpp) {
    uint32_t row = (uint32_t)width * bpp;
    uint32_t a = (uint32_t)g_unpack_alignment;
    return (row + a - 1u) & ~(a - 1u);
}

/* Emit one or more OP_TEX_SUB_IMAGE_2D records for a rect upload. The
 * TLV payload-length field is u16, so uploads larger than ~64 KB are
 * split into row bands; each band's data is sized to the GL client
 * image layout ((rows-1)*stride + width*bpp) so the copy never reads
 * past the caller's last row. */
static void emit_tex_sub_image_2d(GLenum target, GLint level,
                                  GLint xoff, GLint yoff,
                                  GLsizei width, GLsizei height,
                                  GLenum format, GLenum type,
                                  const void *data) {
    uint32_t bpp = bytes_per_pixel(format, type);
    if (bpp == 0 || data == NULL || width <= 0 || height <= 0) return;
    uint32_t stride = unpack_row_stride(width, bpp);
    uint32_t tail = (uint32_t)width * bpp;
    uint32_t max_rows = (0xFFFFu - 36u) / stride;
    if (max_rows == 0) return;
    const uint8_t *src = (const uint8_t *)data;
    for (GLsizei y = 0; y < height; ) {
        uint32_t rows = (uint32_t)(height - y);
        if (rows > max_rows) rows = max_rows;
        uint32_t dlen = (rows - 1u) * stride + tail;
        EMIT_BEGIN(OP_TEX_SUB_IMAGE_2D, 36u + dlen)
        w_u32(&_c, (uint32_t)target);
        w_i32(&_c, level);
        w_i32(&_c, xoff);
        w_i32(&_c, yoff + y);
        w_i32(&_c, width);
        w_i32(&_c, (int32_t)rows);
        w_u32(&_c, (uint32_t)format);
        w_u32(&_c, (uint32_t)type);
        w_u32(&_c, dlen);
        memcpy(_c, src + (uint32_t)y * stride, dlen);
        _c += dlen;
        EMIT_END()
        y += (GLsizei)rows;
    }
}

void glTexImage2D(GLenum target, GLint level, GLint internalFormat,
                  GLsizei width, GLsizei height, GLint border,
                  GLenum format, GLenum type, const void *data) {
    uint32_t dlen = 0;
    if (data != NULL && width > 0 && height > 0) {
        uint32_t bpp = bytes_per_pixel(format, type);
        if (bpp > 0) {
            dlen = (uint32_t) width * (uint32_t) height * bpp;
        }
    }
    /* The TLV payload-length field is u16, so the largest single-call
     * upload that fits is 0xFFFF - 36 (header fields) ≈ 65499 bytes.
     * Larger uploads allocate the texture with no data here and stream
     * the pixels through chunked OP_TEX_SUB_IMAGE_2D records below. */
    const void *inline_data = data;
    if (dlen > 0xFFFFu - 36u) {
        dlen = 0;
        inline_data = NULL;
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
    if (dlen > 0) {
        /* NULL data allocates an uninitialized texture; WebGL zero-fills,
         * so ship zeros to keep the TLV framing and semantics aligned. */
        if (inline_data) memcpy(_c, inline_data, dlen);
        else memset(_c, 0, dlen);
        _c += dlen;
    }
    EMIT_END()
    if (inline_data == NULL && data != NULL) {
        emit_tex_sub_image_2d(target, level, 0, 0, width, height,
                              format, type, data);
    }
}

void glTexSubImage2D(GLenum target, GLint level, GLint xoff, GLint yoff,
                     GLsizei width, GLsizei height,
                     GLenum format, GLenum type, const void *data) {
    emit_tex_sub_image_2d(target, level, xoff, yoff, width, height,
                          format, type, data);
}

void glGenerateMipmap(GLenum target) {
    EMIT_BEGIN(OP_GENERATE_MIPMAP, 4)
    w_u32(&_c, (uint32_t)target);
    EMIT_END()
}

void glTexParameteri(GLenum target, GLenum pname, GLint param) {
    EMIT_BEGIN(OP_TEX_PARAMETERI, 12)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_END()
}

void glPixelStorei(GLenum pname, GLint param) {
    if (pname == GL_UNPACK_ALIGNMENT
        && (param == 1 || param == 2 || param == 4 || param == 8)) {
        g_unpack_alignment = param;
    }
    EMIT_BEGIN(OP_PIXEL_STOREI, 8)
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_END()
}

void glDeleteBuffers(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    EMIT_BEGIN(OP_DELETE_BUFFERS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) w_u32(&_c, names[i]);
    EMIT_END()
}

/* ----- uniforms ----------------------------------------------------- */

void glUniform1i(GLint location, GLint v) {
    EMIT_BEGIN(OP_UNIFORM1I, 8)
    w_i32(&_c, location);
    w_i32(&_c, v);
    EMIT_END()
}
void glUniform1f(GLint location, GLfloat v) {
    EMIT_BEGIN(OP_UNIFORM1F, 8)
    w_i32(&_c, location);
    w_f32(&_c, v);
    EMIT_END()
}
void glUniform2f(GLint location, GLfloat x, GLfloat y) {
    EMIT_BEGIN(OP_UNIFORM2F, 12)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y);
    EMIT_END()
}
void glUniform3f(GLint location, GLfloat x, GLfloat y, GLfloat z) {
    EMIT_BEGIN(OP_UNIFORM3F, 16)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z);
    EMIT_END()
}
void glUniform4f(GLint location, GLfloat x, GLfloat y, GLfloat z, GLfloat w) {
    EMIT_BEGIN(OP_UNIFORM4F, 20)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z); w_f32(&_c, w);
    EMIT_END()
}

/* Column-major 4x4 matrix uniforms — the MVP path any 3D client needs.
 * WebGL2 rejects a
 * transpose flag other than false, so the host forwards `transpose`
 * verbatim to gl.uniformMatrix4fv; callers must pass GL_FALSE and supply
 * column-major data. Payload: i32 loc, u32 count, u32 transposeBool,
 * f32 mat[count*16]. */
void glUniformMatrix4fv(GLint location, GLsizei count, GLboolean transpose,
                        const GLfloat *value) {
    if (count < 0 || !value) return;
    uint32_t floats = (uint32_t)count * 16u;
    /* The TLV payload-length field is u16 — a single record holds at
     * most (0xFFFF - 12) / 4 floats. One mat4 (16 floats) is far under
     * that; guard anyway so an oversized array drops rather than truncates. */
    if (12u + floats * 4u > 0xFFFFu) return;
    EMIT_BEGIN(OP_UNIFORM_MATRIX4FV, 12u + floats * 4u)
    w_i32(&_c, location);
    w_u32(&_c, (uint32_t)count);
    w_u32(&_c, transpose ? 1u : 0u);
    for (uint32_t i = 0; i < floats; i++) w_f32(&_c, value[i]);
    EMIT_END()
}

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
    /* Bytes-per-pixel sizing for the combinations this stub supports.
     * Extend when a demo needs another (format,type) pair. */
    uint32_t bpp = 4;
    if (format == GL_RGB  && type == GL_UNSIGNED_BYTE) bpp = 3;
    if (format == GL_RGBA && type == GL_FLOAT)         bpp = 16;
    if (format == GL_RGB  && type == GL_FLOAT)         bpp = 12;
    uint32_t out_len = (uint32_t)width * (uint32_t)height * bpp;
    uint8_t in[24];
    int32_t xi = x, yi = y;
    int32_t wi = width, hi = height;
    uint32_t fmt = (uint32_t)format, t = (uint32_t)type;
    memcpy(in,      &xi,  4);
    memcpy(in + 4,  &yi,  4);
    memcpy(in + 8,  &wi,  4);
    memcpy(in + 12, &hi,  4);
    memcpy(in + 16, &fmt, 4);
    memcpy(in + 20, &t,   4);
    (void)_wpk_gl_query_into(QOP_READ_PIXELS, in, sizeof in, pixels, out_len);
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

/* ----- strings / state getters -------------------------------------- */

/* Fetch the host's string for `name` into `buf` (NUL-terminated,
 * truncated to cap). Returns buf, or NULL when the query failed. */
static char *wpk_host_string(GLenum name, char *buf, size_t cap) {
    uint32_t n = (uint32_t)name;
    size_t out_cap = 4 + cap;
    uint8_t *out = malloc(out_cap);
    if (!out) return NULL;
    memset(out, 0, out_cap);
    if (_wpk_gl_query_into(QOP_GET_STRING, &n, 4, out, (uint32_t)out_cap) != 0) {
        free(out);
        return NULL;
    }
    uint32_t slen;
    memcpy(&slen, out, 4);
    if (slen > cap - 1) slen = cap - 1;
    memcpy(buf, out + 4, slen);
    buf[slen] = '\0';
    free(out);
    return buf;
}

/* The context this stub exposes is OpenGL ES 2.0 (EGL client version 2
 * over the host WebGL2 bridge), but the host's own strings say "WebGL
 * 2.0 (…)". Report the ES API version of the context — the same
 * normalization ANGLE and Mesa perform — with the host string kept in
 * the parenthesized vendor-specific suffix that GL version strings
 * allow. Results cache in statics: the strings are immutable for the
 * context's lifetime and callers hold the returned pointer. */
const GLubyte *glGetString(GLenum name) {
    static char version[256];
    static char glsl_version[256];
    static char vendor[256];
    static char renderer[256];
    static char extensions[4096];
    char host[192];

    switch (name) {
        case GL_VERSION:
            if (version[0] == '\0') {
                if (!wpk_host_string(name, host, sizeof host)) return NULL;
                snprintf(version, sizeof version, "OpenGL ES 2.0 (%s)", host);
            }
            return (const GLubyte *)version;
        case GL_SHADING_LANGUAGE_VERSION:
            if (glsl_version[0] == '\0') {
                if (!wpk_host_string(name, host, sizeof host)) return NULL;
                snprintf(glsl_version, sizeof glsl_version,
                         "OpenGL ES GLSL ES 1.00 (%s)", host);
            }
            return (const GLubyte *)glsl_version;
        case GL_VENDOR:
            if (vendor[0] == '\0'
                && !wpk_host_string(name, vendor, sizeof vendor)) return NULL;
            return (const GLubyte *)vendor;
        case GL_RENDERER:
            if (renderer[0] == '\0'
                && !wpk_host_string(name, renderer, sizeof renderer)) return NULL;
            return (const GLubyte *)renderer;
        case GL_EXTENSIONS:
            /* WebGL removed the GL_EXTENSIONS getParameter, so the host
             * answers "" — an honest empty extension list, since none of
             * the GLES extension surface is bridged. */
            if (extensions[0] == '\0'
                && !wpk_host_string(name, extensions, sizeof extensions)) {
                return (const GLubyte *)"";
            }
            return (const GLubyte *)extensions;
        default:
            return NULL;
    }
}

/* Single-word pnames only (GL_MAX_TEXTURE_SIZE and friends). The
 * QOP_GET_INTEGERV reply carries one i32; multi-word pnames
 * (GL_MAX_VIEWPORT_DIMS, …) need a wider query op when a consumer
 * appears. */
void glGetIntegerv(GLenum pname, GLint *params) {
    if (!params) return;
    uint32_t p = (uint32_t)pname;
    int32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_INTEGERV, &p, 4, &out, 4) != 0) return;
    *params = out;
}

void glGetShaderPrecisionFormat(GLenum shadertype, GLenum precisiontype,
                                GLint *range, GLint *precision) {
    uint8_t in[8];
    uint32_t s = (uint32_t)shadertype, p = (uint32_t)precisiontype;
    memcpy(in, &s, 4); memcpy(in + 4, &p, 4);
    int32_t out[3] = { 0, 0, 0 };
    if (_wpk_gl_query_into(QOP_GET_SHADER_PRECISION_FORMAT,
                           in, 8, out, 12) != 0) {
        if (range) range[0] = range[1] = 0;
        if (precision) *precision = 0;
        return;
    }
    if (range) { range[0] = out[0]; range[1] = out[1]; }
    if (precision) *precision = out[2];
}

/* GLES2 §5.2: hints are advisory and an implementation may ignore
 * them; dropping the call client-side is conforming. */
void glHint(GLenum target, GLenum mode) {
    (void)target;
    (void)mode;
}
