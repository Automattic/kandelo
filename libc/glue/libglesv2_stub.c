/*
 * libGLESv2 stub for wasm-posix-kernel.
 *
 * Encodes GL calls as TLV records `{u16 op, u16 payload_len, payload}`
 * into the cmdbuf mapped by libEGL's session. `_wpk_gl_flush()`
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
 * Version 3 adds checked logical state queries and bounded index usage
 * replies for draws combining client attributes with an index buffer.
 * Version 4 adds the remaining core object queries and program validation.
 */

#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <errno.h>
#include <stdint.h>
#include <stddef.h>
#include <limits.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>

#include "gl_abi.h"

#define WPK_GL_MAX_ATTRIBS 16u
#define WPK_GL_INITIAL_TEXTURE_UNITS 32

enum wpk_name_space {
    WPK_NAMES_BUFFER,
    WPK_NAMES_TEXTURE,
    WPK_NAMES_RENDERBUFFER,
    WPK_NAMES_SHADER_PROGRAM,
    WPK_NAMES_COUNT
};
struct wpk_object_name {
    GLuint name;
    uint32_t name_space, references;
    GLenum target;
    uint64_t serial;
    int named, external;
    struct wpk_egl_image *image;
    uint32_t image_source, image_revision;
    struct wpk_object_name *next;
};
struct wpk_pending_image {
    struct wpk_egl_image *image;
    struct wpk_object_name *object;
    struct wpk_pending_image *next;
};
struct wpk_object_group {
    pthread_mutex_t mutex, dispatch_mutex;
    unsigned references;
    GLuint next_name[WPK_NAMES_COUNT];
    uint64_t next_serial;
    struct wpk_object_name *names, *retired_objects;
    /* Dispatch serialization admits at most one unpublished raw candidate.
     * Reserve its cleanup slot with the group, before any native allocation. */
    GLuint pending_external_texture;
    /* Unknown native completion can leave storage reachable by any peer.
     * Retain candidate inputs until the last acknowledged encoder retires. */
    struct wpk_pending_image *pending_images;
};
/* Name lookup, native mutation and C publication form one group operation.
 * The metadata mutex remains free across device IO and image cleanup. */

static void object_release(struct wpk_object_group *, struct wpk_object_name *);
/* Final image release can issue device IO. Never do it under the group
 * metadata mutex; the dead record itself carries the deferred work. */
static void destroy_object_records(struct wpk_object_name *records) {
    while (records) {
        struct wpk_object_name *next = records->next;
        if (records->image)
            _wpk_egl_image_release(records->image);
        free(records);
        records = next;
    }
}
static struct wpk_object_group *object_group_create(void) {
    struct wpk_object_group *group = calloc(1, sizeof *group);
    if (!group)
        return NULL;
    if (pthread_mutex_init(&group->mutex, NULL) != 0) {
        free(group);
        return NULL;
    }
    if (pthread_mutex_init(&group->dispatch_mutex, NULL) != 0) {
        pthread_mutex_destroy(&group->mutex);
        free(group);
        return NULL;
    }
    group->references = 1;
    group->next_serial = 1;
    for (unsigned i = 0; i < WPK_NAMES_COUNT; i++)
        group->next_name[i] = 1;
    return group;
}
static int object_group_retain(struct wpk_object_group *group) {
    pthread_mutex_lock(&group->mutex);
    int retained = group->references < UINT_MAX;
    if (retained)
        group->references++;
    pthread_mutex_unlock(&group->mutex);
    return retained;
}
static void object_group_release(struct wpk_object_group *group) {
    pthread_mutex_lock(&group->mutex);
    int final = --group->references == 0;
    pthread_mutex_unlock(&group->mutex);
    if (!final)
        return;
    while (group->pending_images) {
        struct wpk_pending_image *entry = group->pending_images;
        group->pending_images = entry->next;
        object_release(group, entry->object);
        if (entry->image)
            _wpk_egl_image_release(entry->image);
        free(entry);
    }
    destroy_object_records(group->names);
    destroy_object_records(group->retired_objects);
    pthread_mutex_destroy(&group->dispatch_mutex);
    pthread_mutex_destroy(&group->mutex);
    free(group);
}
/* The namespace owns one reference. Bindings and containers own additional
 * references, so deleting a name cannot recycle a retained object identity. */
static struct wpk_object_name *find_object_name(struct wpk_object_group *group, uint32_t name_space,
                                                GLuint name) {
    for (struct wpk_object_name *p = group->names; p; p = p->next)
        if (p->named && p->name_space == name_space && p->name == name)
            return p;
    return NULL;
}
static void release_object_locked(struct wpk_object_group *group, struct wpk_object_name *object) {
    if (!object || --object->references)
        return;
    struct wpk_object_name **p = &group->names;
    while (*p && *p != object)
        p = &(*p)->next;
    if (*p)
        *p = object->next;
    if (object->image) {
        object->next = group->retired_objects;
        group->retired_objects = object;
    } else
        free(object);
}
static void object_release(struct wpk_object_group *group, struct wpk_object_name *object) {
    pthread_mutex_lock(&group->mutex);
    release_object_locked(group, object);
    struct wpk_object_name *retired = group->retired_objects;
    group->retired_objects = NULL;
    pthread_mutex_unlock(&group->mutex);
    destroy_object_records(retired);
}
static struct wpk_object_name *object_acquire(struct wpk_object_group *group, uint32_t name_space,
                                              GLuint name) {
    if (!name)
        return NULL;
    pthread_mutex_lock(&group->mutex);
    struct wpk_object_name *object = find_object_name(group, name_space, name);
    if (!object) {
        if (!group->next_serial || !(object = calloc(1, sizeof *object)))
            goto done;
        *object = (struct wpk_object_name){.name = name,
                                           .name_space = name_space,
                                           .references = 1,
                                           .serial = group->next_serial++,
                                           .named = 1,
                                           .next = group->names};
        group->names = object;
    }
    if (object->references == UINT_MAX)
        object = NULL;
    else
        object->references++;
done:
    pthread_mutex_unlock(&group->mutex);
    return object;
}

static int object_reference(struct wpk_object_group *group, struct wpk_object_name *object) {
    if (!object)
        return 1;
    pthread_mutex_lock(&group->mutex);
    int retained = object->references < UINT_MAX;
    if (retained)
        object->references++;
    pthread_mutex_unlock(&group->mutex);
    return retained;
}
/* The first bind realizes a reserved texture/RBO and fixes its target.
 * Namespace and binding references remain independent of numeric reuse. */
static GLenum realize_image_object(struct wpk_object_group *group, struct wpk_object_name *object,
                                   GLenum target) {
    if (!object)
        return GL_NO_ERROR;
    pthread_mutex_lock(&group->mutex);
    GLenum error = object->target && object->target != target ? GL_INVALID_OPERATION : GL_NO_ERROR;
    if (!error)
        object->target = target;
    pthread_mutex_unlock(&group->mutex);
    return error;
}
static struct wpk_object_name *attachment_object(struct wpk_object_group *group,
                                                 uint32_t name_space, GLuint name, GLenum target,
                                                 GLenum *error) {
    *error = GL_NO_ERROR;
    if (!name)
        return NULL;
    pthread_mutex_lock(&group->mutex);
    struct wpk_object_name *object = find_object_name(group, name_space, name);
    if (!object || object->target != target) {
        *error = GL_INVALID_OPERATION;
        object = NULL;
    } else if (object->references == UINT_MAX) {
        *error = GL_OUT_OF_MEMORY;
        object = NULL;
    } else
        object->references++;
    pthread_mutex_unlock(&group->mutex);
    return object;
}

struct wpk_client_attrib {
    int client;          /* 1: pointer is client memory, not a buffer offset */
    int enabled;
    GLint size;
    GLenum type;
    GLboolean normalized;
    GLsizei stride;
    const void *pointer;
    uint64_t buffer_serial;
    struct wpk_object_name *buffer_object;
    GLuint buffer_name;
};
struct wpk_vertex_array {
    GLuint name, element_buffer;
    uint64_t element_serial;
    struct wpk_object_name *element_object;
    struct wpk_client_attrib attribs[WPK_GL_MAX_ATTRIBS];
    struct wpk_vertex_array *next;
};
struct wpk_image_attachment {
    GLuint framebuffer, point;
    struct wpk_object_name *object;
    struct wpk_image_attachment *next;
};
struct wpk_texture_unit {
    GLuint texture, cube;
    struct wpk_object_name *texture_object, *cube_object;
};
struct wpk_array_capture {
    struct wpk_object_name *object;
    GLuint name;
    uint64_t serial;
    int active;
};

/* Client execution state belongs to the EGL context and follows it across
 * thread transfers. Shared object groups are a separate ownership layer. */
struct wpk_gles_context {
    struct wpk_object_group *objects;
    struct wpk_array_capture array_capture;
    uint8_t *cursor;
    /* Client upload layout is gathered into command records exactly once. */
    GLint unpack_alignment;
    GLint unpack_row_length;
    GLint unpack_skip_pixels;
    GLint unpack_skip_rows;
    /* Unacknowledged flags transfer into the same host context error owner. */
    uint32_t client_errors;
    uint32_t error_reply;
    GLenum generate_mipmap_hint, fragment_derivative_hint;
    uint32_t next_shader_upload;
    uint32_t next_uniform_lookup;
    uint32_t next_uniform_upload;
    GLuint array_buffer;
    uint64_t array_serial;
    struct wpk_object_name *array_object;
    struct wpk_vertex_array default_vertex_array, *current_vertex_array, *vertex_arrays;
    uint32_t next_framebuffer;
    GLuint active_unit;
    struct wpk_texture_unit initial_texture_units[WPK_GL_INITIAL_TEXTURE_UNITS];
    struct wpk_texture_unit *texture_units;
    uint32_t texture_unit_count, texture_unit_limit;
    GLuint bound_renderbuffer;
    struct wpk_object_name *renderbuffer_object;
    struct wpk_image_attachment *image_attachments;
    GLuint bound_framebuffer;
    uint32_t next_vertex_array;
    char version[256];
    char glsl_version[256];
    char vendor[256];
    char renderer[256];
    char extensions[4096];
};

#define g_cursor (_wpk_gl_current_encoder()->cursor)
#define g_unpack_alignment (_wpk_gl_current_encoder()->unpack_alignment)
#define g_unpack_row_length (_wpk_gl_current_encoder()->unpack_row_length)
#define g_unpack_skip_pixels (_wpk_gl_current_encoder()->unpack_skip_pixels)
#define g_unpack_skip_rows (_wpk_gl_current_encoder()->unpack_skip_rows)
#define g_array_buffer (_wpk_gl_current_encoder()->array_buffer)
#define g_element_buffer (_wpk_gl_current_encoder()->current_vertex_array->element_buffer)
#define g_attribs (_wpk_gl_current_encoder()->current_vertex_array->attribs)
#define g_next_framebuffer (_wpk_gl_current_encoder()->next_framebuffer)
#define g_active_unit (_wpk_gl_current_encoder()->active_unit)
#define g_texture_units (_wpk_gl_current_encoder()->texture_units)
#define g_bound_renderbuffer (_wpk_gl_current_encoder()->bound_renderbuffer)
#define g_image_attachments (_wpk_gl_current_encoder()->image_attachments)
#define g_bound_framebuffer (_wpk_gl_current_encoder()->bound_framebuffer)
#define g_next_vertex_array (_wpk_gl_current_encoder()->next_vertex_array)

static int checked_mutation_query(uint32_t op, const uint32_t *words, uint32_t count);
struct wpk_gl_name_scope _wpk_gl_begin_name_scope(struct wpk_gles_context *state) {
    struct wpk_gl_name_scope scope = {.group = state->objects};
    // Do not abandon native publication on cancellation; restore after unlock.
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &scope.cancel_state);
    pthread_mutex_lock(&scope.group->dispatch_mutex);
    if (scope.group->pending_external_texture &&
        !_wpk_gl_discard_external_candidate(scope.group->pending_external_texture)) {
        _wpk_gl_end_name_scope(&scope);
        scope.group = NULL;
    }
    return scope;
}
void _wpk_gl_end_name_scope(struct wpk_gl_name_scope *scope) {
    if (!scope->group)
        return;
    pthread_mutex_unlock(&scope->group->dispatch_mutex);
    pthread_setcancelstate(scope->cancel_state, NULL);
}

struct wpk_gles_context *_wpk_gl_create_shared_encoder(struct wpk_gles_context *source) {
    struct wpk_gles_context *state = calloc(1, sizeof *state);
    if (!state) return NULL;
    if (source) {
        if (!object_group_retain(source->objects)) {
            free(state);
            return NULL;
        }
        state->objects = source->objects;
    } else if (!(state->objects = object_group_create())) {
        free(state);
        return NULL;
    }
    state->texture_units = state->initial_texture_units;
    state->texture_unit_count = WPK_GL_INITIAL_TEXTURE_UNITS;
    state->unpack_alignment = 4;
    state->generate_mipmap_hint = state->fragment_derivative_hint = GL_DONT_CARE;
    state->next_framebuffer = state->next_vertex_array = 1;
    state->current_vertex_array = &state->default_vertex_array;
    for (unsigned i=0; i<WPK_GL_MAX_ATTRIBS; i++) {
        state->default_vertex_array.attribs[i].size = 4;
        state->default_vertex_array.attribs[i].type = GL_FLOAT;
        state->default_vertex_array.attribs[i].client = 1;
    }
    return state;
}

struct wpk_gles_context *_wpk_gl_create_encoder(void) {
    return _wpk_gl_create_shared_encoder(NULL);
}

enum { WPK_GL_MAX_TLV_PAYLOAD = 0xffffu };

static inline void w_u16(uint8_t **c, uint16_t v) { memcpy(*c, &v, 2); *c += 2; }
static inline void w_u32(uint8_t **c, uint32_t v) { memcpy(*c, &v, 4); *c += 4; }
static inline void w_i32(uint8_t **c, int32_t v)  { memcpy(*c, &v, 4); *c += 4; }
static inline void w_f32(uint8_t **c, float v)    { memcpy(*c, &v, 4); *c += 4; }

static void raise_client_error(GLenum error);
static int flush_commands(void) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (!state) return 0;
    int fd = _wpk_gl_fd();
    uint8_t *base = _wpk_gl_cmdbuf_base();
    if (fd < 0 || base == NULL) return 0;
    if (!g_cursor) g_cursor = base;
    const uint32_t errors = state->client_errors;
    if (g_cursor == base && !errors) return 0;
    if (errors) {
        /* reserve() always leaves this fixed trailer available. Error
         * recording neither allocates nor submits at the invalid API call. */
        uint8_t *trailer = g_cursor;
        w_u16(&trailer, OP_CLIENT_ERRORS); w_u16(&trailer, 4); w_u32(&trailer, errors);
        g_cursor = trailer;
    }

    struct gl_submit_info si = { .offset = 0,
                                 .length = (uint32_t)(g_cursor - base) };
    int rc = ioctl(fd, GLIO_SUBMIT, &si);
    g_cursor = base;
    if (rc == 0) state->client_errors &= ~errors;
    else {
        raise_client_error(GL_INVALID_OPERATION);
        const uint32_t token = _wpk_gl_current_encoder()->next_uniform_upload;
        if (token) {
            /* A final COMMIT may have been queued by an earlier API call.
             * Retire every possibly observed upload up to our greatest token
             * before any subsequent valid command, even when failure happens
             * after that setter returned. Future CANCEL is replay-safe. */
            uint8_t *cleanup = base;
            w_u16(&cleanup,OP_UNIFORM_UPLOAD_CANCEL);w_u16(&cleanup,4);w_u32(&cleanup,token);
            g_cursor = cleanup;
        }
    }
    return rc;
}
int _wpk_gl_flush_checked(void) { return flush_commands(); }
void _wpk_gl_flush(void) { (void)_wpk_gl_flush_checked(); }
int _wpk_gl_server_flush_checked(void) {
    int fd = _wpk_gl_fd();
    if (!_wpk_gl_current_encoder() || fd < 0 || !_wpk_gl_cmdbuf_base()) {
        errno = ENODEV;
        return -1;
    }
    if (flush_commands() != 0) return -1;
    /* Submission alone only decodes commands. The empty query acknowledges
     * the native flush without claiming GPU completion. */
    struct gl_query_info info = {.op = QOP_FLUSH};
    return ioctl(fd, GLIO_QUERY, &info);
}

/* Reserve `bytes` of cmdbuf space and return a write cursor for the
 * caller to fill. Flushes if the next op would overflow CMDBUF_LEN.
 * Returns NULL when the EGL session hasn't run eglMakeCurrent yet, in
 * which case every op silently no-ops. */
