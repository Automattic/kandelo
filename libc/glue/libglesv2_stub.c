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
 * Operation-table v2 adds the GLES2 texture, framebuffer, reflection,
 * uniform and depth/stencil commands needed by native renderers while
 * preserving the v1 command layouts. Version 3 adds the OpenGL ES 3.0
 * commands. Where WebGL2 has no equivalent (buffer mapping, a client-side
 * fence wait), the functions below say how they emulate it.
 */

#include <GLES3/gl3.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>

#include "gl_abi.h"

enum { WPK_GL_MAX_TLV_PAYLOAD = 0xffffu };
static uint8_t *g_cursor = NULL;

/* Client-side mirror of GL_UNPACK_ALIGNMENT so glTexImage2D /
 * glTexSubImage2D can size source rows when splitting an upload into
 * u16-payload records. */
static GLint g_unpack_alignment = 4;
/* The other client-memory unpack parameters. A client upload is sent as
 * tightly packed rows (see `unpack_source`), so the host applies none of
 * them to it. */
static GLint g_unpack_row_length = 0;
static GLint g_unpack_image_height = 0;
static GLint g_unpack_skip_pixels = 0;
static GLint g_unpack_skip_rows = 0;
static GLint g_unpack_skip_images = 0;
/* The pack parameters, applied the same way to client-memory reads. */
static GLint g_pack_alignment = 4;
static GLint g_pack_row_length = 0;
static GLint g_pack_skip_pixels = 0;
static GLint g_pack_skip_rows = 0;

/* An error this library raises itself, without a host round trip
 * (glShaderBinary, a client-array draw it cannot stage). GL records the
 * first error until glGetError reads it; this latch holds that first
 * client-side error and glGetError reports it before asking the host. */
static GLenum _wpk_gl_client_error = GL_NO_ERROR;

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

/* Max u32 names that fit one `{u16 op, u16 payload_len, u32 n, u32
 * names[n]}` record: the payload_len header is 16-bit, so
 * 4 + n*4 <= 0xFFFF, i.e. n <= (0xFFFF - 4) / 4 = 16382. */
#define WPK_GL_NAMES_PER_RECORD ((GLsizei)((0xFFFFu - 4u) / 4u))

/* Emit an op carrying `{u32 n, u32 names[n]}`, split across as many
 * records as needed so each record's payload length fits the 16-bit TLV
 * header. Without this an n >= 16383 call truncates the length field and
 * desyncs the host command-stream decoder (glTexImage2D guards its own
 * length the same way). Each chunk is a self-contained record, so the
 * host's per-record dispatch handles the split identically to one call. */
static void emit_name_array(uint16_t op, GLsizei n, const GLuint *names) {
    for (GLsizei i = 0; i < n; ) {
        GLsizei chunk = n - i;
        if (chunk > WPK_GL_NAMES_PER_RECORD) chunk = WPK_GL_NAMES_PER_RECORD;
        EMIT_BEGIN(op, 4u + (uint32_t)chunk * 4u)
        w_u32(&_c, (uint32_t)chunk);
        for (GLsizei j = 0; j < chunk; j++) w_u32(&_c, names[i + j]);
        EMIT_END()
        i += chunk;
    }
}

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
    /* Payload: u32 n, u32 names[n] — assign names, then emit in
     * u16-length-safe chunks. */
    for (GLsizei i = 0; i < n; i++) out[i] = g_next_buffer++;
    emit_name_array(OP_GEN_BUFFERS, n, out);
}

/* The GL_ARRAY_BUFFER binding, mirrored so glVertexAttribPointer can tell a
 * buffer offset from a client-memory pointer (see the client arrays below).
 * The pixel buffer bindings likewise turn a pixel pointer into an offset. */
static GLuint g_array_buffer = 0;
static GLuint g_element_buffer = 0;
static GLuint g_pixel_pack_buffer = 0;
static GLuint g_pixel_unpack_buffer = 0;

void glBindBuffer(GLenum target, GLuint buf) {
    if (target == GL_ARRAY_BUFFER) g_array_buffer = buf;
    if (target == GL_ELEMENT_ARRAY_BUFFER) g_element_buffer = buf;
    if (target == GL_PIXEL_PACK_BUFFER) g_pixel_pack_buffer = buf;
    if (target == GL_PIXEL_UNPACK_BUFFER) g_pixel_unpack_buffer = buf;
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

/* Client-side vertex arrays. OpenGL ES 2.0 lets glVertexAttribPointer name
 * client memory when no GL_ARRAY_BUFFER is bound, and GL reads the vertices
 * from that memory at draw time. WebGL has no client arrays, so the host can
 * only draw from buffers: each such attribute is recorded here, and each draw
 * copies the vertices it reads into a temporary buffer, points the attribute
 * at it, draws, and deletes the buffer. SDL2's GLES2 renderer draws this way
 * on every platform except Emscripten. */
#define WPK_GL_MAX_ATTRIBS 16u

struct wpk_client_attrib {
    int client;          /* 1: pointer is client memory, not a buffer offset */
    int enabled;
    GLint size;
    GLenum type;
    GLboolean normalized;
    GLsizei stride;
    const void *pointer;
};
static struct wpk_client_attrib g_attribs[WPK_GL_MAX_ATTRIBS];

static void emit_vertex_attrib_pointer(GLuint index, GLint size, GLenum type,
                                       GLboolean normalized, GLsizei stride,
                                       uint32_t offset) {
    EMIT_BEGIN(OP_VERTEX_ATTRIB_POINTER, 24)
    w_u32(&_c, (uint32_t)index);
    w_i32(&_c, (int32_t)size);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, normalized ? 1u : 0u);
    w_i32(&_c, (int32_t)stride);
    w_i32(&_c, (int32_t)offset);
    EMIT_END()
}

void glEnableVertexAttribArray(GLuint index) {
    if (index < WPK_GL_MAX_ATTRIBS) g_attribs[index].enabled = 1;
    EMIT_BEGIN(OP_ENABLE_VERTEX_ATTRIB_ARRAY, 4) w_u32(&_c, (uint32_t)index); EMIT_END()
}

void glDisableVertexAttribArray(GLuint index) {
    if (index < WPK_GL_MAX_ATTRIBS) g_attribs[index].enabled = 0;
    EMIT_BEGIN(OP_DISABLE_VERTEX_ATTRIB_ARRAY, 4) w_u32(&_c, (uint32_t)index); EMIT_END()
}

void glVertexAttribPointer(GLuint index, GLint size, GLenum type,
                           GLboolean normalized, GLsizei stride,
                           const void *pointer) {
    if (g_array_buffer == 0 && index < WPK_GL_MAX_ATTRIBS) {
        /* Client memory: record it; the draw uploads what it reads. */
        struct wpk_client_attrib *a = &g_attribs[index];
        a->client = 1;
        a->size = size;
        a->type = type;
        a->normalized = normalized;
        a->stride = stride;
        a->pointer = pointer;
        return;
    }
    if (index < WPK_GL_MAX_ATTRIBS) g_attribs[index].client = 0;
    /* `pointer` is an offset into the bound GL_ARRAY_BUFFER. */
    emit_vertex_attrib_pointer(index, size, type, normalized, stride,
                               (uint32_t)(uintptr_t)pointer);
}

void glVertexAttrib4fv(GLuint index, const GLfloat *values) {
    if (!values) return;
    EMIT_BEGIN(OP_VERTEX_ATTRIB_4FV, 20)
    w_u32(&_c, (uint32_t)index);
    w_f32(&_c, values[0]); w_f32(&_c, values[1]);
    w_f32(&_c, values[2]); w_f32(&_c, values[3]);
    EMIT_END()
}

