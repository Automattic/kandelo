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
#include <stdatomic.h>
#include <stddef.h>
#include <limits.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>

#include "gl_abi.h"

/* WebGL 2, the API behind every Kandelo renderer, guarantees at least 16
 * vertex attributes. Those slots live inline in each VAO; higher indices
 * grow it to the context's actual MAX_VERTEX_ATTRIBS (ES 2.0 table 6.18). */
#define WPK_GL_INITIAL_ATTRIBS 16u
#define WPK_GL_INITIAL_TEXTURE_UNITS 32
#define WPK_GL_INITIAL_FRAMEBUFFER_NAMES 16

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
/* Public name references are distinct from immutable native executable pins.
 * This first layer owns C metadata for current contexts and attachments only;
 * program selection remains acknowledged by the independent host oracle. */
struct wpk_program_record {
    GLuint name;
    uint32_t kind, references;
    GLenum shader_type;
    int delete_pending, link_known, linked;
    uint64_t link_epoch;
    struct wpk_program_record *shaders[2], *next;
};
struct wpk_program_stream;
struct wpk_program_intent;
struct wpk_object_group {
    pthread_mutex_t mutex, dispatch_mutex;
    /* Guarded by the recursive dispatch mutex, never read before acquisition.
     * Only the outer operation reconciles shared unpublished candidates. */
    unsigned dispatch_depth;
    unsigned references;
    GLuint next_name[WPK_NAMES_COUNT];
    uint64_t next_serial;
    struct wpk_object_name *names, *retired_objects;
    struct wpk_program_record *program_records;
    _Atomic int program_records_known;
    /* Foreign publishers see only committed immutable intent cells, never
     * another encoder's cursor or command bytes. Dispatch owns the list. */
    struct wpk_program_stream *program_streams;
    struct wpk_program_intent *program_head, *program_tail;
    /* Reserve uncertain publication custody before entry, across every outer
     * context. Another publisher must reconcile it rather than replay rows. */
    struct wpk_program_stream *program_publication_caller;
    uint32_t program_publication_transaction, program_publication_count;
    uint64_t program_sequence;
    _Atomic int program_intents_pending;
    _Atomic uint64_t program_owner_epoch;
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
    // Ownership must predate every dispatch lock, including before journal
    // admission or the first error drain. A child cannot inherit that lock.
    if (!_wpk_gl_device_requests_fork_safe()) {errno=ENOMEM;return NULL;}
    struct wpk_object_group *group = calloc(1, sizeof *group);
    if (!group)
        return NULL;
    if (pthread_mutex_init(&group->mutex, NULL) != 0) {
        free(group);
        return NULL;
    }
    pthread_mutexattr_t dispatch_attributes;
    if (pthread_mutexattr_init(&dispatch_attributes) != 0) {
        pthread_mutex_destroy(&group->mutex);
        free(group);
        return NULL;
    }
    int dispatch_error = pthread_mutexattr_settype(&dispatch_attributes, PTHREAD_MUTEX_RECURSIVE);
    if (!dispatch_error)
        dispatch_error = pthread_mutex_init(&group->dispatch_mutex, &dispatch_attributes);
    pthread_mutexattr_destroy(&dispatch_attributes);
    if (dispatch_error) {
        pthread_mutex_destroy(&group->mutex);
        free(group);
        return NULL;
    }
    group->references = 1;
    group->program_records_known = 1;
    atomic_store_explicit(&group->program_owner_epoch,_wpk_gl_device_owner_epoch(),memory_order_relaxed);
    group->next_serial = 1;
    for (unsigned i = 0; i < WPK_NAMES_COUNT; i++)
        group->next_name[i] = 1;
    return group;
}
static int object_group_retain(struct wpk_object_group *group) {
    uint64_t owner=atomic_load_explicit(&group->program_owner_epoch,memory_order_relaxed);
    if (!owner || owner!=_wpk_gl_device_owner_epoch()) {errno=EACCES;return 0;}
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
    while (group->program_records) {
        struct wpk_program_record *record = group->program_records;
        group->program_records = record->next;
        free(record);
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
    int host_row_known;
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
    struct wpk_client_attrib initial_attribs[WPK_GL_INITIAL_ATTRIBS];
    struct wpk_client_attrib *attribs;
    uint32_t attrib_count;
    struct wpk_vertex_array *next;
};
struct wpk_image_attachment {
    GLuint framebuffer, point;
    struct wpk_object_name *object;
    struct wpk_image_attachment *next;
};
/* A unit's TEXTURE_2D, TEXTURE_CUBE_MAP and (OES_EGL_image_external)
 * TEXTURE_EXTERNAL_OES bindings. */
struct wpk_texture_unit {
    GLuint texture, cube, external;
    struct wpk_object_name *texture_object, *cube_object, *external_object;
};
struct wpk_array_capture {
    struct wpk_object_name *object;
    GLuint name;
    uint64_t serial;
    int active;
};

/* Handles own native executable storage, never public names. Only admitted
 * journals acquire these cold pins. Unknown publication stays in the host
 * context's retirement index; acquisition stops until that context retires. */
struct wpk_program_capture {
    GLuint name;
    uint32_t handle;
    uint64_t link_epoch;
};
#define WPK_PROGRAM_SLOTS 256u
#define WPK_PROGRAM_CACHE 32u
#define WPK_PROGRAM_BLOCKED_RECEIPT 1
#define WPK_PROGRAM_BLOCKED_EXECUTION 2
#define WPK_PROGRAM_COUNTER_MAX UINT64_C(9007199254740991)
struct wpk_program_generation {
    GLuint name;
    uint64_t link_epoch;
    uint32_t token, capture;
};
struct wpk_program_intent {
    struct wpk_program_stream *owner;
    struct wpk_program_intent *next;
    uint64_t ticket, sequence;
    uint32_t index, name, token, phase;
};
/* Cold-reserved metadata has no pointer to mutable encoder storage. It owns
 * both the output receiver and every cell before local acceptance. */
struct wpk_program_stream {
    struct wpk_program_stream *next;
    int fd, active, blocked;
    uint32_t id, transaction, cache_cursor;
    uint64_t ticket;
    struct wpk_program_generation generations[WPK_PROGRAM_CACHE];
    struct wpk_program_intent slots[WPK_PROGRAM_SLOTS];
    uint32_t request[3+8*WPK_PROGRAM_SLOTS], reply[12], recovery[12], read_request[2];
};

/* Client execution state belongs to the EGL context and follows it across
 * thread transfers. Shared object groups are a separate ownership layer. */
struct wpk_gles_context {
    struct wpk_object_group *objects;
    struct wpk_array_capture array_capture;
    struct wpk_program_record *current_program;
    struct wpk_program_stream *program_stream;
    int program_captures_uncertain;
    /* Embedded owned transport storage: publication/cleanup never allocates C
     * reply metadata after a program mutation was acknowledged. */
    uint32_t program_capture_request[3], program_capture_reply[4];
    struct gl_submit_query_info program_capture_packet;
    uint8_t *cursor;
    /* Client upload layout is gathered into command records exactly once. */
    GLint unpack_alignment;
    GLint unpack_row_length;
    GLint unpack_skip_pixels;
    GLint unpack_skip_rows;
    GLint pack_alignment;
    /* Unacknowledged flags transfer into the same host context error owner. */
    uint32_t client_errors;
    /* glGetError's drain request and reply (shared::gl::error_drain) live in
     * the context, so reporting OUT_OF_MEMORY never allocates. */
    uint32_t error_request[WPK_GL_ERROR_DRAIN_REQUEST_BYTES / 4];
    uint32_t error_drain[WPK_GL_ERROR_DRAIN_REPLY_BYTES / 4];
    struct gl_submit_query_info error_packet;
    /* Flags a drain moved out of the host context, oldest first, not yet
     * returned. Together with client_errors and the host's flags they are
     * the context's error state (ES 2.0 section 2.5). */
    GLenum held_errors[WPK_GL_ERROR_DRAIN_CAPACITY];
    uint32_t held_error_count;
    /* The host held no flags after the last drain. Its request epoch and
     * the end of the exactly validated prefix prove that queued commands
     * cannot have added a flag. Unknown commands leave the prefix behind;
     * any device request invalidates the epoch. */
    int errors_known;
    uint64_t errors_known_at;
    uint8_t *errors_known_cursor;
    /* Flags the host oracle will independently record for exact commands.
     * These are separate from client-only guards that encode no command. */
    uint32_t predicted_errors;
    GLenum generate_mipmap_hint, fragment_derivative_hint;
    uint32_t next_compressed_upload;
    uint32_t next_shader_upload;
    uint32_t next_uniform_lookup;
    uint32_t next_uniform_upload;
    uint32_t next_readback_capture;
    uint32_t next_object_capture;
    GLuint array_buffer;
    /* An indeterminate mutation can change the host binding without a C
     * publication. Draining error flags cannot restore this separate proof. */
    int array_binding_known;
    int default_vertex_array_only;
    /* Never rearm after selecting a user FBO or losing an ordered prefix. */
    int default_framebuffer_only;
    uint64_t array_serial;
    struct wpk_object_name *array_object;
    struct wpk_vertex_array default_vertex_array, *current_vertex_array, *vertex_arrays;
    /* Framebuffers are per-context container objects, so their names never
     * join the shared object group. This sorted set holds every name in use:
     * returned by glGenFramebuffers or created by binding an unused name. */
    uint32_t next_framebuffer;
    GLuint initial_framebuffer_names[WPK_GL_INITIAL_FRAMEBUFFER_NAMES];
    GLuint *framebuffer_names;
    size_t framebuffer_name_count, framebuffer_name_capacity;
    GLuint active_unit;
    struct wpk_texture_unit initial_texture_units[WPK_GL_INITIAL_TEXTURE_UNITS];
    struct wpk_texture_unit *texture_units;
    uint32_t texture_unit_count, texture_unit_limit;
    GLuint bound_renderbuffer;
    struct wpk_object_name *renderbuffer_object;
    struct wpk_image_attachment *image_attachments;
    uint32_t next_vertex_array;
    /* MAX_VERTEX_ATTRIBS, queried once on the first index past the inline
     * slots; zero until then. */
    uint32_t vertex_attrib_limit;
    char version[256];
    char glsl_version[256];
    char vendor[256];
    char renderer[256];
    char extensions[4096];
};
int _wpk_gl_encoder_owned(struct wpk_gles_context *state) {
    if (!state) return 0;
    uint64_t owner=atomic_load_explicit(&state->objects->program_owner_epoch,memory_order_relaxed);
    return owner && owner==_wpk_gl_device_owner_epoch();
}

#define g_cursor (_wpk_gl_current_encoder()->cursor)
#define g_unpack_alignment (_wpk_gl_current_encoder()->unpack_alignment)
#define g_unpack_row_length (_wpk_gl_current_encoder()->unpack_row_length)
#define g_unpack_skip_pixels (_wpk_gl_current_encoder()->unpack_skip_pixels)
#define g_unpack_skip_rows (_wpk_gl_current_encoder()->unpack_skip_rows)
#define g_pack_alignment (_wpk_gl_current_encoder()->pack_alignment)
#define g_array_buffer (_wpk_gl_current_encoder()->array_buffer)
#define g_element_buffer (_wpk_gl_current_encoder()->current_vertex_array->element_buffer)
#define g_attribs (_wpk_gl_current_encoder()->current_vertex_array->attribs)
#define g_active_unit (_wpk_gl_current_encoder()->active_unit)
#define g_texture_units (_wpk_gl_current_encoder()->texture_units)
#define g_bound_renderbuffer (_wpk_gl_current_encoder()->bound_renderbuffer)
#define g_image_attachments (_wpk_gl_current_encoder()->image_attachments)
#define g_next_vertex_array (_wpk_gl_current_encoder()->next_vertex_array)

static int checked_mutation_query(uint32_t op, const uint32_t *words, uint32_t count);
static GLuint checked_shader_program_creation(uint32_t kind, GLenum type, GLuint name);
static GLuint create_program_record(uint32_t kind, GLenum type);
static void mutate_program_record(uint32_t op, GLuint name, GLuint shader);
static int checked_client_query(uint32_t op, const void *in, uint32_t len, void *out, uint32_t cap);
static void raise_client_error(GLenum error);
static int publish_program_intents(struct wpk_object_group *group);
static int program_submission_scope(struct wpk_gles_context *, struct wpk_gl_name_scope *);
static void complete_program_submission(struct wpk_gles_context *, int);
static int disable_program_stream(struct wpk_gles_context *);
static int try_program_stream_use(struct wpk_gles_context *, GLuint);
static struct wpk_gl_name_scope begin_dispatch_scope(struct wpk_gles_context *state) {
    struct wpk_gl_name_scope scope = {.group = state->objects};
    uint64_t owner=atomic_load_explicit(&scope.group->program_owner_epoch,memory_order_relaxed);
    if (!owner || owner!=_wpk_gl_device_owner_epoch()) {
        // Refuse before touching a mutex a vanished parent thread may own.
        scope.group=NULL;errno=EACCES;raise_client_error(GL_INVALID_OPERATION);return scope;
    }
    // Do not abandon native publication on cancellation; restore after unlock.
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &scope.cancel_state);
    /* WHY: publication barriers on queries and submits must compose with a
     * surrounding shared-name/lifecycle operation. Recursion permits only this
     * thread's nesting; the outer scope still excludes every peer through C
     * publication and keeps asynchronous cancellation disabled until unlock. */
    if (pthread_mutex_lock(&scope.group->dispatch_mutex) != 0)
        abort();
    if (scope.group->dispatch_depth == UINT_MAX)
        abort();
    scope.group->dispatch_depth++;
    return scope;
}
struct wpk_gl_name_scope _wpk_gl_begin_name_scope(struct wpk_gles_context *state) {
    struct wpk_gl_name_scope scope = begin_dispatch_scope(state);
    if (!scope.group) return scope;
    if (!publish_program_intents(scope.group)) {
        _wpk_gl_end_name_scope(&scope);return scope;
    }
    if (scope.group->dispatch_depth == 1 && scope.group->pending_external_texture &&
        !_wpk_gl_discard_external_candidate(scope.group->pending_external_texture)) {
        _wpk_gl_end_name_scope(&scope);
    }
    return scope;
}
void _wpk_gl_end_name_scope(struct wpk_gl_name_scope *scope) {
    if (!scope->group)
        return;
    struct wpk_object_group *group = scope->group;
    scope->group = NULL;
    if (!group->dispatch_depth)
        abort();
    group->dispatch_depth--;
    if (pthread_mutex_unlock(&group->dispatch_mutex) != 0)
        abort();
    pthread_setcancelstate(scope->cancel_state, NULL);
}

/* Initial attribute state (ES 2.0 table 6.2): disabled, four FLOAT
 * components. Only the default VAO can name client memory. */
static void init_vertex_attribs(struct wpk_vertex_array *vao, uint32_t first, uint32_t count) {
    for (uint32_t i = first; i < count; i++) {
        vao->attribs[i] = (struct wpk_client_attrib){.size = 4, .type = GL_FLOAT,
                                                     .client = vao->name == 0};
    }
}
static void init_vertex_array(struct wpk_vertex_array *vao) {
    vao->attribs = vao->initial_attribs;
    vao->attrib_count = WPK_GL_INITIAL_ATTRIBS;
    init_vertex_attribs(vao, 0, WPK_GL_INITIAL_ATTRIBS);
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
    state->framebuffer_names = state->initial_framebuffer_names;
    state->framebuffer_name_capacity = WPK_GL_INITIAL_FRAMEBUFFER_NAMES;
    state->unpack_alignment = 4;
    state->pack_alignment = 4;
    state->generate_mipmap_hint = state->fragment_derivative_hint = GL_DONT_CARE;
    state->next_framebuffer = state->next_vertex_array = 1;
    state->current_vertex_array = &state->default_vertex_array;
    state->array_binding_known = 1; /* The initial binding is zero. */
    state->default_vertex_array_only = 1;
    state->default_framebuffer_only = 1;
    init_vertex_array(&state->default_vertex_array);
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

/* Every device reply passes through here. ENODEV is the host's report that
 * the current context's renderer was lost (a graphics reset); libEGL keeps
 * that state, so the reset status needs no request of its own. */
/* Queued attribute creation may not have executed after a lost prefix.
 * Error flags and later array binds cannot repair those separate slots. */
static void invalidate_binding_knowledge(struct wpk_gles_context *state) {
    state->array_binding_known = 0;
    atomic_store_explicit(&state->objects->program_records_known, 0, memory_order_relaxed);
    state->default_framebuffer_only = 0;
    for (uint32_t i=0; i<state->default_vertex_array.attrib_count; i++)
        state->default_vertex_array.attribs[i].host_row_known = 0;
}

static int gl_device_ioctl(int fd, unsigned long request, void *arg) {
    _wpk_gl_note_device_request(); /* Voids local glGetError knowledge. */
    int rc = ioctl(fd, request, arg);
    if (rc != 0) {
        struct wpk_gles_context *state = _wpk_gl_current_encoder();
        if (state) invalidate_binding_knowledge(state);
        if (errno == ENODEV) _wpk_gl_note_reset();
    }
    return rc;
}

static void raise_client_error(GLenum error);
static void record_client_error(struct wpk_gles_context *state, GLenum error);
static int hold_error(struct wpk_gles_context *state, GLenum error);
static void finish_command_submission(struct wpk_gles_context *state,
                                      uint8_t *base, uint32_t errors, int rc) {
    complete_program_submission(state,rc);
    g_cursor = base;
    if (rc == 0) state->client_errors &= ~errors;
    /* A reset context reports CONTEXT_LOST instead and never submits again. */
    else if (!_wpk_gl_context_reset()) {
        invalidate_binding_knowledge(state);
        record_client_error(state, GL_INVALID_OPERATION);
        const uint32_t token = state->next_uniform_upload;
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
}

static int flush_commands(void) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (!state) return 0;
    int fd = _wpk_gl_fd();
    uint8_t *base = _wpk_gl_cmdbuf_base();
    if (fd < 0 || base == NULL) return 0;
    if (!g_cursor) g_cursor = base;
    /* Commands recorded before a reset was observed have no effect. */
    if (_wpk_gl_context_reset()) { g_cursor = base; return 0; }
    struct wpk_gl_name_scope publication __attribute__((cleanup(_wpk_gl_end_name_scope)))={0};
    if (!program_submission_scope(state,&publication)) return -1;
    if (_wpk_gl_context_reset()) {g_cursor=base;errno=ENODEV;return -1;}
    const uint32_t errors = state->client_errors;
    if (g_cursor == base && !errors) return 0;
    if (errors) {
        /* reserve() leaves this trailer plus a transport-observation header
         * available. Error recording neither allocates nor submits. */
        uint8_t *trailer = g_cursor;
        w_u16(&trailer, OP_CLIENT_ERRORS); w_u16(&trailer, 4); w_u32(&trailer, errors);
        g_cursor = trailer;
    }

    struct gl_submit_info si = { .offset = 0,
                                 .length = (uint32_t)(g_cursor - base) };
    int rc = gl_device_ioctl(fd, GLIO_SUBMIT, &si);
    finish_command_submission(state, base, errors, rc);
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
    return gl_device_ioctl(fd, GLIO_QUERY, &info);
}

/* Reserve `bytes` of cmdbuf space and return a write cursor for the
 * caller to fill. Flushes if the next op would overflow CMDBUF_LEN.
 * Returns NULL when the EGL session hasn't run eglMakeCurrent yet, in
 * which case every op silently no-ops. */
static uint8_t *reserve(size_t bytes) {
    uint8_t *base = _wpk_gl_cmdbuf_base();
    if (base == NULL) return NULL;
    if (g_cursor == NULL) g_cursor = base;
    if (bytes > WPK_GL_CMDBUF_LEN - 12u) return NULL;
    if ((size_t)(g_cursor - base) + bytes > WPK_GL_CMDBUF_LEN - 12u) {
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

static int exact_error_state(struct wpk_gles_context *state) {
    return state->errors_known && (!g_cursor || state->errors_known_cursor == g_cursor) &&
           _wpk_gl_device_requests() == state->errors_known_at;
}

struct wpk_error_proof {
    struct wpk_gles_context *state;
    uint8_t *base;
    uint64_t requests;
    int valid;
};
static struct wpk_error_proof capture_error_proof(void) {
    struct wpk_error_proof proof = {
        .state = _wpk_gl_current_encoder(), .base = _wpk_gl_cmdbuf_base(),
        .requests = _wpk_gl_device_requests(),
    };
    proof.valid = proof.state && !proof.state->client_errors && exact_error_state(proof.state);
    return proof;
}
/* A checked acceptance receipt proves the mutation added no API error.
 * Keep this separate from ordinary successful transport: arbitrary queries,
 * rejected mutations and uncertain completions provide no such evidence. */
static void accept_error_proof(struct wpk_error_proof proof) {
    if (!proof.valid || _wpk_gl_current_encoder() != proof.state ||
        _wpk_gl_cmdbuf_base() != proof.base || _wpk_gl_context_reset() ||
        _wpk_gl_device_requests() != proof.requests + 1 ||
        (g_cursor && g_cursor != proof.base) || proof.state->client_errors)
        return;
    proof.state->errors_known = 1;
    proof.state->errors_known_at = proof.requests + 1;
    proof.state->errors_known_cursor = proof.base;
}

/* Keep original records, including rejected arguments: the host oracle
 * independently validates them before the ordered error observation. */
static void finish_predicted_command(uint8_t *start, uint8_t *end, GLenum error) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    /* WHY: reserve() can submit when the buffer fills. Even if its cursor
     * wraps to the same address, that request revokes the old error proof. */
    if (state->errors_known && state->errors_known_cursor == start &&
        _wpk_gl_device_requests() == state->errors_known_at) {
        state->errors_known_cursor = end;
        if (error) {
            state->predicted_errors |= 1u << (error - GL_INVALID_ENUM);
            if (!hold_error(state,error)) state->errors_known = 0;
        }
    }
    g_cursor = end;
}
#define EMIT_PREDICTED_BEGIN(op_, payload_len_, error_)                  \
    EMIT_BEGIN(op_, payload_len_)                                       \
    uint8_t *_exact_start = _c - 4;                                     \
    const GLenum _predicted_error = (error_);
#define EMIT_PREDICTED_END() finish_predicted_command(_exact_start, _c, _predicted_error);
#define EMIT_INFALLIBLE_BEGIN(op_, payload_len_) EMIT_PREDICTED_BEGIN(op_, payload_len_, GL_NO_ERROR)
#define EMIT_INFALLIBLE_END() EMIT_PREDICTED_END()

/* GLES2 scalar argument rules. Keep these independent of the host's
 * state-validation.ts: the ordered audit must be able to detect disagreement. */
static int scalar_cap(GLenum value) {
    switch (value) {
    case GL_DITHER: case GL_DEPTH_TEST: case GL_STENCIL_TEST: case GL_BLEND:
    case GL_CULL_FACE: case GL_SCISSOR_TEST: case GL_POLYGON_OFFSET_FILL:
    case GL_SAMPLE_ALPHA_TO_COVERAGE: case GL_SAMPLE_COVERAGE: return 1;
    default: return 0;
    }
}
static int scalar_face(GLenum value) {
    return value == GL_FRONT || value == GL_BACK || value == GL_FRONT_AND_BACK;
}
static int scalar_compare(GLenum value) { return value >= GL_NEVER && value <= GL_ALWAYS; }
static int scalar_blend_factor(GLenum value, int source) {
    switch (value) {
    case GL_ZERO: case GL_ONE:
    case GL_SRC_COLOR: case GL_ONE_MINUS_SRC_COLOR:
    case GL_DST_COLOR: case GL_ONE_MINUS_DST_COLOR:
    case GL_SRC_ALPHA: case GL_ONE_MINUS_SRC_ALPHA:
    case GL_DST_ALPHA: case GL_ONE_MINUS_DST_ALPHA:
    case GL_CONSTANT_COLOR: case GL_ONE_MINUS_CONSTANT_COLOR:
    case GL_CONSTANT_ALPHA: case GL_ONE_MINUS_CONSTANT_ALPHA: return 1;
    case GL_SRC_ALPHA_SATURATE: return source;
    default: return 0;
    }
}
static int scalar_blend_equation(GLenum value) {
    return value == GL_FUNC_ADD || value == GL_FUNC_SUBTRACT || value == GL_FUNC_REVERSE_SUBTRACT ||
           value == GL_MIN_EXT || value == GL_MAX_EXT;
}
static int scalar_stencil_op(GLenum value) {
    switch (value) {
    case GL_ZERO: case GL_KEEP: case GL_REPLACE: case GL_INCR: case GL_DECR:
    case GL_INVERT: case GL_INCR_WRAP: case GL_DECR_WRAP: return 1;
    default: return 0;
    }
}

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
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_CLEAR_COLOR, 16)
    w_f32(&_c, r); w_f32(&_c, g); w_f32(&_c, b); w_f32(&_c, a);
    EMIT_INFALLIBLE_END()
}