static uint8_t *reserve(size_t bytes) {
    uint8_t *base = _wpk_gl_cmdbuf_base();
    if (base == NULL) return NULL;
    if (g_cursor == NULL) g_cursor = base;
    if (bytes > WPK_GL_CMDBUF_LEN - 8u) return NULL;
    if ((size_t)(g_cursor - base) + bytes > WPK_GL_CMDBUF_LEN - 8u) {
        if (flush_commands() != 0) return NULL;
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
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_CLEAR_COLOR, 16)
    w_f32(&_c, r); w_f32(&_c, g); w_f32(&_c, b); w_f32(&_c, a);
    EMIT_END()
}

void glClear(GLbitfield mask) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_CLEAR, 4)
    w_u32(&_c, (uint32_t)mask);
    EMIT_END()
}

void glViewport(GLint x, GLint y, GLsizei w, GLsizei h) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_VIEWPORT, 16)
    w_i32(&_c, x); w_i32(&_c, y); w_i32(&_c, w); w_i32(&_c, h);
    EMIT_END()
}

void glScissor(GLint x, GLint y, GLsizei w, GLsizei h) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_SCISSOR, 16)
    w_i32(&_c, x); w_i32(&_c, y); w_i32(&_c, w); w_i32(&_c, h);
    EMIT_END()
}

void glEnable(GLenum cap)  {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_ENABLE,  4) w_u32(&_c, (uint32_t)cap); EMIT_END()
}
void glDisable(GLenum cap) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_DISABLE, 4) w_u32(&_c, (uint32_t)cap); EMIT_END()
}

/* ----- buffers ------------------------------------------------------ */

/* Shader and program objects share one namespace (GLES2 section 2.10).
 * A name of the wrong object type must be distinguishable from a name
 * which has never denoted either type. Never wrap through reserved zero. */

/* Reserve an entire batch before publishing names or advancing counters.
 * This private constructor/allocator also serves EGL's future group join;
 * public sharing stays rejected until image/storage references are shared. */
uint32_t _wpk_gl_reserve_names(struct wpk_gles_context *state, uint32_t name_space, int32_t count,
                               uint32_t *out) {
    if (!state || name_space >= WPK_NAMES_COUNT)
        return GL_INVALID_ENUM;
    if (count < 0)
        return GL_INVALID_VALUE;
    if (!count || !out)
        return GL_NO_ERROR;
    struct wpk_object_group *group = state->objects;
    pthread_mutex_lock(&group->mutex);
    GLuint candidate = group->next_name[name_space];
    uint64_t serial = group->next_serial;
    struct wpk_object_name *pending = NULL;
    for (GLsizei i = 0; i < count; i++) {
        while (candidate && find_object_name(group, name_space, candidate))
            candidate++;
        if (!candidate || (name_space != WPK_NAMES_SHADER_PROGRAM && !serial))
            goto fail;
        if (name_space != WPK_NAMES_SHADER_PROGRAM) {
            struct wpk_object_name *entry = calloc(1, sizeof *entry);
            if (!entry)
                goto fail;
            *entry = (struct wpk_object_name){.name = candidate,
                                              .name_space = name_space,
                                              .references = 1,
                                              .serial = serial++,
                                              .named = 1,
                                              .next = pending};
            pending = entry;
        }
        candidate++;
    }
    if (name_space == WPK_NAMES_SHADER_PROGRAM) {
        for (GLsizei i = 0; i < count; i++)
            out[i] = group->next_name[name_space] + (GLuint)i;
    } else
        for (GLsizei i = count; i > 0; i--) {
            struct wpk_object_name *entry = pending;
            pending = entry->next;
            out[i - 1] = entry->name;
            entry->next = group->names;
            group->names = entry;
        }
    group->next_name[name_space] = candidate;
    group->next_serial = serial;
    pthread_mutex_unlock(&group->mutex);
    return GL_NO_ERROR;
fail:
    while (pending) {
        struct wpk_object_name *entry = pending;
        pending = entry->next;
        free(entry);
    }
    pthread_mutex_unlock(&group->mutex);
    return GL_OUT_OF_MEMORY;
}
static GLuint next_shader_program_name(void) {
    GLuint name = 0;
    uint32_t error =
        _wpk_gl_reserve_names(_wpk_gl_current_encoder(), WPK_NAMES_SHADER_PROGRAM, 1, &name);
    if (error) raise_client_error(error);
    return name;
}
void glGenBuffers(GLsizei n, GLuint *out) {
    if (!_wpk_gl_current_encoder())
        return;
    uint32_t error = _wpk_gl_reserve_names(_wpk_gl_current_encoder(), WPK_NAMES_BUFFER, n, out);
    if (error) {
        raise_client_error(error);
        return;
    }
    if (n > 0 && out)
        emit_name_array(OP_GEN_BUFFERS, n, out);
}

/* The GL_ARRAY_BUFFER binding, mirrored so glVertexAttribPointer can tell a
 * buffer offset from a client-memory pointer (see the client arrays below). */

void glBindBuffer(GLenum target, GLuint buf) {
    if (!_wpk_gl_current_encoder()) return;
    if (target != GL_ARRAY_BUFFER && target != GL_ELEMENT_ARRAY_BUFFER) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    WPK_GL_NAME_SCOPE(state);
    struct wpk_object_name *object =
        buf ? object_acquire(state->objects, WPK_NAMES_BUFFER, buf) : NULL;
    if (buf && !object) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
    uint32_t words[2] = {target, buf};
    if (checked_mutation_query(QOP_BIND_BUFFER, words, 2) != 1) {
        object_release(state->objects, object);
        return;
    }
    struct wpk_object_name **slot = target == GL_ARRAY_BUFFER
                                        ? &state->array_object
                                        : &state->current_vertex_array->element_object;
    object_release(state->objects, *slot);
    *slot = object;
    if (target == GL_ARRAY_BUFFER) {
        g_array_buffer = buf;
        state->array_serial = object ? object->serial : 0;
    } else {
        g_element_buffer = buf;
        state->current_vertex_array->element_serial = object ? object->serial : 0;
    }
}

void glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size,
                     const void *data) {
    if (!_wpk_gl_current_encoder()) return;
    if (target != GL_ARRAY_BUFFER && target != GL_ELEMENT_ARRAY_BUFFER) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    if (size < 0 || offset < 0 || (uint64_t)offset+(uint64_t)size > INT32_MAX) {
        raise_client_error(GL_INVALID_VALUE); return;
    }
    if (!(target == GL_ARRAY_BUFFER ? g_array_buffer : g_element_buffer)) {
        raise_client_error(GL_INVALID_OPERATION); return;
    }
    if (size == 0) {
        EMIT_BEGIN(OP_BUFFER_SUB_DATA,12u)
        w_u32(&_c,target); w_i32(&_c,(int32_t)offset); w_u32(&_c,0);
        EMIT_END()
        return;
    }
    if (!data) { raise_client_error(GL_INVALID_VALUE); return; }
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
    if (!_wpk_gl_current_encoder()) return;
    if ((target != GL_ARRAY_BUFFER && target != GL_ELEMENT_ARRAY_BUFFER)
        || (usage != GL_STATIC_DRAW && usage != GL_STREAM_DRAW && usage != GL_DYNAMIC_DRAW)) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    if (size < 0 || (uint64_t)size > INT32_MAX) {
        raise_client_error(GL_INVALID_VALUE); return;
    }
    if (!(target == GL_ARRAY_BUFFER ? g_array_buffer : g_element_buffer)) {
        raise_client_error(GL_INVALID_OPERATION); return;
    }
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
    if (!_wpk_gl_current_encoder()) return 0;
    if (type != GL_VERTEX_SHADER && type != GL_FRAGMENT_SHADER) {
        raise_client_error(GL_INVALID_ENUM);
        return 0;
    }
    uint8_t *_c = reserve(4u + 8u);
    if (_c == NULL) return 0;
    uint32_t name = next_shader_program_name();
    if (name == 0) return 0;
    w_u16(&_c, (uint16_t)OP_CREATE_SHADER);
    w_u16(&_c, 8);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, name);
    g_cursor = _c;
    return name;
}

static void upload_shader_source(GLuint, GLsizei, const GLchar *const *, const GLint *, uint32_t);
void glShaderSource(GLuint shader, GLsizei count,
                    const GLchar *const *string, const GLint *length) {
    if (!_wpk_gl_current_encoder()) return;
    if (count < 0) { raise_client_error(GL_INVALID_VALUE); return; }
    if (count && !string) return;
    /* Concatenate all source strings (length[i] < 0 → strlen) and emit
     * one OP_SHADER_SOURCE with the combined UTF-8 blob. */
    size_t total = 0;
    for (GLsizei i = 0; i < count; i++) {
        size_t li = (length && length[i] >= 0)
            ? (size_t)length[i] : strlen(string[i]);
        if (li > UINT32_MAX-1u-total) { raise_client_error(GL_OUT_OF_MEMORY); return; }
        total += li;
    }
    if (total > 0xFFFFu - 8u) { upload_shader_source(shader,count,string,length,(uint32_t)total); return; }

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
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_COMPILE_SHADER, 4) w_u32(&_c, shader); EMIT_END()
}

void glDeleteShader(GLuint shader) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_DELETE_SHADER, 4) w_u32(&_c, shader); EMIT_END()
}

GLuint glCreateProgram(void) {
    if (!_wpk_gl_current_encoder()) return 0;
    uint8_t *_c = reserve(4u + 4u);
    if (_c == NULL) return 0;
    uint32_t name = next_shader_program_name();
    if (name == 0) return 0;
    w_u16(&_c, (uint16_t)OP_CREATE_PROGRAM);
    w_u16(&_c, 4);
    w_u32(&_c, name);
    g_cursor = _c;
    return name;
}

void glAttachShader(GLuint program, GLuint shader) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_ATTACH_SHADER, 8)
    w_u32(&_c, program); w_u32(&_c, shader);
    EMIT_END()
}

void glDetachShader(GLuint program, GLuint shader) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_DETACH_SHADER, 8)
    w_u32(&_c, program); w_u32(&_c, shader);
    EMIT_END()
}

void glLinkProgram(GLuint program) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_LINK_PROGRAM, 4) w_u32(&_c, program); EMIT_END()
}

void glUseProgram(GLuint program) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_USE_PROGRAM, 4) w_u32(&_c, program); EMIT_END()
}

void glDeleteProgram(GLuint program) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_DELETE_PROGRAM, 4) w_u32(&_c, program); EMIT_END()
}