static uint32_t attrib_type_size(GLenum type) {
    switch (type) {
    case GL_BYTE: case GL_UNSIGNED_BYTE: return 1;
    case GL_SHORT: case GL_UNSIGNED_SHORT: return 2;
    case GL_FIXED: case GL_FLOAT: return 4;
    default: return 0;
    }
}

/* Upload every enabled client-memory attribute for vertices
 * [0, first + count) into its own temporary buffer. Returns the number of
 * buffers made (their names are in `names`), or -1 when the draw cannot be
 * made (the error is latched for glGetError). */
static int stage_client_attribs(GLint first, GLsizei count, GLuint *names) {
    int made = 0;
    if (count <= 0) return 0;
    for (uint32_t i = 0; i < WPK_GL_MAX_ATTRIBS; i++) {
        struct wpk_client_attrib *a = &g_attribs[i];
        if (!a->client || !a->enabled) continue;
        uint32_t tsize = attrib_type_size(a->type);
        if (tsize == 0 || a->size < 1 || a->size > 4 || a->pointer == NULL) {
            if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_INVALID_OPERATION;
            return -1;
        }
        uint32_t elem = tsize * (uint32_t)a->size;
        uint32_t stride = a->stride ? (uint32_t)a->stride : elem;
        uint64_t len = (uint64_t)(uint32_t)(first + count - 1) * stride + elem;
        /* One glBufferData record carries at most 65523 bytes (see
         * glBufferData); a larger client array cannot be staged. */
        if (len > 0xFFFFu - 12u) {
            if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_OUT_OF_MEMORY;
            return -1;
        }
        GLuint name = g_next_buffer++;
        emit_name_array(OP_GEN_BUFFERS, 1, &name);
        glBindBuffer(GL_ARRAY_BUFFER, name);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)len, a->pointer, GL_STREAM_DRAW);
        emit_vertex_attrib_pointer(i, a->size, a->type, a->normalized,
                                   a->stride, 0);
        names[made++] = name;
    }
    return made;
}

void glDrawArrays(GLenum mode, GLint first, GLsizei count) {
    GLuint staged[WPK_GL_MAX_ATTRIBS];
    GLuint app_buffer = g_array_buffer;
    int n = stage_client_attribs(first, count, staged);
    if (n < 0) return;
    if (n > 0) glBindBuffer(GL_ARRAY_BUFFER, app_buffer);
    {
        EMIT_BEGIN(OP_DRAW_ARRAYS, 12)
        w_u32(&_c, (uint32_t)mode);
        w_i32(&_c, first);
        w_i32(&_c, (int32_t)count);
        EMIT_END()
    }
    /* The attributes keep referring to the deleted buffers until the next
     * draw restages them, as GL allows. */
    if (n > 0) emit_name_array(OP_DELETE_BUFFERS, n, staged);
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
    if (_wpk_gl_client_error != GL_NO_ERROR) {
        GLenum e = _wpk_gl_client_error;
        _wpk_gl_client_error = GL_NO_ERROR;
        return e;
    }
    uint32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_ERROR, NULL, 0, &out, 4) != 0) return GL_NO_ERROR;
    return (GLenum)out;
}

/* glFinish blocks until every earlier command has completed. Commands reach
 * the host in submission order, so a query answered after they have run, and
 * after the host context's own finish(), is that point. */
void glFinish(void) {
    (void)_wpk_gl_query_into(QOP_FINISH, NULL, 0, NULL, 0);
}

/* OpenGL ES 2.0 lets an implementation support no shader binary formats;
 * this one supports none (GL_NUM_SHADER_BINARY_FORMATS is 0, as WebGL has no
 * binary shaders). Every binaryformat is therefore not an accepted value,
 * which the specification reports as GL_INVALID_ENUM. */
void glShaderBinary(GLsizei count, const GLuint *shaders, GLenum binaryformat,
                    const void *binary, GLsizei length) {
    (void)count; (void)shaders; (void)binaryformat; (void)binary; (void)length;
    if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_INVALID_ENUM;
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
    for (GLsizei i = 0; i < n; i++) out[i] = g_next_texture++;
    emit_name_array(OP_GEN_TEXTURES, n, out);
}