void glClear(GLbitfield mask) {
    struct wpk_gles_context *state = _wpk_gl_command_encoder();
    if (!state) return;
    if (state->default_framebuffer_only && _wpk_gl_has_draw_surface()) {
        /* No guest attachment or shared namespace can change this target.
         * Keep the original record so the host independently checks it. */
        EMIT_PREDICTED_BEGIN(OP_CLEAR, 4,
            mask & ~(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT)
                ? GL_INVALID_VALUE : GL_NO_ERROR)
        w_u32(&_c, (uint32_t)mask);
        EMIT_PREDICTED_END()
    } else {
        EMIT_BEGIN(OP_CLEAR, 4)
        w_u32(&_c, (uint32_t)mask);
        EMIT_END()
    }
}

void glViewport(GLint x, GLint y, GLsizei w, GLsizei h) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_VIEWPORT, 16, w < 0 || h < 0 ? GL_INVALID_VALUE : GL_NO_ERROR)
    w_i32(&_c, x); w_i32(&_c, y); w_i32(&_c, w); w_i32(&_c, h);
    EMIT_PREDICTED_END()
}

void glScissor(GLint x, GLint y, GLsizei w, GLsizei h) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_SCISSOR, 16, w < 0 || h < 0 ? GL_INVALID_VALUE : GL_NO_ERROR)
    w_i32(&_c, x); w_i32(&_c, y); w_i32(&_c, w); w_i32(&_c, h);
    EMIT_PREDICTED_END()
}

void glEnable(GLenum cap)  {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_ENABLE,  4, scalar_cap(cap) ? GL_NO_ERROR : GL_INVALID_ENUM) w_u32(&_c, (uint32_t)cap); EMIT_PREDICTED_END()
}
void glDisable(GLenum cap) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_DISABLE, 4, scalar_cap(cap) ? GL_NO_ERROR : GL_INVALID_ENUM) w_u32(&_c, (uint32_t)cap); EMIT_PREDICTED_END()
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
    if (!_wpk_gl_command_encoder())
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
    if (!_wpk_gl_command_encoder()) return;
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
        state->array_binding_known = 1;
    } else {
        g_element_buffer = buf;
        state->current_vertex_array->element_serial = object ? object->serial : 0;
    }
}

void glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size,
                     const void *data) {
    if (!_wpk_gl_command_encoder()) return;
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

/* ARRAY_BUFFER is mirrored only after checked bind/delete acceptance. Its
 * valid storage definition has no further API rejection in replaceBufferData;
 * native allocation failure retains the context-reset boundary. Element
 * binding also depends on VAO selection, whose queued acceptance is not yet
 * mirrored exactly, so that target must retain the ordinary error drain. */
static void finish_buffer_definition(uint8_t *start, uint8_t *end, GLenum target) {
    if (target == GL_ARRAY_BUFFER && _wpk_gl_current_encoder()->array_binding_known)
        finish_predicted_command(start, end, GL_NO_ERROR);
    else g_cursor = end;
}

void glBufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage) {
    if (!_wpk_gl_command_encoder()) return;
    if ((target != GL_ARRAY_BUFFER && target != GL_ELEMENT_ARRAY_BUFFER)
        || (usage != GL_STATIC_DRAW && usage != GL_STREAM_DRAW && usage != GL_DYNAMIC_DRAW)) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    if (size < 0) {
        raise_client_error(GL_INVALID_VALUE); return;
    }
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (target == GL_ARRAY_BUFFER && !state->array_binding_known) {
        /* A checked parameter reply certifies binding presence, including a
         * retained unnamed identity. It does not repair the C name/reference
         * mirror: only a subsequent acknowledged bind enables the fast path. */
        const uint32_t input[2] = {GL_ARRAY_BUFFER,GL_BUFFER_SIZE};
        GLint size_ignored;
        if (!checked_client_query(QOP_GET_BUFFER_PARAMETER,input,sizeof input,&size_ignored,sizeof size_ignored)) return;
    } else if (!(target == GL_ARRAY_BUFFER ? g_array_buffer : g_element_buffer)) {
        raise_client_error(GL_INVALID_OPERATION); return;
    }
    /* ES 2.0 section 2.9 makes only a negative size INVALID_VALUE. Buffer
     * offsets travel as i32, so a larger store could not be addressed: like
     * any store the GL cannot create, that is OUT_OF_MEMORY. */
    if ((uint64_t)size > INT32_MAX) {
        raise_client_error(GL_OUT_OF_MEMORY); return;
    }
    /* With data: u32 target, u32 dataLen, u8 data[dataLen], u32 usage.
     * Without data: u32 target, u32 byteLength, u32 usage. */
    uint32_t dlen = (uint32_t)size;
    if (data == NULL || dlen == 0) {
        EMIT_BEGIN(OP_BUFFER_DATA, 12u)
        uint8_t *start = _c - 4;
        w_u32(&_c, (uint32_t)target);
        w_u32(&_c, dlen);
        w_u32(&_c, (uint32_t)usage);
        finish_buffer_definition(start, _c, target);
        return;
    }

    if (dlen > WPK_GL_MAX_TLV_PAYLOAD - 12u) {
        glBufferData(target, size, NULL, usage);
        glBufferSubData(target, 0, size, data);
        return;
    }

    EMIT_BEGIN(OP_BUFFER_DATA, 12u + dlen)
    uint8_t *start = _c - 4;
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, dlen);
    memcpy(_c, data, dlen);
    _c += dlen;
    w_u32(&_c, (uint32_t)usage);
    finish_buffer_definition(start, _c, target);
}

/* ----- shaders / programs ------------------------------------------ */

GLuint glCreateShader(GLenum type) {
    if (!_wpk_gl_command_encoder()) return 0;
    if (type != GL_VERTEX_SHADER && type != GL_FRAGMENT_SHADER) {
        raise_client_error(GL_INVALID_ENUM);
        return 0;
    }
    struct wpk_gl_name_scope scope __attribute__((cleanup(_wpk_gl_end_name_scope))) =
        _wpk_gl_begin_name_scope(_wpk_gl_current_encoder());
    if (!scope.group) return 0;
    return create_program_record(4, type);
}

static void upload_shader_source(GLuint, GLsizei, const GLchar *const *, const GLint *, uint32_t);
void glShaderSource(GLuint shader, GLsizei count,
                    const GLchar *const *string, const GLint *length) {
    if (!_wpk_gl_command_encoder()) return;
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
    if (!_wpk_gl_command_encoder()) return;
    EMIT_BEGIN(OP_COMPILE_SHADER, 4) w_u32(&_c, shader); EMIT_END()
}

void glDeleteShader(GLuint shader) {
    if (!_wpk_gl_command_encoder()) return;
    mutate_program_record(OP_DELETE_SHADER, shader, 0);
}

GLuint glCreateProgram(void) {
    if (!_wpk_gl_command_encoder()) return 0;
    struct wpk_gl_name_scope scope __attribute__((cleanup(_wpk_gl_end_name_scope))) =
        _wpk_gl_begin_name_scope(_wpk_gl_current_encoder());
    if (!scope.group) return 0;
    return create_program_record(5, 0);
}

void glAttachShader(GLuint program, GLuint shader) {
    if (!_wpk_gl_command_encoder()) return;
    mutate_program_record(OP_ATTACH_SHADER, program, shader);
}

void glDetachShader(GLuint program, GLuint shader) {
    if (!_wpk_gl_command_encoder()) return;
    mutate_program_record(OP_DETACH_SHADER, program, shader);
}

void glLinkProgram(GLuint program) {
    if (!_wpk_gl_command_encoder()) return;
    mutate_program_record(OP_LINK_PROGRAM, program, 0);
}

void glUseProgram(GLuint program) {
    if (!_wpk_gl_command_encoder()) return;
    if (try_program_stream_use(_wpk_gl_current_encoder(),program)) return;
    mutate_program_record(OP_USE_PROGRAM, program, 0);
}

void glDeleteProgram(GLuint program) {
    if (!_wpk_gl_command_encoder()) return;
    mutate_program_record(OP_DELETE_PROGRAM, program, 0);
}

void glBindAttribLocation(GLuint program, GLuint index, const GLchar *name) {
    if (!_wpk_gl_command_encoder()) return;
    if (!name) return;
    size_t nlen = strlen(name);
    /* ES 2.0 sets no name-length limit; one command record carries at most
     * 65523 name bytes. Report the transport limit rather than silently
     * dropping the binding and the renderer's program/index errors. */
    if (nlen > 0xFFFFu - 12u) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
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

static uint32_t attrib_type_size(GLenum type);
static void emit_vertex_attrib_pointer(GLuint index, GLint size, GLenum type,
                                       GLboolean normalized, GLsizei stride,
                                       uintptr_t offset) {
    EMIT_BEGIN(OP_VERTEX_ATTRIB_POINTER, 24)
    w_u32(&_c, (uint32_t)index);
    w_i32(&_c, (int32_t)size);
    w_u32(&_c, (uint32_t)type);
    w_u32(&_c, normalized ? 1u : 0u);
    w_i32(&_c, (int32_t)stride);
    w_i32(&_c, (int32_t)offset);
    uint8_t *start = _c - 28;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    const uint32_t width = attrib_type_size(type);
    if (state->default_vertex_array_only && state->array_binding_known &&
        state->current_vertex_array == &state->default_vertex_array &&
        index < state->default_vertex_array.attrib_count &&
        state->default_vertex_array.attribs[index].host_row_known &&
        type != GL_FIXED && width && stride >= 0 && stride <= 255 &&
        (uint32_t)stride % width == 0 && offset <= INT32_MAX && offset % width == 0)
        finish_predicted_command(start,_c,GL_NO_ERROR);
    else g_cursor = _c;
}

static uint32_t vertex_attrib_limit(struct wpk_gles_context *state);
enum { WPK_ATTRIB_ERROR = -1, WPK_ATTRIB_OUT_OF_RANGE = 0, WPK_ATTRIB_PRESENT = 1,
       WPK_ATTRIB_DEFAULT = 2 };
/* Classify `index` for the current VAO. With `grow`, a valid index past its
 * slots grows the VAO to the context limit; without it, such an index keeps
 * its initial state and reports WPK_ATTRIB_DEFAULT. */
static int vertex_attrib_slot(struct wpk_gles_context *state, GLuint index, int grow) {
    struct wpk_vertex_array *vao = state->current_vertex_array;
    if (index < vao->attrib_count) return WPK_ATTRIB_PRESENT;
    const uint32_t limit = vertex_attrib_limit(state);
    if (!limit) return WPK_ATTRIB_ERROR;
    if (index >= limit) return WPK_ATTRIB_OUT_OF_RANGE;
    if (!grow) return WPK_ATTRIB_DEFAULT;
    struct wpk_client_attrib *attribs = calloc(limit, sizeof *attribs);
    if (!attribs) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return WPK_ATTRIB_ERROR;
    }
    memcpy(attribs, vao->attribs, vao->attrib_count * sizeof *attribs);
    if (vao->attribs != vao->initial_attribs) free(vao->attribs);
    const uint32_t old = vao->attrib_count;
    vao->attribs = attribs;
    vao->attrib_count = limit;
    init_vertex_attribs(vao, old, limit);
    return WPK_ATTRIB_PRESENT;
}
static const struct wpk_client_attrib initial_vertex_attrib = {.size = 4, .type = GL_FLOAT};

void glEnableVertexAttribArray(GLuint index) {
    if (!_wpk_gl_command_encoder()) return;
    /* Out-of-range indices still reach the renderer, which reports them. */
    const int slot = vertex_attrib_slot(_wpk_gl_current_encoder(), index, 1);
    if (slot == WPK_ATTRIB_ERROR) return;
    if (slot == WPK_ATTRIB_PRESENT) g_attribs[index].enabled = 1;
    EMIT_PREDICTED_BEGIN(OP_ENABLE_VERTEX_ATTRIB_ARRAY, 4,
        slot == WPK_ATTRIB_OUT_OF_RANGE ? GL_INVALID_VALUE : GL_NO_ERROR)
    w_u32(&_c, (uint32_t)index); EMIT_PREDICTED_END()
    if (slot == WPK_ATTRIB_PRESENT) g_attribs[index].host_row_known = 1;
}

void glDisableVertexAttribArray(GLuint index) {
    if (!_wpk_gl_command_encoder()) return;
    const int slot = vertex_attrib_slot(_wpk_gl_current_encoder(), index, 0);
    if (slot == WPK_ATTRIB_ERROR) return;
    if (slot == WPK_ATTRIB_PRESENT) g_attribs[index].enabled = 0;
    EMIT_PREDICTED_BEGIN(OP_DISABLE_VERTEX_ATTRIB_ARRAY, 4,
        slot == WPK_ATTRIB_OUT_OF_RANGE ? GL_INVALID_VALUE : GL_NO_ERROR)
    w_u32(&_c, (uint32_t)index); EMIT_PREDICTED_END()
    if (slot == WPK_ATTRIB_PRESENT) g_attribs[index].host_row_known = 1;
}