void glBindAttribLocation(GLuint program, GLuint index, const GLchar *name) {
    if (!_wpk_gl_current_encoder()) return;
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
static uint32_t attrib_type_size(GLenum type);

void glEnableVertexAttribArray(GLuint index) {
    if (!_wpk_gl_current_encoder()) return;
    if (index < WPK_GL_MAX_ATTRIBS) g_attribs[index].enabled = 1;
    EMIT_BEGIN(OP_ENABLE_VERTEX_ATTRIB_ARRAY, 4) w_u32(&_c, (uint32_t)index); EMIT_END()
}

void glDisableVertexAttribArray(GLuint index) {
    if (!_wpk_gl_current_encoder()) return;
    if (index < WPK_GL_MAX_ATTRIBS) g_attribs[index].enabled = 0;
    EMIT_BEGIN(OP_DISABLE_VERTEX_ATTRIB_ARRAY, 4) w_u32(&_c, (uint32_t)index); EMIT_END()
}

void glVertexAttribPointer(GLuint index, GLint size, GLenum type,
                           GLboolean normalized, GLsizei stride,
                           const void *pointer) {
    if (!_wpk_gl_current_encoder()) return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (!attrib_type_size(type)) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    if (size < 1 || size > 4 || stride < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (index >= WPK_GL_MAX_ATTRIBS) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (g_array_buffer && ((uintptr_t)pointer % attrib_type_size(type) || (uint32_t)stride % attrib_type_size(type))) {
        raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    if (state->current_vertex_array->name && g_array_buffer == 0 && pointer != NULL) {
        raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    if (index < WPK_GL_MAX_ATTRIBS) {
        struct wpk_client_attrib *a = &g_attribs[index];
        if (!object_reference(state->objects, state->array_object)) {
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        object_release(state->objects, a->buffer_object);
        a->buffer_object = state->array_object;
        a->size = size; a->type = type; a->normalized = normalized;
        a->stride = stride; a->pointer = pointer; a->buffer_serial = state->array_serial; a->buffer_name = g_array_buffer;
    }
    if (g_array_buffer == 0 && !state->current_vertex_array->name && index < WPK_GL_MAX_ATTRIBS) {
        /* Client memory: record it; the draw uploads what it reads. */
        struct wpk_client_attrib *a = &g_attribs[index];
        a->client = 1;
        a->size = size;
        a->type = type;
        a->normalized = normalized;
        a->stride = stride;
        a->pointer = pointer;
        /* Clear a previous native VBO reference without forwarding the
         * client pointer. Draw-time staging supplies the actual bytes. */
        emit_vertex_attrib_pointer(index,size,type,normalized,stride,0);
        return;
    }
    if (index < WPK_GL_MAX_ATTRIBS) g_attribs[index].client = 0;
    /* `pointer` is an offset into the bound GL_ARRAY_BUFFER. */
    emit_vertex_attrib_pointer(index, size, type, normalized, stride,
                               (uint32_t)(uintptr_t)pointer);
}

void glVertexAttrib4fv(GLuint index, const GLfloat *values) {
    if (!_wpk_gl_current_encoder()) return;
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

static int begin_array_capture(struct wpk_array_capture *capture) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (!object_reference(state->objects, state->array_object)) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return 0;
    }
    uint8_t *cursor = reserve(4);
    if (!cursor) {
        object_release(state->objects, state->array_object);
        return 0;
    }
    w_u16(&cursor, OP_BEGIN_CLIENT_ARRAY);
    w_u16(&cursor, 0);
    g_cursor = cursor;
    *capture = (struct wpk_array_capture){.object = state->array_object,
                                          .name = state->array_buffer,
                                          .serial = state->array_serial,
                                          .active = 1};
    return 1;
}
static int end_array_capture(struct wpk_array_capture *capture) {
    if (!capture->active)
        return 1;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    uint8_t *cursor = reserve(4);
    int emitted = cursor != NULL;
    if (emitted) {
        w_u16(&cursor, OP_END_CLIENT_ARRAY);
        w_u16(&cursor, 0);
        g_cursor = cursor;
    }
    /* Transfer the saved reference back into ARRAY without a name lookup.
     * A peer may have deleted or reused that numeric name during upload. */
    object_release(state->objects, state->array_object);
    state->array_object = capture->object;
    state->array_buffer = capture->name;
    state->array_serial = capture->serial;
    capture->object = NULL;
    capture->active = 0;
    return emitted;
}

/* Stage only referenced elements, packed at their original vertex indices.
 * A bounded scratch buffer avoids reading client stride gaps or unused
 * prefixes. Indexed client draws supply a presence mask for sparse indices. */
static int stage_client_attribs(GLint first, GLsizei count, GLuint *names,
                                const uint8_t *used) {
    int made = 0;
    struct wpk_array_capture *capture = &_wpk_gl_current_encoder()->array_capture;
    if (capture->active) {
        raise_client_error(GL_INVALID_OPERATION);
        return -1;
    }
    uint8_t *scratch = NULL;
    if (count <= 0) return 0;
    for (uint32_t i = 0; i < WPK_GL_MAX_ATTRIBS; i++) {
        struct wpk_client_attrib *a = &g_attribs[i];
        if (!a->client || !a->enabled) continue;
        uint32_t tsize = attrib_type_size(a->type);
        if (tsize == 0 || a->size < 1 || a->size > 4 || a->pointer == NULL) {
            raise_client_error(GL_INVALID_OPERATION);
            goto failed;
        }
        uint32_t elem = tsize * (uint32_t)a->size;
        uint32_t stride = a->stride ? (uint32_t)a->stride : elem;
        uint64_t end = (uint64_t)(uint32_t)first + (uint32_t)count;
        uint64_t len = end * elem;
        if (len > INT32_MAX) {
            raise_client_error(GL_OUT_OF_MEMORY);
            goto failed;
        }
        /* Every chunk contains whole elements and fits one TLV payload. */
        uint32_t per_chunk = 65520u / elem;
        if (stride != elem && !scratch && !(scratch = malloc(65520u))) {
            raise_client_error(GL_OUT_OF_MEMORY);
            goto failed;
        }
        if (!capture->active && !begin_array_capture(capture))
            goto failed;
        GLuint name = 0;
        glGenBuffers(1,&name);
        if (!name) goto failed;
        glBindBuffer(GL_ARRAY_BUFFER, name);
        if (g_array_buffer != name) { glDeleteBuffers(1,&name); goto failed; }
        names[made++] = name;
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)len, NULL, GL_STREAM_DRAW);
        uint32_t vertex = (uint32_t)first;
        while (vertex < end) {
            if (used && !(used[vertex>>3] & (1u << (vertex&7)))) { vertex++; continue; }
            uint32_t run = 1;
            while (run < per_chunk && vertex+run < end && (!used || (used[(vertex+run)>>3] & (1u << ((vertex+run)&7))))) run++;
            uint64_t source_offset = (uint64_t)vertex*stride;
            uint64_t source_end = source_offset+(uint64_t)(run-1)*stride+elem;
            if (source_end > UINTPTR_MAX || (uintptr_t)a->pointer > UINTPTR_MAX-(uintptr_t)source_end) {
                raise_client_error(GL_OUT_OF_MEMORY);
                goto failed;
            }
            const uint8_t *source = (const uint8_t *)((uintptr_t)a->pointer+(uintptr_t)source_offset);
            const uint8_t *bytes = source;
            if (stride != elem) {
                for (uint32_t j=0; j<run; j++) memcpy(scratch+j*elem,source+(size_t)j*stride,elem);
                bytes = scratch;
            }
            glBufferSubData(GL_ARRAY_BUFFER,(GLintptr)((uint64_t)vertex*elem),(GLsizeiptr)(run*elem),bytes);
            vertex += run;
        }
        emit_vertex_attrib_pointer(i, a->size, a->type, a->normalized,0,0);
    }
    if (!end_array_capture(capture))
        goto failed;
    free(scratch);
    return made;
failed:
    free(scratch);
    (void)end_array_capture(capture);
    if (made) glDeleteBuffers(made,names);
    return -1;
}

void glDrawArrays(GLenum mode, GLint first, GLsizei count) {
    if (!_wpk_gl_current_encoder()) return;
    if (mode > GL_TRIANGLE_FAN) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    if (first < 0 || count < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    GLuint staged[WPK_GL_MAX_ATTRIBS];
    int n = stage_client_attribs(first, count, staged,NULL);
    if (n < 0)
        return;
    {
        EMIT_BEGIN(OP_DRAW_ARRAYS, 12)
        w_u32(&_c, (uint32_t)mode);
        w_i32(&_c, first);
        w_i32(&_c, (int32_t)count);
        EMIT_END()
    }
    /* The client definition lives in its VAO record. These private staging
     * objects end after the draw; the next draw uploads that definition. */
    if (n > 0) glDeleteBuffers(n, staged);
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
/* Pre-dispatch failures already own their precise error. Wrappers must not
 * turn an allocation failure into an additional INVALID_OPERATION flag or
 * quarantine a native candidate which was never submitted. */
enum { WPK_GL_QUERY_NOT_DISPATCHED = -2 };
static int _wpk_gl_query_into(uint32_t op,
                              const void *in, uint32_t in_len,
                              void *dst, uint32_t dst_len) {
    if (_wpk_gl_cmdbuf_base() == NULL) return -1;
    int fd = _wpk_gl_fd();
    if (fd < 0) return -1;
    if (flush_commands() != 0) return WPK_GL_QUERY_NOT_DISPATCHED;
    void *heap = malloc(dst_len ? dst_len : 1);
    if (!heap) { raise_client_error(GL_OUT_OF_MEMORY); return WPK_GL_QUERY_NOT_DISPATCHED; }
    if (dst_len) memset(heap, 0, dst_len);
    struct gl_query_info qi = {
        .op = op,
        .in_buf_ptr  = (uintptr_t)in,   .in_buf_len  = in_len,
        .out_buf_ptr = (uintptr_t)heap, .out_buf_len = dst_len,
        .reserved = 0,
    };
    int rc = ioctl(fd, GLIO_QUERY, &qi);
    if (rc == 0 && dst_len) memcpy(dst, heap, dst_len);
    free(heap);
    return rc;
}

/* Every upload request and response uses already-allocated bounded buffers.
 * This permits cancellation after a later transport failure without another
 * allocation. A failed cancellation leaves one context-owned transaction;
 * replacement or acknowledged context retirement also releases its bytes. */
static int shader_upload_query(int fd, uint8_t *request, uint32_t input_len,
                                uint8_t *reply, uint32_t token, int quiet) {
    memset(reply,0,12);
    struct gl_query_info info = {
        .op = QOP_SHADER_SOURCE_UPLOAD,
        .in_buf_ptr = (uintptr_t)request, .in_buf_len = input_len,
        .out_buf_ptr = (uintptr_t)reply, .out_buf_len = 12, .reserved = 0,
    };
    if (ioctl(fd,GLIO_QUERY,&info) != 0) goto invalid;
    uint32_t status, echoed, footer;
    memcpy(&status,reply,4); memcpy(&echoed,reply+4,4); memcpy(&footer,reply+8,4);
    if (status > 1 || footer != WPK_GL_QUERY_REPLY_MAGIC) goto invalid;
    if (status) return 0; /* Host GL error already owns the failure. */
    if (echoed != token) goto invalid;
    return 1;
invalid:
    if (!quiet) raise_client_error(GL_INVALID_OPERATION);
    return 0;
}
static void upload_shader_source(GLuint shader, GLsizei count, const GLchar *const *strings,
                                  const GLint *lengths, uint32_t total) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (state->next_shader_upload == UINT32_MAX) { raise_client_error(GL_OUT_OF_MEMORY); return; }
    uint8_t *request = malloc(65536), *reply = malloc(12);
    if (!request || !reply) { free(request); free(reply); raise_client_error(GL_OUT_OF_MEMORY); return; }
    if (flush_commands() != 0) { free(request); free(reply); return; }
    int fd = _wpk_gl_fd();
    uint32_t token = ++state->next_shader_upload;
    uint32_t header[4] = {1,shader,token,total};
    memcpy(request,header,sizeof header);
    if (!shader_upload_query(fd,request,16,reply,token,0)) goto abort;
    uint32_t offset = 0, chunk = 0;
    for (GLsizei i=0; i<count; i++) {
        size_t size = lengths && lengths[i] >= 0 ? (size_t)lengths[i] : strlen(strings[i]);
        const uint8_t *source = (const uint8_t *)strings[i];
        while (size) {
            uint32_t n = size < 65520u-chunk ? (uint32_t)size : 65520u-chunk;
            memcpy(request+16+chunk,source,n); chunk += n; source += n; size -= n;
            if (chunk == 65520u) {
                header[0] = 2; header[3] = offset; memcpy(request,header,16);
                if (!shader_upload_query(fd,request,16+chunk,reply,token,0)) goto abort;
                offset += chunk; chunk = 0;
            }
        }
    }
    if (chunk) {
        header[0] = 2; header[3] = offset; memcpy(request,header,16);
        if (!shader_upload_query(fd,request,16+chunk,reply,token,0)) goto abort;
    }
    header[0] = 3; header[3] = 0; memcpy(request,header,16);
    if (!shader_upload_query(fd,request,16,reply,token,0)) goto abort;
    free(request); free(reply); return;
abort:
    header[0] = 4; header[3] = 0; memcpy(request,header,16);
    (void)shader_upload_query(fd,request,16,reply,token,1);
    free(request); free(reply);
}

GLenum glGetError(void) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (!state) return GL_NO_ERROR;
    if (_wpk_gl_cmdbuf_base() == NULL) return GL_NO_ERROR;
    (void)flush_commands();
    const uint32_t errors = state->client_errors;
    /* The context itself is heap-owned. This fixed reply avoids allocating
     * while draining OUT_OF_MEMORY and remains pinned by current ownership. */
    state->error_reply = GL_NO_ERROR;
    struct gl_query_info info = {.op = QOP_GET_ERROR,
        .in_buf_ptr = errors ? (uintptr_t)&state->client_errors : 0,
        .in_buf_len = errors ? 4 : 0,
        .out_buf_ptr = (uintptr_t)&state->error_reply, .out_buf_len = 4};
    if (ioctl(_wpk_gl_fd(),GLIO_QUERY,&info) != 0) return GL_INVALID_OPERATION;
    state->client_errors &= ~errors;
    return state->error_reply;
}

/* glFinish blocks until every earlier command has completed. Commands reach
 * the host in submission order, so a query answered after they have run, and
 * after the host context's own finish(), is that point. */
int _wpk_gl_finish_checked(void) {
    int fd = _wpk_gl_fd();
    if (!_wpk_gl_current_encoder() || fd < 0 || !_wpk_gl_cmdbuf_base()) {
        errno = ENODEV;
        return -1;
    }
    if (flush_commands() != 0) return -1;
    /* QOP_FINISH has no output bytes. Its completed ioctl is the host
     * acknowledgement, so no reply allocation or guest pointer is needed. */
    struct gl_query_info info = {.op = QOP_FINISH};
    return ioctl(fd,GLIO_QUERY,&info);
}
void glFinish(void) {
    if (!_wpk_gl_current_encoder()) return;
    if (_wpk_gl_finish_checked() != 0) raise_client_error(GL_INVALID_OPERATION);
}

/* OpenGL ES 2.0 lets an implementation support no shader binary formats;
 * this one supports none (GL_NUM_SHADER_BINARY_FORMATS is 0, as WebGL has no
 * binary shaders). Every binaryformat is therefore not an accepted value,
 * which the specification reports as GL_INVALID_ENUM. */
void glShaderBinary(GLsizei count, const GLuint *shaders, GLenum binaryformat,
                    const void *binary, GLsizei length) {
    if (!_wpk_gl_current_encoder()) return;
    (void)count; (void)shaders; (void)binaryformat; (void)binary; (void)length;
    raise_client_error(GL_INVALID_ENUM);
}

GLint glGetAttribLocation(GLuint program, const GLchar *name) {
    if (!_wpk_gl_current_encoder()) return 0;
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

void glGenTextures(GLsizei n, GLuint *out) {
    if (!_wpk_gl_current_encoder()) return;
    uint32_t error = _wpk_gl_reserve_names(_wpk_gl_current_encoder(), WPK_NAMES_TEXTURE, n, out);
    if (error) {
        raise_client_error(error);
        return;
    }
    if (n > 0 && out)
        emit_name_array(OP_GEN_TEXTURES, n, out);
}

/* ----- Shared object image backing ----------------------------------
 * Namespace, binding and container references retain the actual object.
 * Only that shared record owns its confirmed source/image/revision. */

/* Consume a candidate image hold. Native revisions order publication even
 * when an older synchronous completion reaches C after a newer commit. */
static int publish_object_image(struct wpk_object_group *group, struct wpk_object_name *object,
                                struct wpk_egl_image *image, uint32_t source, uint32_t revision) {
    struct wpk_egl_image *old = NULL;
    pthread_mutex_lock(&group->mutex);
    int current = revision == object->image_revision && source == object->image_source;
    if (revision > object->image_revision) {
        old = object->image;
        object->image = image;
        object->image_source = source;
        object->image_revision = revision;
        image = NULL;
        current = 1;
    }
    pthread_mutex_unlock(&group->mutex);
    if (old)
        _wpk_egl_image_release(old);
    if (image)
        _wpk_egl_image_release(image);
    return current;
}

static void record_client_error(struct wpk_gles_context *state, GLenum error) {
    if (state && (error == GL_INVALID_ENUM || error == GL_INVALID_VALUE ||
                  error == GL_INVALID_OPERATION || error == GL_OUT_OF_MEMORY ||
                  error == GL_INVALID_FRAMEBUFFER_OPERATION))
        state->client_errors |= 1u << (error - GL_INVALID_ENUM);
}
static void raise_client_error(GLenum error) {
    record_client_error(_wpk_gl_current_encoder(),error);
}

/* A framebuffer attachment retains its object storage after the object name
 * is deleted while another FBO is bound. Keep that ownership separate from
 * both the name table and the public EGLImage. */

/* Return 1 for checked acceptance, 0 for definite rejection and -1 for
 * indeterminate completion. Inputs must be heap-owned for guest marshalling. */
static int checked_mutation_query(uint32_t op, const uint32_t *words, uint32_t count) {
    uint32_t *input = malloc(count * sizeof *input);
    if (!input) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return 0;
    }
    memcpy(input, words, count * sizeof *input);
    uint32_t reply[3] = {0};
    int rc = _wpk_gl_query_into(op, input, count * sizeof *input, reply, sizeof reply);
    free(input);
    if (rc == WPK_GL_QUERY_NOT_DISPATCHED) return 0;
    if (!rc && reply[2] == WPK_GL_QUERY_REPLY_MAGIC) {
        if (reply[0] == 1)
            return 0;
        if (reply[0] == 0 && reply[1] == 1)
            return 1;
    }
    raise_client_error(GL_INVALID_OPERATION);
    return -1;
}
static int delete_image_object(uint32_t kind, GLuint name) {
    uint32_t words[2] = {kind, name};
    return checked_mutation_query(QOP_IMAGE_OBJECT_DELETE, words, 2) == 1;
}
static void quarantine_image_reference(struct wpk_object_group *group,
                                       struct wpk_pending_image *pending) {
    pthread_mutex_lock(&group->mutex);
    pending->next = group->pending_images;
    group->pending_images = pending;
    pthread_mutex_unlock(&group->mutex);
}
/* Consume the caller's object reference on every path. The object alone
 * retains confirmed image storage; no container-local image mirror exists. */
static int track_image_attachment(GLenum target, GLuint point, GLuint kind, GLenum object_target,
                                  GLuint name, GLint level, struct wpk_object_name *object) {
    struct wpk_object_group *group = _wpk_gl_current_encoder()->objects;
    struct wpk_image_attachment **slot = &g_image_attachments;
    while (*slot && ((*slot)->framebuffer != g_bound_framebuffer || (*slot)->point != point))
        slot = &(*slot)->next;
    struct wpk_image_attachment *entry = *slot;
    int allocated = !entry && name;
    if (allocated && !(entry = calloc(1, sizeof *entry))) {
        object_release(group, object);
        raise_client_error(GL_OUT_OF_MEMORY);
        return 0;
    }
    struct wpk_pending_image *pending = NULL;
    if (object) {
        pending = calloc(1, sizeof *pending);
        if (!pending) {
            if (allocated)
                free(entry);
            object_release(group, object);
            raise_client_error(GL_OUT_OF_MEMORY);
            return 0;
        }
        pending->object = object;
    }
    uint32_t words[6] = {
        kind == GL_RENDERBUFFER ? 2u : 1u, target, point, object_target, name, (uint32_t)level};
    int accepted = checked_mutation_query(QOP_IMAGE_ATTACHMENT, words, 6);
    if (accepted != 1) {
        if (allocated)
            free(entry);
        if (accepted < 0 && pending)
            quarantine_image_reference(group, pending);
        else {
            object_release(group, object);
            free(pending);
        }
        return 0;
    }
    free(pending);
    if (!entry)
        return 1;
    object_release(group, entry->object);
    entry->object = object;
    entry->framebuffer = g_bound_framebuffer;
    entry->point = point;
    *slot = entry;
    if (!name) {
        *slot = entry->next;
        free(entry);
    }
    return 1;
}
static void retire_image_attachments(GLuint framebuffer) {
    struct wpk_image_attachment **slot = &g_image_attachments;
    while (*slot) {
        struct wpk_image_attachment *entry = *slot;
        if (entry->framebuffer != framebuffer) { slot = &entry->next; continue; }
        _wpk_gl_flush();
        object_release(_wpk_gl_current_encoder()->objects, entry->object);
        *slot = entry->next;
        free(entry);
    }
}
static void delete_attached_image_object(struct wpk_object_name *object) {
    struct wpk_image_attachment **slot = &g_image_attachments;
    while (*slot) {
        struct wpk_image_attachment *entry = *slot;
        if (entry->object != object) {
            slot = &entry->next;
            continue;
        }
        if (entry->framebuffer == g_bound_framebuffer) {
            /* Checked native deletion already detached this active container. */
            object_release(_wpk_gl_current_encoder()->objects, entry->object);
            *slot = entry->next;
            free(entry);
            continue;
        }
        // An unbound container retains the actual old record and image.
        slot = &entry->next;
    }
}

static void release_vertex_array_objects(struct wpk_gles_context *state,
                                         struct wpk_vertex_array *vao) {
    object_release(state->objects, vao->element_object);
    vao->element_object = NULL;
    for (unsigned i = 0; i < WPK_GL_MAX_ATTRIBS; i++) {
        object_release(state->objects, vao->attribs[i].buffer_object);
        vao->attribs[i].buffer_object = NULL;
    }
}

/* Release explicit ownership without selecting this context or emitting into
 * another context's stream. Release/exit flushed this context before its last
 * current reference ended; host destruction retires native object maps. */
void _wpk_gl_destroy_encoder(struct wpk_gles_context *state) {
    if (!state)
        return;
    while (state->image_attachments) {
        struct wpk_image_attachment *entry = state->image_attachments;
        state->image_attachments = entry->next;
        object_release(state->objects, entry->object);
        free(entry);
    }
    while (state->vertex_arrays) {
        struct wpk_vertex_array *entry = state->vertex_arrays;
        state->vertex_arrays = entry->next;
        release_vertex_array_objects(state, entry);
        free(entry);
    }
    for (unsigned unit = 0; unit < state->texture_unit_count; unit++) {
        object_release(state->objects, state->texture_units[unit].texture_object);
        object_release(state->objects, state->texture_units[unit].cube_object);
    }
    object_release(state->objects, state->renderbuffer_object);
    if (state->texture_units != state->initial_texture_units)
        free(state->texture_units);
    release_vertex_array_objects(state, &state->default_vertex_array);
    object_release(state->objects, state->array_object);
    object_release(state->objects, state->array_capture.object);
    object_group_release(state->objects);
    free(state);
}

static int checked_query_reply(uint32_t, const void *, uint32_t, uint8_t *, uint32_t);
int _wpk_gl_discard_external_candidate(uint32_t name) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    struct wpk_object_group *group = state->objects;
    if (!name || (group->pending_external_texture && group->pending_external_texture != name)) {
        raise_client_error(GL_INVALID_OPERATION);
        return 0;
    }
    // Keep this name unavailable for reuse even when the reply is unknown.
    // The dispatch guard must reconcile it before a peer can realize a name.
    group->pending_external_texture = name;
    const uint32_t words[2] = {1, name};
    if (checked_mutation_query(QOP_IMAGE_OBJECT_DELETE, words, 2) != 1)
        return 0;
    group->pending_external_texture = 0;
    return 1;
}
uint32_t _wpk_gl_register_external_texture(struct wpk_gles_context *state, uint32_t name) {
    if (!state || !name)
        return GL_INVALID_OPERATION;
    struct wpk_object_group *group = state->objects;
    pthread_mutex_lock(&group->mutex);
    struct wpk_object_name *object = find_object_name(group, WPK_NAMES_TEXTURE, name);
    GLenum error = GL_NO_ERROR;
    if (object) {
        // Gen reservations and failed ordinary realizations still own their
        // numbers. The native allocator must move to a different candidate.
        if (!object->external || object->target != GL_TEXTURE_2D)
            error = WPK_GL_EXTERNAL_NAME_COLLISION;
    } else if (!group->next_serial || !(object = calloc(1, sizeof *object)))
        error = GL_OUT_OF_MEMORY;
    else {
        *object = (struct wpk_object_name){.name = name,
                                           .name_space = WPK_NAMES_TEXTURE,
                                           .references = 1,
                                           .target = GL_TEXTURE_2D,
                                           .serial = group->next_serial++,
                                           .named = 1,
                                           .external = 1,
                                           .next = group->names};
        group->names = object;
    }
    pthread_mutex_unlock(&group->mutex);
    if (error == GL_OUT_OF_MEMORY)
        record_client_error(state,error);
    return error;
}
/* Raw WPK views can be revoked by their BO owner outside the C command
 * stream. Reconcile their namespace before realizing a reused public name. */
static int external_texture_live(struct wpk_gles_context *state, struct wpk_object_name *object) {
    if (!object || !object->external)
        return 1;
    uint32_t input[2] = {1, object->name}, live;
    uint8_t reply[12];
    if (!checked_query_reply(QOP_IS_OBJECT, input, sizeof input, reply, 4))
        return -1;
    memcpy(&live, reply + 4, 4);
    if (live)
        return 1;
    struct wpk_object_group *group = state->objects;
    pthread_mutex_lock(&group->mutex);
    if (object->named) {
        object->named = 0;
        release_object_locked(group, object);
    }
    for (uint32_t unit = 0; unit < state->texture_unit_count; unit++) {
        struct wpk_texture_unit *binding = &state->texture_units[unit];
        if (binding->texture_object == object) {
            binding->texture_object = NULL;
            binding->texture = 0;
            release_object_locked(group, object);
        }
        if (binding->cube_object == object) {
            binding->cube_object = NULL;
            binding->cube = 0;
            release_object_locked(group, object);
        }
    }
    pthread_mutex_unlock(&group->mutex);
    return 0;
}

/* Wait for native acceptance before changing C bindings or dimensionality.
 * A definite GL rejection preserves both layers. Indeterminate transport
 * failures still require the context-loss/reconciliation lifecycle path. */
static int bind_image_object(uint32_t kind, GLenum target, GLuint name) {
    uint32_t *input = malloc(12);
    if (!input) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return 0;
    }
    input[0] = kind;
    input[1] = target;
    input[2] = name;
    uint8_t reply[12];
    int accepted = checked_query_reply(QOP_BIND_IMAGE_OBJECT, input, 12, reply, 4);
    free(input);
    if (accepted) {
        uint32_t value;
        memcpy(&value, reply + 4, 4);
        if (value != 1) {
            raise_client_error(GL_INVALID_OPERATION);
            return 0;
        }
    }
    return accepted;
}
/* Retain both the selected record and input image before native mutation.
 * Unknown completion keeps those candidates with the entire shared group. */