void glDeleteTextures(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    emit_name_array(OP_DELETE_TEXTURES, n, names);
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

/* Bytes per pixel of client pixel data in (format, type), or 0 for a pair
 * OpenGL ES 3.0 does not define, which drops the upload rather than emit a
 * garbled record. */
static uint32_t bytes_per_pixel(GLenum format, GLenum type) {
    switch (type) {
        case GL_UNSIGNED_SHORT_5_6_5:
        case GL_UNSIGNED_SHORT_4_4_4_4:
        case GL_UNSIGNED_SHORT_5_5_5_1:
            return 2;
        case GL_UNSIGNED_INT_2_10_10_10_REV:
        case GL_UNSIGNED_INT_10F_11F_11F_REV:
        case GL_UNSIGNED_INT_5_9_9_9_REV:
        case GL_UNSIGNED_INT_24_8:
            return 4;
        case GL_FLOAT_32_UNSIGNED_INT_24_8_REV:
            return 8;
        default:
            break;
    }
    uint32_t size;
    switch (type) {
        case GL_UNSIGNED_BYTE: case GL_BYTE: size = 1; break;
        case GL_UNSIGNED_SHORT: case GL_SHORT: case GL_HALF_FLOAT:
        case 0x8D61: /* GL_HALF_FLOAT_OES */
            size = 2; break;
        case GL_UNSIGNED_INT: case GL_INT: case GL_FLOAT: size = 4; break;
        default: return 0;
    }
    switch (format) {
        case GL_ALPHA: case GL_LUMINANCE: case GL_RED: case GL_RED_INTEGER:
        case GL_DEPTH_COMPONENT:
            return size;
        case GL_LUMINANCE_ALPHA: case GL_RG: case GL_RG_INTEGER:
            return 2 * size;
        case GL_RGB: case GL_RGB_INTEGER:
            return 3 * size;
        case GL_RGBA: case GL_RGBA_INTEGER:
            return 4 * size;
        default:
            return 0;
    }
}

static uint32_t align_up(uint32_t n, uint32_t a) {
    return (n + a - 1u) & ~(a - 1u);
}

static void emit_pixel_storei(GLenum pname, GLint param) {
    EMIT_BEGIN(OP_PIXEL_STOREI, 8)
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_END()
}

static int unpack_params_set(void) {
    return g_unpack_row_length || g_unpack_image_height || g_unpack_skip_pixels
        || g_unpack_skip_rows || g_unpack_skip_images;
}

/* Set the host's row length, image height and skips for a client upload
 * (tightly packed rows: all zero) or back to the caller's values. */
static void host_unpack_params(int caller) {
    if (!unpack_params_set()) return;
    emit_pixel_storei(GL_UNPACK_ROW_LENGTH, caller ? g_unpack_row_length : 0);
    emit_pixel_storei(GL_UNPACK_IMAGE_HEIGHT, caller ? g_unpack_image_height : 0);
    emit_pixel_storei(GL_UNPACK_SKIP_PIXELS, caller ? g_unpack_skip_pixels : 0);
    emit_pixel_storei(GL_UNPACK_SKIP_ROWS, caller ? g_unpack_skip_rows : 0);
    emit_pixel_storei(GL_UNPACK_SKIP_IMAGES, caller ? g_unpack_skip_images : 0);
}

/* Source row `y` of image `z` of a client upload, under the caller's
 * unpack parameters (OpenGL ES 3.0 section 3.7.1). */
static const uint8_t *unpack_source(const void *data, GLsizei width, GLsizei height,
                                    uint32_t bpp, GLsizei y, GLsizei z) {
    uint32_t row_pixels = g_unpack_row_length > 0 ? (uint32_t)g_unpack_row_length : (uint32_t)width;
    uint32_t stride = align_up(row_pixels * bpp, (uint32_t)g_unpack_alignment);
    uint32_t image_rows = g_unpack_image_height > 0 ? (uint32_t)g_unpack_image_height : (uint32_t)height;
    return (const uint8_t *)data
        + ((uint64_t)(uint32_t)(g_unpack_skip_images + z) * image_rows
           + (uint32_t)(g_unpack_skip_rows + y)) * stride
        + (uint32_t)g_unpack_skip_pixels * bpp;
}

/* Emit OP_TEX_SUB_IMAGE_2D (depth 0) or OP_TEX_SUB_IMAGE_3D records for a
 * client-memory upload. The TLV payload length is 16-bit, so the upload is
 * split into bands of whole rows of one image, and a row longer than one
 * record (a 16384-texel RGBA row is 64 KiB) into bands of columns. Each
 * band carries its rows at the host's stride: the band width aligned to
 * GL_UNPACK_ALIGNMENT. */
static void emit_tex_sub_image(GLenum target, GLint level,
                               GLint xoff, GLint yoff, GLint zoff,
                               GLsizei width, GLsizei height, GLsizei depth,
                               GLenum format, GLenum type, const void *data, int is_3d) {
    if (data == NULL || width <= 0 || height <= 0 || depth <= 0) return;
    uint32_t bpp = bytes_per_pixel(format, type);
    if (bpp == 0) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_INVALID_ENUM;
        return;
    }
    uint32_t header = is_3d ? 44u : 36u;
    uint32_t max_cols = (0xFFFFu - header) / bpp;
    host_unpack_params(0);
    for (GLsizei x = 0; x < width; ) {
        uint32_t cols = (uint32_t)(width - x);
        if (cols > max_cols) cols = max_cols;
        uint32_t tail = cols * bpp;
        uint32_t stride = align_up(tail, (uint32_t)g_unpack_alignment);
        uint32_t max_rows = (0xFFFFu - header - tail) / stride + 1u;
        for (GLsizei z = 0; z < depth; z++) {
            for (GLsizei y = 0; y < height; ) {
                uint32_t rows = (uint32_t)(height - y);
                if (rows > max_rows) rows = max_rows;
                uint32_t dlen = (rows - 1u) * stride + tail;
                EMIT_BEGIN(is_3d ? OP_TEX_SUB_IMAGE_3D : OP_TEX_SUB_IMAGE_2D, header + dlen)
                w_u32(&_c, (uint32_t)target);
                w_i32(&_c, level);
                w_i32(&_c, xoff + x);
                w_i32(&_c, yoff + y);
                if (is_3d) w_i32(&_c, zoff + z);
                w_i32(&_c, (int32_t)cols);
                w_i32(&_c, (int32_t)rows);
                if (is_3d) w_i32(&_c, 1);
                w_u32(&_c, (uint32_t)format);
                w_u32(&_c, (uint32_t)type);
                w_u32(&_c, dlen);
                memset(_c, 0, dlen);
                for (uint32_t r = 0; r < rows; r++)
                    memcpy(_c + r * stride,
                           unpack_source(data, width, height, bpp, y + (GLsizei)r, z) + (uint32_t)x * bpp,
                           tail);
                _c += dlen;
                EMIT_END()
                y += (GLsizei)rows;
            }
        }
        x += (GLsizei)cols;
    }
    host_unpack_params(1);
}

/* With a GL_PIXEL_UNPACK_BUFFER bound, `data` is an offset into it and the
 * host reads the buffer under the unpack parameters it already has. */
static void emit_tex_sub_image_pbo(GLenum target, GLint level,
                                   GLint xoff, GLint yoff, GLint zoff,
                                   GLsizei width, GLsizei height, GLsizei depth,
                                   GLenum format, GLenum type, const void *data, int is_3d) {
    EMIT_BEGIN(is_3d ? OP_TEX_SUB_IMAGE_3D_PBO : OP_TEX_SUB_IMAGE_2D_PBO, is_3d ? 44u : 36u)
    w_u32(&_c, (uint32_t)target);
    w_i32(&_c, level);
    w_i32(&_c, xoff);
    w_i32(&_c, yoff);
    if (is_3d) w_i32(&_c, zoff);
    w_i32(&_c, width);
    w_i32(&_c, height);
    if (is_3d) w_i32(&_c, depth);
    w_u32(&_c, (uint32_t)format);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, (uint32_t)(uintptr_t)data);
    EMIT_END()
}

/* Allocates the level (the host does so even with an unpack buffer
 * bound), then uploads any data as glTexSubImage2D would. */
void glTexImage2D(GLenum target, GLint level, GLint internalFormat,
                  GLsizei width, GLsizei height, GLint border,
                  GLenum format, GLenum type, const void *data) {
    {
        EMIT_BEGIN(OP_TEX_IMAGE_2D, 36u)
        w_u32(&_c, (uint32_t)target);
        w_i32(&_c, level);
        w_i32(&_c, internalFormat);
        w_i32(&_c, width);
        w_i32(&_c, height);
        w_i32(&_c, border);
        w_u32(&_c, (uint32_t)format);
        w_u32(&_c, (uint32_t)type);
        w_u32(&_c, 0);
        EMIT_END()
    }
    if (g_pixel_unpack_buffer)
        emit_tex_sub_image_pbo(target, level, 0, 0, 0, width, height, 1, format, type, data, 0);
    else
        emit_tex_sub_image(target, level, 0, 0, 0, width, height, 1, format, type, data, 0);
}

void glTexSubImage2D(GLenum target, GLint level, GLint xoff, GLint yoff,
                     GLsizei width, GLsizei height,
                     GLenum format, GLenum type, const void *data) {
    if (g_pixel_unpack_buffer)
        emit_tex_sub_image_pbo(target, level, xoff, yoff, 0, width, height, 1, format, type, data, 0);
    else
        emit_tex_sub_image(target, level, xoff, yoff, 0, width, height, 1, format, type, data, 0);
}

void glTexSubImage3D(GLenum target, GLint level, GLint xoff, GLint yoff, GLint zoff,
                     GLsizei width, GLsizei height, GLsizei depth,
                     GLenum format, GLenum type, const void *data) {
    if (g_pixel_unpack_buffer)
        emit_tex_sub_image_pbo(target, level, xoff, yoff, zoff, width, height, depth, format, type, data, 1);
    else
        emit_tex_sub_image(target, level, xoff, yoff, zoff, width, height, depth, format, type, data, 1);
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
    if (pname == GL_PACK_ALIGNMENT
        && (param == 1 || param == 2 || param == 4 || param == 8)) {
        g_pack_alignment = param;
    }
    if (param >= 0) {
        if (pname == GL_PACK_ROW_LENGTH) g_pack_row_length = param;
        if (pname == GL_PACK_SKIP_PIXELS) g_pack_skip_pixels = param;
        if (pname == GL_PACK_SKIP_ROWS) g_pack_skip_rows = param;
        if (pname == GL_UNPACK_ROW_LENGTH) g_unpack_row_length = param;
        if (pname == GL_UNPACK_IMAGE_HEIGHT) g_unpack_image_height = param;
        if (pname == GL_UNPACK_SKIP_PIXELS) g_unpack_skip_pixels = param;
        if (pname == GL_UNPACK_SKIP_ROWS) g_unpack_skip_rows = param;
        if (pname == GL_UNPACK_SKIP_IMAGES) g_unpack_skip_images = param;
    }
    EMIT_BEGIN(OP_PIXEL_STOREI, 8)
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_END()
}