void glVertexAttribPointer(GLuint index, GLint size, GLenum type,
                           GLboolean normalized, GLsizei stride,
                           const void *pointer) {
    if (!_wpk_gl_command_encoder()) return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (!attrib_type_size(type)) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    if (size < 1 || size > 4 || stride < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    const int slot = vertex_attrib_slot(state, index, 1);
    if (slot == WPK_ATTRIB_ERROR) return;
    if (slot == WPK_ATTRIB_OUT_OF_RANGE) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    /* ES 2.0 section 2.8 accepts any buffer offset and stride. WebGL's
     * component-size alignment rule is the renderer's to adapt to. */
    if (state->current_vertex_array->name && g_array_buffer == 0 && pointer != NULL) {
        raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    {
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
    if (g_array_buffer == 0 && !state->current_vertex_array->name) {
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
    g_attribs[index].client = 0;
    /* `pointer` is an offset into the bound GL_ARRAY_BUFFER. */
    emit_vertex_attrib_pointer(index, size, type, normalized, stride,
                               (uintptr_t)pointer);
}

void glVertexAttrib4fv(GLuint index, const GLfloat *values) {
    if (!_wpk_gl_command_encoder()) return;
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

/* Room for one private staging name per attribute slot of the current VAO.
 * A VAO grown past the inline slots needs heap room; NULL raised OOM. */
static GLuint *staging_names(GLuint *initial) {
    const uint32_t count = _wpk_gl_current_encoder()->current_vertex_array->attrib_count;
    if (count <= WPK_GL_INITIAL_ATTRIBS) return initial;
    GLuint *names = malloc((size_t)count * sizeof *names);
    if (!names) raise_client_error(GL_OUT_OF_MEMORY);
    return names;
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
    const uint32_t slots = _wpk_gl_current_encoder()->current_vertex_array->attrib_count;
    for (uint32_t i = 0; i < slots; i++) {
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

/* A whole small nonindexed draw owns one record. Source layout stays in the
 * encoder; the device receives packed referenced elements without public names
 * or ARRAY mutations. Return zero only before admission for the legacy path. */
static int emit_inline_client_arrays(GLenum mode, GLint first, GLsizei count) {
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (count <= 0 || state->current_vertex_array->name)
        return 0;
    if (state->array_capture.active) {
        raise_client_error(GL_INVALID_OPERATION);
        return -1;
    }
    struct inline_client_attribute {
        const struct wpk_client_attrib *attribute;
        const uint8_t *source;
        uint32_t index, element, stride, bytes;
    } plan[WPK_GL_INLINE_DRAW_MAX_ATTRIBUTES];
    uint32_t clients = 0;
    uint64_t payload = WPK_GL_INLINE_DRAW_HEADER_BYTES;
    for (uint32_t i = 0; i < state->current_vertex_array->attrib_count; i++) {
        const struct wpk_client_attrib *a = &g_attribs[i];
        if (!a->client || !a->enabled) continue;
        /* The inline record names only the first 16 attributes; a higher
         * client attribute uses ordinary staging for the whole draw. */
        if (i >= WPK_GL_INLINE_DRAW_MAX_ATTRIBUTES) return 0;
        const uint32_t width = attrib_type_size(a->type);
        if (!width || a->size < 1 || a->size > 4 || !a->pointer) {
            raise_client_error(GL_INVALID_OPERATION);
            return -1;
        }
        const uint32_t element = width * (uint32_t)a->size;
        const uint32_t stride = a->stride ? (uint32_t)a->stride : element;
        const uint64_t end = (uint64_t)(uint32_t)first + (uint32_t)count;
        const uint64_t source_offset = (uint64_t)(uint32_t)first * stride;
        const uint64_t source_end = (end - 1) * stride + element;
        const uint64_t bytes = (uint64_t)(uint32_t)count * element;
        if (end * element > INT32_MAX || source_end > UINTPTR_MAX ||
            (uintptr_t)a->pointer > UINTPTR_MAX - (uintptr_t)source_end) {
            raise_client_error(GL_OUT_OF_MEMORY);
            return -1;
        }
        plan[clients++] = (struct inline_client_attribute){a,
            (const uint8_t *)((uintptr_t)a->pointer + (uintptr_t)source_offset),
            i, element, stride, (uint32_t)bytes};
        payload += WPK_GL_INLINE_DRAW_ATTRIBUTE_BYTES + bytes;
    }
    if (!clients || payload > WPK_GL_INLINE_DRAW_MAX_BYTES)
        return 0;
    uint8_t *cursor = reserve(4 + (size_t)payload);
    if (!cursor) return -1;
    w_u16(&cursor, OP_DRAW_CLIENT_ARRAYS);
    w_u16(&cursor, (uint16_t)payload);
    w_u32(&cursor, mode);
    w_i32(&cursor, first);
    w_i32(&cursor, count);
    w_u32(&cursor, clients);
    for (uint32_t i = 0; i < clients; i++) {
        const struct inline_client_attribute *p = &plan[i];
        const struct wpk_client_attrib *a = p->attribute;
        w_u32(&cursor, p->index);
        w_u32(&cursor, (uint32_t)a->size);
        w_u32(&cursor, a->type);
        w_u32(&cursor, a->normalized ? 1u : 0u);
        w_u32(&cursor, p->bytes);
        if (p->stride == p->element) {
            memcpy(cursor, p->source, p->bytes);
            cursor += p->bytes;
        } else {
            for (uint32_t vertex = 0; vertex < (uint32_t)count; vertex++) {
                memcpy(cursor, p->source + (size_t)vertex * p->stride, p->element);
                cursor += p->element;
            }
        }
    }
    g_cursor = cursor;
    return 1;
}

static void emit_draw_arrays(GLenum mode, GLint first, GLsizei count) {
    EMIT_BEGIN(OP_DRAW_ARRAYS, 12)
    w_u32(&_c, (uint32_t)mode);
    w_i32(&_c, first);
    w_i32(&_c, (int32_t)count);
    EMIT_END()
}

void glDrawArrays(GLenum mode, GLint first, GLsizei count) {
    if (!_wpk_gl_command_encoder()) return;
    if (mode > GL_TRIANGLE_FAN) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    if (first < 0 || count < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (emit_inline_client_arrays(mode, first, count) != 0)
        return;
    GLuint initial_staged[WPK_GL_INITIAL_ATTRIBS], *staged = staging_names(initial_staged);
    if (!staged)
        return;
    int n = stage_client_attribs(first, count, staged,NULL);
    if (n < 0) {
        if (staged != initial_staged) free(staged);
        return;
    }
    emit_draw_arrays(mode, first, count);
    /* The client definition lives in its VAO record. These private staging
     * objects end after the draw; the next draw uploads that definition. */
    if (n > 0) glDeleteBuffers(n, staged);
    if (staged != initial_staged) free(staged);
}

/* ----- sync queries ------------------------------------------------- */

/* [RUNTIME-WORKAROUND: V8-GL-HEAP-QUERY-REPLY] Retain heap-owned
 * replies while the historical stack-reply visibility failure remains
 * unreduced. The engine cause is suspected, not established; see registry.
 * The compound phase result also stays in this heap allocation. */
/* Pre-dispatch failures keep their precise flag and own no native candidate. */
enum { WPK_GL_QUERY_NOT_DISPATCHED = -2 };
/* One synchronous execution path for malloc-owned replies and the context's
 * persistent error reply/packet. Storage is reserved before any native effects;
 * this helper neither allocates nor retries an entered operation. */
static int query_owned_reply(struct wpk_gles_context *state, uint8_t *base, int fd,
                             uint32_t op, const void *in, uint32_t in_len,
                             void *reply, uint32_t out_len, uint32_t prefix,
                             struct gl_submit_query_info *packet, int *query_entered) {
    if (query_entered) *query_entered = 0;
    struct wpk_gl_name_scope publication __attribute__((cleanup(_wpk_gl_end_name_scope)))={0};
    if (!program_submission_scope(state,&publication)) return WPK_GL_QUERY_NOT_DISPATCHED;
    struct gl_query_info qi = {
        .op = op,
        .in_buf_ptr = (uintptr_t)in, .in_buf_len = in_len,
        .out_buf_ptr = (uintptr_t)reply, .out_buf_len = out_len,
        .reserved = 0,
    };
    int rc;
    if (prefix) {
        memset(packet,0,sizeof *packet);
        packet->submit.length = prefix;
        packet->query = qi;
        if (query_entered) *query_entered = 1;
        int submit_rc = -1; // Unknown entry never proves the prefix rejected.
        rc = gl_device_ioctl(fd,GLIO_SUBMIT_QUERY,packet);
        // Once entered, the prefix may have executed even without a reply.
        // Match flush_commands: consume on every return, never replay/fallback.
        g_cursor = base;
        if (rc != 0) {
            raise_client_error(GL_INVALID_OPERATION);
        } else {
            struct gl_submit_query_result result = packet->result;
            int valid = result.result_magic == WPK_GL_SUBMIT_QUERY_REPLY_MAGIC &&
                ((result.completed_phase == WPK_GL_SUBMIT_QUERY_PHASE_SUBMIT &&
                  result.submit_rc < 0 && result.submit_rc >= -4095 && result.query_rc == 0) ||
                 (result.completed_phase == WPK_GL_SUBMIT_QUERY_PHASE_QUERY &&
                  result.submit_rc == 0 && result.query_rc <= 0 && result.query_rc >= -4095));
            if (!valid) {
                errno = EIO; rc = -1; raise_client_error(GL_INVALID_OPERATION);
            } else if (result.submit_rc < 0) {
                // A validated prefix-failure receipt proves this query did not
                // enter. Outer errors or malformed receipts prove no such fact.
                if (query_entered) *query_entered = 0;
                errno = -result.submit_rc; rc = WPK_GL_QUERY_NOT_DISPATCHED;
            } else {
                submit_rc = 0;
                if (result.query_rc < 0) {
                    errno = -result.query_rc; rc = -1;
                }
            }
        }
        // Phase results carry the renderer-lost reply inside the receipt.
        if (rc != 0 && errno == ENODEV) _wpk_gl_note_reset();
        // A consumed or uncertain prefix gets the same recovery as SUBMIT.
        // Query-only failure does not retroactively reject an accepted prefix.
        finish_command_submission(state, base, 0, submit_rc);
    } else {
        if (query_entered) *query_entered = 1;
        rc = gl_device_ioctl(fd,GLIO_QUERY,&qi);
    }
    return rc;
}

static int query_into_tracked(uint32_t op,
                              const void *in, uint32_t in_len,
                              void *dst, uint32_t dst_len, int *query_entered) {
    if (query_entered) *query_entered = 0;
    uint8_t *base = _wpk_gl_cmdbuf_base();
    if (base == NULL) return -1;
    int fd = _wpk_gl_fd();
    if (fd < 0) return -1;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    /* Preserve the acknowledged error trailer as one ordinary flush. A clean
     * nonempty command prefix may use the compound transport below. */
    if (state->client_errors && flush_commands() != 0)
        return WPK_GL_QUERY_NOT_DISPATCHED;
    uint32_t prefix = g_cursor && g_cursor != base ? (uint32_t)(g_cursor-base) : 0;
    size_t reply_bytes = dst_len ? dst_len : 1;
    const size_t alignment = _Alignof(struct gl_submit_query_info);
    size_t header_offset = 0, bytes = reply_bytes;
    if (prefix) {
        if (reply_bytes > SIZE_MAX-(alignment-1)-sizeof(struct gl_submit_query_info)) {
            if (flush_commands() != 0) return WPK_GL_QUERY_NOT_DISPATCHED;
            raise_client_error(GL_OUT_OF_MEMORY); return WPK_GL_QUERY_NOT_DISPATCHED;
        }
        header_offset = (reply_bytes+alignment-1) & ~(alignment-1);
        bytes = header_offset + sizeof(struct gl_submit_query_info);
    }
    void *heap = malloc(bytes);
    if (!heap) {
        // The old helper submitted before allocating its reply. Preserve
        // that ordering on OOM, including the submit failure's GL flag.
        if (prefix && flush_commands() != 0) return WPK_GL_QUERY_NOT_DISPATCHED;
        raise_client_error(GL_OUT_OF_MEMORY); return WPK_GL_QUERY_NOT_DISPATCHED;
    }
    if (dst_len) memset(heap, 0, dst_len);
    struct gl_submit_query_info *packet = prefix ? (void *)((uint8_t *)heap+header_offset) : NULL;
    int rc = query_owned_reply(state,base,fd,op,in,in_len,heap,dst_len,prefix,packet,query_entered);
    if (rc == 0 && dst_len) memcpy(dst,heap,dst_len);
    free(heap);
    return rc;
}

static int _wpk_gl_query_into(uint32_t op, const void *in, uint32_t in_len,
                              void *dst, uint32_t dst_len) {
    return query_into_tracked(op,in,in_len,dst,dst_len,NULL);
}

/* Context limit, queried once. Zero means the query failed and its error is
 * already recorded. A limit below the inline slots contradicts WebGL 2's
 * guarantee, so it fails loudly rather than shrinking validation. */
static uint32_t vertex_attrib_limit(struct wpk_gles_context *state) {
    if (state->vertex_attrib_limit) return state->vertex_attrib_limit;
    GLint limit = 0;
    uint32_t pname = GL_MAX_VERTEX_ATTRIBS;
    const int rc = _wpk_gl_query_into(QOP_GET_INTEGERV, &pname, 4, &limit, 4);
    if (rc != 0) {
        if (rc != WPK_GL_QUERY_NOT_DISPATCHED) raise_client_error(GL_INVALID_OPERATION);
        return 0;
    }
    if (limit < (GLint)WPK_GL_INITIAL_ATTRIBS) {
        raise_client_error(GL_INVALID_OPERATION);
        return 0;
    }
    return state->vertex_attrib_limit = (uint32_t)limit;
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
    if (gl_device_ioctl(fd,GLIO_QUERY,&info) != 0) goto invalid;
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

/* ----- glGetError ----------------------------------------------------
 * ES 2.0 section 2.5: each error flag is recorded once, glGetError returns
 * and clears one recorded flag (which one is implementation-dependent) and
 * NO_ERROR when none is recorded. Flags come from three places: the host
 * renderer (commands it executed), client_errors (detected by this encoder)
 * and held_errors (host flags already moved here by a drain).
 *
 * Programs that check every call (ScummVM's OPENGL_DEBUG GL_CALL is
 * glGetError; call; glGetError) used to pay one synchronous host request per
 * glGetError. A drain request moves all host flags into held_errors. When
 * it reports none retained and no device request has followed it, nothing
 * can have recorded a new host flag, so later calls answer from
 * held_errors/client_errors with no request. Any device request voids that
 * knowledge (see _wpk_gl_note_device_request in libEGL). Commands outside
 * the exactly validated prefix are sent as the prefix of the next drain.
 * Infallible scalar setters can extend that proof without a request, while
 * keeping their original commands for host execution. */
static int hold_error(struct wpk_gles_context *state, GLenum error) {
    for (uint32_t i = 0; i < state->held_error_count; ++i)
        if (state->held_errors[i] == error) return 1; /* One flag per value. */
    if (state->held_error_count == WPK_GL_ERROR_DRAIN_CAPACITY) return 0;
    state->held_errors[state->held_error_count++] = error;
    return 1;
}
/* Return one flag the guest holds; the caller proved no host flag exists
 * (or exists no longer) that this could duplicate. */
static GLenum take_held_error(struct wpk_gles_context *state) {
    for (unsigned bit = 0; bit <= 6; ++bit)
        if ((state->client_errors & (1u << bit)) && hold_error(state, GL_INVALID_ENUM + bit))
            state->client_errors &= ~(1u << bit);
    if (!state->held_error_count) return GL_NO_ERROR;
    const GLenum error = state->held_errors[0];
    memmove(state->held_errors, state->held_errors + 1,
            --state->held_error_count * sizeof state->held_errors[0]);
    return error;
}
/* Validate the complete checked reply before taking custody of any flag.
 * At most six distinct values exist (WebGL getError's five ES2 flags and
 * CONTEXT_LOST_WEBGL), so a merge that overflows held_errors is malformed. */
static int accept_error_drain(struct wpk_gles_context *state, int *retained) {
    const uint32_t *reply = state->error_drain, capacity = WPK_GL_ERROR_DRAIN_CAPACITY;
    const uint32_t count = reply[0];
    if (count > capacity || reply[1] > 1 || reply[2 + capacity] != WPK_GL_QUERY_REPLY_MAGIC) return 0;
    uint32_t fresh = 0;
    for (uint32_t i = 0; i < capacity; ++i) {
        const uint32_t error = reply[2 + i];
        if (i >= count) { if (error) return 0; continue; }
        if (!error) return 0;
        for (uint32_t j = 0; j < i; ++j) if (reply[2 + j] == error) return 0;
        int held = 0;
        for (uint32_t j = 0; j < state->held_error_count; ++j) held |= state->held_errors[j] == error;
        fresh += !held;
    }
    if (state->held_error_count + fresh > capacity) return 0;
    for (uint32_t i = 0; i < count; ++i) (void)hold_error(state, reply[2 + i]);
    *retained = (int)reply[1];
    return 1;
}
/* This failure path must neither allocate nor try to submit again. Normal
 * reservations leave one observation header plus the error trailer free.
 * Consecutive failures with no intervening record coalesce: both returned the
 * same synthetic flag, and no command between them could set a new host flag.
 * Scan only on failure, avoiding unused-feature work in command encoders. */
static void record_transport_error_observation(void) {
    uint8_t *base = _wpk_gl_cmdbuf_base();
    if (!base) return;
    if (!g_cursor) g_cursor = base;
    uint8_t *last = NULL;
    for (uint8_t *at = base; at < g_cursor;) {
        uint16_t length;
        if (g_cursor-at < 4) abort();
        memcpy(&length,at+2,2);
        if (g_cursor-at < 4+length) abort();
        last=at;at+=4+length;
    }
    if (last && g_cursor-last==4) {
        uint16_t op;memcpy(&op,last,2);
        if (op==OP_TRANSPORT_ERROR_OBSERVED) return;
    }
    if (g_cursor-base > WPK_GL_CMDBUF_LEN-12u) abort();
    uint8_t *at=g_cursor;
    w_u16(&at,OP_TRANSPORT_ERROR_OBSERVED);w_u16(&at,0);
    g_cursor=at;
}
static GLenum failed_error_observation(struct wpk_gles_context *state) {
    state->client_errors &= ~(1u << (GL_INVALID_OPERATION-GL_INVALID_ENUM));
    for (uint32_t i=0;i<state->held_error_count;i++) if (state->held_errors[i]==GL_INVALID_OPERATION) {
        memmove(state->held_errors+i,state->held_errors+i+1,
            (--state->held_error_count-i)*sizeof state->held_errors[0]);
        break;
    }
    GLenum reset_error;
    if (_wpk_gl_reset_error(&reset_error)) return reset_error;
    record_transport_error_observation();
    return GL_INVALID_OPERATION;
}
GLenum glGetError(void) {
    /* KHR_robustness section 2.3.1rob: GetError keeps working after a
     * reset, reporting CONTEXT_LOST rather than lost context errors. */
    GLenum reset_error;
    if (_wpk_gl_reset_error(&reset_error)) return reset_error;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (!state) return GL_NO_ERROR;
    uint8_t *base = _wpk_gl_cmdbuf_base();
    if (base == NULL) return GL_NO_ERROR;
    if (exact_error_state(state)) {
        if ((!g_cursor || g_cursor == base) && !state->predicted_errors)
            return take_held_error(state);
        /* WHY: observing a flag is ordered work too. If another invalid
         * command records that value later, it must set a fresh flag rather
         * than being swallowed by a host flag the guest already returned. */
        uint8_t *observed = reserve(12);
        if (observed && exact_error_state(state)) {
            const uint32_t expected = state->predicted_errors;
            const GLenum result = take_held_error(state);
            const uint32_t consumed = result >= GL_INVALID_ENUM && result <= GL_INVALID_FRAMEBUFFER_OPERATION
                ? expected & (1u << (result - GL_INVALID_ENUM)) : 0;
            w_u16(&observed,OP_ERROR_OBSERVED); w_u16(&observed,8);
            w_u32(&observed,expected); w_u32(&observed,consumed);
            g_cursor = state->errors_known_cursor = observed;
            state->predicted_errors &= ~consumed;
            return result;
        }
        /* reserve() may have submitted. Re-enter the ordinary drain before
         * returning or consuming any flag under a now-invalid proof. */
    }
    state->errors_known = 0;
    /* Only the fallback drain publishes metadata. Sampling its request epoch
     * afterward lets the one actual error drain establish a fresh proof;
     * local observations above must never turn into publication round trips. */
    struct wpk_gl_name_scope publication __attribute__((cleanup(_wpk_gl_end_name_scope)))={0};
    if (!program_submission_scope(state,&publication)) return failed_error_observation(state);
    /* One request carries the queued commands (as the compound prefix), the
     * unacknowledged client flags and the drain, in that order, matching the
     * ordering the separate trailer flush used to give. */
    const int fd = _wpk_gl_fd();
    const uint32_t errors = state->client_errors;
    const uint32_t prefix = !g_cursor ? 0 : (uint32_t)(g_cursor-base);
    state->error_request[0] = errors;
    state->error_request[1] = WPK_GL_ERROR_DRAIN_REQUEST;
    memset(state->error_drain, 0, sizeof state->error_drain);
    const uint64_t requests = _wpk_gl_device_requests();
    int retained = 1;
    int rc = query_owned_reply(state,base,fd,QOP_GET_ERROR,state->error_request,
        WPK_GL_ERROR_DRAIN_REQUEST_BYTES,state->error_drain,WPK_GL_ERROR_DRAIN_REPLY_BYTES,
        prefix,prefix ? &state->error_packet : NULL,NULL);
    if (rc == 0 && !accept_error_drain(state, &retained)) { errno = EIO; rc = -1; }
    if (rc != 0) {
        /* Report the failed transport as this call's INVALID_OPERATION and
         * clear that one flag wherever the guest holds it. Client flags stay
         * until a reply proves the host received them, so none is lost; host
         * flags a failed reply may have carried away are the remaining
         * copyout custody gap, as for any query whose completion is unknown.
         * An ordered transport observation prevents an earlier retained
         * INVALID_OPERATION from being reported twice after recovery.
         * The next call asks the host again. */
        return failed_error_observation(state);
    }
    state->client_errors &= ~errors;
    state->predicted_errors = 0;
    /* Exactly one request since the snapshot means no other thread reached
     * a device in between. A fork child must not inherit this knowledge;
     * when that cannot be arranged, every call keeps asking the host. */
    if (!retained && (!g_cursor || g_cursor == base) &&
        _wpk_gl_device_requests() == requests + 1 && _wpk_gl_device_requests_fork_safe()) {
        state->errors_known = 1;
        state->errors_known_at = requests + 1;
        state->errors_known_cursor = base;
    }
    return take_held_error(state);
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
    return gl_device_ioctl(fd,GLIO_QUERY,&info);
}
void glFinish(void) {
    if (!_wpk_gl_command_encoder()) return;
    if (_wpk_gl_finish_checked() != 0) raise_client_error(GL_INVALID_OPERATION);
}

/* OpenGL ES 2.0 lets an implementation support no shader binary formats;
 * this one supports none (GL_NUM_SHADER_BINARY_FORMATS is 0, as WebGL has no
 * binary shaders). Every binaryformat is therefore not an accepted value,
 * which the specification reports as GL_INVALID_ENUM. */
void glShaderBinary(GLsizei count, const GLuint *shaders, GLenum binaryformat,
                    const void *binary, GLsizei length) {
    if (!_wpk_gl_command_encoder()) return;
    (void)count; (void)shaders; (void)binaryformat; (void)binary; (void)length;
    raise_client_error(GL_INVALID_ENUM);
}

/* Matches the kernel's MAX_QUERY_IN_LEN for one GLIO_QUERY request. */
#define WPK_GL_MAX_QUERY_INPUT 65536u

GLint glGetAttribLocation(GLuint program, const GLchar *name) {
    if (!_wpk_gl_command_encoder()) return 0;
    if (!name) return -1;
    size_t nlen = strlen(name);
    /* The renderer owns the lookup and its program errors for every name
     * one query can carry. A longer name exceeds the transport, so report
     * that instead of a -1 that skipped the program checks. */
    if (nlen > WPK_GL_MAX_QUERY_INPUT - 8u) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return -1;
    }
    uint8_t *in = malloc(8 + nlen);
    if (!in) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return -1;
    }
    uint32_t prog_u32 = program, nlen_u32 = (uint32_t)nlen;
    memcpy(in,     &prog_u32, 4);
    memcpy(in + 4, &nlen_u32, 4);
    memcpy(in + 8, name, nlen);
    int32_t loc = -1;
    const int rc = _wpk_gl_query_into(QOP_GET_ATTRIB_LOC, in, (uint32_t)(8 + nlen), &loc, 4);
    free(in);
    return rc != 0 ? -1 : loc;
}

/* ----- textures ----------------------------------------------------- */

void glGenTextures(GLsizei n, GLuint *out) {
    if (!_wpk_gl_command_encoder()) return;
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

/* Creation returns its name only after this operation's own receipt. An
 * uncertain prefix/reply cannot authorize retrying a possibly-created name. */
static GLuint checked_shader_program_creation(uint32_t kind, GLenum type, GLuint name) {
    uint32_t *input = malloc(3 * sizeof *input);
    if (!input) { raise_client_error(GL_OUT_OF_MEMORY); return 0; }
    input[0] = kind; input[1] = type; input[2] = name;
    uint32_t reply[3] = {0};
    const struct wpk_error_proof proof = capture_error_proof();
    int entered = 0;
    int rc = query_into_tracked(QOP_CREATE_SHADER_PROGRAM, input, 12, reply, 12, &entered);
    free(input);
    if (rc == WPK_GL_QUERY_NOT_DISPATCHED || (rc && !entered)) return 0;
    if (!rc && reply[2] == WPK_GL_QUERY_REPLY_MAGIC) {
        if (reply[0] == 1 && reply[1] == 0) return 0;
        if (reply[0] == 0 && reply[1] == name) {
            accept_error_proof(proof);
            return name;
        }
    }
    // The query may have published its native owner. Never emit a second
    // creation or infer any binding/error knowledge from the lost reply.
    invalidate_binding_knowledge(_wpk_gl_current_encoder());
    raise_client_error(GL_INVALID_OPERATION);
    return 0;
}

/* All record access below is serialized by the group's dispatch scope. No
 * metadata mutex crosses IO; the scope also disables cancellation until C
 * publication is complete. Metadata retirement performs no native calls. */
static struct wpk_program_record *find_program_record(struct wpk_object_group *group, GLuint name) {
    for (struct wpk_program_record *p=group->program_records; p; p=p->next)
        if (p->name==name) return p;
    return NULL;
}
static void collect_program_record(struct wpk_object_group *group, struct wpk_program_record *record) {
    if (!record || !record->delete_pending || record->references) return;
    struct wpk_program_record **p=&group->program_records;
    while (*p && *p!=record) p=&(*p)->next;
    if (!*p) return;
    *p=record->next;
    if (record->kind==5) for (unsigned i=0; i<2; i++) {
        struct wpk_program_record *shader=record->shaders[i];
        if (shader) { shader->references--; collect_program_record(group,shader); }
    }
    free(record);
}
static GLuint create_program_record(uint32_t kind, GLenum type) {
    struct wpk_object_group *group=_wpk_gl_current_encoder()->objects;
    /* Reserve the C publication before creating a native/name owner. */
    struct wpk_program_record *record=calloc(1,sizeof *record);
    if (!record) { raise_client_error(GL_OUT_OF_MEMORY); return 0; }
    GLuint name=next_shader_program_name();
    if (!name || checked_shader_program_creation(kind,type,name)!=name) {
        free(record); return 0;
    }
    *record=(struct wpk_program_record){.name=name,.kind=kind,.shader_type=type,
        .link_known=kind==5,.next=group->program_records};
    group->program_records=record;
    return name;
}
/* A canonical nonacceptance supplies no new state proof. Even a valid error
 * receipt cannot authorize retry of a mutation that may have partly run. */
static int checked_program_mutation(uint32_t op, GLuint name, GLuint shader) {
    uint32_t count=(op==OP_ATTACH_SHADER || op==OP_DETACH_SHADER)?3:2;
    uint32_t *input=malloc(count*4);
    if (!input) { raise_client_error(GL_OUT_OF_MEMORY); return -2; }
    input[0]=op;input[1]=name;if(count==3)input[2]=shader;
    uint32_t reply[3]={0};int entered=0;
    const struct wpk_error_proof proof=capture_error_proof();
    int rc=query_into_tracked(QOP_PROGRAM_MUTATION,input,count*4,reply,12,&entered);
    free(input);
    if (rc==WPK_GL_QUERY_NOT_DISPATCHED || (rc && !entered)) return -2;
    if (!rc && reply[2]==WPK_GL_QUERY_REPLY_MAGIC) {
        if (reply[0]==0 && reply[1]==1) { accept_error_proof(proof); return 1; }
        if (reply[0]==1 && reply[1]==0) return 0;
    }
    invalidate_binding_knowledge(_wpk_gl_current_encoder());
    raise_client_error(GL_INVALID_OPERATION);
    return -1;
}
/* Called under dispatch serialization, with current live-session authority.
 * Canonical rejection owns its host error; unknown completion cannot authorize
 * retry or claim that an acquired handle was never published. Native context
 * retirement closes even an owner whose receipt was lost. */
static int program_capture_query(struct wpk_gles_context *state, uint32_t action,
                                uint32_t value, struct wpk_program_capture *capture) {
    uint8_t *base=_wpk_gl_cmdbuf_base();
    int fd=_wpk_gl_fd();
    if (!base || fd<0 || state->program_captures_uncertain) return 0;
    uint32_t *request=state->program_capture_request, *reply=state->program_capture_reply;
    request[0]=action;request[1]=value;request[2]=0;
    memset(reply,0,sizeof state->program_capture_reply);
    const uint32_t prefix=g_cursor ? (uint32_t)(g_cursor-base) : 0;
    const struct wpk_error_proof proof=capture_error_proof();
    int entered=0;
    int rc=query_owned_reply(state,base,fd,QOP_PROGRAM_CAPTURE,request,8,reply,16,
        prefix,prefix ? &state->program_capture_packet : NULL,&entered);
    if (!rc && reply[3]==WPK_GL_QUERY_REPLY_MAGIC) {
        if (reply[0]==0 && reply[1]==1 &&
            (action==1 ? reply[2]!=0 : reply[2]==0)) {
            if (action==1) capture->handle=reply[2];
            accept_error_proof(proof);return 1;
        }
        if (action==1 && reply[0]==0 && reply[1]==0 && reply[2]==0) {
            accept_error_proof(proof);return 2; /* Observed failed link. */
        }
        if (reply[0]==1 && reply[1]==0 && reply[2]==0) {
            // A private release rejection cannot discard the C receiver.
            // Stop new captures; acknowledged context retirement owns cleanup.
            state->program_captures_uncertain=1;return 0;
        }
    }
    state->program_captures_uncertain=1;
    atomic_store_explicit(&state->objects->program_records_known,0,memory_order_relaxed);
    if (rc!=WPK_GL_QUERY_NOT_DISPATCHED || entered) raise_client_error(GL_INVALID_OPERATION);
    return 0;
}
static int release_program_capture(struct wpk_gles_context *state,
                                   struct wpk_program_capture *capture) {
    if (!capture->handle) return 1;
    if (program_capture_query(state,3,capture->handle,NULL)!=1) return 0;
    *capture=(struct wpk_program_capture){0};return 1;
}
static uint64_t program_counter(const uint32_t *words) {
    return (uint64_t)words[0] | ((uint64_t)words[1]<<32);
}
static void write_program_counter(uint32_t *words,uint64_t value) {
    words[0]=(uint32_t)value;words[1]=(uint32_t)(value>>32);
}
static int valid_program_receipt(const uint32_t *words) {
    return words[11]==WPK_GL_QUERY_REPLY_MAGIC && words[0]<=2 &&
        words[6]<=0x1fffff && words[8]<=0x1fffff && words[10]<=0x1fffff;
}
/* This transport never owns a command prefix or another encoder. In
 * particular a foreign lifecycle publisher must not mark the calling thread's
 * unrelated current context lost when its outer metadata context fails. */
static int program_stream_io(struct wpk_program_stream *stream,uint32_t op,
                              const uint32_t *request,uint32_t words,uint32_t *reply) {
    memset(reply,0,48);
    struct gl_query_info query={.op=op,.in_buf_ptr=(uintptr_t)request,.in_buf_len=words*4,
        .out_buf_ptr=(uintptr_t)reply,.out_buf_len=48};
    _wpk_gl_note_device_request();
    int rc=ioctl(stream->fd,GLIO_QUERY,&query);
    if (rc && errno==ENODEV) {
        stream->blocked|=WPK_PROGRAM_BLOCKED_EXECUTION;
        if (stream->fd==_wpk_gl_fd()) _wpk_gl_note_reset();
    }
    return !rc && valid_program_receipt(reply);
}
static int valid_program_mutation_receipt(struct wpk_program_stream *stream,const uint32_t *reply,
                                           uint32_t action,uint32_t tx) {
    if (!valid_program_receipt(reply) || reply[1]!=tx || reply[2]!=action) return 0;
    if (reply[0]) return 1;
    if (program_counter(reply+9)>program_counter(reply+7)) return 0;
    if (action==1) return reply[3] && reply[4]==WPK_PROGRAM_SLOTS &&
        !program_counter(reply+7) && !program_counter(reply+9);
    if (reply[3]!=stream->id || program_counter(reply+7)>stream->ticket) return 0;
    if (action==2) return reply[4]!=0;
    if (action==3) return reply[4]==stream->request[2] &&
        program_counter(reply+5)==program_counter(stream->request+3+8*(stream->request[2]-1)+4);
    if (action==4) return reply[4]==stream->request[3];
    return action==5 && !reply[4];
}
/* One entry, then read-only reconciliation. Never replay a mutation after an
 * uncertain return. An unchanged last transaction proves nonentry but leaves
 * retry to the next caller, with every immutable receiver still reserved. */
static int program_stream_mutate(struct wpk_program_stream *stream,uint32_t action,
                                 uint32_t words,uint32_t transport) {
    if (stream->blocked || stream->transaction==UINT32_MAX) return -1;
    uint32_t tx=stream->transaction+1;
    stream->request[0]=action;stream->request[1]=tx;
    int valid=program_stream_io(stream,transport,stream->request,words,stream->reply);
    if (!valid || !valid_program_mutation_receipt(stream,stream->reply,action,tx) || stream->reply[0]) {
        stream->read_request[0]=6;
        if (!program_stream_io(stream,QOP_PROGRAM_JOURNAL_BARRIER,stream->read_request,1,stream->recovery)) {
            stream->blocked|=WPK_PROGRAM_BLOCKED_RECEIPT;return -1;
        }
        if (stream->recovery[1]==stream->transaction && stream->recovery[0]!=2) return -2;
        if (!valid_program_mutation_receipt(stream,stream->recovery,action,tx)) {
            stream->blocked|=WPK_PROGRAM_BLOCKED_RECEIPT;return -1;
        }
        memcpy(stream->reply,stream->recovery,48);
    }
    stream->transaction=tx;
    if (stream->reply[0]==2) {stream->blocked|=WPK_PROGRAM_BLOCKED_RECEIPT;return -1;}
    return stream->reply[0]==0;
}
static void finish_program_publication_prefix(struct wpk_object_group *group,unsigned count) {
    for (unsigned i=0;i<count;i++) {
        struct wpk_program_intent *p=group->program_head;
        if (!p) abort();
        group->program_head=p->next;p->next=NULL;p->phase=2;
    }
    if (!group->program_head) group->program_tail=NULL;
    group->program_publication_caller=NULL;
    group->program_publication_transaction=group->program_publication_count=0;
}
/* A context reset may interrupt shared publication after an exact prefix.
 * Read only: require one consistent group sequence and each owner's exact
 * published ticket before releasing any receiver or choosing another caller.
 * The failed caller retains its consumed transaction and execution loss. */
static int recover_reset_publication(struct wpk_object_group *group) {
    struct wpk_program_stream *caller=group->program_publication_caller;
    const unsigned count=group->program_publication_count;
    if (!caller || !(caller->blocked&WPK_PROGRAM_BLOCKED_EXECUTION) ||
        caller->recovery[0]!=2 || caller->recovery[1]!=group->program_publication_transaction ||
        caller->recovery[2]!=3 || !count || !group->program_head) return 0;
    const uint64_t before=group->program_head->sequence-1;
    uint64_t sequence=0;int known=0,valid=1;
    caller->read_request[0]=7;
    struct wpk_program_intent *p=group->program_head;
    for (unsigned i=0;i<count && valid;i++,p=p->next) {
        if (!p || p->phase!=1 || p->sequence!=before+i+1) {valid=0;break;}
        int seen=0;struct wpk_program_intent *earlier=group->program_head;
        for (unsigned j=0;j<i;j++,earlier=earlier->next)
            if (earlier->owner==p->owner) {seen=1;break;}
        if (seen) continue;
        caller->read_request[1]=p->owner->id;
        if (!program_stream_io(caller,QOP_PROGRAM_JOURNAL_BARRIER,caller->read_request,2,caller->recovery) ||
            caller->recovery[0] || caller->recovery[2]!=7 ||
            caller->recovery[3]!=p->owner->id || !(caller->recovery[4]&1)) {valid=0;break;}
        const uint64_t observed=program_counter(caller->recovery+5);
        if (!known) {sequence=observed;known=1;}
        if (observed!=sequence || sequence<before || sequence-before>count) {valid=0;break;}
        uint64_t ticket=p->ticket-1;struct wpk_program_intent *row=group->program_head;
        for (unsigned j=0;j<count;j++,row=row->next) {
            if (!row || row->phase!=1 || row->sequence!=before+j+1) {valid=0;break;}
            if (row->owner==p->owner && row->sequence<=sequence) ticket=row->ticket;
        }
        if (program_counter(caller->recovery+7)!=ticket ||
            program_counter(caller->recovery+9)>ticket) valid=0;
    }
    caller->read_request[0]=6;
    if (!valid || !known) return 0;
    // Status2 is never retried on that caller. Other healthy metadata owners
    // publish only the still-unentered suffix, keeping global order intact.
    caller->blocked|=WPK_PROGRAM_BLOCKED_RECEIPT;
    finish_program_publication_prefix(group,(unsigned)(sequence-before));
    return 1;
}
static int publish_program_intents(struct wpk_object_group *group) {
    if (group->program_publication_caller) {
        struct wpk_program_stream *caller=group->program_publication_caller;
        caller->read_request[0]=6;
        if (!program_stream_io(caller,QOP_PROGRAM_JOURNAL_BARRIER,caller->read_request,1,caller->recovery)) {
            raise_client_error(GL_INVALID_OPERATION);return 0;
        }
        uint32_t tx=group->program_publication_transaction;
        if (caller->transaction==tx-1 && caller->recovery[1]==caller->transaction && caller->recovery[0]!=2) {
            // Only this exact retained predecessor proves the attempt never
            // entered. Future publication may retry those still-owned rows.
            caller->blocked&=~WPK_PROGRAM_BLOCKED_RECEIPT;
            group->program_publication_caller=NULL;
            group->program_publication_transaction=group->program_publication_count=0;
        } else if (valid_program_mutation_receipt(caller,caller->recovery,3,tx) && !caller->recovery[0]) {
            caller->transaction=tx;
            // Receipt recovery is not renderer recovery. Execution/capture
            // uncertainty and EGL reset state retain their separate authority.
            caller->blocked&=~WPK_PROGRAM_BLOCKED_RECEIPT;
            memcpy(caller->reply,caller->recovery,48);
            finish_program_publication_prefix(group,group->program_publication_count);
        } else if (recover_reset_publication(group)) {
            // The read-only prefix proof retained every unpublished receiver.
        } else {raise_client_error(GL_INVALID_OPERATION);return 0;}
    }
    while (group->program_head) {
        struct wpk_program_stream *caller=group->program_streams;
        while (caller && (caller->blocked || caller->transaction==UINT32_MAX)) caller=caller->next;
        if (!caller) {raise_client_error(GL_INVALID_OPERATION);return 0;}
        unsigned count=0;
        for (struct wpk_program_intent *p=group->program_head;p && count<WPK_PROGRAM_SLOTS;p=p->next) {
            uint32_t *row=caller->request+3+8*count++;
            row[0]=p->owner->id;row[1]=p->index;
            write_program_counter(row+2,p->ticket);write_program_counter(row+4,p->sequence);
            row[6]=p->name;row[7]=p->token;
        }
        caller->request[2]=count;
        group->program_publication_caller=caller;
        group->program_publication_transaction=caller->transaction+1;
        group->program_publication_count=count;
        int accepted=program_stream_mutate(caller,3,3+8*count,QOP_PROGRAM_JOURNAL_BARRIER);
        if (accepted!=1 ||
            caller->reply[4]!=count) {
            if (accepted==-2) {
                group->program_publication_caller=NULL;
                group->program_publication_transaction=group->program_publication_count=0;
                if (caller->blocked&WPK_PROGRAM_BLOCKED_EXECUTION) continue;
            } else if (recover_reset_publication(group)) {
                continue;
            } else caller->blocked|=WPK_PROGRAM_BLOCKED_RECEIPT;
            raise_client_error(GL_INVALID_OPERATION);return 0;
        }
        finish_program_publication_prefix(group,group->program_publication_count);
    }
    atomic_store_explicit(&group->program_intents_pending,0,memory_order_release);
    return 1;
}
static int program_submission_scope(struct wpk_gles_context *state,struct wpk_gl_name_scope *scope) {
    if ((!state->program_stream || !state->program_stream->active) &&
        !atomic_load_explicit(&state->objects->program_intents_pending,memory_order_acquire)) return 1;
    *scope=begin_dispatch_scope(state);
    if (!scope->group) return 0;
    if (!publish_program_intents(scope->group)) {
        _wpk_gl_end_name_scope(scope);return 0;
    }
    return 1;
}
static void complete_program_submission(struct wpk_gles_context *state,int rc) {
    struct wpk_program_stream *stream=state->program_stream;
    if (!stream || !stream->active) return;
    if (rc) {stream->blocked|=WPK_PROGRAM_BLOCKED_EXECUTION;return;}
    // Stage B's synchronous acknowledgement proves these selectors executed.
    // C1 must transfer cell custody to jobs instead of freeing at admission.
    for (unsigned i=0;i<WPK_PROGRAM_SLOTS;i++)
        if (stream->slots[i].phase==2) stream->slots[i].phase=0;
}
static int disable_program_stream(struct wpk_gles_context *state) {
    struct wpk_program_stream *stream=state->program_stream;
    if (!stream || !stream->active) return 1;
    if (!publish_program_intents(state->objects) || flush_commands()!=0) return 0;
    if (program_stream_mutate(stream,5,2,QOP_PROGRAM_JOURNAL)!=1) {
        raise_client_error(GL_INVALID_OPERATION);return 0;
    }
    stream->active=0;stream->id=0;stream->ticket=0;
    for (unsigned i=0;i<WPK_PROGRAM_CACHE;i++) {
        struct wpk_program_generation *g=&stream->generations[i];
        g->token=0; // The acknowledged journal closure retired every token.
        if (g->capture) {
            struct wpk_program_capture capture={.name=g->name,.link_epoch=g->link_epoch,.handle=g->capture};
            if (!release_program_capture(state,&capture)) {
                stream->blocked|=WPK_PROGRAM_BLOCKED_EXECUTION;return 0; // Keep the exact receiver until context retirement.
            }
        }
        *g=(struct wpk_program_generation){0};
    }
    return 1;
}
int _wpk_gl_enable_program_journal(void) {
    struct wpk_gles_context *state=_wpk_gl_command_encoder();
    if (!state || !_wpk_gl_device_requests_fork_safe()) return 0;
    struct wpk_gl_name_scope guard __attribute__((cleanup(_wpk_gl_end_name_scope)))=begin_dispatch_scope(state);
    if (!guard.group) return 0;
    if (!publish_program_intents(state->objects) || flush_commands()!=0) return 0;
    if (!atomic_load_explicit(&state->objects->program_records_known,memory_order_relaxed)) return 0;
    struct wpk_program_stream *stream=state->program_stream;
    if (!stream) {
        stream=calloc(1,sizeof *stream);
        if (!stream) {raise_client_error(GL_OUT_OF_MEMORY);return 0;}
        stream->fd=_wpk_gl_fd();
        stream->next=state->objects->program_streams;
        state->objects->program_streams=stream;state->program_stream=stream;
        atomic_store_explicit(&state->objects->program_owner_epoch,_wpk_gl_device_owner_epoch(),memory_order_relaxed);
        stream->read_request[0]=6;
        if (!program_stream_io(stream,QOP_PROGRAM_JOURNAL_BARRIER,stream->read_request,1,stream->reply) ||
            stream->reply[0]==2) {stream->blocked|=WPK_PROGRAM_BLOCKED_RECEIPT;return 0;}
        stream->transaction=stream->reply[1];
    }
    if (stream->blocked) return 0;
    if (stream->active) return 1;
    stream->request[2]=WPK_PROGRAM_SLOTS;
    // Reserve the receiver even if the response is lost after host admission.
    // Unknown entry must not fall back to legacy Use with a live host journal.
    stream->active=1;
    int admitted=program_stream_mutate(stream,1,3,QOP_PROGRAM_JOURNAL);
    if (admitted!=1) {
        if (!admitted || admitted==-2) stream->active=0;
        return 0;
    }
    // Publish the receiver before checking the remaining receipt fields.
    stream->id=stream->reply[3];stream->active=1;
    if (!stream->id || stream->reply[4]!=WPK_PROGRAM_SLOTS ||
        program_counter(stream->reply+5)!=state->objects->program_sequence) {
        stream->blocked|=WPK_PROGRAM_BLOCKED_EXECUTION;raise_client_error(GL_INVALID_OPERATION);return 0;
    }
    return 1;
}
static uint32_t program_stream_generation(struct wpk_gles_context *state,struct wpk_program_record *record) {
    struct wpk_program_stream *stream=state->program_stream;
    for (unsigned i=0;i<WPK_PROGRAM_CACHE;i++) {
        struct wpk_program_generation *g=&stream->generations[i];
        if (g->token && g->name==record->name && g->link_epoch==record->link_epoch) return g->token;
    }
    // Cold acquisition may submit only this caller's prefix, never a peer's.
    if (!publish_program_intents(state->objects) || flush_commands()!=0) return 0;
    unsigned index=stream->cache_cursor++%WPK_PROGRAM_CACHE;
    for (unsigned i=0;i<WPK_PROGRAM_CACHE;i++)
        if (!stream->generations[i].token && !stream->generations[i].capture) {index=i;break;}
    struct wpk_program_generation *g=&stream->generations[index];
    if (g->capture) return 0;
    if (g->token) {
        stream->request[2]=stream->id;stream->request[3]=g->token;
        if (program_stream_mutate(stream,4,4,QOP_PROGRAM_JOURNAL)!=1) return 0;
        *g=(struct wpk_program_generation){0};
    }
    struct wpk_program_capture capture={.name=record->name,.link_epoch=record->link_epoch};
    int observed=program_capture_query(state,1,record->name,&capture);
    if (observed) {record->link_known=1;record->linked=observed==1;}
    if (observed!=1) return 0;
    *g=(struct wpk_program_generation){.name=record->name,.link_epoch=record->link_epoch,.capture=capture.handle};
    stream->request[2]=capture.handle;
    if (program_stream_mutate(stream,2,3,QOP_PROGRAM_JOURNAL)!=1) return 0;
    g->token=stream->reply[4];
    if (!g->token) {stream->blocked|=WPK_PROGRAM_BLOCKED_EXECUTION;return 0;}
    if (!release_program_capture(state,&capture)) {stream->blocked|=WPK_PROGRAM_BLOCKED_EXECUTION;return 0;}
    g->capture=0;
    return g->token;
}
static int try_program_stream_use(struct wpk_gles_context *state,GLuint name) {
    struct wpk_program_stream *stream=state->program_stream;
    if (!stream || !stream->active) return 0;
    struct wpk_gl_name_scope guard __attribute__((cleanup(_wpk_gl_end_name_scope)))=begin_dispatch_scope(state);
    if (!guard.group) return 1;
    if (stream->blocked) {raise_client_error(GL_INVALID_OPERATION);return 1;}
    if (!atomic_load_explicit(&state->objects->program_records_known,memory_order_relaxed)) return 0;
    struct wpk_program_record *record=find_program_record(state->objects,name);
    GLenum error=GL_NO_ERROR;
    if (name && !record) error=GL_INVALID_VALUE;
    else if (record && record->kind!=5) error=GL_INVALID_OPERATION;
    else if (record && record->link_known && !record->linked) error=GL_INVALID_OPERATION;
    if (!error && record && record!=state->current_program && record->references==UINT_MAX) {
        raise_client_error(GL_OUT_OF_MEMORY);return 1;
    }
    uint32_t token=!error && record ? program_stream_generation(state,record) : 0;
    if (!error && record && !token) {
        // Cold capture also observes link status. A failed link is an exact
        // local rejection; uncertain acquisition retains synchronous fallback.
        if (record->link_known && !record->linked) error=GL_INVALID_OPERATION;
        else return 0;
    }
    struct wpk_program_intent *slot=NULL;
    for (unsigned i=0;i<WPK_PROGRAM_SLOTS;i++) if (!stream->slots[i].phase) {slot=&stream->slots[i];break;}
    if (!slot) {
        if (flush_commands()!=0) return 1;
        for (unsigned i=0;i<WPK_PROGRAM_SLOTS;i++) if (!stream->slots[i].phase) {slot=&stream->slots[i];break;}
    }
    if (!slot || stream->ticket==WPK_PROGRAM_COUNTER_MAX ||
        state->objects->program_sequence==WPK_PROGRAM_COUNTER_MAX) {
        raise_client_error(GL_OUT_OF_MEMORY);return 1;
    }
    struct wpk_program_stream *publisher=state->objects->program_streams;
    while (publisher && (publisher->blocked || publisher->transaction==UINT32_MAX)) publisher=publisher->next;
    if (!publisher) {raise_client_error(GL_OUT_OF_MEMORY);return 1;}
    uint8_t *cursor=reserve(20);
    if (!cursor) return 1;
    uint8_t *start=cursor;
    *slot=(struct wpk_program_intent){.owner=stream,.index=(uint32_t)(slot-stream->slots),
        .ticket=++stream->ticket,.sequence=++state->objects->program_sequence,
        .name=name,.token=token,.phase=1};
    w_u16(&cursor,OP_USE_PROGRAM_JOURNAL);w_u16(&cursor,16);
    w_u32(&cursor,stream->id);w_u32(&cursor,slot->index);
    w_u32(&cursor,(uint32_t)slot->ticket);w_u32(&cursor,(uint32_t)(slot->ticket>>32));
    if (!error && record!=state->current_program) {
        struct wpk_program_record *previous=state->current_program;
        if (record) record->references++;
        state->current_program=record;
        if (previous) {previous->references--;collect_program_record(state->objects,previous);}
    }
    if (state->objects->program_tail) state->objects->program_tail->next=slot;
    else state->objects->program_head=slot;
    state->objects->program_tail=slot;
    atomic_store_explicit(&state->objects->program_intents_pending,1,memory_order_release);
    finish_predicted_command(start,cursor,error);
    return 1;
}
static void mutate_program_record(uint32_t op, GLuint name, GLuint shader_name) {
    struct wpk_gles_context *state=_wpk_gl_current_encoder();
    struct wpk_gl_name_scope scope __attribute__((cleanup(_wpk_gl_end_name_scope))) =
        _wpk_gl_begin_name_scope(state);
    if (!scope.group) return;
    struct wpk_object_group *group=state->objects;
    if ((op==OP_USE_PROGRAM || op==OP_LINK_PROGRAM) && !disable_program_stream(state)) return;
    struct wpk_program_record *record=find_program_record(group,name);
    struct wpk_program_record *shader=find_program_record(group,shader_name);
    int slot=shader && shader->kind==4 ? (shader->shader_type==GL_VERTEX_SHADER?0:1) : -1;
    /* Dispatch serialization reserves reference capacity until publication.
     * No allocation or counter overflow may follow accepted native work. */
    if ((op==OP_USE_PROGRAM && record && record->kind==5 && record!=state->current_program &&
         record->references==UINT_MAX) ||
        (op==OP_ATTACH_SHADER && record && record->kind==5 && slot>=0 &&
         !record->shaders[slot] && shader->references==UINT_MAX)) {
        raise_client_error(GL_OUT_OF_MEMORY);return;
    }
    int accepted=checked_program_mutation(op,name,shader_name);
    if (accepted!=1) {
        if (accepted!=-2) group->program_records_known=0;
        return;
    }
    if (op==OP_USE_PROGRAM) {
        if (record && record->kind!=5) record=NULL;
        if (name && !record) group->program_records_known=0;
        struct wpk_program_record *previous=state->current_program;
        if (record!=previous) {
            if (record) record->references++;
            state->current_program=record;
            if (previous) {previous->references--;collect_program_record(group,previous);}
        }
        if (record) {
            record->link_known=1;record->linked=1;
        }
    } else if (op==OP_ATTACH_SHADER || op==OP_DETACH_SHADER) {
        if (!record || record->kind!=5 || slot<0) {group->program_records_known=0;return;}
        struct wpk_program_record *previous=record->shaders[slot];
        if (op==OP_ATTACH_SHADER && !previous) {
            shader->references++;record->shaders[slot]=shader;
        } else if (op==OP_DETACH_SHADER && previous==shader) {
            record->shaders[slot]=NULL;shader->references--;collect_program_record(group,shader);
        } else group->program_records_known=0;
    } else if (op==OP_LINK_PROGRAM) {
        if (record && record->kind==5) {
            record->link_known=0;
            if (record->link_epoch==UINT64_MAX) {
                atomic_store_explicit(&group->program_records_known,0,memory_order_relaxed);
            } else {
                record->link_epoch++;
            }
        }
        else group->program_records_known=0;
    } else if (op==OP_DELETE_SHADER || op==OP_DELETE_PROGRAM) {
        if (record && record->kind==(op==OP_DELETE_SHADER?4u:5u)) {
            record->delete_pending=1;collect_program_record(group,record);
        } else if (name) group->program_records_known=0;
    }
}

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
    const struct wpk_error_proof proof = capture_error_proof();
    int rc = _wpk_gl_query_into(op, input, count * sizeof *input, reply, sizeof reply);
    free(input);
    if (rc == WPK_GL_QUERY_NOT_DISPATCHED) return 0;
    if (!rc && reply[2] == WPK_GL_QUERY_REPLY_MAGIC) {
        if (reply[0] == 1)
            return 0;
        if (reply[0] == 0 && reply[1] == 1) {
            accept_error_proof(proof);
            return 1;
        }
    }
    invalidate_binding_knowledge(_wpk_gl_current_encoder());
    raise_client_error(GL_INVALID_OPERATION);
    return -1;
}
/* Opt-in replies preserve the old mutation payload while adding authoritative
 * container names. Zero in a deletion receipt denotes logical default storage;
 * an accepted attachment always names a nonzero application container. */
static int checked_container_query(uint32_t op, const uint32_t *words, uint32_t count,
                                   uint32_t *containers, uint32_t container_count) {
    uint32_t *input = malloc(count * sizeof *input);
    if (!input) { raise_client_error(GL_OUT_OF_MEMORY); return 0; }
    memcpy(input,words,count * sizeof *input);
    uint32_t reply[5] = {0};
    int query_entered = 0;
    int rc = query_into_tracked(op,input,count * sizeof *input,reply,(container_count+3)*4,&query_entered);
    free(input);
    if (rc == WPK_GL_QUERY_NOT_DISPATCHED) return 0;
    if (rc && !query_entered) {
        // Releasing the candidate is safe only when this attachment/deletion
        // query provably never ran; a prior queued prefix may still be consumed.
        raise_client_error(GL_INVALID_OPERATION);
        return 0;
    }
    if (!rc && reply[container_count+2] == WPK_GL_QUERY_REPLY_MAGIC) {
        if (reply[0] == 1) {
            // Only a canonical rejected receipt proves the candidate unused.
            // Contradictory payload must retain uncertain input ownership.
            uint32_t i = 1;
            while (i < container_count+2 && reply[i] == 0) i++;
            if (i == container_count+2) return 0;
        }
        if (reply[0] == 0 && reply[1] == 1 && (container_count != 1 || reply[2] != 0)) {
            memcpy(containers,reply+2,container_count*4);
            return 1;
        }
    }
    raise_client_error(GL_INVALID_OPERATION);
    return -1;
}
static int delete_image_object(uint32_t kind, GLuint name, uint32_t *containers) {
    uint32_t words[2] = {kind,name};
    return (containers ? checked_container_query(QOP_IMAGE_OBJECT_DELETE,words,2,containers,2)
                       : checked_mutation_query(QOP_IMAGE_OBJECT_DELETE,words,2)) == 1;
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
    // The selected container belongs to the host. Reserve publication storage
    // and the uncertain-completion hold before entering any native mutation.
    struct wpk_image_attachment *reserved = name ? calloc(1,sizeof *reserved) : NULL;
    if (name && !reserved) {
        object_release(group,object); raise_client_error(GL_OUT_OF_MEMORY); return 0;
    }
    struct wpk_pending_image *pending = object ? calloc(1,sizeof *pending) : NULL;
    if (object && !pending) {
        free(reserved); object_release(group,object); raise_client_error(GL_OUT_OF_MEMORY); return 0;
    }
    if (pending) pending->object = object;
    uint32_t words[6] = {kind == GL_RENDERBUFFER ? 2u : 1u,target,point,object_target,name,(uint32_t)level};
    uint32_t framebuffer = 0;
    int accepted = checked_container_query(QOP_IMAGE_ATTACHMENT,words,6,&framebuffer,1);
    if (accepted != 1) {
        free(reserved);
        if (accepted < 0 && pending) quarantine_image_reference(group,pending);
        else { object_release(group,object); free(pending); }
        return 0;
    }
    free(pending);
    struct wpk_image_attachment **slot = &g_image_attachments;
    while (*slot && ((*slot)->framebuffer != framebuffer || (*slot)->point != point)) slot = &(*slot)->next;
    struct wpk_image_attachment *entry = *slot;
    if (!entry && name) { entry = reserved; reserved = NULL; *slot = entry; }
    free(reserved);
    if (!entry) return 1;
    struct wpk_object_name *old = entry->object;
    entry->object = object; entry->framebuffer = framebuffer; entry->point = point;
    if (!name) { *slot = entry->next; free(entry); }
    object_release(group,old);
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
static void delete_attached_image_object(struct wpk_object_name *object, const uint32_t containers[2]) {
    struct wpk_image_attachment **slot = &g_image_attachments;
    while (*slot) {
        struct wpk_image_attachment *entry = *slot;
        if (entry->object != object) {
            slot = &entry->next;
            continue;
        }
        if (entry->framebuffer == containers[0] || entry->framebuffer == containers[1]) {
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
    for (unsigned i = 0; i < vao->attrib_count; i++) {
        object_release(state->objects, vao->attribs[i].buffer_object);
        vao->attribs[i].buffer_object = NULL;
    }
    if (vao->attribs != vao->initial_attribs) free(vao->attribs);
    vao->attribs = vao->initial_attribs;
    vao->attrib_count = WPK_GL_INITIAL_ATTRIBS;
}

/* Release explicit ownership without selecting this context or emitting into
 * another context's stream. Release/exit flushed this context before its last
 * current reference ended; host destruction retires native object maps. */
struct wpk_gl_name_scope _wpk_gl_begin_encoder_retirement(struct wpk_gles_context *state) {
    // Retirement needs no current encoder and must not reconcile a pending
    // texture by querying whichever unrelated context happens to be current.
    struct wpk_gl_name_scope scope=begin_dispatch_scope(state);
    if (scope.group && !publish_program_intents(scope.group)) _wpk_gl_end_name_scope(&scope);
    return scope;
}
void _wpk_gl_retire_encoder_programs(struct wpk_gles_context *state) {
    // Called with the dispatch guard only AFTER acknowledged host retirement.
    // Its context index already retired known and lost-receipt capture owners.
    if (state->program_stream) {
        struct wpk_program_stream **p=&state->objects->program_streams;
        while (*p && *p!=state->program_stream) p=&(*p)->next;
        if (*p) *p=(*p)->next;
        free(state->program_stream);state->program_stream=NULL;
    }
    if (state->current_program) {
        struct wpk_program_record *record=state->current_program;
        state->current_program=NULL;record->references--;
        collect_program_record(state->objects,record);
    }
}
void _wpk_gl_destroy_encoder(struct wpk_gles_context *state) {
    if (!state)
        return;
    // Creation-failure encoders have no host captures; normal retirement has
    // already dropped these names under the same guard as GLIO_DESTROY_CONTEXT.
    struct wpk_gl_name_scope scope=begin_dispatch_scope(state);
    if (!scope.group) return;
    _wpk_gl_retire_encoder_programs(state);
    _wpk_gl_end_name_scope(&scope);
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
        object_release(state->objects, state->texture_units[unit].external_object);
    }
    object_release(state->objects, state->renderbuffer_object);
    if (state->texture_units != state->initial_texture_units)
        free(state->texture_units);
    if (state->framebuffer_names != state->initial_framebuffer_names)
        free(state->framebuffer_names);
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
        if (binding->external_object == object) {
            binding->external_object = NULL;
            binding->external = 0;
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
    const struct wpk_error_proof proof = capture_error_proof();
    int accepted = checked_query_reply(QOP_BIND_IMAGE_OBJECT, input, 12, reply, 4);
    free(input);
    if (accepted) {
        uint32_t value;
        memcpy(&value, reply + 4, 4);
        if (value != 1) {
            raise_client_error(GL_INVALID_OPERATION);
            return 0;
        }
        accept_error_proof(proof);
    }
    return accepted;
}
/* Retain both the selected record and input image before native mutation.
 * Unknown completion keeps those candidates with the entire shared group. */
static int import_image_object(uint32_t kind, GLenum target, struct wpk_object_name *object,
                               GLuint source, struct wpk_egl_image *image) {
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
    input[1] = target;
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
static int sync_object_image_target(uint32_t kind, GLenum target, struct wpk_object_name *object) {
    if (!object)
        return 1;
    uint32_t *input = malloc(8);
    uint8_t reply[16];
    if (!input) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return 0;
    }
    input[0] = kind;
    input[1] = target;
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
static int sync_object_image(uint32_t kind, struct wpk_object_name *object) {
    return sync_object_image_target(kind, kind == 1 ? GL_TEXTURE_2D : GL_RENDERBUFFER, object);
}
/* An exported cube-map face keeps its cube texture a sibling; respecifying
 * any face of that texture ends the association (EGL 1.5 section 3.9). */
static int is_cube_face(GLenum target) {
    return target >= GL_TEXTURE_CUBE_MAP_POSITIVE_X && target <= GL_TEXTURE_CUBE_MAP_NEGATIVE_Z;
}
static int sync_respecified_image(GLenum target) {
    if (target == GL_TEXTURE_2D)
        return sync_object_image(1, g_texture_units[g_active_unit].texture_object);
    if (target != GL_TEXTURE_CUBE_MAP && !is_cube_face(target))
        return 1;
    /* Cube maps are never EGLImage targets; only an exported source needs
     * the extra round trip. */
    struct wpk_object_name *object = g_texture_units[g_active_unit].cube_object;
    struct wpk_object_group *group = _wpk_gl_current_encoder()->objects;
    pthread_mutex_lock(&group->mutex);
    int linked = object && object->image;
    pthread_mutex_unlock(&group->mutex);
    return linked ? sync_object_image_target(1, GL_TEXTURE_CUBE_MAP, object) : 1;
}
int _wpk_gl_image_source_state(struct wpk_gles_context *state, uint32_t kind,
                               uint32_t object_target, uint32_t name) {
    struct wpk_object_group *group = state->objects;
    pthread_mutex_lock(&group->mutex);
    struct wpk_object_name *object =
        find_object_name(group, kind == 1 ? WPK_NAMES_TEXTURE : WPK_NAMES_RENDERBUFFER, name);
    /* A generated name is no object until its first bind fixes its type. */
    int result = !object || object->target != object_target ? WPK_GL_IMAGE_SOURCE_INVALID
               : object->image ? WPK_GL_IMAGE_SOURCE_SIBLING : WPK_GL_IMAGE_SOURCE_READY;
    pthread_mutex_unlock(&group->mutex);
    return result;
}
void _wpk_gl_link_image_source(struct wpk_gles_context *state, uint32_t kind, uint32_t name,
                               struct wpk_egl_image *image, uint32_t source, uint32_t revision) {
    struct wpk_object_group *group = state->objects;
    pthread_mutex_lock(&group->mutex);
    struct wpk_object_name *object =
        find_object_name(group, kind == 1 ? WPK_NAMES_TEXTURE : WPK_NAMES_RENDERBUFFER, name);
    int retained = object && object->references < UINT_MAX;
    if (retained)
        object->references++;
    pthread_mutex_unlock(&group->mutex);
    if (!retained)
        return;
    _wpk_egl_image_retain(image);
    (void)publish_object_image(group, object, image, source, revision);
    object_release(group, object);
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
    if (!_wpk_gl_command_encoder()) return;
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
        uint32_t containers[2];
        if (!delete_image_object(1, names[i], containers)) {
            object_release(group, object);
            continue;
        }
        pthread_mutex_lock(&group->mutex);
        object->named = 0;
        release_object_locked(group, object);
        pthread_mutex_unlock(&group->mutex);
        delete_attached_image_object(object,containers);
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
            if (binding->external_object == object) {
                binding->external_object = NULL;
                binding->external = 0;
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
    if (!_wpk_gl_command_encoder()) return;
    /* OES_EGL_image_external: an object first bound to TEXTURE_EXTERNAL_OES
     * is and remains an external texture (image_target_error below). */
    if (target != GL_TEXTURE_2D && target != GL_TEXTURE_CUBE_MAP && target != GL_TEXTURE_EXTERNAL_OES) {
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
    struct wpk_texture_unit *unit = &state->texture_units[g_active_unit];
    struct wpk_object_name **slot = target == GL_TEXTURE_2D ? &unit->texture_object
                                  : target == GL_TEXTURE_CUBE_MAP ? &unit->cube_object
                                  : &unit->external_object;
    object_release(state->objects, *slot);
    *slot = object;
    if (target == GL_TEXTURE_2D)
        unit->texture = tex;
    else if (target == GL_TEXTURE_CUBE_MAP)
        unit->cube = tex;
    else
        unit->external = tex;
}

void glActiveTexture(GLenum unit) {
    if (!_wpk_gl_command_encoder())
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
    uint8_t *start = cursor;
    w_u16(&cursor, OP_ACTIVE_TEXTURE);
    w_u16(&cursor, 4);
    w_u32(&cursor, unit);
    finish_predicted_command(start,cursor,GL_NO_ERROR);
    g_active_unit = index;
}

/* Bytes per pixel of a glReadPixels destination. Unknown combinations
 * return 0 and are rejected by the native read query. Texture uploads use
 * the admission table below instead. */
static uint32_t bytes_per_pixel(GLenum format, GLenum type) {
    uint32_t channels;
    switch (format) {
        case GL_ALPHA: case GL_LUMINANCE: case 0x1903: /* RED */
        case 0x1902: /* DEPTH_COMPONENT */ channels = 1; break;
        case GL_LUMINANCE_ALPHA: case 0x8227: /* RG */ channels = 2; break;
        case GL_RGB: channels = 3; break;
        case GL_RGBA: channels = 4; break;
        case GL_BGRA_EXT:
            return type == GL_UNSIGNED_BYTE ? 4
                 : type == GL_UNSIGNED_SHORT_4_4_4_4_REV_EXT
                   || type == GL_UNSIGNED_SHORT_1_5_5_5_REV_EXT ? 2 : 0;
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

/* GLES 2.0.25 table 3.4 plus the texture formats of the extensions this
 * platform advertises: the host (host/src/webgl/capabilities.ts) always lists
 * OES_texture_float, OES_texture_half_float, EXT_texture_rg,
 * OES_depth_texture and OES_packed_depth_stencil, and this encoder adds
 * EXT_texture_format_BGRA8888. WebGL 2 would also accept GLES 3 sized,
 * integer and sRGB formats, so admission must happen here, before the checked
 * storage request: one table selects the error and supplies the bytes per
 * pixel used to pack rows, so an admitted upload always has a packing rule.
 * host/src/webgl/es2-formats.ts holds the host's copy of this table. */
static const struct { GLenum format, type; uint8_t bytes; } k_texture_pixels[] = {
    {GL_RGBA, GL_UNSIGNED_BYTE, 4}, {GL_RGBA, GL_UNSIGNED_SHORT_4_4_4_4, 2},
    {GL_RGBA, GL_UNSIGNED_SHORT_5_5_5_1, 2}, {GL_RGB, GL_UNSIGNED_BYTE, 3},
    {GL_RGB, GL_UNSIGNED_SHORT_5_6_5, 2}, {GL_LUMINANCE_ALPHA, GL_UNSIGNED_BYTE, 2},
    {GL_LUMINANCE, GL_UNSIGNED_BYTE, 1}, {GL_ALPHA, GL_UNSIGNED_BYTE, 1},
    /* OES_texture_float and OES_texture_half_float. */
    {GL_RGBA, GL_FLOAT, 16}, {GL_RGBA, GL_HALF_FLOAT_OES, 8},
    {GL_RGB, GL_FLOAT, 12}, {GL_RGB, GL_HALF_FLOAT_OES, 6},
    {GL_LUMINANCE_ALPHA, GL_FLOAT, 8}, {GL_LUMINANCE_ALPHA, GL_HALF_FLOAT_OES, 4},
    {GL_LUMINANCE, GL_FLOAT, 4}, {GL_LUMINANCE, GL_HALF_FLOAT_OES, 2},
    {GL_ALPHA, GL_FLOAT, 4}, {GL_ALPHA, GL_HALF_FLOAT_OES, 2},
    /* EXT_texture_rg, including its float/half-float interactions. */
    {GL_RED_EXT, GL_UNSIGNED_BYTE, 1}, {GL_RED_EXT, GL_FLOAT, 4}, {GL_RED_EXT, GL_HALF_FLOAT_OES, 2},
    {GL_RG_EXT, GL_UNSIGNED_BYTE, 2}, {GL_RG_EXT, GL_FLOAT, 8}, {GL_RG_EXT, GL_HALF_FLOAT_OES, 4},
    /* OES_depth_texture and OES_packed_depth_stencil. */
    {GL_DEPTH_COMPONENT, GL_UNSIGNED_SHORT, 2}, {GL_DEPTH_COMPONENT, GL_UNSIGNED_INT, 4},
    {GL_DEPTH_STENCIL_OES, GL_UNSIGNED_INT_24_8_OES, 4},
    /* EXT_texture_format_BGRA8888 (sent to the host as swizzled RGBA). */
    {GL_BGRA_EXT, GL_UNSIGNED_BYTE, 4},
};

static int texture_format_known(GLenum format) {
    for (size_t i = 0; i < sizeof k_texture_pixels / sizeof k_texture_pixels[0]; i++)
        if (k_texture_pixels[i].format == format) return 1;
    return 0;
}

/* Section 3.7.1/3.7.2: a format or type no advertised API accepts is
 * INVALID_ENUM; a pair outside table 3.4 is INVALID_OPERATION. */
static GLenum texture_pixel_error(GLenum format, GLenum type, uint32_t *bpp) {
    int type_known = 0;
    for (size_t i = 0; i < sizeof k_texture_pixels / sizeof k_texture_pixels[0]; i++) {
        if (k_texture_pixels[i].type != type) continue;
        type_known = 1;
        if (k_texture_pixels[i].format == format) {
            *bpp = k_texture_pixels[i].bytes;
            return GL_NO_ERROR;
        }
    }
    return type_known && texture_format_known(format) ? GL_INVALID_OPERATION : GL_INVALID_ENUM;
}

/* Section 3.7.1: an internal format outside the base formats is
 * INVALID_VALUE, and one that differs from format is INVALID_OPERATION. */
static GLenum texture_image_error(GLint internal, GLenum format, GLenum type, uint32_t *bpp) {
    GLenum error = texture_pixel_error(format, type, bpp);
    if (error == GL_INVALID_ENUM) return error;
    /* Sized internal formats the dEQP-GLES2 tables accept with exactly one
     * unsized pair (glsFboCompletenessTests.cpp s_extTextureRgRboFormats and
     * s_extTextureFormatBGRA8888Formats, uploaded through gluTextureUtil's
     * transfer format): EXT_texture_rg R8/RG8 and BGRA8888's BGRA8_EXT. */
    if ((GLenum)internal == GL_R8_EXT || (GLenum)internal == GL_RG8_EXT || (GLenum)internal == GL_BGRA8_EXT) {
        GLenum base = (GLenum)internal == GL_R8_EXT ? GL_RED_EXT
                      : (GLenum)internal == GL_RG8_EXT ? GL_RG_EXT : GL_BGRA_EXT;
        return format == base && type == GL_UNSIGNED_BYTE ? error : GL_INVALID_OPERATION;
    }
    if (!texture_format_known((GLenum)internal)) return GL_INVALID_VALUE;
    if ((GLenum)internal != format) return GL_INVALID_OPERATION;
    return error;
}

/* OES_depth_texture and OES_packed_depth_stencil: depth and depth-stencil
 * textures exist only for TEXTURE_2D, and "using this format in conjunction
 * with any other <target> will result in an INVALID_OPERATION error". Other
 * invalid targets remain the host's INVALID_ENUM. */
static GLenum depth_texture_target_error(GLenum target, GLenum format) {
    return (format == GL_DEPTH_COMPONENT || format == GL_DEPTH_STENCIL_OES)
        && target >= GL_TEXTURE_CUBE_MAP_POSITIVE_X && target <= GL_TEXTURE_CUBE_MAP_NEGATIVE_Z
        ? GL_INVALID_OPERATION : GL_NO_ERROR;
}

/* Section 3.7.2 CopyTexImage2D base formats, plus EXT_texture_rg. */
static GLenum copy_texture_format_error(GLenum internal) {
    switch (internal) {
        case GL_ALPHA: case GL_LUMINANCE: case GL_LUMINANCE_ALPHA: case GL_RGB: case GL_RGBA:
        case GL_RED_EXT: case GL_RG_EXT:
            return GL_NO_ERROR;
        default:
            return GL_INVALID_ENUM;
    }
}

/* Section 4.4.3 RenderbufferStorage formats plus the extension formats the
 * host advertises: OES_rgb8_rgba8, OES_packed_depth_stencil and
 * EXT_texture_rg, plus GL_EXT_color_buffer_half_float's 16-bit float formats
 * when the host advertises it. 32-bit float formats have no GLES 2
 * extension and are INVALID_ENUM.
 * BGRA and BGRA8_EXT follow the dEQP-GLES2 EXT_texture_format_BGRA8888
 * table (required color-renderable renderbuffers); the host stores them as
 * RGBA8 and reports the requested format. */
static GLenum renderbuffer_format_error(GLenum internal) {
    switch (internal) {
        case GL_RGBA4: case GL_RGB5_A1: case GL_RGB565: case GL_DEPTH_COMPONENT16: case GL_STENCIL_INDEX8:
        case GL_RGB8_OES: case GL_RGBA8_OES: case GL_DEPTH24_STENCIL8_OES: case GL_R8_EXT: case GL_RG8_EXT:
        case GL_BGRA_EXT: case GL_BGRA8_EXT:
        /* GL_EXT_color_buffer_half_float; the host admits these only while it
         * advertises the extension (it depends on the browser's renderer). */
        case GL_RGBA16F_EXT: case GL_RGB16F_EXT: case GL_RG16F_EXT: case GL_R16F_EXT:
            return GL_NO_ERROR;
        default:
            return GL_INVALID_ENUM;
    }
}

static int packed_pixel_format_mismatch(GLenum format, GLenum type) {
    return (type == GL_UNSIGNED_SHORT_5_6_5 && format != GL_RGB) ||
           ((type == GL_UNSIGNED_SHORT_4_4_4_4 || type == GL_UNSIGNED_SHORT_5_5_5_1) &&
            format != GL_RGBA);
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

/* Largest OP_TEX_SUB_IMAGE_2D pixel payload: the TLV payload-length field
 * is u16 and the record header takes 36 bytes. */
#define WPK_TEX_ROW_PAYLOAD (0xFFFFu - 36u)

/* Emit OP_TEX_SUB_IMAGE_2D records for `height` rows of `width` pixels of
 * one column band, the first at `src`, each `src_stride` bytes after the one
 * before. The rows are split into row groups; each group's rows are packed at
 * the host's unpack stride, whose data length is (rows-1)*stride + width*bpp.
 * The caller guarantees that one packed row fits a record. */
static void emit_tex_band(GLenum target, GLint level, GLint xoff, GLint yoff,
                          GLsizei width, GLsizei height,
                          GLenum format, GLenum type, uint32_t bpp,
                          const uint8_t *src, uint32_t src_stride) {
    int swap = format == GL_BGRA_EXT;
    uint32_t stride = unpack_row_stride(width, bpp);
    uint32_t tail = (uint32_t)width * bpp;
    uint32_t max_rows = WPK_TEX_ROW_PAYLOAD / stride;
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
            copy_row(_c + (size_t)r * stride,
                     src + ((size_t)(uint32_t)y + r) * src_stride, tail, swap);
        }
        _c += dlen;
        EMIT_END()
        y += (GLsizei)rows;
    }
}

/* GLES 2.0.25 sections 3.7.1/3.7.2 load the whole image. A packed row wider
 * than one record (RGBA8 at 16375 pixels, RGBA float at 4094) is sent as
 * column bands: ordinary subimage records at an advancing x offset. Each
 * band's rows are packed at that band's own UNPACK_ALIGNMENT stride, which is
 * the stride the host's native unpack applies to a band of that width, and
 * the source is still addressed at the caller's full row stride. */
static void emit_tex_rows(GLenum target, GLint level, GLint xoff, GLint yoff,
                          GLsizei width, GLsizei height,
                          GLenum format, GLenum type, uint32_t bpp,
                          const uint8_t *src, uint32_t src_stride) {
    if (src == NULL || width <= 0 || height <= 0) return;
    /* align(w*bpp) <= payload exactly when w*bpp <= the largest multiple of
     * the alignment that fits; bpp <= 16, so a band has at least one pixel. */
    const uint32_t band_max = (WPK_TEX_ROW_PAYLOAD & ~((uint32_t)g_unpack_alignment - 1u)) / bpp;
    for (uint32_t x = 0; x < (uint32_t)width; ) {
        uint32_t band = (uint32_t)width - x;
        if (band > band_max) band = band_max;
        emit_tex_band(target, level, (GLint)((uint32_t)xoff + x), yoff, (GLsizei)band, height,
                      format, type, bpp, src + (size_t)x * bpp, src_stride);
        x += band;
    }
}

static void emit_tex_sub_image_2d(GLenum target, GLint level,
                                  GLint xoff, GLint yoff,
                                  GLsizei width, GLsizei height,
                                  GLenum format, GLenum type, uint32_t bpp,
                                  const void *data) {
    if (data == NULL) return;
    GLsizei row_pixels = g_unpack_row_length > 0 ? g_unpack_row_length : width;
    uint32_t src_stride = unpack_row_stride(row_pixels, bpp);
    const uint8_t *src = (const uint8_t *)data
        + (uint32_t)g_unpack_skip_rows * src_stride
        + (uint32_t)g_unpack_skip_pixels * bpp;
    emit_tex_rows(target, level, xoff, yoff, width, height, format, type, bpp,
                  src, src_stride);
}

void glTexImage2D(GLenum target, GLint level, GLint internalFormat,
                  GLsizei width, GLsizei height, GLint border,
                  GLenum format, GLenum type, const void *data) {
    if (!_wpk_gl_command_encoder()) return;
    uint32_t bpp = 0;
    GLenum error = texture_image_error(internalFormat, format, type, &bpp);
    if (!error) error = depth_texture_target_error(target, format);
    if (error) {
        raise_client_error(error);
        return;
    }
    if (internalFormat == GL_BGRA_EXT || internalFormat == GL_BGRA8_EXT)
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
    if (!sync_respecified_image(target))
        return;
    emit_tex_sub_image_2d(target, level, 0, 0, width, height, format, type, bpp, data);
}

void glTexSubImage2D(GLenum target, GLint level, GLint xoff, GLint yoff,
                     GLsizei width, GLsizei height,
                     GLenum format, GLenum type, const void *data) {
    if (!_wpk_gl_command_encoder()) return;
    /* Validate the original pair before BGRA normalization or pixel access. */
    uint32_t bpp = 0;
    GLenum error = texture_pixel_error(format, type, &bpp);
    if (!error) error = depth_texture_target_error(target, format);
    if (error) {
        raise_client_error(error);
        return;
    }
    uint32_t words[10] = {OP_TEX_SUB_IMAGE_2D, target, (uint32_t)level,
                          (uint32_t)xoff, (uint32_t)yoff, (uint32_t)width,
                          (uint32_t)height, host_pixel_format(format), type, 0};
    if (checked_mutation_query(QOP_IMAGE_STORAGE, words, 10) != 1)
        return;
    emit_tex_sub_image_2d(target, level, xoff, yoff, width, height,
                          format, type, bpp, data);
}

void glGenerateMipmap(GLenum target) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_BEGIN(OP_GENERATE_MIPMAP, 4)
    w_u32(&_c, (uint32_t)target);
    EMIT_END()
    sync_respecified_image(target);
}

void glTexParameteri(GLenum target, GLenum pname, GLint param) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_BEGIN(OP_TEX_PARAMETERI, 12)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_END()
}

/* Sections 3.6.1 and 4.3.1: GLES 2 has only the two alignment parameters.
 * EXT_unpack_subimage adds three unpack names, which this encoder applies
 * itself while packing rows. WebGL 2's other pixel-store names (pack row
 * length and skips, image height, WEBGL flip/premultiply) are host-private
 * state and are INVALID_ENUM for the guest. */
void glPixelStorei(GLenum pname, GLint param) {
    if (!_wpk_gl_command_encoder()) return;
    if (pname == GL_UNPACK_ALIGNMENT || pname == GL_PACK_ALIGNMENT) {
        if (param != 1 && param != 2 && param != 4 && param != 8) {
            raise_client_error(GL_INVALID_VALUE);
            return;
        }
    } else if (pname != GL_UNPACK_ROW_LENGTH_EXT && pname != GL_UNPACK_SKIP_ROWS_EXT
               && pname != GL_UNPACK_SKIP_PIXELS_EXT) {
        raise_client_error(GL_INVALID_ENUM);
        return;
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
    EMIT_INFALLIBLE_BEGIN(OP_PIXEL_STOREI, 8)
    w_u32(&_c, (uint32_t)pname);
    w_i32(&_c, param);
    EMIT_INFALLIBLE_END()
    if (pname == GL_UNPACK_ALIGNMENT) g_unpack_alignment = param;
    else if (pname == GL_PACK_ALIGNMENT) g_pack_alignment = param;
}

void glDeleteBuffers(GLsizei n, const GLuint *names) {
    if (!_wpk_gl_command_encoder()) return;
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
        for (unsigned a = 0; a < vao->attrib_count; a++)
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
    if (!_wpk_gl_command_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM1I, 8)
    w_i32(&_c, location);
    w_i32(&_c, v);
    EMIT_END()
}
void glUniform1f(GLint location, GLfloat v) {
    if (!_wpk_gl_command_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM1F, 8)
    w_i32(&_c, location);
    w_f32(&_c, v);
    EMIT_END()
}
void glUniform2f(GLint location, GLfloat x, GLfloat y) {
    if (!_wpk_gl_command_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM2F, 12)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y);
    EMIT_END()
}
void glUniform3f(GLint location, GLfloat x, GLfloat y, GLfloat z) {
    if (!_wpk_gl_command_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM3F, 16)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z);
    EMIT_END()
}
void glUniform4f(GLint location, GLfloat x, GLfloat y, GLfloat z, GLfloat w) {
    if (!_wpk_gl_command_encoder()) return;
    if (!uniform_location_accepted(location)) return;
    EMIT_BEGIN(OP_UNIFORM4F, 20)
    w_i32(&_c, location);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z); w_f32(&_c, w);
    EMIT_END()
}

/* ----- framebuffers ------------------------------------------------- */

/* First slot whose name is not below `name`. */
static size_t framebuffer_name_slot(const struct wpk_gles_context *state, GLuint name) {
    size_t low = 0, high = state->framebuffer_name_count;
    while (low < high) {
        size_t middle = low + (high - low) / 2;
        if (state->framebuffer_names[middle] < name) low = middle + 1;
        else high = middle;
    }
    return low;
}
static int framebuffer_name_used(const struct wpk_gles_context *state, GLuint name) {
    size_t slot = framebuffer_name_slot(state, name);
    return slot < state->framebuffer_name_count && state->framebuffer_names[slot] == name;
}
/* Reserve capacity before choosing or publishing any name. */
static int framebuffer_names_reserve(struct wpk_gles_context *state, size_t extra) {
    const size_t count = state->framebuffer_name_count;
    if (state->framebuffer_name_capacity - count >= extra) return 1;
    if (extra > SIZE_MAX / sizeof(GLuint) - count) return 0;
    size_t capacity = state->framebuffer_name_capacity;
    while (capacity < count + extra)
        capacity = capacity > SIZE_MAX / sizeof(GLuint) / 2 ? count + extra : capacity * 2;
    GLuint *names = malloc(capacity * sizeof *names);
    if (!names) return 0;
    if (count) memcpy(names, state->framebuffer_names, count * sizeof *names);
    if (state->framebuffer_names != state->initial_framebuffer_names)
        free(state->framebuffer_names);
    state->framebuffer_names = names;
    state->framebuffer_name_capacity = capacity;
    return 1;
}

void glGenFramebuffers(GLsizei n, GLuint *out) {
    if (!_wpk_gl_command_encoder()) return;
    if (n < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (!n || !out) return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    if (!framebuffer_names_reserve(state, (size_t)n)) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
    /* Skip names already in use, including names a bind created, and never
     * wrap through reserved zero. Check the whole batch before publishing. */
    const size_t first_used = framebuffer_name_slot(state, state->next_framebuffer);
    for (int publish = 0; publish < 2; publish++) {
        GLuint candidate = state->next_framebuffer;
        size_t used = first_used;
        for (GLsizei i = 0; i < n; i++, candidate++) {
            while (candidate && used < state->framebuffer_name_count &&
                   state->framebuffer_names[used] <= candidate) {
                if (state->framebuffer_names[used] == candidate) candidate++;
                used++;
            }
            if (!candidate) {
                raise_client_error(GL_OUT_OF_MEMORY);
                return;
            }
            if (publish) out[i] = candidate;
        }
        if (publish) state->next_framebuffer = candidate;
    }
    /* Both runs are ascending; merge from the end into reserved capacity. */
    size_t existing = state->framebuffer_name_count, added = (size_t)n;
    for (size_t at = existing + added; added; ) {
        if (existing && state->framebuffer_names[existing - 1] > out[added - 1])
            state->framebuffer_names[--at] = state->framebuffer_names[--existing];
        else
            state->framebuffer_names[--at] = out[--added];
    }
    state->framebuffer_name_count += (size_t)n;
    /* The renderer only reserves; the first bind creates the object. */
    emit_name_array(OP_GEN_FRAMEBUFFERS, n, out);
}

void glDeleteFramebuffers(GLsizei n, const GLuint *names) {
    if (!_wpk_gl_command_encoder()) return;
    if (n < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (!n || !names)
        return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    for (GLsizei i = 0; i < n; i++) {
        if (!delete_image_object(3, names[i], NULL))
            continue;
        retire_image_attachments(names[i]);
        size_t slot = framebuffer_name_slot(state, names[i]);
        if (names[i] && slot < state->framebuffer_name_count && state->framebuffer_names[slot] == names[i]) {
            memmove(state->framebuffer_names + slot, state->framebuffer_names + slot + 1,
                    (state->framebuffer_name_count - slot - 1) * sizeof *state->framebuffer_names);
            state->framebuffer_name_count--;
        }
    }
}

/* Section 4.4.1: FRAMEBUFFER is the only GLES 2 framebuffer target. */
void glBindFramebuffer(GLenum target, GLuint fb) {
    if (!_wpk_gl_command_encoder()) return;
    if (target != GL_FRAMEBUFFER) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    /* Binding an unused name creates a framebuffer, so later generation must
     * skip it. Mark it before the unchecked bind: if the renderer rejects the
     * bind, the name merely stays unused by generation, which is harmless. */
    if (fb && !framebuffer_name_used(state, fb)) {
        if (!framebuffer_names_reserve(state, 1)) {
            raise_client_error(GL_OUT_OF_MEMORY);
            return;
        }
        size_t slot = framebuffer_name_slot(state, fb);
        memmove(state->framebuffer_names + slot + 1, state->framebuffer_names + slot,
                (state->framebuffer_name_count - slot) * sizeof *state->framebuffer_names);
        state->framebuffer_names[slot] = fb;
        state->framebuffer_name_count++;
    }
    if (!fb) {
        EMIT_INFALLIBLE_BEGIN(OP_BIND_FRAMEBUFFER,8)
        w_u32(&_c,target); w_u32(&_c,fb);
        EMIT_INFALLIBLE_END()
    } else {
        state->default_framebuffer_only = 0;
        EMIT_BEGIN(OP_BIND_FRAMEBUFFER,8)
        w_u32(&_c,target); w_u32(&_c,fb);
        EMIT_END()
    }
}

void glFramebufferTexture2D(GLenum target, GLenum attachment,
                            GLenum textarget, GLuint texture, GLint level) {
    if (!_wpk_gl_command_encoder()) return;
    if (target != GL_FRAMEBUFFER || (attachment != GL_COLOR_ATTACHMENT0 && attachment != GL_DEPTH_ATTACHMENT && attachment != GL_STENCIL_ATTACHMENT)
        || (textarget != GL_TEXTURE_2D && (textarget < GL_TEXTURE_CUBE_MAP_POSITIVE_X || textarget > GL_TEXTURE_CUBE_MAP_NEGATIVE_Z))) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    if (level != 0) { raise_client_error(GL_INVALID_VALUE); return; }
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
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_BLEND_FUNC, 8, scalar_blend_factor(sfactor,1) && scalar_blend_factor(dfactor,0) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)sfactor);
    w_u32(&_c, (uint32_t)dfactor);
    EMIT_PREDICTED_END()
}

void glBlendFuncSeparate(GLenum srcRGB, GLenum dstRGB,
                         GLenum srcAlpha, GLenum dstAlpha) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_BLEND_FUNC_SEPARATE, 16, scalar_blend_factor(srcRGB,1) && scalar_blend_factor(dstRGB,0) && scalar_blend_factor(srcAlpha,1) && scalar_blend_factor(dstAlpha,0) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)srcRGB);
    w_u32(&_c, (uint32_t)dstRGB);
    w_u32(&_c, (uint32_t)srcAlpha);
    w_u32(&_c, (uint32_t)dstAlpha);
    EMIT_PREDICTED_END()
}

void glBlendEquationSeparate(GLenum modeRGB, GLenum modeAlpha) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_BLEND_EQUATION_SEPARATE, 8, scalar_blend_equation(modeRGB) && scalar_blend_equation(modeAlpha) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)modeRGB);
    w_u32(&_c, (uint32_t)modeAlpha);
    EMIT_PREDICTED_END()
}

void glBlendEquation(GLenum mode) {
    if (!_wpk_gl_command_encoder()) return;
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
    if (gl_device_ioctl(fd, GLIO_QUERY, &info) != 0)
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
    if (!_wpk_gl_command_encoder())
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
    if (!_wpk_gl_command_encoder()) return 0;
    if (target != GL_FRAMEBUFFER) {
        raise_client_error(GL_INVALID_ENUM);
        return 0;
    }
    uint32_t t = (uint32_t)target;
    uint32_t status = 0;
    if (_wpk_gl_query_into(QOP_CHECK_FB_STATUS, &t, 4, &status, 4) != 0) return 0;
    return (GLenum)status;
}

/* A captured native read is never repeated on an unknown reply. Preallocate
 * cancellation buffers before admission, and publish only after every copied
 * byte and the final release have been acknowledged. */
static int readback_capture_query(int fd, uint8_t *request, uint32_t input_len,
                                  uint8_t *reply, uint32_t output_len,
                                  uint32_t token, uint32_t expected, int quiet) {
    memset(reply,0,output_len);
    struct gl_query_info info = {.op=QOP_READBACK_CAPTURE,
        .in_buf_ptr=(uintptr_t)request,.in_buf_len=input_len,
        .out_buf_ptr=(uintptr_t)reply,.out_buf_len=output_len,.reserved=0};
    if (gl_device_ioctl(fd,GLIO_QUERY,&info) != 0) goto invalid;
    uint32_t status,echoed,count,magic;
    memcpy(&status,reply,4);memcpy(&echoed,reply+4,4);memcpy(&count,reply+8,4);
    memcpy(&magic,reply+output_len-4,4);
    if (status>1 || magic!=WPK_GL_QUERY_REPLY_MAGIC) goto invalid;
    if (status) return 0; /* The host's original GL error owns this rejection. */
    if (echoed!=token || count!=expected) goto invalid;
    return 1;
invalid:
    if (!quiet) raise_client_error(GL_INVALID_OPERATION);
    return 0;
}
static int captured_read_pixels(const uint8_t metadata[24], uint8_t *pixels, uint32_t total) {
    struct wpk_gles_context *state=_wpk_gl_current_encoder();
    if (state->next_readback_capture==UINT32_MAX) {raise_client_error(GL_OUT_OF_MEMORY);return 0;}
    uint8_t *request=malloc(36),*reply=malloc(65536);
    if (!request || !reply) {free(request);free(reply);raise_client_error(GL_OUT_OF_MEMORY);return 0;}
    if (flush_commands()!=0) {free(request);free(reply);return 0;}
    int fd=_wpk_gl_fd(),success=0;
    uint32_t token=++state->next_readback_capture;
    uint32_t header[3]={1,token,total};memcpy(request,header,12);memcpy(request+12,metadata,24);
    if (!readback_capture_query(fd,request,36,reply,16,token,total,0)) goto abort;
    for (uint32_t offset=0;offset<total;) {
        uint32_t count=total-offset;if (count>65520u) count=65520u;
        uint32_t chunk[4]={2,token,offset,count};memcpy(request,chunk,16);
        if (!readback_capture_query(fd,request,16,reply,count+16,token,count,0)) goto abort;
        memcpy(pixels+offset,reply+12,count);offset+=count;
    }
    header[0]=3;memcpy(request,header,8);
    if (!readback_capture_query(fd,request,8,reply,16,token,0,0)) goto abort;
    success=1;goto done;
abort:
    header[0]=3;memcpy(request,header,8);
    (void)readback_capture_query(fd,request,8,reply,16,token,0,1);
done:
    free(request);free(reply);return success;
}

/* GL_EXT_read_format_bgra destination types. */
static int read_bgra_type(GLenum type) {
    return type == GL_UNSIGNED_BYTE || type == GL_UNSIGNED_SHORT_4_4_4_4_REV_EXT
        || type == GL_UNSIGNED_SHORT_1_5_5_5_REV_EXT;
}

/* GL_EXT_read_format_bgra: valid ReadPixels format and type enums that do
 * not form one of its three pairs. GLES 2.0.25 section 4.3.1 makes such a
 * combination INVALID_OPERATION; an unknown enum is left to the host, whose
 * INVALID_ENUM is authoritative. */
static int read_bgra_mismatch(GLenum format, GLenum type) {
    if (format == GL_BGRA_EXT)
        return !read_bgra_type(type)
            && (bytes_per_pixel(GL_RGBA, type) || type == GL_UNSIGNED_SHORT_5_6_5);
    return (type == GL_UNSIGNED_SHORT_4_4_4_4_REV_EXT || type == GL_UNSIGNED_SHORT_1_5_5_5_REV_EXT)
        && bytes_per_pixel(format, GL_UNSIGNED_BYTE);
}

/* Convert one row of RGBA8 staging into GL_EXT_read_format_bgra layout.
 * Packed types use the GL normalized fixed-point conversion
 * round(c / 255 * (2^n - 1)); with format BGRA the first (least
 * significant) component of a _REV type is blue, so 4_4_4_4_REV is
 * ARGB4444 and 1_5_5_5_REV is ARGB1555 in a native-endian short. */
static void pack_bgra_row(uint8_t *dst, const uint8_t *rgba, uint32_t width, GLenum type) {
    for (uint32_t i = 0; i < width; i++, rgba += 4) {
        const uint32_t r = rgba[0], g = rgba[1], b = rgba[2], a = rgba[3];
        if (type == GL_UNSIGNED_BYTE) {
            dst[0] = (uint8_t)b; dst[1] = (uint8_t)g; dst[2] = (uint8_t)r; dst[3] = (uint8_t)a;
            dst += 4;
            continue;
        }
        uint16_t value;
        if (type == GL_UNSIGNED_SHORT_4_4_4_4_REV_EXT)
            value = (uint16_t)(((a * 15u + 127u) / 255u) << 12 | ((r * 15u + 127u) / 255u) << 8
                             | ((g * 15u + 127u) / 255u) << 4 | (b * 15u + 127u) / 255u);
        else
            value = (uint16_t)(((a + 127u) / 255u) << 15 | ((r * 31u + 127u) / 255u) << 10
                             | ((g * 31u + 127u) / 255u) << 5 | (b * 31u + 127u) / 255u);
        memcpy(dst, &value, 2);
        dst += 2;
    }
}

/* `limit` is ReadnPixels' bufSize (UINT64_MAX for ReadPixels). */
static void read_pixels(GLint x, GLint y, GLsizei width, GLsizei height,
                        GLenum format, GLenum type, uint64_t limit, void *pixels) {
    if (width < 0 || height < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    /* GLES 2.0 sections 3.6.2/4.3.1 require INVALID_OPERATION for these
     * packed-component mismatches, independently of destination storage. */
    if (packed_pixel_format_mismatch(format, type) || read_bgra_mismatch(format, type)) {
        raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    uint32_t bpp = bytes_per_pixel(format, type);
    /* GL_EXT_read_format_bgra (a client extension, advertised below): WebGL 2
     * reads no BGRA layout, so the host performs the native RGBA/UNSIGNED_BYTE
     * read and this encoder converts the staged rows. That native read is
     * accepted from normalized fixed-point color buffers and rejected (with
     * the host's error) from float ones, so BGRA reads follow the same rule.
     * The host's PACK_ALIGNMENT is the guest's, so staging rows use the
     * caller's alignment at four bytes per pixel. */
    const int bgra = format == GL_BGRA_EXT && read_bgra_type(type);
    const uint32_t staged_bpp = bgra ? 4 : bpp;
    uint8_t in[24];
    int32_t xi = x, yi = y;
    int32_t wi = width, hi = height;
    uint32_t fmt = bgra ? GL_RGBA : (uint32_t)format;
    uint32_t t = bgra ? GL_UNSIGNED_BYTE : (uint32_t)type;
    memcpy(in,      &xi,  4);
    memcpy(in + 4,  &yi,  4);
    memcpy(in + 8,  &wi,  4);
    memcpy(in + 12, &hi,  4);
    memcpy(in + 16, &fmt, 4);
    memcpy(in + 20, &t,   4);
    /* Empty reads still validate enums, framebuffer and implementation format.
     * Unknown pixel layouts are rejected by that same native query. */
    if (!width || !height || !bpp) {
        (void)_wpk_gl_query_into(QOP_READ_PIXELS, in, sizeof in, NULL, 0);
        return;
    }
    const uint64_t align_mask = (uint64_t)(uint32_t)g_pack_alignment - 1u;
    uint64_t row = (uint64_t)(uint32_t)width * bpp;
    uint64_t stride = (row + align_mask) & ~align_mask;
    /* Below 2^63 once the stride fits 32 bits; a wider stride is beyond any
     * GLsizei buffer and any allocation. */
    uint64_t dest_required = stride > UINT32_MAX ? UINT64_MAX
        : (uint64_t)((uint32_t)height - 1u) * stride + row;
    /* EXT/KHR_robustness section 4.3.1: a destination smaller than the
     * packed image is INVALID_OPERATION and is not written. */
    if (limit != UINT64_MAX && dest_required > limit) {
        raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    if (!pixels) return;
    uint64_t staged_row = (uint64_t)(uint32_t)width * staged_bpp;
    uint64_t staged_stride = (staged_row + align_mask) & ~align_mask;
    /* Bound before multiplication: oversized signed dimensions and wide
     * component types must never wrap into a smaller destination allocation.
     * Staging is never narrower than the destination. */
    if (staged_stride > UINT32_MAX) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
    uint64_t required = (uint64_t)((uint32_t)height - 1u) * staged_stride + staged_row;
    if (required > UINT32_MAX || required > SIZE_MAX) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
    uint32_t out_len = (uint32_t)required;
    uint8_t *reply = malloc(out_len);
    if (!reply) {
        raise_client_error(GL_OUT_OF_MEMORY);
        return;
    }
    int accepted = out_len > 65536u ? captured_read_pixels(in,reply,out_len)
        : _wpk_gl_query_into(QOP_READ_PIXELS,in,sizeof in,reply,out_len)==0;
    if (accepted) {
        /* Pack padding belongs to the caller. Transport staging must never
         * overwrite it, nor publish any pixel after a rejected native read. */
        for (uint32_t r = 0; r < (uint32_t)height; ++r) {
            uint8_t *dst = (uint8_t *)pixels + r * (uint32_t)stride;
            const uint8_t *src = reply + r * (uint32_t)staged_stride;
            if (bgra) pack_bgra_row(dst, src, (uint32_t)width, type);
            else memcpy(dst, src, (size_t)row);
        }
    }
    free(reply);
}
void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height,
                  GLenum format, GLenum type, void *pixels) {
    if (!_wpk_gl_command_encoder()) return;
    read_pixels(x, y, width, height, format, type, UINT64_MAX, pixels);
}
void glReadnPixelsEXT(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format,
                      GLenum type, GLsizei bufSize, void *data) {
    if (!_wpk_gl_command_encoder()) return;
    read_pixels(x, y, width, height, format, type, bufSize < 0 ? 0 : (uint64_t)bufSize, data);
}
void glReadnPixelsKHR(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format,
                      GLenum type, GLsizei bufSize, void *data) {
    glReadnPixelsEXT(x, y, width, height, format, type, bufSize, data);
}

void glGetShaderiv(GLuint shader, GLenum pname, GLint *params) {
    if (!_wpk_gl_command_encoder()) return;
    if (!params) return;
    uint8_t in[8];
    uint32_t s = shader, p = (uint32_t)pname;
    memcpy(in, &s, 4); memcpy(in + 4, &p, 4);
    int32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_SHADERIV, in, 8, &out, 4) != 0) return;
    *params = out;
}

static int query_object_blob(uint32_t op, uint32_t *input, uint32_t words,
                             uint32_t header_size, uint32_t unit, uint32_t limit,
                             uint8_t **bytes, uint32_t *count, uint32_t header[3]);

void glGetShaderInfoLog(GLuint object, GLsizei bufSize, GLsizei *length, GLchar *infoLog) {
    if (!_wpk_gl_command_encoder()) return;
    if (bufSize < 0) { raise_client_error(GL_INVALID_VALUE); return; }
    if (bufSize > 0 && !infoLog) return;
    uint32_t input[3]={object,0,0},count,header[3];uint8_t *bytes;
    uint32_t limit=bufSize>0?(uint32_t)bufSize-1:0;
    if (!query_object_blob(QOP_GET_SHADER_INFO_LOG,input,3,4,1,limit,&bytes,&count,header)) return;
    if (bufSize>0) { if(count)memcpy(infoLog,bytes,count);infoLog[count]='\0'; }
    if(length)*length=(GLsizei)count;
    free(bytes);
}

void glGetProgramiv(GLuint program, GLenum pname, GLint *params) {
    if (!_wpk_gl_command_encoder()) return;
    if (!params) return;
    struct wpk_gl_name_scope scope __attribute__((cleanup(_wpk_gl_end_name_scope))) =
        _wpk_gl_begin_name_scope(_wpk_gl_current_encoder());
    if (!scope.group) return;
    uint8_t in[8];
    uint32_t s = program, p = (uint32_t)pname;
    memcpy(in, &s, 4); memcpy(in + 4, &p, 4);
    int32_t out = 0;
    if (_wpk_gl_query_into(QOP_GET_PROGRAMIV, in, 8, &out, 4) != 0) return;
    struct wpk_program_record *record=find_program_record(scope.group,program);
    if (record && record->kind==5 && pname==GL_LINK_STATUS && (out==0 || out==1)) {
        record->link_known=1;record->linked=out;
    }
    *params = out;
}

void glGetProgramInfoLog(GLuint object, GLsizei bufSize, GLsizei *length, GLchar *infoLog) {
    if (!_wpk_gl_command_encoder()) return;
    if (bufSize < 0) { raise_client_error(GL_INVALID_VALUE); return; }
    if (bufSize > 0 && !infoLog) return;
    uint32_t input[3]={object,0,0},count,header[3];uint8_t *bytes;
    uint32_t limit=bufSize>0?(uint32_t)bufSize-1:0;
    if (!query_object_blob(QOP_GET_PROGRAM_INFO_LOG,input,3,4,1,limit,&bytes,&count,header)) return;
    if (bufSize>0) { if(count)memcpy(infoLog,bytes,count);infoLog[count]='\0'; }
    if(length)*length=(GLsizei)count;
    free(bytes);
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
    /* ReadPixels BGRA layouts are converted from the native RGBA read by
     * glReadPixels; the host's IMPLEMENTATION_COLOR_READ pair stays its own
     * native layout. */
    "GL_EXT_read_format_bgra",
    "GL_EXT_texture_format_BGRA8888",
    "GL_EXT_unpack_subimage",
    "GL_OES_EGL_image",
    /* TEXTURE_EXTERNAL_OES bindings and samplerExternalOES: the host keeps
     * each unit's external binding and binds it for the draws whose
     * program samples it (host/src/webgl/external-texture.ts). */
    "GL_OES_EGL_image_external",
    /* Fence placement is supplied by the EGL client facade, rather than a
     * WebGL getExtension name. It adds no GLES entry points. */
    "GL_OES_EGL_sync",
    /* Reset notification is kept by libEGL from the host's renderer-lost
     * replies; the bounded queries are client-side checks. */
    "GL_EXT_robustness",
    "GL_KHR_robustness",
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
    if (!_wpk_gl_command_encoder()) return NULL;
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
    if (!_wpk_gl_command_encoder()) return;
    if (!data)
        return;
    /* EXT/KHR_robustness context state, fixed at creation by libEGL. */
    GLint robust;
    if (_wpk_gl_robustness_state(pname, &robust)) { *data = robust; return; }
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
    if (!_wpk_gl_command_encoder()) return;
    if ((shadertype != GL_VERTEX_SHADER && shadertype != GL_FRAGMENT_SHADER) ||
        (precisiontype != GL_LOW_FLOAT && precisiontype != GL_MEDIUM_FLOAT &&
         precisiontype != GL_HIGH_FLOAT && precisiontype != GL_LOW_INT &&
         precisiontype != GL_MEDIUM_INT && precisiontype != GL_HIGH_INT)) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    uint8_t in[8];
    uint32_t s = (uint32_t)shadertype, p = (uint32_t)precisiontype;
    memcpy(in, &s, 4); memcpy(in + 4, &p, 4);
    int32_t out[3] = { 0, 0, 0 };
    if (_wpk_gl_query_into(QOP_GET_SHADER_PRECISION_FORMAT,
                           in, 8, out, 12) != 0) return;
    if (range) { range[0] = out[0]; range[1] = out[1]; }
    if (precision) *precision = out[2];
}

void glHint(GLenum target, GLenum mode) {
    struct wpk_gles_context *state = _wpk_gl_command_encoder();
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
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_BLEND_COLOR, 16)
    w_f32(&_c, r); w_f32(&_c, g); w_f32(&_c, b); w_f32(&_c, a);
    EMIT_INFALLIBLE_END()
}

void glClearDepthf(GLfloat d) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_CLEAR_DEPTHF, 4)
    w_f32(&_c, d);
    EMIT_INFALLIBLE_END()
}

void glClearStencil(GLint s) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_CLEAR_STENCIL, 4)
    w_i32(&_c, s);
    EMIT_INFALLIBLE_END()
}