static int import_image_object(uint32_t kind, struct wpk_object_name *object, GLuint source,
                               struct wpk_egl_image *image) {
    if (!object) {
        raise_client_error(GL_INVALID_OPERATION);
        return 0;
    }
    struct wpk_object_group *group = _wpk_gl_current_encoder()->objects;
    struct wpk_pending_image *pending = calloc(1, sizeof *pending);
    uint32_t *input = malloc(12);
    if (!pending || !input || !object_reference(group, object)) {
        free(pending);
        free(input);
        raise_client_error(GL_OUT_OF_MEMORY);
        return 0;
    }
    pending->object = object;
    pending->image = image;
    _wpk_egl_image_retain(image);
    input[0] = kind;
    input[1] = kind == 1 ? GL_TEXTURE_2D : GL_RENDERBUFFER;
    input[2] = source;
    uint32_t reply[4] = {0};
    int rc = _wpk_gl_query_into(QOP_BOUND_IMAGE_TARGET, input, 12, reply, 16);
    free(input);
    if (rc == WPK_GL_QUERY_NOT_DISPATCHED) {
        _wpk_egl_image_release(image);
        object_release(group, object);
        free(pending);
        return 0;
    }
    if (!rc && reply[3] == WPK_GL_QUERY_REPLY_MAGIC && reply[0] == 0 && reply[1] == source &&
        reply[2] != 0) {
        (void)publish_object_image(group, object, image, source, reply[2]);
        object_release(group, object);
        free(pending);
        return 1;
    }
    if (!rc && reply[3] == WPK_GL_QUERY_REPLY_MAGIC && reply[0] == 1) {
        _wpk_egl_image_release(image);
        object_release(group, object);
        free(pending);
        return 0;
    }
    quarantine_image_reference(group, pending);
    raise_client_error(GL_INVALID_OPERATION);
    return 0;
}
/* An explicit public name may already belong to a new peer object. Read
 * the retained implicit binding and publish only an ordered owned revision. */
static int sync_object_image(uint32_t kind, struct wpk_object_name *object) {
    if (!object)
        return 1;
    uint32_t *input = malloc(8);
    uint8_t reply[16];
    if (!input) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return 0;
    }
    input[0] = kind;
    input[1] = kind == 1 ? GL_TEXTURE_2D : GL_RENDERBUFFER;
    int accepted = checked_query_reply(QOP_BOUND_IMAGE_STATE, input, 8, reply, 8);
    free(input);
    uint32_t source = 1, revision = 0;
    if (accepted) {
        memcpy(&source, reply + 4, 4);
        memcpy(&revision, reply + 8, 4);
    }
    if (!accepted || source)
        return 0;
    return publish_object_image(_wpk_gl_current_encoder()->objects, object, NULL, 0, revision);
}
static GLenum image_target_error(struct wpk_object_group *group, struct wpk_object_name *object,
                                 GLenum target) {
    pthread_mutex_lock(&group->mutex);
    GLenum error =
        object && object->target && object->target != target ? GL_INVALID_OPERATION : GL_NO_ERROR;
    pthread_mutex_unlock(&group->mutex);
    return error;
}

static void emit_bind_texture(GLenum target, GLuint host);
void glDeleteTextures(GLsizei n, const GLuint *names) {
    if (!_wpk_gl_current_encoder()) return;
    if (n < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (!n || !names)
        return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    WPK_GL_NAME_SCOPE(state);
    struct wpk_object_group *group = state->objects;
    for (GLsizei i = 0; i < n; i++) {
        pthread_mutex_lock(&group->mutex);
        struct wpk_object_name *object = find_object_name(group, WPK_NAMES_TEXTURE, names[i]);
        if (!object) {
            pthread_mutex_unlock(&group->mutex);
            continue;
        }
        if (object->references == UINT_MAX) {
            pthread_mutex_unlock(&group->mutex);
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        object->references++; // Pin through native acceptance and C cleanup.
        pthread_mutex_unlock(&group->mutex);
        if (!delete_image_object(1, names[i])) {
            object_release(group, object);
            continue;
        }
        pthread_mutex_lock(&group->mutex);
        object->named = 0;
        release_object_locked(group, object);
        pthread_mutex_unlock(&group->mutex);
        delete_attached_image_object(object);
        pthread_mutex_lock(&group->mutex);
        for (uint32_t unit = 0; unit < state->texture_unit_count; unit++) {
            struct wpk_texture_unit *binding = &state->texture_units[unit];
            if (binding->texture_object == object) {
                binding->texture_object = NULL;
                binding->texture = 0;
                release_object_locked(group, object);
            }
            if (binding->cube_object == object) {
                binding->cube_object = NULL;
                binding->cube = 0;
                release_object_locked(group, object);
            }
        }
        pthread_mutex_unlock(&group->mutex);
        object_release(group, object);
    }
}

static void emit_bind_texture(GLenum target, GLuint host) {
    EMIT_BEGIN(OP_BIND_TEXTURE, 8)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, host);
    EMIT_END()
}

void glBindTexture(GLenum target, GLuint tex) {
    if (!_wpk_gl_current_encoder()) return;
    if (target != GL_TEXTURE_2D && target != GL_TEXTURE_CUBE_MAP) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    WPK_GL_NAME_SCOPE(state);
    struct wpk_object_name *object = object_acquire(state->objects, WPK_NAMES_TEXTURE, tex);
    if (tex && !object) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
    int live = external_texture_live(state, object);
    if (live < 0) {
        object_release(state->objects, object);
        return;
    }
    if (!live) {
        object_release(state->objects, object);
        object = object_acquire(state->objects, WPK_NAMES_TEXTURE, tex);
        if (!object) {
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
    }
    GLenum error = image_target_error(state->objects, object, target);
    if (error) {
        object_release(state->objects, object);
        raise_client_error(error);
        return;
    }
    if (!bind_image_object(1, target, tex)) {
        object_release(state->objects, object);
        return;
    }
    (void)realize_image_object(state->objects, object, target);
    struct wpk_object_name **slot = target == GL_TEXTURE_2D
                                        ? &state->texture_units[g_active_unit].texture_object
                                        : &state->texture_units[g_active_unit].cube_object;
    object_release(state->objects, *slot);
    *slot = object;
    if (target == GL_TEXTURE_2D)
        g_texture_units[g_active_unit].texture = tex;
    else
        g_texture_units[g_active_unit].cube = tex;
}

void glActiveTexture(GLenum unit) {
    if (!_wpk_gl_current_encoder())
        return;
    if (unit < GL_TEXTURE0) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    uint32_t index = unit - GL_TEXTURE0;
    if (!state->texture_unit_limit) {
        GLint limit = 0;
        uint32_t pname = GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS;
        const int rc = _wpk_gl_query_into(QOP_GET_INTEGERV, &pname, 4, &limit, 4);
        if (rc != 0) {
            if (rc != WPK_GL_QUERY_NOT_DISPATCHED) raise_client_error(GL_INVALID_OPERATION);
            return;
        }
        if (limit <= 0) {
            raise_client_error(GL_INVALID_OPERATION);
            return;
        }
        state->texture_unit_limit = (uint32_t)limit;
    }
    if (index >= state->texture_unit_limit) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    if (index >= state->texture_unit_count) {
        if (state->texture_unit_limit > SIZE_MAX / sizeof *state->texture_units) {
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        struct wpk_texture_unit *units = calloc(state->texture_unit_limit, sizeof *units);
        if (!units) {
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        memcpy(units, state->texture_units, state->texture_unit_count * sizeof *units);
        if (state->texture_units != state->initial_texture_units)
            free(state->texture_units);
        state->texture_units = units;
        state->texture_unit_count = state->texture_unit_limit;
    }
    uint8_t *cursor = reserve(8);
    if (!cursor)
        return;
    w_u16(&cursor, OP_ACTIVE_TEXTURE);
    w_u16(&cursor, 4);
    w_u32(&cursor, unit);
    g_cursor = cursor;
    g_active_unit = index;
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
        case GL_BGRA_EXT: return type == GL_UNSIGNED_BYTE ? 4 : 0;
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

/* Row stride under the current GL_UNPACK_ALIGNMENT for rows of
 * `pixels` pixels. */
static uint32_t unpack_row_stride(GLsizei pixels, uint32_t bpp) {
    uint32_t row = (uint32_t)pixels * bpp;
    uint32_t a = (uint32_t)g_unpack_alignment;
    return (row + a - 1u) & ~(a - 1u);
}

/* GL_EXT_texture_format_BGRA8888: WebGL has no BGRA format, so BGRA
 * pixels travel as RGBA with red and blue exchanged on the way. */
static GLenum host_pixel_format(GLenum format) {
    return format == GL_BGRA_EXT ? GL_RGBA : format;
}

static void copy_row(uint8_t *dst, const uint8_t *src, uint32_t bytes,
                     int swap_red_blue) {
    if (!swap_red_blue) {
        memcpy(dst, src, bytes);
        return;
    }
    for (uint32_t i = 0; i + 3 < bytes; i += 4) {
        dst[i]     = src[i + 2];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i];
        dst[i + 3] = src[i + 3];
    }
}

/* Emit OP_TEX_SUB_IMAGE_2D records for `height` rows of `width` pixels,
 * the first at `src`, each `src_stride` bytes after the one before. The
 * TLV payload-length field is u16, so the rows are split into bands; each
 * band's rows are packed at the host's unpack stride, whose data length
 * is (rows-1)*stride + width*bpp. */
static void emit_tex_rows(GLenum target, GLint level, GLint xoff, GLint yoff,
                          GLsizei width, GLsizei height,
                          GLenum format, GLenum type,
                          const uint8_t *src, uint32_t src_stride) {
    uint32_t bpp = bytes_per_pixel(format, type);
    if (bpp == 0 || src == NULL || width <= 0 || height <= 0) return;
    int swap = format == GL_BGRA_EXT;
    uint32_t stride = unpack_row_stride(width, bpp);
    uint32_t tail = (uint32_t)width * bpp;
    uint32_t max_rows = (0xFFFFu - 36u) / stride;
    if (max_rows == 0) return;
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
        w_u32(&_c, (uint32_t)host_pixel_format(format));
        w_u32(&_c, (uint32_t)type);
        w_u32(&_c, dlen);
        for (uint32_t r = 0; r < rows; r++) {
            copy_row(_c + r * stride,
                     src + ((uint32_t)y + r) * src_stride, tail, swap);
        }
        _c += dlen;
        EMIT_END()
        y += (GLsizei)rows;
    }
}

static void emit_tex_sub_image_2d(GLenum target, GLint level,
                                  GLint xoff, GLint yoff,
                                  GLsizei width, GLsizei height,
                                  GLenum format, GLenum type,
                                  const void *data) {
    uint32_t bpp = bytes_per_pixel(format, type);
    if (bpp == 0 || data == NULL) return;
    GLsizei row_pixels = g_unpack_row_length > 0 ? g_unpack_row_length : width;
    uint32_t src_stride = unpack_row_stride(row_pixels, bpp);
    const uint8_t *src = (const uint8_t *)data
        + (uint32_t)g_unpack_skip_rows * src_stride
        + (uint32_t)g_unpack_skip_pixels * bpp;
    emit_tex_rows(target, level, xoff, yoff, width, height, format, type,
                  src, src_stride);
}

void glTexImage2D(GLenum target, GLint level, GLint internalFormat,
                  GLsizei width, GLsizei height, GLint border,
                  GLenum format, GLenum type, const void *data) {
    if (!_wpk_gl_current_encoder()) return;
    if (internalFormat == GL_BGRA_EXT)
        internalFormat = GL_RGBA;
    uint32_t words[10] = {OP_TEX_IMAGE_2D,
                          target,
                          (uint32_t)level,
                          (uint32_t)internalFormat,
                          (uint32_t)width,
                          (uint32_t)height,
                          (uint32_t)border,
                          host_pixel_format(format),
                          type,
                          0};
    if (checked_mutation_query(QOP_IMAGE_STORAGE, words, 10) != 1)
        return;
    // A rejected imported allocation must not turn row uploads into writes
    // to the old shared image. Establish orphaning before publishing pixels.
    if (target == GL_TEXTURE_2D &&
        !sync_object_image(1, g_texture_units[g_active_unit].texture_object))
        return;
    emit_tex_sub_image_2d(target, level, 0, 0, width, height, format, type, data);
}

void glTexSubImage2D(GLenum target, GLint level, GLint xoff, GLint yoff,
                     GLsizei width, GLsizei height,
                     GLenum format, GLenum type, const void *data) {
    if (!_wpk_gl_current_encoder()) return;
    emit_tex_sub_image_2d(target, level, xoff, yoff, width, height,
                          format, type, data);
}

void glGenerateMipmap(GLenum target) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_GENERATE_MIPMAP, 4)
    w_u32(&_c, (uint32_t)target);
    EMIT_END()
    if (target == GL_TEXTURE_2D)
        sync_object_image(1, g_texture_units[g_active_unit].texture_object);
}

void glTexParameteri(GLenum target, GLenum pname, GLint param) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_TEX_PARAMETERI, 12)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_END()
}