void glDeleteBuffers(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    emit_name_array(OP_DELETE_BUFFERS, n, names);
}

static void link_uniform_location(GLuint program, const char *name, GLint location);
static uint32_t query_value_count(GLenum pname);
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

/* Column-major 4x4 matrix uniforms — the MVP path any 3D client needs.
 * WebGL2 rejects a
 * transpose flag other than false, so the host forwards `transpose`
 * verbatim to gl.uniformMatrix4fv; callers must pass GL_FALSE and supply
 * column-major data. Payload: i32 loc, u32 count, u32 transposeBool,
 * f32 mat[count*16]. */
void glUniformMatrix4fv(GLint location, GLsizei count, GLboolean transpose,
                        const GLfloat *value) {
    if (location < 0) return;
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
    for (GLsizei i = 0; i < n; i++) out[i] = g_next_framebuffer++;
    emit_name_array(OP_GEN_FRAMEBUFFERS, n, out);
}

void glDeleteFramebuffers(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    emit_name_array(OP_DELETE_FRAMEBUFFERS, n, names);
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

void glBlendFuncSeparate(GLenum srcRGB, GLenum dstRGB,
                         GLenum srcAlpha, GLenum dstAlpha) {
    EMIT_BEGIN(OP_BLEND_FUNC_SEPARATE, 16)
    w_u32(&_c, (uint32_t)srcRGB);
    w_u32(&_c, (uint32_t)dstRGB);
    w_u32(&_c, (uint32_t)srcAlpha);
    w_u32(&_c, (uint32_t)dstAlpha);
    EMIT_END()
}

void glBlendEquationSeparate(GLenum modeRGB, GLenum modeAlpha) {
    EMIT_BEGIN(OP_BLEND_EQUATION_SEPARATE, 8)
    w_u32(&_c, (uint32_t)modeRGB);
    w_u32(&_c, (uint32_t)modeAlpha);
    EMIT_END()
}

void glBlendEquation(GLenum mode) {
    glBlendEquationSeparate(mode, mode);
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
    if (_wpk_gl_query_into(QOP_CHECK_FB_STATUS, &t, 4, &status, 4) != 0) return 0;
    return (GLenum)status;
}

static int pack_params_set(void) {
    return g_pack_alignment != 1 || g_pack_row_length || g_pack_skip_pixels || g_pack_skip_rows;
}

/* Set the host's pack parameters for a client read (tightly packed rows) or
 * back to the caller's values. */
static void host_pack_params(int caller) {
    if (!pack_params_set()) return;
    emit_pixel_storei(GL_PACK_ALIGNMENT, caller ? g_pack_alignment : 1);
    emit_pixel_storei(GL_PACK_ROW_LENGTH, caller ? g_pack_row_length : 0);
    emit_pixel_storei(GL_PACK_SKIP_PIXELS, caller ? g_pack_skip_pixels : 0);
    emit_pixel_storei(GL_PACK_SKIP_ROWS, caller ? g_pack_skip_rows : 0);
}

/* With a GL_PIXEL_PACK_BUFFER bound, `pixels` is an offset into it. A read
 * into client memory comes back in bands of tight rows (each sync query
 * returns at most WPK_GL_MAX_QUERY_OUT_LEN bytes), and each row is stored
 * under the caller's pack parameters. */
void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height,
                  GLenum format, GLenum type, void *pixels) {
    if (width <= 0 || height <= 0) return;
    if (g_pixel_pack_buffer) {
        EMIT_BEGIN(OP_READ_PIXELS_PBO, 28)
        w_i32(&_c, x);
        w_i32(&_c, y);
        w_i32(&_c, width);
        w_i32(&_c, height);
        w_u32(&_c, (uint32_t)format);
        w_u32(&_c, (uint32_t)type);
        w_u32(&_c, (uint32_t)(uintptr_t)pixels);
        EMIT_END()
        return;
    }
    uint32_t bpp = bytes_per_pixel(format, type);
    if (bpp == 0) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_INVALID_ENUM;
        return;
    }
    if (!pixels) return;
    uint32_t tail = (uint32_t)width * bpp;
    if (tail > WPK_GL_MAX_QUERY_OUT_LEN) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_OUT_OF_MEMORY;
        return;
    }
    uint32_t row_pixels = g_pack_row_length > 0 ? (uint32_t)g_pack_row_length : (uint32_t)width;
    uint32_t stride = align_up(row_pixels * bpp, (uint32_t)g_pack_alignment);
    uint8_t *dst = (uint8_t *)pixels + (uint32_t)g_pack_skip_rows * stride
        + (uint32_t)g_pack_skip_pixels * bpp;
    uint32_t max_rows = WPK_GL_MAX_QUERY_OUT_LEN / tail;
    uint8_t *band = malloc((size_t)max_rows * tail);
    if (!band) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_OUT_OF_MEMORY;
        return;
    }
    host_pack_params(0);
    for (GLsizei row = 0; row < height; ) {
        uint32_t rows = (uint32_t)(height - row);
        if (rows > max_rows) rows = max_rows;
        int32_t in[6] = { x, y + row, width, (int32_t)rows, (int32_t)format, (int32_t)type };
        if (_wpk_gl_query_into(QOP_READ_PIXELS, in, sizeof in, band, rows * tail) != 0) break;
        for (uint32_t r = 0; r < rows; r++)
            memcpy(dst + ((uint32_t)row + r) * stride, band + r * tail, tail);
        row += (GLsizei)rows;
    }
    host_pack_params(1);
    free(band);
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
    uint32_t input[2] = { (uint32_t)name, WPK_GL_OP_VERSION };
    uint32_t input_len = name == GL_EXTENSIONS ? sizeof input : 4;
    size_t out_cap = 4 + cap;
    uint8_t *out = malloc(out_cap);
    if (!out) return NULL;
    memset(out, 0, out_cap);
    if (_wpk_gl_query_into(QOP_GET_STRING, input, input_len, out, (uint32_t)out_cap) != 0) {
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

/* The context this stub exposes is OpenGL ES 2.0 or 3.0 (its EGL client
 * version, over the host WebGL2 bridge), but the host's own strings say
 * "WebGL 2.0 (…)". Report the ES API version of the context — the same
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
                snprintf(version, sizeof version, "OpenGL ES %s (%s)",
                         _wpk_gl_client_version() >= 3 ? "3.0" : "2.0", host);
            }
            return (const GLubyte *)version;
        case GL_SHADING_LANGUAGE_VERSION:
            if (glsl_version[0] == '\0') {
                if (!wpk_host_string(name, host, sizeof host)) return NULL;
                snprintf(glsl_version, sizeof glsl_version, "OpenGL ES GLSL ES %s (%s)",
                         _wpk_gl_client_version() >= 3 ? "3.00" : "1.00", host);
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
            /* The host reports GLES equivalents supported by this encoder
             * version and the actual WebGL context. */
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
void glGetIntegerv(GLenum pname, GLint *data) {
    if (!data) return;
    uint32_t p = (uint32_t)pname;
    uint32_t count = query_value_count(pname);
    memset(data, 0, count * sizeof(GLint));
    (void)_wpk_gl_query_into(QOP_GET_INTEGERV, &p, 4, data, count * sizeof(GLint));
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

// Native GLES renderer entry points.
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

void glReleaseShaderCompiler(void) {}

void glVertexAttrib4f(GLuint index, GLfloat x, GLfloat y, GLfloat z, GLfloat w) {
    EMIT_BEGIN(OP_VERTEX_ATTRIB_4FV, 20)
    w_u32(&_c, index);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z); w_f32(&_c, w);
    EMIT_END()
}

void glVertexAttrib1f(GLuint index, GLfloat x) { glVertexAttrib4f(index, x, 0.0f, 0.0f, 1.0f); }

void glVertexAttrib2f(GLuint index, GLfloat x, GLfloat y) { glVertexAttrib4f(index, x, y, 0.0f, 1.0f); }

void glVertexAttrib3f(GLuint index, GLfloat x, GLfloat y, GLfloat z) { glVertexAttrib4f(index, x, y, z, 1.0f); }

void glVertexAttrib1fv(GLuint index, const GLfloat *v) { if (v) glVertexAttrib1f(index, v[0]); }

void glVertexAttrib2fv(GLuint index, const GLfloat *v) { if (v) glVertexAttrib2f(index, v[0], v[1]); }

void glVertexAttrib3fv(GLuint index, const GLfloat *v) { if (v) glVertexAttrib3f(index, v[0], v[1], v[2]); }

static uint32_t query_value_count(GLenum pname) {
    switch (pname) {
    case GL_VIEWPORT:
    case GL_SCISSOR_BOX:
    case GL_COLOR_WRITEMASK:
    case GL_COLOR_CLEAR_VALUE:
    case GL_BLEND_COLOR:
        return 4;
    case GL_ALIASED_POINT_SIZE_RANGE:
    case GL_ALIASED_LINE_WIDTH_RANGE:
    case GL_MAX_VIEWPORT_DIMS:
    case GL_DEPTH_RANGE:
        return 2;
    default:
        return 1;
    }
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

static void emit_uniform_fv(uint16_t op, GLint location, GLsizei count,
                            const GLfloat *value, uint32_t components) {
    if (location < 0) return;
    if (count < 0 || (count > 0 && !value)) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_INVALID_VALUE;
        return;
    }
    if (count == 0) return;
    if ((uint32_t)count > (WPK_GL_MAX_TLV_PAYLOAD - 12u) / (4u * components)) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_OUT_OF_MEMORY;
        return;
    }
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
    if (count < 0 || (count > 0 && !value)) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_INVALID_VALUE;
        return;
    }
    if (count == 0) return;
    if ((uint32_t)count > (WPK_GL_MAX_TLV_PAYLOAD - 12u) / (4u * components)) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_OUT_OF_MEMORY;
        return;
    }
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
    if (count < 0 || (count > 0 && !value)) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_INVALID_VALUE;
        return;
    }
    if (count == 0) return;
    if ((uint32_t)count > (WPK_GL_MAX_TLV_PAYLOAD - 12u) / (4u * components)) {
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_OUT_OF_MEMORY;
        return;
    }
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