void glColorMask(GLboolean r, GLboolean g, GLboolean b, GLboolean a) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_COLOR_MASK, 16)
    w_u32(&_c, r ? 1u : 0u);
    w_u32(&_c, g ? 1u : 0u);
    w_u32(&_c, b ? 1u : 0u);
    w_u32(&_c, a ? 1u : 0u);
    EMIT_INFALLIBLE_END()
}

void glDepthMask(GLboolean flag) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_DEPTH_MASK, 4)
    w_u32(&_c, flag ? 1u : 0u);
    EMIT_INFALLIBLE_END()
}

void glDepthFunc(GLenum func) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_DEPTH_FUNC, 4, scalar_compare(func) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)func);
    EMIT_PREDICTED_END()
}

void glCullFace(GLenum mode) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_CULL_FACE, 4, scalar_face(mode) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)mode);
    EMIT_PREDICTED_END()
}

void glFrontFace(GLenum mode) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_FRONT_FACE, 4, mode == GL_CW || mode == GL_CCW ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)mode);
    EMIT_PREDICTED_END()
}

void glLineWidth(GLfloat width) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_LINE_WIDTH, 4, width > 0 ? GL_NO_ERROR : GL_INVALID_VALUE)
    w_f32(&_c, width);
    EMIT_PREDICTED_END()
}