void glPixelStorei(GLenum pname, GLint param) {
    if (!_wpk_gl_current_encoder()) return;
    if (pname == GL_UNPACK_ALIGNMENT
        && (param == 1 || param == 2 || param == 4 || param == 8)) {
        g_unpack_alignment = param;
    }
    if (pname == GL_UNPACK_ROW_LENGTH_EXT || pname == GL_UNPACK_SKIP_ROWS_EXT
        || pname == GL_UNPACK_SKIP_PIXELS_EXT) {
        if (param < 0) {
            raise_client_error(GL_INVALID_VALUE);
            return;
        }
        if (pname == GL_UNPACK_ROW_LENGTH_EXT) g_unpack_row_length = param;
        if (pname == GL_UNPACK_SKIP_ROWS_EXT) g_unpack_skip_rows = param;
        if (pname == GL_UNPACK_SKIP_PIXELS_EXT) g_unpack_skip_pixels = param;
        return;
    }
    EMIT_BEGIN(OP_PIXEL_STOREI, 8)
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_END()
}

void glDeleteBuffers(GLsizei n, const GLuint *names) {
    if (!_wpk_gl_current_encoder()) return;
    if (n < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (!n || !names)
        return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    WPK_GL_NAME_SCOPE(state);
    struct wpk_object_group *group = state->objects;
    for (GLsizei i = 0; i < n; i++) {
        pthread_mutex_lock(&group->mutex);
        struct wpk_object_name *object = find_object_name(group, WPK_NAMES_BUFFER, names[i]);
        if (!object) {
            pthread_mutex_unlock(&group->mutex);
            continue;
        }
        if (object->references == UINT_MAX) {
            pthread_mutex_unlock(&group->mutex);
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        object->references++; // Pin the exact record through native acceptance.
        pthread_mutex_unlock(&group->mutex);
        uint32_t word = names[i];
        if (checked_mutation_query(QOP_DELETE_BUFFER, &word, 1) != 1) {
            object_release(group, object);
            continue;
        }
        pthread_mutex_lock(&group->mutex);
        // Only the caller's active bindings are detached. Other VAOs and
        // group members retain the actual now-unnamed object identity.
        if (state->array_object == object) {
            state->array_object = NULL;
            g_array_buffer = 0;
            state->array_serial = 0;
            release_object_locked(group, object);
        }
        struct wpk_vertex_array *vao = state->current_vertex_array;
        if (vao->element_object == object) {
            vao->element_object = NULL;
            vao->element_buffer = 0;
            vao->element_serial = 0;
            release_object_locked(group, object);
        }
        for (unsigned a = 0; a < WPK_GL_MAX_ATTRIBS; a++)
            if (vao->attribs[a].buffer_object == object) {
                vao->attribs[a].buffer_object = NULL;
                vao->attribs[a].buffer_serial = 0;
                vao->attribs[a].buffer_name = 0;
                vao->attribs[a].client = vao->name == 0;
                release_object_locked(group, object);
            }
        object->named = 0;
        release_object_locked(group, object);
        pthread_mutex_unlock(&group->mutex);
        object_release(group, object);
    }
}

static int checked_query_reply(uint32_t op, const void *input, uint32_t input_len, uint8_t *reply,
                               uint32_t payload);
static uint32_t query_value_count(GLenum pname);

/* ----- uniforms ----------------------------------------------------- */

/* Only -1 denotes an ignored inactive uniform. Other negative locations
 * cannot identify a uniform and must not silently suppress an API error. */
static int uniform_location_accepted(GLint location) {
    if (location >= 0) return 1;
    if (location != -1) {
        raise_client_error(GL_INVALID_OPERATION);
        return 0;
    }
    /* All signatures ignore inactive data but still require a current
     * executable. An existing scalar record carries that identical check
     * without reading caller data. The host owns accepted use/link/delete
     * state and deduplicated errors; an optimistic C cache or a local error
     * derived from a state query would split that authority. Count/transpose
     * validation happens before this helper for vector/matrix signatures. */
    uint8_t *record = reserve(12);
    if (!record) return 0;
    w_u16(&record, OP_UNIFORM1F); w_u16(&record, 8);
    w_i32(&record, -1); w_f32(&record, 0);
    g_cursor = record;
    return 0;
}

void glUniform1i(GLint location, GLint v) {
    if (!_wpk_gl_current_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM1I, 8)
    w_i32(&_c, location);
    w_i32(&_c, v);
    EMIT_END()
}
void glUniform1f(GLint location, GLfloat v) {
    if (!_wpk_gl_current_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM1F, 8)
    w_i32(&_c, location);
    w_f32(&_c, v);
    EMIT_END()
}
void glUniform2f(GLint location, GLfloat x, GLfloat y) {
    if (!_wpk_gl_current_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM2F, 12)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y);
    EMIT_END()
}
void glUniform3f(GLint location, GLfloat x, GLfloat y, GLfloat z) {
    if (!_wpk_gl_current_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM3F, 16)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z);
    EMIT_END()
}
void glUniform4f(GLint location, GLfloat x, GLfloat y, GLfloat z, GLfloat w) {
    if (!_wpk_gl_current_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM4F, 20)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z); w_f32(&_c, w);
    EMIT_END()
}

/* ----- framebuffers ------------------------------------------------- */

void glGenFramebuffers(GLsizei n, GLuint *out) {
    if (!_wpk_gl_current_encoder()) return;
    if (n < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (!n || !out) return;
    for (GLsizei i = 0; i < n; i++) out[i] = g_next_framebuffer++;
    emit_name_array(OP_GEN_FRAMEBUFFERS, n, out);
}

void glDeleteFramebuffers(GLsizei n, const GLuint *names) {
    if (!_wpk_gl_current_encoder()) return;
    if (n < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (!n || !names)
        return;
    for (GLsizei i = 0; i < n; i++) {
        if (!delete_image_object(3, names[i]))
            continue;
        retire_image_attachments(names[i]);
        if (g_bound_framebuffer == names[i]) g_bound_framebuffer = 0;
    }
}

void glBindFramebuffer(GLenum target, GLuint fb) {
    if (!_wpk_gl_current_encoder()) return;
    uint32_t words[2] = {target, fb};
    if (checked_mutation_query(QOP_BIND_FRAMEBUFFER, words, 2) != 1)
        return;
    if (target == GL_FRAMEBUFFER)
        g_bound_framebuffer = fb;
}

void glFramebufferTexture2D(GLenum target, GLenum attachment,
                            GLenum textarget, GLuint texture, GLint level) {
    if (!_wpk_gl_current_encoder()) return;
    if (target != GL_FRAMEBUFFER || (attachment != GL_COLOR_ATTACHMENT0 && attachment != GL_DEPTH_ATTACHMENT && attachment != GL_STENCIL_ATTACHMENT)
        || (textarget != GL_TEXTURE_2D && (textarget < GL_TEXTURE_CUBE_MAP_POSITIVE_X || textarget > GL_TEXTURE_CUBE_MAP_NEGATIVE_Z))) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    if (level != 0) { raise_client_error(GL_INVALID_VALUE); return; }
    if (!g_bound_framebuffer) {
        raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    WPK_GL_NAME_SCOPE(_wpk_gl_current_encoder());
    GLenum error;
    struct wpk_object_name *object =
        attachment_object(_wpk_gl_current_encoder()->objects, WPK_NAMES_TEXTURE, texture,
                          textarget == GL_TEXTURE_2D ? GL_TEXTURE_2D : GL_TEXTURE_CUBE_MAP, &error);
    if (error) {
        raise_client_error(error);
        return;
    }
    int live = external_texture_live(_wpk_gl_current_encoder(), object);
    if (live <= 0) {
        object_release(_wpk_gl_current_encoder()->objects, object);
        if (!live)
            raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    (void)track_image_attachment(target, attachment, GL_TEXTURE_2D, textarget, texture, level,
                                 object);
}

/* ----- blend -------------------------------------------------------- */

void glBlendFunc(GLenum sfactor, GLenum dfactor) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_BLEND_FUNC, 8)
    w_u32(&_c, (uint32_t)sfactor);
    w_u32(&_c, (uint32_t)dfactor);
    EMIT_END()
}

void glBlendFuncSeparate(GLenum srcRGB, GLenum dstRGB,
                         GLenum srcAlpha, GLenum dstAlpha) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_BLEND_FUNC_SEPARATE, 16)
    w_u32(&_c, (uint32_t)srcRGB);
    w_u32(&_c, (uint32_t)dstRGB);
    w_u32(&_c, (uint32_t)srcAlpha);
    w_u32(&_c, (uint32_t)dstAlpha);
    EMIT_END()
}

void glBlendEquationSeparate(GLenum modeRGB, GLenum modeAlpha) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_BLEND_EQUATION_SEPARATE, 8)
    w_u32(&_c, (uint32_t)modeRGB);
    w_u32(&_c, (uint32_t)modeAlpha);
    EMIT_END()
}

void glBlendEquation(GLenum mode) {
    if (!_wpk_gl_current_encoder()) return;
    glBlendEquationSeparate(mode, mode);
}

/* ----- queries: locations, shader/program info --------------------- */

/* Preallocated query buffers also permit cancellation after a transport
 * failure, without another allocation. Only acknowledged replies publish. */
static int uniform_lookup_query(int fd, uint8_t *request, uint32_t length, uint8_t *reply,
                                uint32_t token, GLint *location, int quiet) {
    memset(reply, 0, 16);
    struct gl_query_info info = {.op = QOP_LOOKUP_UNIFORM,
                                 .in_buf_ptr = (uintptr_t)request,
                                 .in_buf_len = length,
                                 .out_buf_ptr = (uintptr_t)reply,
                                 .out_buf_len = 16,
                                 .reserved = 0};
    if (ioctl(fd, GLIO_QUERY, &info) != 0)
        goto invalid;
    uint32_t status, echoed, footer;
    memcpy(&status, reply, 4);
    memcpy(&echoed, reply + 4, 4);
    memcpy(&footer, reply + 12, 4);
    if (status > 1 || footer != WPK_GL_QUERY_REPLY_MAGIC)
        goto invalid;
    if (status)
        return 0;
    if (echoed != token)
        goto invalid;
    memcpy(location, reply + 8, 4);
    return 1;
invalid:
    if (!quiet)
        raise_client_error(GL_INVALID_OPERATION);
    return 0;
}
GLint glGetUniformLocation(GLuint program, const GLchar *name) {
    if (!_wpk_gl_current_encoder())
        return -1;
    if (!name) return -1;
    size_t length = strlen(name);
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (length > UINT32_MAX || state->next_uniform_lookup == UINT32_MAX) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return -1;
    }
    uint32_t capacity = length <= 65520 ? (uint32_t)length + 16 : 65536;
    uint8_t *request = malloc(capacity), *reply = malloc(16);
    if (!request || !reply) {
        free(request);
        free(reply);
        raise_client_error(GL_OUT_OF_MEMORY);
        return -1;
    }
    GLint location = -1;
    if (flush_commands() != 0)
        goto done;
    int fd = _wpk_gl_fd();
    uint32_t token = ++state->next_uniform_lookup;
    uint32_t header[4] = {length <= 65520 ? 0u : 1u, program, token, (uint32_t)length};
    memcpy(request, header, 16);
    if (length <= 65520) {
        memcpy(request + 16, name, length);
        if (!uniform_lookup_query(fd, request, (uint32_t)length + 16, reply, token, &location, 0))
            location = -1;
        goto done;
    }
    if (!uniform_lookup_query(fd, request, 16, reply, token, &location, 0))
        goto abort;
    for (uint32_t offset = 0; offset < (uint32_t)length;) {
        uint32_t count = (uint32_t)length - offset < 65520 ? (uint32_t)length - offset : 65520;
        header[0] = 2;
        header[3] = offset;
        memcpy(request, header, 16);
        memcpy(request + 16, name + offset, count);
        if (!uniform_lookup_query(fd, request, count + 16, reply, token, &location, 0))
            goto abort;
        offset += count;
    }
    header[0] = 3;
    header[3] = 0;
    memcpy(request, header, 16);
    if (!uniform_lookup_query(fd, request, 16, reply, token, &location, 0))
        goto abort;
    goto done;
abort:
    header[0] = 4;
    header[3] = 0;
    memcpy(request, header, 16);
    (void)uniform_lookup_query(fd, request, 16, reply, token, &location, 1);
    location = -1;
done:
    free(request);
    free(reply);
    return location;
}

GLenum glCheckFramebufferStatus(GLenum target) {
    if (!_wpk_gl_current_encoder()) return 0;
    uint32_t t = (uint32_t)target;
    uint32_t status = 0;
    if (_wpk_gl_query_into(QOP_CHECK_FB_STATUS, &t, 4, &status, 4) != 0) return 0;
    return (GLenum)status;
}

void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height,
                  GLenum format, GLenum type, void *pixels) {
    if (!_wpk_gl_current_encoder()) return;
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
    if (!_wpk_gl_current_encoder()) return;
    if (!params) return;
    uint8_t in[8];
    uint32_t s = shader, p = (uint32_t)pname;
    memcpy(in, &s, 4); memcpy(in + 4, &p, 4);
    int32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_SHADERIV, in, 8, &out, 4) != 0) { *params = 0; return; }
    *params = out;
}

void glGetShaderInfoLog(GLuint shader, GLsizei bufSize, GLsizei *length, GLchar *infoLog) {
    if (!_wpk_gl_current_encoder()) return;
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
    if (!_wpk_gl_current_encoder()) return;
    if (!params) return;
    uint8_t in[8];
    uint32_t s = program, p = (uint32_t)pname;
    memcpy(in, &s, 4); memcpy(in + 4, &p, 4);
    int32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_PROGRAMIV, in, 8, &out, 4) != 0) { *params = 0; return; }
    *params = out;
}

