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
 * preserving the v1 command layouts.
 */

#include <GLES2/gl2.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>

#include "gl_abi.h"

enum { WPK_GL_MAX_TLV_PAYLOAD = 0xffffu };
static uint8_t *g_cursor = NULL;

/* Client-side mirror of GL_UNPACK_ALIGNMENT so glTexImage2D /
 * glTexSubImage2D can size source rows when splitting an upload into
 * u16-payload records. */
static GLint g_unpack_alignment = 4;

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
 * buffer offset from a client-memory pointer (see the client arrays below). */
static GLuint g_array_buffer = 0;
static GLuint g_element_buffer = 0;

void glBindBuffer(GLenum target, GLuint buf) {
    if (target == GL_ARRAY_BUFFER) g_array_buffer = buf;
    if (target == GL_ELEMENT_ARRAY_BUFFER) g_element_buffer = buf;
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

/* Bytes-per-pixel for the GL (format,type) pairs we know how to
 * marshal. Returns 0 for unknown combos so glTexImage2D / glTexSubImage2D
 * drops the upload rather than emit a garbled record. Extend when a
 * demo needs a new combo. */
static uint32_t bytes_per_pixel(GLenum format, GLenum type) {
    uint32_t channels;
    switch (format) {
        case GL_ALPHA: case GL_LUMINANCE: case 0x1903: /* RED */
        case 0x1902: /* DEPTH_COMPONENT */ channels = 1; break;
        case GL_LUMINANCE_ALPHA: case 0x8227: /* RG */ channels = 2; break;
        case GL_RGB: channels = 3; break;
        case GL_RGBA: channels = 4; break;
        case 0x84F9: /* DEPTH_STENCIL */ return type == 0x84FA ? 4 : 0;
        default: return 0;
    }
    switch (type) {
        case GL_UNSIGNED_BYTE: return channels;
        case GL_FLOAT: case GL_UNSIGNED_INT: return channels * 4;
        case GL_UNSIGNED_SHORT: case 0x140B: case 0x8D61: /* half float */
            return channels * 2;
        case GL_UNSIGNED_SHORT_5_6_5: return format == GL_RGB ? 2 : 0;
        case GL_UNSIGNED_SHORT_4_4_4_4: case GL_UNSIGNED_SHORT_5_5_5_1:
            return format == GL_RGBA ? 2 : 0;
        default: return 0;
    }
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
            dlen = ((uint32_t)height - 1u) * unpack_row_stride(width, bpp)
                 + (uint32_t)width * bpp;
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