void glStencilFunc(GLenum func, GLint ref, GLuint mask) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_STENCIL_FUNC, 12, scalar_compare(func) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)func);
    w_i32(&_c, ref);
    w_u32(&_c, mask);
    EMIT_PREDICTED_END()
}

void glStencilFuncSeparate(GLenum face, GLenum func, GLint ref, GLuint mask) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_STENCIL_FUNC_SEPARATE, 16, scalar_face(face) && scalar_compare(func) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)face);
    w_u32(&_c, (uint32_t)func);
    w_i32(&_c, ref);
    w_u32(&_c, mask);
    EMIT_PREDICTED_END()
}

void glStencilMask(GLuint mask) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_STENCIL_MASK, 4)
    w_u32(&_c, mask);
    EMIT_INFALLIBLE_END()
}

void glStencilMaskSeparate(GLenum face, GLuint mask) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_STENCIL_MASK_SEPARATE, 8, scalar_face(face) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)face);
    w_u32(&_c, mask);
    EMIT_PREDICTED_END()
}

void glStencilOp(GLenum fail, GLenum zfail, GLenum zpass) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_STENCIL_OP, 12, scalar_stencil_op(fail) && scalar_stencil_op(zfail) && scalar_stencil_op(zpass) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)fail);
    w_u32(&_c, (uint32_t)zfail);
    w_u32(&_c, (uint32_t)zpass);
    EMIT_PREDICTED_END()
}