void glUniform4fv(GLint location, GLsizei count, const GLfloat *value) {
    if (location < 0) return; emit_uniform_fv(OP_UNIFORM4FV, location, count, value, 4); }

void glUniform1iv(GLint location, GLsizei count, const GLint *value) { emit_uniform_iv(OP_UNIFORM1IV, location, count, value, 1); }

void glUniform2iv(GLint location, GLsizei count, const GLint *value) { emit_uniform_iv(OP_UNIFORM2IV, location, count, value, 2); }

void glUniform3iv(GLint location, GLsizei count, const GLint *value) { emit_uniform_iv(OP_UNIFORM3IV, location, count, value, 3); }

void glUniform4iv(GLint location, GLsizei count, const GLint *value) { emit_uniform_iv(OP_UNIFORM4IV, location, count, value, 4); }

void glUniform2i(GLint location, GLint x, GLint y) {
    if (location < 0) return; GLint v[2] = {x, y}; glUniform2iv(location, 1, v); }

void glUniform3i(GLint location, GLint x, GLint y, GLint z) {
    if (location < 0) return; GLint v[3] = {x, y, z}; glUniform3iv(location, 1, v); }

void glUniform4i(GLint location, GLint x, GLint y, GLint z, GLint w) {
    if (location < 0) return; GLint v[4] = {x, y, z, w}; glUniform4iv(location, 1, v); }

void glUniformMatrix2fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) { emit_uniform_matrix(OP_UNIFORM_MATRIX2FV, location, count, transpose, value, 4); }

void glUniformMatrix3fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) { emit_uniform_matrix(OP_UNIFORM_MATRIX3FV, location, count, transpose, value, 9); }

void glGenRenderbuffers(GLsizei n, GLuint *out) {
    if (n <= 0 || !out) return;
    for (GLsizei i = 0; i < n; i++) out[i] = g_next_renderbuffer++;
    emit_name_array(OP_GEN_RENDERBUFFERS, n, out);
}

void glDeleteRenderbuffers(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    emit_name_array(OP_DELETE_RENDERBUFFERS, n, names);
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
    if (n < 0 || n > WPK_GL_NAMES_PER_RECORD) {
        _wpk_gl_client_error = GL_INVALID_VALUE;
        return;
    }
    if (n > 0 && !bufs) return;
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
    for (GLsizei i = 0; i < n; i++) out[i] = g_next_vertex_array++;
    emit_name_array(OP_GEN_VERTEX_ARRAYS, n, out);
}

void glDeleteVertexArrays(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    emit_name_array(OP_DELETE_VERTEX_ARRAYS, n, names);
}

void glBindVertexArray(GLuint array) {
    EMIT_BEGIN(OP_BIND_VERTEX_ARRAY, 4)
    w_u32(&_c, array);
    EMIT_END()
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

void glFlush(void) { _wpk_gl_flush(); }

void glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices) {
    if (count <= 0) return;
    GLuint staged[WPK_GL_MAX_ATTRIBS];
    GLuint app_array_buffer = g_array_buffer, app_element_buffer = g_element_buffer;
    GLuint element = 0;
    uint32_t offset = (uint32_t)(uintptr_t)indices;
    int has_client = 0;
    for (unsigned i = 0; i < WPK_GL_MAX_ATTRIBS; i++)
        if (g_attribs[i].enabled && g_attribs[i].client) has_client = 1;
    if (has_client && app_element_buffer != 0) {
        /* A bound index buffer cannot be inspected as a guest pointer. */
        if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = GL_INVALID_OPERATION;
        return;
    }
    uint32_t max_index = 0;
    if (app_element_buffer == 0) {
        if (!indices) { _wpk_gl_client_error = GL_INVALID_VALUE; return; }
        uint32_t index_size = type == GL_UNSIGNED_BYTE ? 1u : type == GL_UNSIGNED_SHORT ? 2u : 0u;
        if (!index_size) { _wpk_gl_client_error = GL_INVALID_ENUM; return; }
        for (GLsizei i = 0; i < count; i++) {
            uint16_t value = 0;
            if (index_size == 1) value = ((const uint8_t *)indices)[i];
            else memcpy(&value, (const uint8_t *)indices + (size_t)i * 2, 2);
            if (value > max_index) max_index = value;
        }
        glGenBuffers(1, &element);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, element);
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)((size_t)count * index_size), indices, GL_STREAM_DRAW);
        offset = 0;
    }
    int n = has_client ? stage_client_attribs(0, (GLsizei)(max_index + 1), staged) : 0;
    if (n >= 0) {
        if (n > 0) glBindBuffer(GL_ARRAY_BUFFER, app_array_buffer);
        {
            EMIT_BEGIN(OP_DRAW_ELEMENTS, 16)
            w_u32(&_c, (uint32_t)mode); w_i32(&_c, count);
            w_u32(&_c, (uint32_t)type); w_u32(&_c, offset);
            EMIT_END()
        }
        if (n > 0) emit_name_array(OP_DELETE_BUFFERS, n, staged);
    }
    if (element) {
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, app_element_buffer);
        glDeleteBuffers(1, &element);
    }
}