void glGetProgramInfoLog(GLuint program, GLsizei bufSize, GLsizei *length, GLchar *infoLog) {
    if (!_wpk_gl_current_encoder()) return;
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

static const char *const k_client_extensions[] = {
    "GL_EXT_texture_format_BGRA8888",
    "GL_EXT_unpack_subimage",
    "GL_OES_EGL_image",
    /* Fence placement is supplied by the EGL client facade, rather than a
     * WebGL getExtension name. It adds no GLES entry points. */
    "GL_OES_EGL_sync",
};

static int has_extension(const char *list, const char *name) {
    size_t len = strlen(name);
    for (const char *p = strstr(list, name); p; p = strstr(p + 1, name)) {
        int starts = p == list || p[-1] == ' ';
        int ends = p[len] == '\0' || p[len] == ' ';
        if (starts && ends) return 1;
    }
    return 0;
}

static void append_client_extensions(char *list, size_t cap) {
    for (size_t i = 0; i < sizeof k_client_extensions / sizeof k_client_extensions[0]; i++) {
        if (has_extension(list, k_client_extensions[i])) continue;
        size_t used = strlen(list);
        snprintf(list + used, cap - used, "%s%s", used ? " " : "",
                 k_client_extensions[i]);
    }
}

/* The context this stub exposes is OpenGL ES 2.0 (EGL client version 2
 * over the host WebGL2 bridge), but the host's own strings say "WebGL
 * 2.0 (…)". Report the ES API version of the context — the same
 * normalization ANGLE and Mesa perform — with the host string kept in
 * the parenthesized vendor-specific suffix that GL version strings
 * allow. Results cache in the context: the strings are immutable for the
 * context's lifetime and callers hold the returned pointer. */
const GLubyte *glGetString(GLenum name) {
    if (!_wpk_gl_current_encoder()) return NULL;
    char *version = _wpk_gl_current_encoder()->version;
    char *glsl_version = _wpk_gl_current_encoder()->glsl_version;
    char *vendor = _wpk_gl_current_encoder()->vendor;
    char *renderer = _wpk_gl_current_encoder()->renderer;
    char *extensions = _wpk_gl_current_encoder()->extensions;
    char host[192];

    switch (name) {
        case GL_VERSION:
            if (version[0] == '\0') {
                if (!wpk_host_string(name, host, sizeof host)) return NULL;
                snprintf(version, sizeof _wpk_gl_current_encoder()->version, "OpenGL ES 2.0 (%s)", host);
            }
            return (const GLubyte *)version;
        case GL_SHADING_LANGUAGE_VERSION:
            if (glsl_version[0] == '\0') {
                if (!wpk_host_string(name, host, sizeof host)) return NULL;
                snprintf(glsl_version, sizeof _wpk_gl_current_encoder()->glsl_version,
                         "OpenGL ES GLSL ES 1.00 (%s)", host);
            }
            return (const GLubyte *)glsl_version;
        case GL_VENDOR:
            if (vendor[0] == '\0'
                && !wpk_host_string(name, vendor, sizeof _wpk_gl_current_encoder()->vendor)) return NULL;
            return (const GLubyte *)vendor;
        case GL_RENDERER:
            if (renderer[0] == '\0'
                && !wpk_host_string(name, renderer, sizeof _wpk_gl_current_encoder()->renderer)) return NULL;
            return (const GLubyte *)renderer;
        case GL_EXTENSIONS:
            /* The host reports GLES equivalents supported by this encoder
             * version and the actual WebGL context. The extensions this
             * library implements itself follow. */
            if (extensions[0] == '\0') {
                if (!wpk_host_string(name, extensions, sizeof _wpk_gl_current_encoder()->extensions))
                    return (const GLubyte *)"";
                append_client_extensions(extensions, sizeof _wpk_gl_current_encoder()->extensions);
            }
            return (const GLubyte *)extensions;
        default:
            raise_client_error(GL_INVALID_ENUM);
            return NULL;
    }
}

/* Hint quality may be ignored, but the selected state and invalid-enum
 * behavior are observable. Keep this execution-local state with the context,
 * including the advertised OES derivative hint. Shared-object peers retain
 * independent values even when their native renderer is multiplexed. */
static GLenum *hint_slot(struct wpk_gles_context *state, GLenum target) {
    if (target == GL_GENERATE_MIPMAP_HINT) return &state->generate_mipmap_hint;
    if (target == GL_FRAGMENT_SHADER_DERIVATIVE_HINT_OES) return &state->fragment_derivative_hint;
    return NULL;
}

/* Scalar and vector pnames use the same query with their complete width. */
void glGetIntegerv(GLenum pname, GLint *data) {
    if (!_wpk_gl_current_encoder()) return;
    if (!data)
        return;
    if (pname == GL_UNPACK_ROW_LENGTH_EXT) { *data = g_unpack_row_length; return; }
    if (pname == GL_UNPACK_SKIP_ROWS_EXT) { *data = g_unpack_skip_rows; return; }
    if (pname == GL_UNPACK_SKIP_PIXELS_EXT) { *data = g_unpack_skip_pixels; return; }
    const GLenum *hint = hint_slot(_wpk_gl_current_encoder(), pname);
    if (hint) { *data = (GLint)*hint; return; }
    uint32_t p = (uint32_t)pname;
    uint32_t count = query_value_count(pname);
    if (count == 0) return;
    (void)_wpk_gl_query_into(QOP_GET_INTEGERV, &p, 4, data, count * sizeof(GLint));
}

void glGetShaderPrecisionFormat(GLenum shadertype, GLenum precisiontype,
                                GLint *range, GLint *precision) {
    if (!_wpk_gl_current_encoder()) return;
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

void glHint(GLenum target, GLenum mode) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (!state) return;
    GLenum *slot = hint_slot(state, target);
    if (!slot || (mode != GL_DONT_CARE && mode != GL_FASTEST && mode != GL_NICEST)) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    *slot = mode;
}

// Native GLES renderer entry points.
void glBlendColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_BLEND_COLOR, 16)
    w_f32(&_c, r); w_f32(&_c, g); w_f32(&_c, b); w_f32(&_c, a);
    EMIT_END()
}

void glClearDepthf(GLfloat d) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_CLEAR_DEPTHF, 4)
    w_f32(&_c, d);
    EMIT_END()
}

void glClearStencil(GLint s) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_CLEAR_STENCIL, 4)
    w_i32(&_c, s);
    EMIT_END()
}

void glColorMask(GLboolean r, GLboolean g, GLboolean b, GLboolean a) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_COLOR_MASK, 16)
    w_u32(&_c, r ? 1u : 0u);
    w_u32(&_c, g ? 1u : 0u);
    w_u32(&_c, b ? 1u : 0u);
    w_u32(&_c, a ? 1u : 0u);
    EMIT_END()
}

void glDepthMask(GLboolean flag) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_DEPTH_MASK, 4)
    w_u32(&_c, flag ? 1u : 0u);
    EMIT_END()
}

void glDepthFunc(GLenum func) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_DEPTH_FUNC, 4)
    w_u32(&_c, (uint32_t)func);
    EMIT_END()
}

void glCullFace(GLenum mode) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_CULL_FACE, 4)
    w_u32(&_c, (uint32_t)mode);
    EMIT_END()
}

void glFrontFace(GLenum mode) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_FRONT_FACE, 4)
    w_u32(&_c, (uint32_t)mode);
    EMIT_END()
}

void glLineWidth(GLfloat width) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_LINE_WIDTH, 4)
    w_f32(&_c, width);
    EMIT_END()
}

void glStencilFunc(GLenum func, GLint ref, GLuint mask) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_STENCIL_FUNC, 12)
    w_u32(&_c, (uint32_t)func);
    w_i32(&_c, ref);
    w_u32(&_c, mask);
    EMIT_END()
}

void glStencilFuncSeparate(GLenum face, GLenum func, GLint ref, GLuint mask) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_STENCIL_FUNC_SEPARATE, 16)
    w_u32(&_c, (uint32_t)face);
    w_u32(&_c, (uint32_t)func);
    w_i32(&_c, ref);
    w_u32(&_c, mask);
    EMIT_END()
}

void glStencilMask(GLuint mask) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_STENCIL_MASK, 4)
    w_u32(&_c, mask);
    EMIT_END()
}

void glStencilMaskSeparate(GLenum face, GLuint mask) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_STENCIL_MASK_SEPARATE, 8)
    w_u32(&_c, (uint32_t)face);
    w_u32(&_c, mask);
    EMIT_END()
}

void glStencilOp(GLenum fail, GLenum zfail, GLenum zpass) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_STENCIL_OP, 12)
    w_u32(&_c, (uint32_t)fail);
    w_u32(&_c, (uint32_t)zfail);
    w_u32(&_c, (uint32_t)zpass);
    EMIT_END()
}

void glStencilOpSeparate(GLenum face, GLenum fail, GLenum zfail, GLenum zpass) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_STENCIL_OP_SEPARATE, 16)
    w_u32(&_c, (uint32_t)face);
    w_u32(&_c, (uint32_t)fail);
    w_u32(&_c, (uint32_t)zfail);
    w_u32(&_c, (uint32_t)zpass);
    EMIT_END()
}

void glPolygonOffset(GLfloat factor, GLfloat units) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_POLYGON_OFFSET, 8)
    w_f32(&_c, factor);
    w_f32(&_c, units);
    EMIT_END()
}

void glDepthRangef(GLfloat n, GLfloat f) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_DEPTH_RANGEF, 8)
    w_f32(&_c, n);
    w_f32(&_c, f);
    EMIT_END()
}

void glSampleCoverage(GLfloat value, GLboolean invert) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_SAMPLE_COVERAGE, 8)
    w_f32(&_c, value);
    w_u32(&_c, invert ? 1u : 0u);
    EMIT_END()
}

void glReleaseShaderCompiler(void) {
    if (!_wpk_gl_current_encoder()) return;}

void glVertexAttrib4f(GLuint index, GLfloat x, GLfloat y, GLfloat z, GLfloat w) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_VERTEX_ATTRIB_4FV, 20)
    w_u32(&_c, index);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z); w_f32(&_c, w);
    EMIT_END()
}

void glVertexAttrib1f(GLuint index, GLfloat x) {
    if (!_wpk_gl_current_encoder()) return;
    glVertexAttrib4f(index, x, 0.0f, 0.0f, 1.0f);
}

void glVertexAttrib2f(GLuint index, GLfloat x, GLfloat y) {
    if (!_wpk_gl_current_encoder()) return;
    glVertexAttrib4f(index, x, y, 0.0f, 1.0f);
}

void glVertexAttrib3f(GLuint index, GLfloat x, GLfloat y, GLfloat z) {
    if (!_wpk_gl_current_encoder()) return;
    glVertexAttrib4f(index, x, y, z, 1.0f);
}

void glVertexAttrib1fv(GLuint index, const GLfloat *v) {
    if (!_wpk_gl_current_encoder()) return;
    if (v) glVertexAttrib1f(index, v[0]);
}

void glVertexAttrib2fv(GLuint index, const GLfloat *v) {
    if (!_wpk_gl_current_encoder()) return;
    if (v) glVertexAttrib2f(index, v[0], v[1]);
}

void glVertexAttrib3fv(GLuint index, const GLfloat *v) {
    if (!_wpk_gl_current_encoder()) return;
    if (v) glVertexAttrib3f(index, v[0], v[1], v[2]);
}

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
    case GL_COMPRESSED_TEXTURE_FORMATS:
    case GL_SHADER_BINARY_FORMATS: {
        GLint count = 0;
        glGetIntegerv(pname == GL_COMPRESSED_TEXTURE_FORMATS
            ? GL_NUM_COMPRESSED_TEXTURE_FORMATS : GL_NUM_SHADER_BINARY_FORMATS, &count);
        return count > 0 ? (uint32_t)count : 0;
    }
    default:
        return 1;
    }
}

void glGetFloatv(GLenum pname, GLfloat *data) {
    if (!_wpk_gl_current_encoder()) return;
    if (!data)
        return;
    if (pname == GL_UNPACK_ROW_LENGTH_EXT) { *data = (GLfloat)g_unpack_row_length; return; }
    if (pname == GL_UNPACK_SKIP_ROWS_EXT) { *data = (GLfloat)g_unpack_skip_rows; return; }
    if (pname == GL_UNPACK_SKIP_PIXELS_EXT) { *data = (GLfloat)g_unpack_skip_pixels; return; }
    const GLenum *hint = hint_slot(_wpk_gl_current_encoder(), pname);
    if (hint) { *data = (GLfloat)*hint; return; }
    uint32_t p = (uint32_t)pname;
    uint32_t count = query_value_count(pname);
    if (count == 0) return;
    (void)_wpk_gl_query_into(QOP_GET_FLOATV, &p, 4, data, count * sizeof(GLfloat));
}

void glGetBooleanv(GLenum pname, GLboolean *data) {
    if (!_wpk_gl_current_encoder()) return;
    if (!data)
        return;
    if (pname == GL_UNPACK_ROW_LENGTH_EXT) { *data = g_unpack_row_length != 0; return; }
    if (pname == GL_UNPACK_SKIP_ROWS_EXT) { *data = g_unpack_skip_rows != 0; return; }
    if (pname == GL_UNPACK_SKIP_PIXELS_EXT) { *data = g_unpack_skip_pixels != 0; return; }
    const GLenum *hint = hint_slot(_wpk_gl_current_encoder(), pname);
    if (hint) { *data = *hint != 0 ? GL_TRUE : GL_FALSE; return; }
    uint32_t count = query_value_count(pname);
    if (count == 0) return;
    GLfloat small[4];
    GLfloat *values = count <= 4 ? small : malloc((size_t)count * sizeof *values);
    if (!values) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
    /* Boolean conversion tests the original value against zero. Integer
     * conversion would first truncate fractional state such as clear color.
     * Every exposed integer/enum remains nonzero when converted to float. */
    uint32_t p = pname;
    if (_wpk_gl_query_into(QOP_GET_FLOATV, &p, 4, values, count * sizeof *values) == 0)
        for (uint32_t i = 0; i < count; i++) data[i] = values[i] != 0.0f ? GL_TRUE : GL_FALSE;
    if (values != small) free(values);
}

void glTexParameterf(GLenum target, GLenum pname, GLfloat param) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_TEX_PARAMETERF, 12)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)pname);
    w_f32(&_c, param);
    EMIT_END()
}

void glTexParameteriv(GLenum target, GLenum pname, const GLint *params) {
    if (!_wpk_gl_current_encoder()) return;
    if (params) glTexParameteri(target, pname, params[0]);
}

void glTexParameterfv(GLenum target, GLenum pname, const GLfloat *params) {
    if (!_wpk_gl_current_encoder()) return;
    if (params) glTexParameterf(target, pname, params[0]);
}

void glCompressedTexImage2D(GLenum target, GLint level, GLenum internalformat,
                            GLsizei width, GLsizei height, GLint border,
                            GLsizei imageSize, const void *data) {
    if (!_wpk_gl_current_encoder()) return;
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
    if (target == GL_TEXTURE_2D)
        sync_object_image(1, g_texture_units[g_active_unit].texture_object);
}

void glCompressedTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset,
                               GLsizei width, GLsizei height, GLenum format,
                               GLsizei imageSize, const void *data) {
    if (!_wpk_gl_current_encoder()) return;
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
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_COPY_TEX_IMAGE_2D, 32)
    w_u32(&_c, (uint32_t)target);
    w_i32(&_c, level);
    w_u32(&_c, (uint32_t)internalformat);
    w_i32(&_c, x); w_i32(&_c, y); w_i32(&_c, width); w_i32(&_c, height); w_i32(&_c, border);
    EMIT_END()
    if (target == GL_TEXTURE_2D)
        sync_object_image(1, g_texture_units[g_active_unit].texture_object);
}

void glCopyTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset,
                         GLint x, GLint y, GLsizei width, GLsizei height) {
    if (!_wpk_gl_current_encoder()) return;
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

/* One API call may span many command submissions. Stage the complete call
 * at the host before any native setter, preserving whole-call type/count
 * rejection and array-tail semantics without a client reflection cache. */
static void emit_large_uniform(uint16_t op, GLint location, GLsizei count,
                               GLboolean transpose, const void *value,
                               uint32_t components) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (state->next_uniform_upload == UINT32_MAX) {
        raise_client_error(GL_OUT_OF_MEMORY); return;
    }
    const uint32_t token = ++state->next_uniform_upload;
    uint8_t *cursor = reserve(24);
    if (!cursor) return;
    w_u16(&cursor,OP_UNIFORM_UPLOAD_BEGIN); w_u16(&cursor,20);
    w_u32(&cursor,token); w_u32(&cursor,op); w_i32(&cursor,location);
    w_u32(&cursor,(uint32_t)count); w_u32(&cursor,transpose);
    g_cursor=cursor;
    const uint32_t maximum=(WPK_GL_MAX_TLV_PAYLOAD-16u)/(components*4u);
    for(uint32_t offset=0;offset<(uint32_t)count;) {
        const uint32_t remaining=(uint32_t)count-offset;
        const uint32_t n=remaining<maximum?remaining:maximum, bytes=n*components*4u;
        cursor=reserve(20u+bytes);
        if(!cursor) goto cancel;
        w_u16(&cursor,OP_UNIFORM_UPLOAD_CHUNK); w_u16(&cursor,(uint16_t)(16u+bytes));
        w_u32(&cursor,token); w_u32(&cursor,op); w_u32(&cursor,offset); w_u32(&cursor,n);
        memcpy(cursor,(const uint8_t *)value+(size_t)offset*components*4u,bytes);
        cursor+=bytes;g_cursor=cursor;offset+=n;
    }
    cursor=reserve(8);
    if(!cursor) goto cancel;
    w_u16(&cursor,OP_UNIFORM_UPLOAD_COMMIT);w_u16(&cursor,4);w_u32(&cursor,token);
    g_cursor=cursor;return;
cancel:
    /* Failed submission already queued allocation-free token retirement in
     * flush_commands; a missing encoder is reclaimed through context teardown. */
    return;
}

static int uniform_source_span(const void *value, GLsizei count, uint32_t components) {
    const uint64_t bytes=(uint64_t)(uint32_t)count*components*4u;
    if(bytes>SIZE_MAX || (uintptr_t)value>UINTPTR_MAX-(uintptr_t)bytes) {
        raise_client_error(GL_OUT_OF_MEMORY);return 0;
    }
    return 1;
}

/* An inactive location ignores data, not an invalid sizei argument. Validate
 * count first; zero and ignored calls must not read even an invalid pointer.
 * Positive zero-count calls still publish their original-op header so the
 * host can judge the accepted executable, location and signature in order.
 * Vector records have an eight-byte header, unlike matrix records' twelve. */