void glStencilOpSeparate(GLenum face, GLenum fail, GLenum zfail, GLenum zpass) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_PREDICTED_BEGIN(OP_STENCIL_OP_SEPARATE, 16, scalar_face(face) && scalar_stencil_op(fail) && scalar_stencil_op(zfail) && scalar_stencil_op(zpass) ? GL_NO_ERROR : GL_INVALID_ENUM)
    w_u32(&_c, (uint32_t)face);
    w_u32(&_c, (uint32_t)fail);
    w_u32(&_c, (uint32_t)zfail);
    w_u32(&_c, (uint32_t)zpass);
    EMIT_PREDICTED_END()
}

void glPolygonOffset(GLfloat factor, GLfloat units) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_POLYGON_OFFSET, 8)
    w_f32(&_c, factor);
    w_f32(&_c, units);
    EMIT_INFALLIBLE_END()
}

void glDepthRangef(GLfloat n, GLfloat f) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_DEPTH_RANGEF, 8)
    w_f32(&_c, n);
    w_f32(&_c, f);
    EMIT_INFALLIBLE_END()
}

void glSampleCoverage(GLfloat value, GLboolean invert) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_INFALLIBLE_BEGIN(OP_SAMPLE_COVERAGE, 8)
    w_f32(&_c, value);
    w_u32(&_c, invert ? 1u : 0u);
    EMIT_INFALLIBLE_END()
}