/* ===== OpenGL ES 3.0 ================================================ */

static void emit_words(uint16_t op, uint32_t n, const uint32_t *words) {
    EMIT_BEGIN(op, n * 4u)
    for (uint32_t i = 0; i < n; i++) w_u32(&_c, words[i]);
    EMIT_END()
}

static void latch_error(GLenum error) {
    if (_wpk_gl_client_error == GL_NO_ERROR) _wpk_gl_client_error = error;
}

/* ----- buffers ------------------------------------------------------ */

void glCopyBufferSubData(GLenum read_target, GLenum write_target,
                         GLintptr read_offset, GLintptr write_offset, GLsizeiptr size) {
    uint32_t w[5] = { read_target, write_target, (uint32_t)read_offset,
                      (uint32_t)write_offset, (uint32_t)size };
    emit_words(OP_COPY_BUFFER_SUB_DATA, 5, w);
}

void glBindBufferRange(GLenum target, GLuint index, GLuint buffer,
                       GLintptr offset, GLsizeiptr size) {
    uint32_t w[5] = { target, index, buffer, (uint32_t)offset, (uint32_t)size };
    emit_words(OP_BIND_BUFFER_RANGE, 5, w);
}

void glBindBufferBase(GLenum target, GLuint index, GLuint buffer) {
    uint32_t w[3] = { target, index, buffer };
    emit_words(OP_BIND_BUFFER_BASE, 3, w);
}

/* Read `length` bytes of the buffer bound to `target` into `dst`. */
static int read_buffer_store(GLenum target, uint32_t offset, uint32_t length, uint8_t *dst) {
    for (uint32_t done = 0; done < length; ) {
        uint32_t chunk = length - done;
        if (chunk > WPK_GL_MAX_QUERY_OUT_LEN) chunk = WPK_GL_MAX_QUERY_OUT_LEN;
        uint32_t in[3] = { target, offset + done, chunk };
        if (_wpk_gl_query_into(QOP_GET_BUFFER_SUB_DATA, in, sizeof in, dst + done, chunk) != 0)
            return -1;
        done += chunk;
    }
    return 0;
}

/* Buffer mapping. WebGL2 maps nothing, so a mapping is a client copy of the
 * range: filled from the store unless the caller discards the old contents,
 * and written back at glUnmapBuffer (or glFlushMappedBufferRange with
 * GL_MAP_FLUSH_EXPLICIT_BIT) when the map allows writing. One mapping per
 * target, as GL allows one per bound buffer. */
struct wpk_mapping {
    GLenum target;
    uint32_t offset;
    uint32_t length;
    GLbitfield access;
    uint8_t *data;
};
static struct wpk_mapping g_mappings[8];

static struct wpk_mapping *mapping_for(GLenum target) {
    for (size_t i = 0; i < sizeof g_mappings / sizeof g_mappings[0]; i++)
        if (g_mappings[i].data && g_mappings[i].target == target) return &g_mappings[i];
    return NULL;
}

void *glMapBufferRange(GLenum target, GLintptr offset, GLsizeiptr length, GLbitfield access) {
    if (offset < 0 || length <= 0 || !(access & (GL_MAP_READ_BIT | GL_MAP_WRITE_BIT))) {
        latch_error(GL_INVALID_VALUE);
        return NULL;
    }
    if (mapping_for(target)) {
        latch_error(GL_INVALID_OPERATION);
        return NULL;
    }
    struct wpk_mapping *m = NULL;
    for (size_t i = 0; i < sizeof g_mappings / sizeof g_mappings[0] && !m; i++)
        if (!g_mappings[i].data) m = &g_mappings[i];
    uint8_t *data = m ? calloc(1, (size_t)length) : NULL;
    if (!data) {
        latch_error(GL_OUT_OF_MEMORY);
        return NULL;
    }
    int discard = access & (GL_MAP_INVALIDATE_RANGE_BIT | GL_MAP_INVALIDATE_BUFFER_BIT);
    if (((access & GL_MAP_READ_BIT) || !discard)
        && read_buffer_store(target, (uint32_t)offset, (uint32_t)length, data) != 0) {
        free(data);
        latch_error(GL_INVALID_OPERATION);
        return NULL;
    }
    *m = (struct wpk_mapping){ target, (uint32_t)offset, (uint32_t)length, access, data };
    return data;
}

void glFlushMappedBufferRange(GLenum target, GLintptr offset, GLsizeiptr length) {
    struct wpk_mapping *m = mapping_for(target);
    if (!m || !(m->access & GL_MAP_FLUSH_EXPLICIT_BIT) || offset < 0 || length < 0
        || (uint64_t)offset + (uint64_t)length > m->length) {
        latch_error(GL_INVALID_OPERATION);
        return;
    }
    glBufferSubData(target, (GLintptr)(m->offset + (uint32_t)offset), length, m->data + offset);
}

GLboolean glUnmapBuffer(GLenum target) {
    struct wpk_mapping *m = mapping_for(target);
    if (!m) {
        latch_error(GL_INVALID_OPERATION);
        return GL_FALSE;
    }
    if ((m->access & GL_MAP_WRITE_BIT) && !(m->access & GL_MAP_FLUSH_EXPLICIT_BIT))
        glBufferSubData(target, (GLintptr)m->offset, (GLsizeiptr)m->length, m->data);
    free(m->data);
    m->data = NULL;
    return GL_TRUE;
}

/* ----- textures and samplers --------------------------------------- */

void glTexStorage2D(GLenum target, GLsizei levels, GLenum internalformat,
                    GLsizei width, GLsizei height) {
    uint32_t w[5] = { target, (uint32_t)levels, internalformat, (uint32_t)width, (uint32_t)height };
    emit_words(OP_TEX_STORAGE_2D, 5, w);
}

void glTexStorage3D(GLenum target, GLsizei levels, GLenum internalformat,
                    GLsizei width, GLsizei height, GLsizei depth) {
    uint32_t w[6] = { target, (uint32_t)levels, internalformat,
                      (uint32_t)width, (uint32_t)height, (uint32_t)depth };
    emit_words(OP_TEX_STORAGE_3D, 6, w);
}

void glCopyTexSubImage3D(GLenum target, GLint level, GLint xoffset, GLint yoffset,
                         GLint zoffset, GLint x, GLint y, GLsizei width, GLsizei height) {
    uint32_t w[9] = { target, (uint32_t)level, (uint32_t)xoffset, (uint32_t)yoffset,
                      (uint32_t)zoffset, (uint32_t)x, (uint32_t)y,
                      (uint32_t)width, (uint32_t)height };
    emit_words(OP_COPY_TEX_SUB_IMAGE_3D, 9, w);
}

static uint32_t g_next_sampler = 1;

void glGenSamplers(GLsizei n, GLuint *out) {
    if (n <= 0 || !out) return;
    for (GLsizei i = 0; i < n; i++) out[i] = g_next_sampler++;
    emit_name_array(OP_GEN_SAMPLERS, n, out);
}