static uint64_t uniform_vector_length(GLint location, GLsizei count,
                                      const void *value, uint32_t components) {
    if (count < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return UINT64_MAX;
    }
    if (!uniform_location_accepted(location)) return UINT64_MAX;
    if (count && !value) {
        raise_client_error(GL_INVALID_VALUE);
        return UINT64_MAX;
    }
    if (!uniform_source_span(value,count,components)) return UINT64_MAX;
    return (uint64_t)(uint32_t)count * components;
}

static void emit_uniform_fv(uint16_t op, GLint location, GLsizei count,
                            const GLfloat *value, uint32_t components) {
    uint64_t n = uniform_vector_length(location, count, value, components);
    if (n == UINT64_MAX) return;
    if (n > (WPK_GL_MAX_TLV_PAYLOAD-8u)/4u) {
        emit_large_uniform(op,location,count,GL_FALSE,value,components); return;
    }
    EMIT_BEGIN(op, 8u + (uint32_t)n * 4u)
    w_i32(&_c, location);
    w_u32(&_c, (uint32_t)count);
    for (uint32_t i = 0; i < n; i++) w_f32(&_c, value[i]);
    EMIT_END()
}

static void emit_uniform_iv(uint16_t op, GLint location, GLsizei count,
                            const GLint *value, uint32_t components) {
    uint64_t n = uniform_vector_length(location, count, value, components);
    if (n == UINT64_MAX) return;
    if (n > (WPK_GL_MAX_TLV_PAYLOAD-8u)/4u) {
        emit_large_uniform(op,location,count,GL_FALSE,value,components); return;
    }
    EMIT_BEGIN(op, 8u + (uint32_t)n * 4u)
    w_i32(&_c, location);
    w_u32(&_c, (uint32_t)count);
    for (uint32_t i = 0; i < n; i++) w_i32(&_c, value[i]);
    EMIT_END()
}

/* ES2 requires non-transposed matrices. Check the complete source span before
 * multiplying or reading it, then use bounded transport for larger arrays. */
static void emit_uniform_matrix(uint16_t op, GLint location, GLsizei count,
                                GLboolean transpose, const GLfloat *value,
                                uint32_t components) {
    if (count < 0 || transpose != GL_FALSE) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (!uniform_location_accepted(location)) return;
    if (count && !value) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (!uniform_source_span(value,count,components)) return;
    if ((uint64_t)(uint32_t)count*components > (WPK_GL_MAX_TLV_PAYLOAD-12u)/4u) {
        emit_large_uniform(op,location,count,transpose,value,components); return;
    }
    uint32_t n = (uint32_t)count * components;
    EMIT_BEGIN(op, 12u + n * 4u)
    w_i32(&_c, location);
    w_u32(&_c, (uint32_t)count);
    w_u32(&_c, transpose ? 1u : 0u);
    for (uint32_t i = 0; i < n; i++) w_f32(&_c, value[i]);
    EMIT_END()
}

void glUniform1fv(GLint location, GLsizei count, const GLfloat *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_fv(OP_UNIFORM1FV, location, count, value, 1);
}

void glUniform2fv(GLint location, GLsizei count, const GLfloat *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_fv(OP_UNIFORM2FV, location, count, value, 2);
}

void glUniform3fv(GLint location, GLsizei count, const GLfloat *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_fv(OP_UNIFORM3FV, location, count, value, 3);
}

void glUniform4fv(GLint location, GLsizei count, const GLfloat *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_fv(OP_UNIFORM4FV, location, count, value, 4);
}

void glUniform1iv(GLint location, GLsizei count, const GLint *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_iv(OP_UNIFORM1IV, location, count, value, 1);
}

void glUniform2iv(GLint location, GLsizei count, const GLint *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_iv(OP_UNIFORM2IV, location, count, value, 2);
}

void glUniform3iv(GLint location, GLsizei count, const GLint *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_iv(OP_UNIFORM3IV, location, count, value, 3);
}

void glUniform4iv(GLint location, GLsizei count, const GLint *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_iv(OP_UNIFORM4IV, location, count, value, 4);
}

void glUniform2i(GLint location, GLint x, GLint y) {
    if (!_wpk_gl_current_encoder()) return;
    if (!uniform_location_accepted(location)) return; GLint v[2] = {x, y}; glUniform2iv(location, 1, v); }

void glUniform3i(GLint location, GLint x, GLint y, GLint z) {
    if (!_wpk_gl_current_encoder()) return;
    if (!uniform_location_accepted(location)) return; GLint v[3] = {x, y, z}; glUniform3iv(location, 1, v); }

void glUniform4i(GLint location, GLint x, GLint y, GLint z, GLint w) {
    if (!_wpk_gl_current_encoder()) return;
    if (!uniform_location_accepted(location)) return; GLint v[4] = {x, y, z, w}; glUniform4iv(location, 1, v); }

void glUniformMatrix2fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_matrix(OP_UNIFORM_MATRIX2FV, location, count, transpose, value, 4);
}

void glUniformMatrix3fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_matrix(OP_UNIFORM_MATRIX3FV, location, count, transpose, value, 9);
}

void glUniformMatrix4fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) {
    if (!_wpk_gl_current_encoder()) return;
    emit_uniform_matrix(OP_UNIFORM_MATRIX4FV, location, count, transpose, value, 16);
}

void glGenRenderbuffers(GLsizei n, GLuint *out) {
    if (!_wpk_gl_current_encoder()) return;
    uint32_t error =
        _wpk_gl_reserve_names(_wpk_gl_current_encoder(), WPK_NAMES_RENDERBUFFER, n, out);
    if (error) {
        raise_client_error(error);
        return;
    }
    if (n > 0 && out)
        emit_name_array(OP_GEN_RENDERBUFFERS, n, out);
}

void glDeleteRenderbuffers(GLsizei n, const GLuint *names) {
    if (!_wpk_gl_current_encoder()) return;
    if (n < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (!n || !names)
        return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    WPK_GL_NAME_SCOPE(state);
    struct wpk_object_group *group = state->objects;
    for (GLsizei i = 0; i < n; i++) {
        pthread_mutex_lock(&group->mutex);
        struct wpk_object_name *object = find_object_name(group, WPK_NAMES_RENDERBUFFER, names[i]);
        if (!object) {
            pthread_mutex_unlock(&group->mutex);
            continue;
        }
        if (object->references == UINT_MAX) {
            pthread_mutex_unlock(&group->mutex);
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        object->references++;
        pthread_mutex_unlock(&group->mutex);
        if (!delete_image_object(2, names[i])) {
            object_release(group, object);
            continue;
        }
        pthread_mutex_lock(&group->mutex);
        if (state->renderbuffer_object == object) {
            state->renderbuffer_object = NULL;
            g_bound_renderbuffer = 0;
            release_object_locked(group, object);
        }
        object->named = 0;
        release_object_locked(group, object);
        pthread_mutex_unlock(&group->mutex);
        delete_attached_image_object(object);
        object_release(group, object);
    }
}

void glBindRenderbuffer(GLenum target, GLuint rb) {
    if (!_wpk_gl_current_encoder())
        return;
    if (target != GL_RENDERBUFFER) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    WPK_GL_NAME_SCOPE(state);
    struct wpk_object_name *object = object_acquire(state->objects, WPK_NAMES_RENDERBUFFER, rb);
    if (rb && !object) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
    if (!bind_image_object(2, target, rb)) {
        object_release(state->objects, object);
        return;
    }
    (void)realize_image_object(state->objects, object, target);
    object_release(state->objects, state->renderbuffer_object);
    state->renderbuffer_object = object;
    g_bound_renderbuffer = rb;
}

void glRenderbufferStorage(GLenum target, GLenum internalformat, GLsizei width, GLsizei height) {
    if (!_wpk_gl_current_encoder())
        return;
    uint32_t words[5] = {OP_RENDERBUFFER_STORAGE, target, internalformat, (uint32_t)width,
                         (uint32_t)height};
    if (checked_mutation_query(QOP_IMAGE_STORAGE, words, 5) != 1)
        return;
    if (target == GL_RENDERBUFFER)
        sync_object_image(2, _wpk_gl_current_encoder()->renderbuffer_object);
}

/* The host resolves a logical renderbuffer attachment to its current native
 * storage; imported backing does not change its public object type/name. */
void glFramebufferRenderbuffer(GLenum target, GLenum attachment,
                               GLenum renderbuffertarget, GLuint renderbuffer) {
    if (!_wpk_gl_current_encoder()) return;
    if (target != GL_FRAMEBUFFER || renderbuffertarget != GL_RENDERBUFFER
        || (attachment != GL_COLOR_ATTACHMENT0 && attachment != GL_DEPTH_ATTACHMENT && attachment != GL_STENCIL_ATTACHMENT)) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    if (!g_bound_framebuffer) {
        raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    WPK_GL_NAME_SCOPE(_wpk_gl_current_encoder());
    GLenum error;
    struct wpk_object_name *object =
        attachment_object(_wpk_gl_current_encoder()->objects, WPK_NAMES_RENDERBUFFER, renderbuffer,
                          GL_RENDERBUFFER, &error);
    if (error) {
        raise_client_error(error);
        return;
    }
    (void)track_image_attachment(target, attachment, GL_RENDERBUFFER, renderbuffertarget,
                                 renderbuffer, 0, object);
}

/* ----- GL_OES_EGL_image --------------------------------------------- */

/* Both storage tiers use retained canonical sources. The host publishes CPU
 * mappings and native sibling writes at ordered command boundaries. */
void glEGLImageTargetTexture2DOES(GLenum target, GLeglImageOES image) {
    if (!_wpk_gl_current_encoder()) return;
    if (target != GL_TEXTURE_2D) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    struct wpk_egl_image *img = _wpk_egl_image_lookup(image);
    GLuint name = g_texture_units[g_active_unit].texture;
    if (!img) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (name == 0) {
        raise_client_error(GL_INVALID_OPERATION);
        _wpk_egl_image_release(img);
        return;
    }
    GLuint source = _wpk_egl_image_texture(img);
    if (!source) {
        raise_client_error(GL_INVALID_OPERATION);
        _wpk_egl_image_release(img);
        return;
    }
    (void)import_image_object(1, g_texture_units[g_active_unit].texture_object, source, img);
    _wpk_egl_image_release(img);
}

/* Renderbuffer siblings retain the same canonical source as texture siblings. */
void glEGLImageTargetRenderbufferStorageOES(GLenum target, GLeglImageOES image) {
    if (!_wpk_gl_current_encoder()) return;
    if (target != GL_RENDERBUFFER) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    struct wpk_egl_image *img = _wpk_egl_image_lookup(image);
    if (!img) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (g_bound_renderbuffer == 0) {
        raise_client_error(GL_INVALID_OPERATION);
        _wpk_egl_image_release(img);
        return;
    }
    GLuint source = _wpk_egl_image_texture(img);
    if (!source) {
        raise_client_error(GL_INVALID_OPERATION);
        _wpk_egl_image_release(img);
        return;
    }
    (void)import_image_object(2, _wpk_gl_current_encoder()->renderbuffer_object, source, img);
    _wpk_egl_image_release(img);
}

void glDrawBuffer(GLenum buf) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_DRAW_BUFFER, 4)
    w_u32(&_c, (uint32_t)buf);
    EMIT_END()
}

void glDrawBuffers(GLsizei n, const GLenum *bufs) {
    if (!_wpk_gl_current_encoder()) return;
    if (n < 0 || n > WPK_GL_NAMES_PER_RECORD) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (n > 0 && !bufs) return;
    EMIT_BEGIN(OP_DRAW_BUFFERS, 4u + (uint32_t)n * 4u)
    w_u32(&_c, (uint32_t)n);
    for (GLsizei i = 0; i < n; i++) w_u32(&_c, (uint32_t)bufs[i]);
    EMIT_END()
}

void glReadBuffer(GLenum src) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_READ_BUFFER, 4)
    w_u32(&_c, (uint32_t)src);
    EMIT_END()
}