void glReleaseShaderCompiler(void) {
    if (!_wpk_gl_command_encoder()) return;}

void glVertexAttrib4f(GLuint index, GLfloat x, GLfloat y, GLfloat z, GLfloat w) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_BEGIN(OP_VERTEX_ATTRIB_4FV, 20)
    w_u32(&_c, index);
    w_f32(&_c, x); w_f32(&_c, y); w_f32(&_c, z); w_f32(&_c, w);
    EMIT_END()
}

void glVertexAttrib1f(GLuint index, GLfloat x) {
    if (!_wpk_gl_command_encoder()) return;
    glVertexAttrib4f(index, x, 0.0f, 0.0f, 1.0f);
}

void glVertexAttrib2f(GLuint index, GLfloat x, GLfloat y) {
    if (!_wpk_gl_command_encoder()) return;
    glVertexAttrib4f(index, x, y, 0.0f, 1.0f);
}

void glVertexAttrib3f(GLuint index, GLfloat x, GLfloat y, GLfloat z) {
    if (!_wpk_gl_command_encoder()) return;
    glVertexAttrib4f(index, x, y, z, 1.0f);
}

void glVertexAttrib1fv(GLuint index, const GLfloat *v) {
    if (!_wpk_gl_command_encoder()) return;
    if (v) glVertexAttrib1f(index, v[0]);
}

void glVertexAttrib2fv(GLuint index, const GLfloat *v) {
    if (!_wpk_gl_command_encoder()) return;
    if (v) glVertexAttrib2f(index, v[0], v[1]);
}

void glVertexAttrib3fv(GLuint index, const GLfloat *v) {
    if (!_wpk_gl_command_encoder()) return;
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
    if (!_wpk_gl_command_encoder()) return;
    if (!data)
        return;
    /* EXT/KHR_robustness context state, fixed at creation by libEGL. */
    GLint robust;
    if (_wpk_gl_robustness_state(pname, &robust)) { *data = (GLfloat)robust; return; }
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
    if (!_wpk_gl_command_encoder()) return;
    if (!data)
        return;
    /* EXT/KHR_robustness context state, fixed at creation by libEGL. */
    GLint robust;
    if (_wpk_gl_robustness_state(pname, &robust)) { *data = robust != 0 ? GL_TRUE : GL_FALSE; return; }
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
    if (!_wpk_gl_command_encoder()) return;
    EMIT_BEGIN(OP_TEX_PARAMETERF, 12)
    w_u32(&_c, (uint32_t)target);
    w_u32(&_c, (uint32_t)pname);
    w_f32(&_c, param);
    EMIT_END()
}

void glTexParameteriv(GLenum target, GLenum pname, const GLint *params) {
    if (!_wpk_gl_command_encoder()) return;
    if (params) glTexParameteri(target, pname, params[0]);
}

void glTexParameterfv(GLenum target, GLenum pname, const GLfloat *params) {
    if (!_wpk_gl_command_encoder()) return;
    if (params) glTexParameterf(target, pname, params[0]);
}

/* One compressed API call owns an opaque checked transaction. No row/band
 * operation is equivalent to a compressed full-image validation. BEGIN can
 * reject metadata before touching source bytes; COMMIT alone mutates native
 * storage. Unknown completion is never replayed. */
static int compressed_upload_query(int fd, uint8_t *request, uint32_t length,
                                    uint8_t *reply, uint32_t token, int quiet) {
    memset(reply,0,12);
    struct gl_query_info info = {.op=QOP_COMPRESSED_UPLOAD,
        .in_buf_ptr=(uintptr_t)request,.in_buf_len=length,
        .out_buf_ptr=(uintptr_t)reply,.out_buf_len=12};
    if (gl_device_ioctl(fd,GLIO_QUERY,&info) == 0) {
        uint32_t status,echoed,footer;
        memcpy(&status,reply,4);memcpy(&echoed,reply+4,4);memcpy(&footer,reply+8,4);
        if (footer==WPK_GL_QUERY_REPLY_MAGIC && status<=1) {
            if (status==1 && echoed==0) return 0;
            if (status==0 && echoed==token) return 1;
        }
    }
    if (!quiet) raise_client_error(GL_INVALID_OPERATION);
    return 0;
}
static void compressed_upload(uint32_t op, GLenum target, GLint level, GLenum format,
                                GLint x, GLint y, GLsizei width, GLsizei height,
                                GLint border, GLsizei imageSize, const void *data) {
    struct wpk_gles_context *state=_wpk_gl_command_encoder();
    if (!state) return;
    if (imageSize<0) {raise_client_error(GL_INVALID_VALUE);return;}
    if (state->next_compressed_upload==UINT32_MAX) {raise_client_error(GL_OUT_OF_MEMORY);return;}
    uint8_t *request=malloc(65536), *reply=malloc(12);
    if (!request || !reply) {free(request);free(reply);raise_client_error(GL_OUT_OF_MEMORY);return;}
    if (flush_commands()!=0) {free(request);free(reply);return;}
    const int fd=_wpk_gl_fd();
    const uint32_t token=++state->next_compressed_upload;
    uint32_t header[13]={1,token,op,target,(uint32_t)level,format,(uint32_t)x,(uint32_t)y,
        (uint32_t)width,(uint32_t)height,(uint32_t)border,(uint32_t)imageSize,data!=NULL};
    memcpy(request,header,sizeof header);
    if (!compressed_upload_query(fd,request,sizeof header,reply,token,0)) goto cancel;
    if (imageSize>0 && !data) {raise_client_error(GL_INVALID_VALUE);goto cancel;}
    if ((uint32_t)imageSize>WPK_GL_COMPRESSED_UPLOAD_MAX_BYTES) {raise_client_error(GL_OUT_OF_MEMORY);goto cancel;}
    if ((uintptr_t)data>UINTPTR_MAX-(uintptr_t)imageSize) {raise_client_error(GL_OUT_OF_MEMORY);goto cancel;}
    for (uint32_t offset=0;offset<(uint32_t)imageSize;) {
        uint32_t bytes=(uint32_t)imageSize-offset;
        if (bytes>65524u) bytes=65524u;
        header[0]=2;header[2]=offset;memcpy(request,header,12);
        memcpy(request+12,(const uint8_t *)data+offset,bytes);
        if (!compressed_upload_query(fd,request,12+bytes,reply,token,0)) goto cancel;
        offset+=bytes;
    }
    header[0]=3;header[2]=0;memcpy(request,header,12);
    if (!compressed_upload_query(fd,request,12,reply,token,0)) goto cancel;
    if (op==OP_COMPRESSED_TEX_IMAGE_2D)
        sync_respecified_image(target);
    free(request);free(reply);return;
cancel:
    /* ABORT drops staged bytes only. It cannot undo or repeat an uncertain
     * accepted native COMMIT; image input ownership stays conservatively held. */
    header[0]=4;header[2]=0;memcpy(request,header,12);
    (void)compressed_upload_query(fd,request,12,reply,token,1);
    free(request);free(reply);
}
void glCompressedTexImage2D(GLenum target, GLint level, GLenum internalformat,
                            GLsizei width, GLsizei height, GLint border,
                            GLsizei imageSize, const void *data) {
    compressed_upload(OP_COMPRESSED_TEX_IMAGE_2D,target,level,internalformat,0,0,width,height,border,imageSize,data);
}
void glCompressedTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset,
                               GLsizei width, GLsizei height, GLenum format,
                               GLsizei imageSize, const void *data) {
    compressed_upload(OP_COMPRESSED_TEX_SUB_IMAGE_2D,target,level,format,xoffset,yoffset,width,height,0,imageSize,data);
}

void glCopyTexImage2D(GLenum target, GLint level, GLenum internalformat,
                      GLint x, GLint y, GLsizei width, GLsizei height, GLint border) {
    if (!_wpk_gl_command_encoder()) return;
    GLenum error = copy_texture_format_error(internalformat);
    if (error) {
        raise_client_error(error);
        return;
    }
    EMIT_BEGIN(OP_COPY_TEX_IMAGE_2D, 32)
    w_u32(&_c, (uint32_t)target);
    w_i32(&_c, level);
    w_u32(&_c, (uint32_t)internalformat);
    w_i32(&_c, x); w_i32(&_c, y); w_i32(&_c, width); w_i32(&_c, height); w_i32(&_c, border);
    EMIT_END()
    sync_respecified_image(target);
}

void glCopyTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset,
                         GLint x, GLint y, GLsizei width, GLsizei height) {
    if (!_wpk_gl_command_encoder()) return;
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
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_fv(OP_UNIFORM1FV, location, count, value, 1);
}

void glUniform2fv(GLint location, GLsizei count, const GLfloat *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_fv(OP_UNIFORM2FV, location, count, value, 2);
}