void glDeleteSamplers(GLsizei n, const GLuint *names) {
    if (n <= 0 || !names) return;
    emit_name_array(OP_DELETE_SAMPLERS, n, names);
}

void glBindSampler(GLuint unit, GLuint sampler) {
    uint32_t w[2] = { unit, sampler };
    emit_words(OP_BIND_SAMPLER, 2, w);
}

void glSamplerParameteri(GLuint sampler, GLenum pname, GLint param) {
    uint32_t w[3] = { sampler, pname, (uint32_t)param };
    emit_words(OP_SAMPLER_PARAMETERI, 3, w);
}

void glSamplerParameterf(GLuint sampler, GLenum pname, GLfloat param) {
    EMIT_BEGIN(OP_SAMPLER_PARAMETERF, 12)
    w_u32(&_c, sampler); w_u32(&_c, pname); w_f32(&_c, param);
    EMIT_END()
}

/* ----- programs and uniforms --------------------------------------- */

GLuint glGetUniformBlockIndex(GLuint program, const GLchar *name) {
    if (!name) return GL_INVALID_INDEX;
    uint8_t in[256];
    size_t nlen = strlen(name);
    if (8 + nlen > sizeof in) return GL_INVALID_INDEX;
    uint32_t head[2] = { program, (uint32_t)nlen };
    memcpy(in, head, 8);
    memcpy(in + 8, name, nlen);
    uint32_t index = GL_INVALID_INDEX;
    if (_wpk_gl_query_into(QOP_GET_UNIFORM_BLOCK_INDEX, in, (uint32_t)(8 + nlen), &index, 4) != 0)
        return GL_INVALID_INDEX;
    return index;
}

void glUniformBlockBinding(GLuint program, GLuint index, GLuint binding) {
    uint32_t w[3] = { program, index, binding };
    emit_words(OP_UNIFORM_BLOCK_BINDING, 3, w);
}

/* `values` holds components * count words. */
static void emit_uniform_uiv(GLint location, uint32_t comps, GLsizei count, const GLuint *values) {
    if (location < 0) return;
    if (count < 0 || !values) return;
    uint32_t words = comps * (uint32_t)count;
    if (12u + words * 4u > 0xFFFFu) {
        latch_error(GL_OUT_OF_MEMORY);
        return;
    }
    EMIT_BEGIN(OP_UNIFORM_UIV, 12u + words * 4u)
    w_i32(&_c, location);
    w_u32(&_c, comps);
    w_u32(&_c, (uint32_t)count);
    memcpy(_c, values, words * 4u);
    _c += words * 4u;
    EMIT_END()
}

void glUniform1uiv(GLint l, GLsizei n, const GLuint *v) { emit_uniform_uiv(l, 1, n, v); }
void glUniform2uiv(GLint l, GLsizei n, const GLuint *v) { emit_uniform_uiv(l, 2, n, v); }
void glUniform3uiv(GLint l, GLsizei n, const GLuint *v) { emit_uniform_uiv(l, 3, n, v); }
void glUniform4uiv(GLint l, GLsizei n, const GLuint *v) { emit_uniform_uiv(l, 4, n, v); }

void glUniform1ui(GLint l, GLuint x) { glUniform1uiv(l, 1, &x); }
void glUniform2ui(GLint l, GLuint x, GLuint y) {
    GLuint v[2] = { x, y };
    glUniform2uiv(l, 1, v);
}
void glUniform3ui(GLint l, GLuint x, GLuint y, GLuint z) {
    GLuint v[3] = { x, y, z };
    glUniform3uiv(l, 1, v);
}
void glUniform4ui(GLint l, GLuint x, GLuint y, GLuint z, GLuint w) {
    GLuint v[4] = { x, y, z, w };
    glUniform4uiv(l, 1, v);
}

static void emit_uniform_matrix_fv(GLint location, uint32_t cols, uint32_t rows,
                                   GLsizei count, GLboolean transpose, const GLfloat *values) {
    if (location < 0) return;
    if (count < 0 || !values) return;
    uint32_t floats = cols * rows * (uint32_t)count;
    if (20u + floats * 4u > 0xFFFFu) {
        latch_error(GL_OUT_OF_MEMORY);
        return;
    }
    EMIT_BEGIN(OP_UNIFORM_MATRIX_FV, 20u + floats * 4u)
    w_i32(&_c, location);
    w_u32(&_c, cols);
    w_u32(&_c, rows);
    w_u32(&_c, (uint32_t)count);
    w_u32(&_c, transpose ? 1u : 0u);
    memcpy(_c, values, floats * 4u);
    _c += floats * 4u;
    EMIT_END()
}

void glUniformMatrix2x3fv(GLint l, GLsizei n, GLboolean t, const GLfloat *v) { emit_uniform_matrix_fv(l, 2, 3, n, t, v); }
void glUniformMatrix3x2fv(GLint l, GLsizei n, GLboolean t, const GLfloat *v) { emit_uniform_matrix_fv(l, 3, 2, n, t, v); }
void glUniformMatrix2x4fv(GLint l, GLsizei n, GLboolean t, const GLfloat *v) { emit_uniform_matrix_fv(l, 2, 4, n, t, v); }
void glUniformMatrix4x2fv(GLint l, GLsizei n, GLboolean t, const GLfloat *v) { emit_uniform_matrix_fv(l, 4, 2, n, t, v); }
void glUniformMatrix3x4fv(GLint l, GLsizei n, GLboolean t, const GLfloat *v) { emit_uniform_matrix_fv(l, 3, 4, n, t, v); }
void glUniformMatrix4x3fv(GLint l, GLsizei n, GLboolean t, const GLfloat *v) { emit_uniform_matrix_fv(l, 4, 3, n, t, v); }

/* ----- vertex arrays and draws ------------------------------------- */

void glVertexAttribIPointer(GLuint index, GLint size, GLenum type, GLsizei stride,
                            const void *pointer) {
    /* Client-memory integer attributes are not staged (see glDrawArrays). */
    if (g_array_buffer == 0) {
        latch_error(GL_INVALID_OPERATION);
        return;
    }
    if (index < WPK_GL_MAX_ATTRIBS) g_attribs[index].client = 0;
    uint32_t w[5] = { index, (uint32_t)size, type, (uint32_t)stride, (uint32_t)(uintptr_t)pointer };
    emit_words(OP_VERTEX_ATTRIB_I_POINTER, 5, w);
}

void glVertexAttribDivisor(GLuint index, GLuint divisor) {
    uint32_t w[2] = { index, divisor };
    emit_words(OP_VERTEX_ATTRIB_DIVISOR, 2, w);
}

/* Client vertex arrays are not staged for instanced draws: staging would
 * need the instance count of each attribute. Such a draw is refused, the
 * gap being visible as GL_INVALID_OPERATION. */
static int client_attribs_enabled(void) {
    for (uint32_t i = 0; i < WPK_GL_MAX_ATTRIBS; i++)
        if (g_attribs[i].client && g_attribs[i].enabled) return 1;
    return 0;
}

void glDrawArraysInstanced(GLenum mode, GLint first, GLsizei count, GLsizei instances) {
    if (client_attribs_enabled()) {
        latch_error(GL_INVALID_OPERATION);
        return;
    }
    uint32_t w[4] = { mode, (uint32_t)first, (uint32_t)count, (uint32_t)instances };
    emit_words(OP_DRAW_ARRAYS_INSTANCED, 4, w);
}