void glGenVertexArrays(GLsizei n, GLuint *out) {
    if (!_wpk_gl_current_encoder()) return;
    if (n < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (n <= 0 || !out) return;
    if (g_next_vertex_array == 0 || (uint64_t)(uint32_t)n > (uint64_t)UINT32_MAX-g_next_vertex_array+1) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
    struct wpk_vertex_array *pending = NULL;
    for (GLsizei i=0; i<n; i++) {
        struct wpk_vertex_array *entry = calloc(1,sizeof *entry);
        if (!entry) {
            while (pending) { entry = pending; pending = entry->next; free(entry); }
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        entry->name = g_next_vertex_array+(GLuint)i;
        for (unsigned a=0; a<WPK_GL_MAX_ATTRIBS; a++) { entry->attribs[a].size = 4; entry->attribs[a].type = GL_FLOAT; }
        entry->next = pending; pending = entry;
    }
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    while (pending) {
        struct wpk_vertex_array *entry = pending; pending = entry->next;
        entry->next = state->vertex_arrays; state->vertex_arrays = entry;
    }
    for (GLsizei i=0; i<n; i++) out[i] = g_next_vertex_array++;
    emit_name_array(OP_GEN_VERTEX_ARRAYS, n, out);
}

void glDeleteVertexArrays(GLsizei n, const GLuint *names) {
    if (!_wpk_gl_current_encoder()) return;
    if (n < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (n <= 0 || !names) return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    for (GLsizei i=0; i<n; i++) {
        struct wpk_vertex_array **slot = &state->vertex_arrays;
        while (*slot && (*slot)->name != names[i]) slot = &(*slot)->next;
        if (!*slot) continue;
        struct wpk_vertex_array *entry = *slot;
        if (state->current_vertex_array == entry) state->current_vertex_array = &state->default_vertex_array;
        *slot = entry->next;
        release_vertex_array_objects(state, entry);
        free(entry);
    }
    emit_name_array(OP_DELETE_VERTEX_ARRAYS, n, names);
}

void glBindVertexArray(GLuint array) {
    if (!_wpk_gl_current_encoder()) return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    struct wpk_vertex_array *entry = array ? state->vertex_arrays : &state->default_vertex_array;
    while (entry && entry->name != array) entry = entry->next;
    if (!entry) { raise_client_error(GL_INVALID_OPERATION); return; }
    state->current_vertex_array = entry;
    EMIT_BEGIN(OP_BIND_VERTEX_ARRAY, 4)
    w_u32(&_c, array);
    EMIT_END()
}

/* A single renderer read supplies both width and values. C reflection order,
 * name truncation and another shared context's relink cannot stale a cache. */
static void get_uniform_values(GLuint program, GLint location, int integer, void *params) {
    if (!params)
        return;
    const uint32_t input[3] = {program, (uint32_t)location, (uint32_t)integer};
    uint8_t reply[76];
    if (!checked_query_reply(QOP_GET_UNIFORM_VALUES, input, sizeof input, reply, 68))
        return;
    uint32_t count;
    memcpy(&count, reply + 4, 4);
    if (count != 1 && count != 2 && count != 3 && count != 4 && count != 9 && count != 16) {
        raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    memcpy(params, reply + 8, count * 4);
}
void glGetUniformfv(GLuint program, GLint location, GLfloat *params) {
    if (!_wpk_gl_current_encoder()) return;
    get_uniform_values(program, location, 0, params);
}
void glGetUniformiv(GLuint program, GLint location, GLint *params) {
    if (!_wpk_gl_current_encoder()) return;
    get_uniform_values(program, location, 1, params);
}

void glFlush(void) {
    if (!_wpk_gl_current_encoder()) return;
    if (_wpk_gl_server_flush_checked() != 0) raise_client_error(GL_INVALID_OPERATION);
}

void glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices) {
    if (!_wpk_gl_current_encoder()) return;
    if (mode > GL_TRIANGLE_FAN || (type != GL_UNSIGNED_BYTE && type != GL_UNSIGNED_SHORT)) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    if (count < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (count <= 0) return;
    GLuint staged[WPK_GL_MAX_ATTRIBS];
    GLuint app_element_buffer = g_element_buffer;
    GLuint element = 0;
    uint32_t offset = (uint32_t)(uintptr_t)indices;
    int has_client = 0;
    for (unsigned i = 0; i < WPK_GL_MAX_ATTRIBS; i++)
        if (g_attribs[i].enabled && g_attribs[i].client) has_client = 1;
    uint32_t max_index = 0;
    uint8_t *used = NULL, *index_reply = NULL;
    if (has_client && app_element_buffer != 0) {
        index_reply = malloc(WPK_GL_INDEX_REPLY_LEN);
        if (!index_reply) {
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        uint32_t input[3] = {type,(uint32_t)(uintptr_t)indices,(uint32_t)count};
        const int rc = _wpk_gl_query_into(QOP_GET_INDEX_USAGE,input,sizeof input,index_reply,WPK_GL_INDEX_REPLY_LEN);
        if (rc != 0) {
            if (rc != WPK_GL_QUERY_NOT_DISPATCHED) raise_client_error(GL_INVALID_OPERATION);
            free(index_reply); return;
        }
        uint32_t status, footer; memcpy(&status,index_reply,4); memcpy(&max_index,index_reply+4,4); memcpy(&footer,index_reply+WPK_GL_INDEX_REPLY_LEN-4,4);
        used = index_reply+8;
        if (footer == WPK_GL_QUERY_REPLY_MAGIC && status == 1) { free(index_reply); return; }
        if (footer != WPK_GL_QUERY_REPLY_MAGIC || status > 1 || max_index > (type == GL_UNSIGNED_BYTE ? 255u : 65535u)
            || !(used[max_index>>3] & (1u << (max_index&7)))) {
            raise_client_error(GL_INVALID_OPERATION);
            free(index_reply); return;
        }
    }
    if (app_element_buffer == 0) {
        if (!indices) { raise_client_error(GL_INVALID_VALUE); return; }
        uint32_t index_size = type == GL_UNSIGNED_BYTE ? 1u : type == GL_UNSIGNED_SHORT ? 2u : 0u;
        if (!index_size) { raise_client_error(GL_INVALID_ENUM); return; }
        if ((uint64_t)(uint32_t)count*index_size > INT32_MAX) {
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        for (GLsizei i = 0; i < count; i++) {
            uint16_t value = 0;
            if (index_size == 1) value = ((const uint8_t *)indices)[i];
            else memcpy(&value, (const uint8_t *)indices + (size_t)i * 2, 2);
            if (value > max_index) max_index = value;
        }
        if (has_client) {
            used = calloc(((size_t)max_index+8)/8,1);
            if (!used) {
                raise_client_error(GL_OUT_OF_MEMORY);
                return;
            }
            for (GLsizei i=0; i<count; i++) {
                uint16_t value = 0;
                if (index_size == 1) value = ((const uint8_t *)indices)[i];
                else memcpy(&value,(const uint8_t *)indices+(size_t)i*2,2);
                used[value>>3] |= (uint8_t)(1u << (value&7));
            }
        }
        glGenBuffers(1, &element);
        if (!element) goto done;
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, element);
        if (g_element_buffer != element) goto done;
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)((size_t)count * index_size), indices, GL_STREAM_DRAW);
        offset = 0;
    }
    int n = has_client ? stage_client_attribs(0, (GLsizei)(max_index + 1), staged,used) : 0;
    if (n >= 0) {
        {
            EMIT_BEGIN(OP_DRAW_ELEMENTS, 16)
            w_u32(&_c, (uint32_t)mode); w_i32(&_c, count);
            w_u32(&_c, (uint32_t)type); w_u32(&_c, offset);
            EMIT_END()
        }
        if (n > 0) glDeleteBuffers(n, staged);
    }
done:
    if (index_reply) free(index_reply); else free(used);
    if (element) {
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, app_element_buffer);
        glDeleteBuffers(1, &element);
    }
}


/* Op-table v3 queries preserve outputs on failure. Public client array
 * queries use the original VAO definition, never private staging buffers. */
static int checked_query_reply(uint32_t op, const void *input, uint32_t input_len,
                               uint8_t *reply, uint32_t payload) {
    const int rc = _wpk_gl_query_into(op,input,input_len,reply,payload+8);
    if (rc == WPK_GL_QUERY_NOT_DISPATCHED) return 0;
    if (rc != 0) goto invalid;
    uint32_t status, footer;
    memcpy(&status,reply,4); memcpy(&footer,reply+payload+4,4);
    if (status > 1 || footer != WPK_GL_QUERY_REPLY_MAGIC) goto invalid;
    return status == 0;
invalid:
    raise_client_error(GL_INVALID_OPERATION); return 0;
}
static int checked_client_query(uint32_t op, const void *in, uint32_t len, void *out, uint32_t cap) {
    uint8_t reply[24];
    if (cap > 16) { raise_client_error(GL_INVALID_OPERATION); return 0; }
    if (!checked_query_reply(op,in,len,reply,cap)) return 0;
    memcpy(out,reply+4,cap); return 1;
}
void glGetBufferParameteriv(GLenum target, GLenum pname, GLint *params) {
    if (!_wpk_gl_current_encoder()) return;
    if (!params) return;
    if ((target != GL_ARRAY_BUFFER && target != GL_ELEMENT_ARRAY_BUFFER) || (pname != GL_BUFFER_SIZE && pname != GL_BUFFER_USAGE)) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    uint32_t input[2] = {target,pname}; GLint value;
    if (checked_client_query(QOP_GET_BUFFER_PARAMETER,input,sizeof input,&value,sizeof value)) *params = value;
}
static int client_vertex_scalar(GLuint index, GLenum pname, GLuint *value) {
    if (index >= WPK_GL_MAX_ATTRIBS) {
        raise_client_error(GL_INVALID_VALUE); return 0;
    }
    struct wpk_client_attrib *a = &g_attribs[index];
    switch (pname) {
        case GL_VERTEX_ATTRIB_ARRAY_ENABLED: *value = a->enabled != 0; return 1;
        case GL_VERTEX_ATTRIB_ARRAY_SIZE: *value = (GLuint)a->size; return 1;
        case GL_VERTEX_ATTRIB_ARRAY_STRIDE: *value = (GLuint)a->stride; return 1;
        case GL_VERTEX_ATTRIB_ARRAY_TYPE: *value = a->type; return 1;
        case GL_VERTEX_ATTRIB_ARRAY_NORMALIZED: *value = a->normalized != 0; return 1;
        case GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: *value = a->buffer_name; return 1;
        default: raise_client_error(GL_INVALID_ENUM); return 0;
    }
}
void glGetVertexAttribiv(GLuint index, GLenum pname, GLint *params) {
    if (!_wpk_gl_current_encoder()) return;
    if (!params) return;
    if (pname == GL_CURRENT_VERTEX_ATTRIB && index < WPK_GL_MAX_ATTRIBS) {
        uint32_t input[2] = {index,pname}; GLint value[4];
        if (checked_client_query(QOP_GET_VERTEX_ATTRIBIV,input,sizeof input,value,sizeof value)) memcpy(params,value,sizeof value);
    } else { GLuint value; if (client_vertex_scalar(index,pname,&value)) *params = (GLint)value; }
}
void glGetVertexAttribfv(GLuint index, GLenum pname, GLfloat *params) {
    if (!_wpk_gl_current_encoder()) return;
    if (!params) return;
    if (pname == GL_CURRENT_VERTEX_ATTRIB && index < WPK_GL_MAX_ATTRIBS) {
        uint32_t input[2] = {index,pname}; GLfloat value[4];
        if (checked_client_query(QOP_GET_VERTEX_ATTRIBFV,input,sizeof input,value,sizeof value)) memcpy(params,value,sizeof value);
    } else { GLuint value; if (client_vertex_scalar(index,pname,&value)) *params = (GLfloat)value; }
}
void glGetVertexAttribPointerv(GLuint index, GLenum pname, void **pointer) {
    if (!_wpk_gl_current_encoder()) return;
    if (!pointer) return;
    if (index >= WPK_GL_MAX_ATTRIBS) {
        raise_client_error(GL_INVALID_VALUE); return;
    }
    if (pname != GL_VERTEX_ATTRIB_ARRAY_POINTER) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    *pointer = (void *)g_attribs[index].pointer;
}
static GLboolean client_is_object(uint32_t kind, GLuint name) {
    struct wpk_gl_name_scope name_scope __attribute__((cleanup(_wpk_gl_end_name_scope))) =
        _wpk_gl_begin_name_scope(_wpk_gl_current_encoder());
    if (!name_scope.group)
        return GL_FALSE;
    uint32_t input[2] = {kind,name}, value = 0;
    if (!checked_client_query(QOP_IS_OBJECT,input,sizeof input,&value,sizeof value)) return GL_FALSE;
    return value ? GL_TRUE : GL_FALSE;
}
GLboolean glIsBuffer(GLuint name) { if (!_wpk_gl_current_encoder()) return GL_FALSE; return client_is_object(0,name); }
GLboolean glIsTexture(GLuint name) {
    if (!_wpk_gl_current_encoder())
        return GL_FALSE;
    return client_is_object(1, name);
}
GLboolean glIsRenderbuffer(GLuint name) {
    if (!_wpk_gl_current_encoder())
        return GL_FALSE;
    return client_is_object(2,name);
}
GLboolean glIsFramebuffer(GLuint name) { if (!_wpk_gl_current_encoder()) return GL_FALSE; return client_is_object(3,name); }
GLboolean glIsShader(GLuint name) { if (!_wpk_gl_current_encoder()) return GL_FALSE; return client_is_object(4,name); }
GLboolean glIsProgram(GLuint name) { if (!_wpk_gl_current_encoder()) return GL_FALSE; return client_is_object(5,name); }
GLboolean glIsEnabled(GLenum cap) {
    if (!_wpk_gl_current_encoder()) return GL_FALSE;
    switch (cap) {
        case GL_BLEND: case GL_CULL_FACE: case GL_DEPTH_TEST: case GL_DITHER: case GL_POLYGON_OFFSET_FILL:
        case GL_SAMPLE_ALPHA_TO_COVERAGE: case GL_SAMPLE_COVERAGE: case GL_SCISSOR_TEST: case GL_STENCIL_TEST: break;
        default: raise_client_error(GL_INVALID_ENUM); return GL_FALSE;
    }
    uint32_t value = 0, input = cap;
    if (!checked_client_query(QOP_IS_ENABLED,&input,sizeof input,&value,sizeof value)) return GL_FALSE;
    return value ? GL_TRUE : GL_FALSE;
}

/* The v4 string/list queries fetch metadata first, then bounded chunks.
 * Accumulate privately so later allocation/device failure leaves every
 * public output unchanged instead of exposing a partial successful query. */
static int query_object_blob(uint32_t op, uint32_t *input, uint32_t words,
                             uint32_t header_size, uint32_t unit, uint32_t limit,
                             uint8_t **bytes, uint32_t *count, uint32_t header[3]) {
    uint8_t meta[20];
    input[words-2] = input[words-1] = 0;
    if (!checked_query_reply(op,input,words*4,meta,header_size)) return 0;
    memcpy(header,meta+4,header_size);
    uint32_t total = header[0], wanted = total < limit ? total : limit;
    if (wanted > (SIZE_MAX-1)/unit) { raise_client_error(GL_OUT_OF_MEMORY); return 0; }
    *bytes = NULL; *count = 0;
    if (!wanted) return 1;
    uint32_t per_chunk = (65536u-8-header_size)/unit;
    uint32_t chunk = wanted < per_chunk ? wanted : per_chunk;
    uint8_t *result = malloc((size_t)wanted*unit), *reply = malloc(header_size+chunk*unit+8);
    if (!result || !reply) { free(result); free(reply); raise_client_error(GL_OUT_OF_MEMORY); return 0; }
    for (uint32_t offset=0; offset<wanted;) {
        uint32_t n = wanted-offset < chunk ? wanted-offset : chunk;
        input[words-2] = offset; input[words-1] = n;
        if (!checked_query_reply(op,input,words*4,reply,header_size+n*unit)) goto failed;
        if (memcmp(reply+4,header,header_size)) { raise_client_error(GL_INVALID_OPERATION); goto failed; }
        memcpy(result+(size_t)offset*unit,reply+4+header_size,(size_t)n*unit);
        offset += n;
    }
    free(reply); *bytes = result; *count = wanted; return 1;
failed:
    free(reply); free(result); return 0;
}
void glGetShaderSource(GLuint shader, GLsizei bufSize, GLsizei *length, GLchar *source) {
    if (!_wpk_gl_current_encoder()) return;
    if (bufSize < 0) { raise_client_error(GL_INVALID_VALUE); return; }
    uint32_t input[3] = {shader,0,0}, count, header[3]; uint8_t *bytes;
    uint32_t limit = source && bufSize > 0 ? (uint32_t)bufSize-1 : 0;
    if (!query_object_blob(QOP_GET_SHADER_SOURCE,input,3,4,1,limit,&bytes,&count,header)) return;
    if (source && bufSize > 0) { if (count) memcpy(source,bytes,count); source[count] = '\0'; }
    if (length) *length = (GLsizei)count;
    free(bytes);
}
void glGetActiveAttrib(GLuint program, GLuint index, GLsizei bufSize,
                       GLsizei *length, GLint *size, GLenum *type, GLchar *name) {
    if (!_wpk_gl_current_encoder()) return;
    if (bufSize < 0) { raise_client_error(GL_INVALID_VALUE); return; }
    uint32_t input[4] = {program,index,0,0}, count, header[3]; uint8_t *bytes;
    uint32_t limit = name && bufSize > 0 ? (uint32_t)bufSize-1 : 0;
    if (!query_object_blob(QOP_GET_ACTIVE_ATTRIB,input,4,12,1,limit,&bytes,&count,header)) return;
    if (name && bufSize > 0) { if (count) memcpy(name,bytes,count); name[count] = '\0'; }
    if (length) *length = (GLsizei)count;
    if (size) *size = (GLint)header[1];
    if (type) *type = (GLenum)header[2];
    free(bytes);
}
void glGetActiveUniform(GLuint program, GLuint index, GLsizei bufSize, GLsizei *length, GLint *size,
                        GLenum *type, GLchar *name) {
    if (!_wpk_gl_current_encoder())
        return;
    if (bufSize < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    uint32_t input[4] = {program, index, 0, 0}, count, header[3];
    uint8_t *bytes;
    uint32_t limit = name && bufSize > 0 ? (uint32_t)bufSize - 1 : 0;
    if (!query_object_blob(QOP_GET_ACTIVE_UNIFORM_INFO, input, 4, 12, 1, limit, &bytes, &count,
                           header))
        return;
    if (name && bufSize > 0) {
        if (count)
            memcpy(name, bytes, count);
        name[count] = '\0';
    }
    if (length)
        *length = (GLsizei)count;
    if (size)
        *size = (GLint)header[1];
    if (type)
        *type = (GLenum)header[2];
    free(bytes);
}
void glGetAttachedShaders(GLuint program, GLsizei maxCount, GLsizei *count, GLuint *shaders) {
    if (!_wpk_gl_current_encoder()) return;
    if (maxCount < 0) { raise_client_error(GL_INVALID_VALUE); return; }
    uint32_t input[3] = {program,0,0}, written, header[3]; uint8_t *bytes;
    if (!query_object_blob(QOP_GET_ATTACHED_SHADERS,input,3,4,4,shaders ? (uint32_t)maxCount : 0,&bytes,&written,header)) return;
    if (written) memcpy(shaders,bytes,(size_t)written*4);
    if (count) *count = (GLsizei)written;
    free(bytes);
}
void glValidateProgram(GLuint program) {
    if (!_wpk_gl_current_encoder()) return;
    EMIT_BEGIN(OP_VALIDATE_PROGRAM,4) w_u32(&_c,program); EMIT_END()
}
void glGetTexParameteriv(GLenum target, GLenum pname, GLint *params) {
    if (!_wpk_gl_current_encoder()) return;
    if (!params) return;
    uint32_t input[2] = {target,pname}; GLint value;
    if (checked_client_query(QOP_GET_TEX_PARAMETER,input,sizeof input,&value,4)) *params = value;
}
void glGetTexParameterfv(GLenum target, GLenum pname, GLfloat *params) {
    if (!_wpk_gl_current_encoder()) return;
    if (!params) return;
    uint32_t input[2] = {target,pname}; GLint value;
    if (checked_client_query(QOP_GET_TEX_PARAMETER,input,sizeof input,&value,4)) *params = (GLfloat)value;
}
void glGetRenderbufferParameteriv(GLenum target, GLenum pname, GLint *params) {
    if (!_wpk_gl_current_encoder()) return;
    if (!params) return;
    if (target != GL_RENDERBUFFER) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    uint32_t input[2] = {target,pname}; GLint value;
    if (checked_client_query(QOP_GET_RENDERBUFFER_PARAMETER,input,sizeof input,&value,4)) *params = value;
}
void glGetFramebufferAttachmentParameteriv(GLenum target, GLenum attachment, GLenum pname, GLint *params) {
    if (!_wpk_gl_current_encoder()) return;
    if (!params) return;
    uint32_t input[2] = {target,attachment}, info[4];
    if (!checked_client_query(QOP_GET_FB_ATTACHMENT, input, sizeof input, info, sizeof info))
        return;
    switch (pname) {
        case GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: *params = (GLint)info[0]; return;
        case GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME:
            if (info[0] != GL_NONE) { *params = (GLint)info[1]; return; } break;
        case GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL:
            if (info[0] == GL_TEXTURE) { *params = (GLint)info[2]; return; } break;
        case GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE:
            if (info[0] == GL_TEXTURE) { *params = (GLint)info[3]; return; } break;
    }
    raise_client_error(GL_INVALID_ENUM);
}