void glUniform3fv(GLint location, GLsizei count, const GLfloat *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_fv(OP_UNIFORM3FV, location, count, value, 3);
}

void glUniform4fv(GLint location, GLsizei count, const GLfloat *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_fv(OP_UNIFORM4FV, location, count, value, 4);
}

void glUniform1iv(GLint location, GLsizei count, const GLint *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_iv(OP_UNIFORM1IV, location, count, value, 1);
}

void glUniform2iv(GLint location, GLsizei count, const GLint *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_iv(OP_UNIFORM2IV, location, count, value, 2);
}

void glUniform3iv(GLint location, GLsizei count, const GLint *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_iv(OP_UNIFORM3IV, location, count, value, 3);
}

void glUniform4iv(GLint location, GLsizei count, const GLint *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_iv(OP_UNIFORM4IV, location, count, value, 4);
}

void glUniform2i(GLint location, GLint x, GLint y) {
    if (!_wpk_gl_command_encoder()) return;
    if (!uniform_location_accepted(location)) return; GLint v[2] = {x, y}; glUniform2iv(location, 1, v); }

void glUniform3i(GLint location, GLint x, GLint y, GLint z) {
    if (!_wpk_gl_command_encoder()) return;
    if (!uniform_location_accepted(location)) return; GLint v[3] = {x, y, z}; glUniform3iv(location, 1, v); }

void glUniform4i(GLint location, GLint x, GLint y, GLint z, GLint w) {
    if (!_wpk_gl_command_encoder()) return;
    if (!uniform_location_accepted(location)) return; GLint v[4] = {x, y, z, w}; glUniform4iv(location, 1, v); }

void glUniformMatrix2fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_matrix(OP_UNIFORM_MATRIX2FV, location, count, transpose, value, 4);
}

void glUniformMatrix3fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_matrix(OP_UNIFORM_MATRIX3FV, location, count, transpose, value, 9);
}

void glUniformMatrix4fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) {
    if (!_wpk_gl_command_encoder()) return;
    emit_uniform_matrix(OP_UNIFORM_MATRIX4FV, location, count, transpose, value, 16);
}

void glGenRenderbuffers(GLsizei n, GLuint *out) {
    if (!_wpk_gl_command_encoder()) return;
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
    if (!_wpk_gl_command_encoder()) return;
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
        uint32_t containers[2];
        if (!delete_image_object(2, names[i], containers)) {
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
        delete_attached_image_object(object,containers);
        object_release(group, object);
    }
}

void glBindRenderbuffer(GLenum target, GLuint rb) {
    if (!_wpk_gl_command_encoder())
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
    if (!_wpk_gl_command_encoder())
        return;
    GLenum error = renderbuffer_format_error(internalformat);
    if (error) {
        raise_client_error(error);
        return;
    }
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
    if (!_wpk_gl_command_encoder()) return;
    if (target != GL_FRAMEBUFFER || renderbuffertarget != GL_RENDERBUFFER
        || (attachment != GL_COLOR_ATTACHMENT0 && attachment != GL_DEPTH_ATTACHMENT && attachment != GL_STENCIL_ATTACHMENT)) {
        raise_client_error(GL_INVALID_ENUM); return;
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
 * mappings and native sibling writes at ordered command boundaries.
 * OES_EGL_image_external: TEXTURE_EXTERNAL_OES makes the bound external
 * texture a sibling the same way; its sampling is read-only. */
void glEGLImageTargetTexture2DOES(GLenum target, GLeglImageOES image) {
    if (!_wpk_gl_command_encoder()) return;
    if (target != GL_TEXTURE_2D && target != GL_TEXTURE_EXTERNAL_OES) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    struct wpk_egl_image *img = _wpk_egl_image_lookup(image);
    struct wpk_texture_unit *unit = &g_texture_units[g_active_unit];
    GLuint name = target == GL_TEXTURE_2D ? unit->texture : unit->external;
    struct wpk_object_name *object = target == GL_TEXTURE_2D ? unit->texture_object : unit->external_object;
    if (!img) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    /* A YUV image is external-only: no 2D texture can be its sibling. */
    if (name == 0 || (target == GL_TEXTURE_2D && _wpk_egl_image_external_only(img))) {
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
    (void)import_image_object(1, target, object, source, img);
    _wpk_egl_image_release(img);
}

/* Renderbuffer siblings retain the same canonical source as texture siblings. */
void glEGLImageTargetRenderbufferStorageOES(GLenum target, GLeglImageOES image) {
    if (!_wpk_gl_command_encoder()) return;
    if (target != GL_RENDERBUFFER) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    struct wpk_egl_image *img = _wpk_egl_image_lookup(image);
    if (!img) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    /* A YUV image is external-only and never a render target. */
    if (g_bound_renderbuffer == 0 || _wpk_egl_image_external_only(img)) {
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
    (void)import_image_object(2, GL_RENDERBUFFER, _wpk_gl_current_encoder()->renderbuffer_object, source, img);
    _wpk_egl_image_release(img);
}

void glDrawBuffer(GLenum buf) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_BEGIN(OP_DRAW_BUFFER, 4)
    w_u32(&_c, (uint32_t)buf);
    EMIT_END()
}

void glDrawBuffers(GLsizei n, const GLenum *bufs) {
    if (!_wpk_gl_command_encoder()) return;
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
    if (!_wpk_gl_command_encoder()) return;
    EMIT_BEGIN(OP_READ_BUFFER, 4)
    w_u32(&_c, (uint32_t)src);
    EMIT_END()
}

void glGenVertexArrays(GLsizei n, GLuint *out) {
    if (!_wpk_gl_command_encoder()) return;
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
        init_vertex_array(entry);
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
    if (!_wpk_gl_command_encoder()) return;
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
    if (!_wpk_gl_command_encoder()) return;
    struct wpk_gles_context *state = _wpk_gl_current_encoder();
    struct wpk_vertex_array *entry = array ? state->vertex_arrays : &state->default_vertex_array;
    while (entry && entry->name != array) entry = entry->next;
    if (!entry) { raise_client_error(GL_INVALID_OPERATION); return; }
    if (array) state->default_vertex_array_only = 0;
    state->current_vertex_array = entry;
    EMIT_BEGIN(OP_BIND_VERTEX_ARRAY, 4)
    w_u32(&_c, array);
    EMIT_END()
}

/* A single renderer read supplies both width and values. C reflection order,
 * name truncation and another shared context's relink cannot stale a cache. */
/* `limit` is GetnUniform's bufSize in bytes (UINT32_MAX for GetUniform). */
static void get_uniform_values(GLuint program, GLint location, int integer, uint32_t limit,
                               void *params) {
    if (!params && limit == UINT32_MAX)
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
    /* EXT/KHR_robustness section 6.1.8: a smaller destination is
     * INVALID_OPERATION and is not written. */
    if (count * 4u > limit) {
        raise_client_error(GL_INVALID_OPERATION);
        return;
    }
    if (params) memcpy(params, reply + 8, count * 4);
}
void glGetUniformfv(GLuint program, GLint location, GLfloat *params) {
    if (!_wpk_gl_command_encoder()) return;
    get_uniform_values(program, location, 0, UINT32_MAX, params);
}
void glGetUniformiv(GLuint program, GLint location, GLint *params) {
    if (!_wpk_gl_command_encoder()) return;
    get_uniform_values(program, location, 1, UINT32_MAX, params);
}
void glGetnUniformfvEXT(GLuint program, GLint location, GLsizei bufSize, GLfloat *params) {
    if (!_wpk_gl_command_encoder()) return;
    get_uniform_values(program, location, 0, bufSize < 0 ? 0 : (uint32_t)bufSize, params);
}
void glGetnUniformfvKHR(GLuint program, GLint location, GLsizei bufSize, GLfloat *params) {
    glGetnUniformfvEXT(program, location, bufSize, params);
}
void glGetnUniformivEXT(GLuint program, GLint location, GLsizei bufSize, GLint *params) {
    if (!_wpk_gl_command_encoder()) return;
    get_uniform_values(program, location, 1, bufSize < 0 ? 0 : (uint32_t)bufSize, params);
}
void glGetnUniformivKHR(GLuint program, GLint location, GLsizei bufSize, GLint *params) {
    glGetnUniformivEXT(program, location, bufSize, params);
}
/* EXT/KHR_robustness section 2.6, answered from libEGL's reset state with
 * no host request (renderers poll it every frame). */
GLenum glGetGraphicsResetStatusEXT(void) {
    return _wpk_gl_graphics_reset_status();
}
GLenum glGetGraphicsResetStatusKHR(void) {
    return _wpk_gl_graphics_reset_status();
}

void glFlush(void) {
    if (!_wpk_gl_command_encoder()) return;
    if (_wpk_gl_server_flush_checked() != 0) raise_client_error(GL_INVALID_OPERATION);
}

static void emit_draw_elements(GLenum mode, GLsizei count, GLenum type, uint32_t offset) {
    EMIT_BEGIN(OP_DRAW_ELEMENTS, 16)
    w_u32(&_c, (uint32_t)mode); w_i32(&_c, count);
    w_u32(&_c, (uint32_t)type); w_u32(&_c, offset);
    EMIT_END()
}

void glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices) {
    if (!_wpk_gl_command_encoder()) return;
    if (mode > GL_TRIANGLE_FAN || (type != GL_UNSIGNED_BYTE && type != GL_UNSIGNED_SHORT)) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    if (count < 0) {
        raise_client_error(GL_INVALID_VALUE);
        return;
    }
    if (count <= 0) return;
    GLuint app_element_buffer = g_element_buffer;
    GLuint element = 0;
    uint32_t offset = (uint32_t)(uintptr_t)indices;
    int has_client = 0;
    for (unsigned i = 0; i < _wpk_gl_current_encoder()->current_vertex_array->attrib_count; i++)
        if (g_attribs[i].enabled && g_attribs[i].client) has_client = 1;
    GLuint initial_staged[WPK_GL_INITIAL_ATTRIBS], *staged = initial_staged;
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
    if (has_client && !(staged = staging_names(initial_staged))) {
        staged = initial_staged;
        goto done;
    }
    int n = has_client ? stage_client_attribs(0, (GLsizei)(max_index + 1), staged,used) : 0;
    if (n >= 0) {
        emit_draw_elements(mode, count, type, offset);
        if (n > 0) glDeleteBuffers(n, staged);
    }
done:
    if (staged != initial_staged) free(staged);
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
    if (!_wpk_gl_command_encoder()) return;
    if (!params) return;
    if ((target != GL_ARRAY_BUFFER && target != GL_ELEMENT_ARRAY_BUFFER) || (pname != GL_BUFFER_SIZE && pname != GL_BUFFER_USAGE)) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    uint32_t input[2] = {target,pname}; GLint value;
    if (checked_client_query(QOP_GET_BUFFER_PARAMETER,input,sizeof input,&value,sizeof value)) *params = value;
}
static int client_vertex_scalar(GLuint index, GLenum pname, GLuint *value) {
    const int slot = vertex_attrib_slot(_wpk_gl_current_encoder(), index, 0);
    if (slot == WPK_ATTRIB_ERROR) return 0;
    if (slot == WPK_ATTRIB_OUT_OF_RANGE) {
        raise_client_error(GL_INVALID_VALUE); return 0;
    }
    const struct wpk_client_attrib *a = slot == WPK_ATTRIB_PRESENT ? &g_attribs[index] : &initial_vertex_attrib;
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
    if (!_wpk_gl_command_encoder()) return;
    if (!params) return;
    /* The renderer owns current values and validates their index. */
    if (pname == GL_CURRENT_VERTEX_ATTRIB) {
        uint32_t input[2] = {index,pname}; GLint value[4];
        if (checked_client_query(QOP_GET_VERTEX_ATTRIBIV,input,sizeof input,value,sizeof value)) memcpy(params,value,sizeof value);
    } else { GLuint value; if (client_vertex_scalar(index,pname,&value)) *params = (GLint)value; }
}
void glGetVertexAttribfv(GLuint index, GLenum pname, GLfloat *params) {
    if (!_wpk_gl_command_encoder()) return;
    if (!params) return;
    if (pname == GL_CURRENT_VERTEX_ATTRIB) {
        uint32_t input[2] = {index,pname}; GLfloat value[4];
        if (checked_client_query(QOP_GET_VERTEX_ATTRIBFV,input,sizeof input,value,sizeof value)) memcpy(params,value,sizeof value);
    } else { GLuint value; if (client_vertex_scalar(index,pname,&value)) *params = (GLfloat)value; }
}
void glGetVertexAttribPointerv(GLuint index, GLenum pname, void **pointer) {
    if (!_wpk_gl_command_encoder()) return;
    if (!pointer) return;
    const int slot = vertex_attrib_slot(_wpk_gl_current_encoder(), index, 0);
    if (slot == WPK_ATTRIB_ERROR) return;
    if (slot == WPK_ATTRIB_OUT_OF_RANGE) {
        raise_client_error(GL_INVALID_VALUE); return;
    }
    if (pname != GL_VERTEX_ATTRIB_ARRAY_POINTER) {
        raise_client_error(GL_INVALID_ENUM); return;
    }
    *pointer = slot == WPK_ATTRIB_PRESENT ? (void *)g_attribs[index].pointer : NULL;
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
GLboolean glIsBuffer(GLuint name) { if (!_wpk_gl_command_encoder()) return GL_FALSE; return client_is_object(0,name); }
GLboolean glIsTexture(GLuint name) {
    if (!_wpk_gl_command_encoder())
        return GL_FALSE;
    return client_is_object(1, name);
}
GLboolean glIsRenderbuffer(GLuint name) {
    if (!_wpk_gl_command_encoder())
        return GL_FALSE;
    return client_is_object(2,name);
}
GLboolean glIsFramebuffer(GLuint name) { if (!_wpk_gl_command_encoder()) return GL_FALSE; return client_is_object(3,name); }
GLboolean glIsShader(GLuint name) { if (!_wpk_gl_command_encoder()) return GL_FALSE; return client_is_object(4,name); }
GLboolean glIsProgram(GLuint name) { if (!_wpk_gl_command_encoder()) return GL_FALSE; return client_is_object(5,name); }
GLboolean glIsEnabled(GLenum cap) {
    if (!_wpk_gl_command_encoder()) return GL_FALSE;
    switch (cap) {
        case GL_BLEND: case GL_CULL_FACE: case GL_DEPTH_TEST: case GL_DITHER: case GL_POLYGON_OFFSET_FILL:
        case GL_SAMPLE_ALPHA_TO_COVERAGE: case GL_SAMPLE_COVERAGE: case GL_SCISSOR_TEST: case GL_STENCIL_TEST: break;
        default: raise_client_error(GL_INVALID_ENUM); return GL_FALSE;
    }
    uint32_t value = 0, input = cap;
    if (!checked_client_query(QOP_IS_ENABLED,&input,sizeof input,&value,sizeof value)) return GL_FALSE;
    return value ? GL_TRUE : GL_FALSE;
}

/* Each variable query owns one independent snapshot, including metadata.
 * Preallocate the transport/cancellation buffer before BEGIN. A failed chunk,
 * allocation, or RELEASE preserves every public output and never re-queries. */
static int object_capture_query(int fd, uint32_t request[6], uint32_t input_len,
                                uint8_t *reply, uint32_t output_len,
                                uint32_t token, uint32_t *count, int quiet) {
    memset(reply,0,output_len);
    struct gl_query_info info={.op=QOP_OBJECT_CAPTURE,
        .in_buf_ptr=(uintptr_t)request,.in_buf_len=input_len,
        .out_buf_ptr=(uintptr_t)reply,.out_buf_len=output_len,.reserved=0};
    if(gl_device_ioctl(fd,GLIO_QUERY,&info)!=0)goto invalid;
    uint32_t status,echoed,magic;
    memcpy(&status,reply,4);memcpy(&echoed,reply+4,4);memcpy(&magic,reply+output_len-4,4);
    if(status>1 || magic!=WPK_GL_QUERY_REPLY_MAGIC)goto invalid;
    if(status)return 0;
    if(echoed!=token)goto invalid;
    memcpy(count,reply+8,4);return 1;
invalid:
    if(!quiet)raise_client_error(GL_INVALID_OPERATION);
    return 0;
}
static int query_object_blob(uint32_t op, uint32_t *input, uint32_t words,
                             uint32_t header_size, uint32_t unit, uint32_t limit,
                             uint8_t **bytes, uint32_t *count, uint32_t header[3]) {
    struct wpk_gles_context *state=_wpk_gl_current_encoder();
    if(state->next_object_capture==UINT32_MAX){raise_client_error(GL_OUT_OF_MEMORY);return 0;}
    uint32_t *request=malloc(24);uint8_t *reply=malloc(65536),*result=NULL;int success=0;
    if(!request || !reply){free(request);free(reply);raise_client_error(GL_OUT_OF_MEMORY);return 0;}
    if(flush_commands()!=0){free(request);free(reply);return 0;}
    const int fd=_wpk_gl_fd();const uint32_t token=++state->next_object_capture;
    uint32_t begin[6]={1,token,op,input[0],words==4?input[1]:0,limit},total=0,got=0;
    memcpy(request,begin,sizeof begin);
    if(!object_capture_query(fd,request,24,reply,16,token,&total,0))goto abort;
    if(total<header_size || total>64u*1024u*1024u ||
        (uint64_t)total>(uint64_t)header_size+(uint64_t)limit*unit)goto malformed;
    result=malloc(total);
    if(!result){raise_client_error(GL_OUT_OF_MEMORY);goto abort;}
    for(uint32_t offset=0;offset<total;) {
        uint32_t n=total-offset;if(n>65520u)n=65520u;
        request[0]=2;request[2]=offset;request[3]=n;
        if(!object_capture_query(fd,request,16,reply,n+16,token,&got,0))goto abort;
        if(got!=n)goto malformed;
        memcpy(result+offset,reply+12,n);offset+=n;
    }
    memcpy(header,result,header_size);
    uint32_t wanted=header[0]<limit?header[0]:limit;
    if((uint64_t)header_size+(uint64_t)wanted*unit!=total)goto malformed;
    request[0]=3;
    if(!object_capture_query(fd,request,8,reply,16,token,&got,0))goto abort;
    if(got!=0)goto malformed;
    memmove(result,result+header_size,(size_t)wanted*unit);
    *bytes=result;*count=wanted;result=NULL;success=1;goto done;
malformed:
    raise_client_error(GL_INVALID_OPERATION);
abort:
    request[0]=3;(void)object_capture_query(fd,request,8,reply,16,token,&got,1);
done:
    free(result);free(reply);free(request);return success;
}

void glGetShaderSource(GLuint shader, GLsizei bufSize, GLsizei *length, GLchar *source) {
    if (!_wpk_gl_command_encoder()) return;
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
    if (!_wpk_gl_command_encoder()) return;
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
    if (!_wpk_gl_command_encoder())
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
    if (!_wpk_gl_command_encoder()) return;
    if (maxCount < 0) { raise_client_error(GL_INVALID_VALUE); return; }
    uint32_t input[3] = {program,0,0}, written, header[3]; uint8_t *bytes;
    if (!query_object_blob(QOP_GET_ATTACHED_SHADERS,input,3,4,4,shaders ? (uint32_t)maxCount : 0,&bytes,&written,header)) return;
    if (written) memcpy(shaders,bytes,(size_t)written*4);
    if (count) *count = (GLsizei)written;
    free(bytes);
}
void glValidateProgram(GLuint program) {
    if (!_wpk_gl_command_encoder()) return;
    EMIT_BEGIN(OP_VALIDATE_PROGRAM,4) w_u32(&_c,program); EMIT_END()
}
/* OES_EGL_image_external: every texture of a valid target needs one texture
 * image unit. An external texture samples one converted RGBA image, never
 * separate planes, so it needs one as well. */
static int required_texture_units(GLenum target, GLenum pname, GLint *value) {
    if (pname != GL_REQUIRED_TEXTURE_IMAGE_UNITS_OES) return 0;
    if (target == GL_TEXTURE_2D || target == GL_TEXTURE_CUBE_MAP || target == GL_TEXTURE_EXTERNAL_OES) *value = 1;
    else raise_client_error(GL_INVALID_ENUM);
    return 1;
}
void glGetTexParameteriv(GLenum target, GLenum pname, GLint *params) {
    if (!_wpk_gl_command_encoder()) return;
    if (!params) return;
    GLint required = 0;
    if (required_texture_units(target, pname, &required)) { if (required) *params = required; return; }
    uint32_t input[2] = {target,pname}; GLint value;
    if (checked_client_query(QOP_GET_TEX_PARAMETER,input,sizeof input,&value,4)) *params = value;
}
void glGetTexParameterfv(GLenum target, GLenum pname, GLfloat *params) {
    if (!_wpk_gl_command_encoder()) return;
    if (!params) return;
    GLint required = 0;
    if (required_texture_units(target, pname, &required)) { if (required) *params = (GLfloat)required; return; }
    uint32_t input[2] = {target,pname}; GLint value;
    if (checked_client_query(QOP_GET_TEX_PARAMETER,input,sizeof input,&value,4)) *params = (GLfloat)value;
}
void glGetRenderbufferParameteriv(GLenum target, GLenum pname, GLint *params) {
    if (!_wpk_gl_command_encoder()) return;
    if (!params) return;
    if (target != GL_RENDERBUFFER) {
        raise_client_error(GL_INVALID_ENUM);
        return;
    }
    uint32_t input[2] = {target,pname}; GLint value;
    if (checked_client_query(QOP_GET_RENDERBUFFER_PARAMETER,input,sizeof input,&value,4)) *params = value;
}
void glGetFramebufferAttachmentParameteriv(GLenum target, GLenum attachment, GLenum pname, GLint *params) {
    if (!_wpk_gl_command_encoder()) return;
    if (!params) return;
    uint32_t input[3] = {target,attachment,pname}, info[5];
    if (pname == GL_FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT) {
        /* GL_EXT_color_buffer_half_float: the 12-byte request returns a fifth
         * word, FLOAT or UNSIGNED_NORMALIZED_EXT. The host raises INVALID_ENUM
         * while the extension is not advertised. */
        uint32_t *request = malloc(sizeof input);
        uint8_t *reply = malloc(28);
        if (!request || !reply) { free(request); free(reply); raise_client_error(GL_OUT_OF_MEMORY); return; }
        memcpy(request,input,sizeof input);
        int accepted = checked_query_reply(QOP_GET_FB_ATTACHMENT,request,sizeof input,reply,20);
        if (accepted) memcpy(info,reply+4,sizeof info);
        free(request); free(reply);
        if (!accepted) return;
        if (info[0] == GL_NONE) { raise_client_error(GL_INVALID_ENUM); return; }
        *params = (GLint)info[4];
        return;
    }
    if (!checked_client_query(QOP_GET_FB_ATTACHMENT, input, 8, info, 16))
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