void glDrawElementsInstanced(GLenum mode, GLsizei count, GLenum type,
                             const void *indices, GLsizei instances) {
    if (client_attribs_enabled()) {
        latch_error(GL_INVALID_OPERATION);
        return;
    }
    uint32_t w[5] = { mode, (uint32_t)count, type, (uint32_t)(uintptr_t)indices,
                      (uint32_t)instances };
    emit_words(OP_DRAW_ELEMENTS_INSTANCED, 5, w);
}

/* ----- framebuffers and renderbuffers ------------------------------ */

void glRenderbufferStorageMultisample(GLenum target, GLsizei samples, GLenum internalformat,
                                      GLsizei width, GLsizei height) {
    uint32_t w[5] = { target, (uint32_t)samples, internalformat, (uint32_t)width, (uint32_t)height };
    emit_words(OP_RENDERBUFFER_STORAGE_MULTISAMPLE, 5, w);
}

void glFramebufferTextureLayer(GLenum target, GLenum attachment, GLuint texture,
                               GLint level, GLint layer) {
    uint32_t w[5] = { target, attachment, texture, (uint32_t)level, (uint32_t)layer };
    emit_words(OP_FRAMEBUFFER_TEXTURE_LAYER, 5, w);
}

void glBlitFramebuffer(GLint sx0, GLint sy0, GLint sx1, GLint sy1,
                       GLint dx0, GLint dy0, GLint dx1, GLint dy1,
                       GLbitfield mask, GLenum filter) {
    uint32_t w[10] = { (uint32_t)sx0, (uint32_t)sy0, (uint32_t)sx1, (uint32_t)sy1,
                       (uint32_t)dx0, (uint32_t)dy0, (uint32_t)dx1, (uint32_t)dy1,
                       mask, filter };
    emit_words(OP_BLIT_FRAMEBUFFER, 10, w);
}

void glInvalidateFramebuffer(GLenum target, GLsizei n, const GLenum *attachments) {
    if (n < 0 || (n > 0 && !attachments) || 8u + (uint32_t)n * 4u > 0xFFFFu) return;
    EMIT_BEGIN(OP_INVALIDATE_FRAMEBUFFER, 8u + (uint32_t)n * 4u)
    w_u32(&_c, target);
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) w_u32(&_c, attachments[i]);
    EMIT_END()
}

/* The value array holds four words: color takes four, depth or stencil the
 * first one (the host reads only what WebGL2 uses). */
static void emit_clear_buffer(uint16_t op, GLenum buffer, GLint drawbuffer, const void *value) {
    if (!value) return;
    uint32_t words[4] = { 0, 0, 0, 0 };
    memcpy(words, value, buffer == GL_COLOR ? 16 : 4);
    EMIT_BEGIN(op, 24)
    w_u32(&_c, buffer);
    w_i32(&_c, drawbuffer);
    for (int i = 0; i < 4; i++) w_u32(&_c, words[i]);
    EMIT_END()
}

void glClearBufferfv(GLenum buffer, GLint drawbuffer, const GLfloat *value) {
    emit_clear_buffer(OP_CLEAR_BUFFERFV, buffer, drawbuffer, value);
}
void glClearBufferiv(GLenum buffer, GLint drawbuffer, const GLint *value) {
    emit_clear_buffer(OP_CLEAR_BUFFERIV, buffer, drawbuffer, value);
}
void glClearBufferuiv(GLenum buffer, GLint drawbuffer, const GLuint *value) {
    emit_clear_buffer(OP_CLEAR_BUFFERUIV, buffer, drawbuffer, value);
}
void glClearBufferfi(GLenum buffer, GLint drawbuffer, GLfloat depth, GLint stencil) {
    EMIT_BEGIN(OP_CLEAR_BUFFERFI, 16)
    w_u32(&_c, buffer); w_i32(&_c, drawbuffer); w_f32(&_c, depth); w_i32(&_c, stencil);
    EMIT_END()
}

/* ----- sync objects ------------------------------------------------- */

/* A GLsync is the name the encoder gives the host's fence. */
static uint32_t g_next_sync = 1;

GLsync glFenceSync(GLenum condition, GLbitfield flags) {
    uint32_t name = g_next_sync++;
    uint32_t w[3] = { name, condition, flags };
    emit_words(OP_FENCE_SYNC, 3, w);
    return (GLsync)(uintptr_t)name;
}

void glDeleteSync(GLsync sync) {
    if (!sync) return;
    uint32_t name = (uint32_t)(uintptr_t)sync;
    emit_words(OP_DELETE_SYNC, 1, &name);
}

/* WebGL2 has no client-side wait (its maximum timeout is 0), so the wait is
 * repeated polls until the fence signals or `timeout` nanoseconds pass. */
GLenum glClientWaitSync(GLsync sync, GLbitfield flags, GLuint64 timeout) {
    uint32_t in[2] = { (uint32_t)(uintptr_t)sync, flags };
    struct timespec start;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;) {
        uint32_t status = GL_WAIT_FAILED;
        if (_wpk_gl_query_into(QOP_CLIENT_WAIT_SYNC, in, sizeof in, &status, 4) != 0) {
            latch_error(GL_INVALID_VALUE);
            return GL_WAIT_FAILED;
        }
        if (status != GL_TIMEOUT_EXPIRED) return status;
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        uint64_t elapsed = (uint64_t)(now.tv_sec - start.tv_sec) * 1000000000ull
            + (uint64_t)(now.tv_nsec - start.tv_nsec);
        if (elapsed >= timeout) return GL_TIMEOUT_EXPIRED;
        struct timespec pause = { 0, 1000000 };
        nanosleep(&pause, NULL);
    }
}

void glWaitSync(GLsync sync, GLbitfield flags, GLuint64 timeout) {
    if (timeout != GL_TIMEOUT_IGNORED) {
        latch_error(GL_INVALID_VALUE);
        return;
    }
    uint32_t w[2] = { (uint32_t)(uintptr_t)sync, flags };
    emit_words(OP_WAIT_SYNC, 2, w);
}

void glGetSynciv(GLsync sync, GLenum pname, GLsizei count, GLsizei *length, GLint *values) {
    if (count < 1 || !values) return;
    uint32_t in[2] = { (uint32_t)(uintptr_t)sync, pname };
    int32_t value = 0;
    if (_wpk_gl_query_into(QOP_GET_SYNCIV, in, sizeof in, &value, 4) != 0) {
        latch_error(GL_INVALID_VALUE);
        return;
    }
    values[0] = value;
    if (length) *length = 1;
}

/* ----- strings ------------------------------------------------------ */

/* Each string is kept for the context's lifetime, as callers hold it. */
const GLubyte *glGetStringi(GLenum name, GLuint index) {
    static char *cache[64];
    if (name != GL_EXTENSIONS) {
        latch_error(GL_INVALID_ENUM);
        return NULL;
    }
    if (index < sizeof cache / sizeof cache[0] && cache[index]) return (const GLubyte *)cache[index];
    uint32_t in[2] = { name, index };
    uint8_t out[4 + 128];
    if (_wpk_gl_query_into(QOP_GET_STRINGI, in, sizeof in, out, sizeof out) != 0) {
        latch_error(GL_INVALID_VALUE);
        return NULL;
    }
    uint32_t slen;
    memcpy(&slen, out, 4);
    if (slen > sizeof out - 4) slen = sizeof out - 4;
    char *str = malloc(slen + 1);
    if (!str) return NULL;
    memcpy(str, out + 4, slen);
    str[slen] = '\0';
    if (index < sizeof cache / sizeof cache[0]) cache[index] = str;
    return (const GLubyte *)str;
}
