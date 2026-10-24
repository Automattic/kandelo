/* Focused library tests. The device double records storage ownership and
 * encoded commands; real guest and browser tests remain separate gates. */
#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <pthread.h>
#include "gl_abi.h"
/* Wire tag is independent of the selected production revision in baseline runs. */
#define GRAPHICS_SURFACE_CAPABILITIES 0x002du
/* Existing bridge entry points; this fixture does not advertise GLES3. */
void glGenVertexArrays(GLsizei, GLuint *);
void glDeleteVertexArrays(GLsizei, const GLuint *);
void glBindVertexArray(GLuint);

/* Native pointers exceed the guest's u32 query fields. Resolve the query's
 * recorded allocation explicitly instead of dereferencing a truncated host
 * pointer. The library still allocates, queries and copies the actual reply. */
#undef pthread_mutex_lock
#undef malloc
#undef calloc
#undef free
#undef mmap
#undef munmap
static void *latest_allocation;
static int fail_calloc, fail_malloc;
static int malloc_before_failure = -1;
static int calloc_before_failure = -1;
static struct { void *pointer; size_t size; } allocations[1024];
static pthread_mutex_t allocation_mutex = PTHREAD_MUTEX_INITIALIZER;
static void *record_allocation(void *pointer, size_t size) {
    if (!pointer) return pointer;
    for (unsigned i=0; i<1024; i++) if (!allocations[i].pointer) {
        allocations[i].pointer = pointer; allocations[i].size = size; return pointer;
    }
    assert(!"native allocation registry exhausted"); return NULL;
}
static void *allocation_for(uint32_t pointer, size_t size) {
    void *found = NULL;
    pthread_mutex_lock(&allocation_mutex);
    for (unsigned i=0; i<1024; i++) if (allocations[i].pointer && (uint32_t)(uintptr_t)allocations[i].pointer == pointer) {
        assert(!found && size <= allocations[i].size); found = allocations[i].pointer;
    }
    assert(found);
    pthread_mutex_unlock(&allocation_mutex);
    return found;
}
void *graphics_calloc(size_t count, size_t size) {
    pthread_mutex_lock(&allocation_mutex);
    if (fail_calloc || calloc_before_failure == 0) {
        pthread_mutex_unlock(&allocation_mutex);
        errno = ENOMEM;
        return NULL;
    }
    if (calloc_before_failure > 0)
        calloc_before_failure--;
    void *pointer = record_allocation(calloc(count, size), count * size);
    pthread_mutex_unlock(&allocation_mutex);
    return pointer;
}
void *graphics_malloc(size_t size) {
    pthread_mutex_lock(&allocation_mutex);
    void *pointer =
        fail_malloc || malloc_before_failure == 0 ? NULL : record_allocation(malloc(size), size);
    if (malloc_before_failure > 0)
        malloc_before_failure--;
    if (pointer)
        latest_allocation = pointer;
    pthread_mutex_unlock(&allocation_mutex);
    return pointer;
}
void graphics_free(void *ptr) {
    pthread_mutex_lock(&allocation_mutex);
    if (latest_allocation == ptr)
        latest_allocation = NULL;
    for (unsigned i = 0; i < 1024; i++)
        if (allocations[i].pointer == ptr)
            allocations[i].pointer = NULL;
    free(ptr);
    pthread_mutex_unlock(&allocation_mutex);
}
static unsigned allocation_count(void) {
    pthread_mutex_lock(&allocation_mutex);
    unsigned count = 0;
    for (unsigned i = 0; i < 1024; i++)
        count += allocations[i].pointer != NULL;
    pthread_mutex_unlock(&allocation_mutex);
    return count;
}

/* A small native-window identity exercises the real EGL resize hook. */
static int native_window, record_windows[3];
static uint32_t native_window_bo;
static int native_window_fd = 10;
static uint32_t native_window_width = 64, native_window_height = 32;
extern int _wpk_egl_window_retarget(void *);
uint32_t _wpk_wlegl_bo_handle(void *window) { return window == &native_window ? native_window_bo : 0; }
int _wpk_wlegl_device_fd(void *window) {
    assert(window == &native_window);
    return native_window_fd;
}
int _wpk_wlegl_dimensions(void *window, uint32_t *width, uint32_t *height) {
    assert(window == &native_window);
    *width = native_window_width;
    *height = native_window_height;
    return 1;
}
void _wpk_wlegl_present(void *window) { (void)window; }
int _wpk_gbm_surface_dimensions(const void *window, uint32_t *w, uint32_t *h) {
    for (unsigned i = 0; i < 3; i++)
        if (window == &record_windows[i]) {
            *w = 32 + i;
            *h = 24 + i;
            return 1;
        }
    return 0;
}

static unsigned closes, imports;
static struct {
    uint32_t handle;
    int source_fd;
} prime_exports[8];
static uint32_t transferred_handles[8];
static int imported_owners[8];
static unsigned transfers, transfer_closes, export_closes;
static int fail_prime_export, fail_prime_import, fail_foreign_texture;
static unsigned display_opens, display_closes, object_closes;
static uint32_t display_generation = 91;
static int display_live, fail_display_join;
static uint32_t bound_texture, redefined_texture;
static GLenum binding_query_kind;
static unsigned binding_model, advertised_texture_units;
static unsigned char command_storage[8][WPK_GL_CMDBUF_LEN];
struct device_slot {
    int root_open, object_open, root_live;
    uint32_t generation, context, surface, image_group;
    unsigned char *commands;
    int has_current;
    pthread_t current_thread;
    uint32_t current_surface, current_read_surface;
    unsigned clears, closes;
    uint32_t array_binding, element_binding, saved_array_binding;
    int array_saved;
    uint32_t texture_active, texture_2d[128], texture_cube[128], renderbuffer_binding;

    struct {
        GLuint name;
        GLenum target;
    } texture_targets[128];
};
static struct device_slot device_slots[8];
static struct {
    struct {
        uint32_t kind, name, source, revision;
    } image_sources[128];
    uint32_t raw_name;
    int raw_live;
} image_groups[64];
static unsigned next_image_group;

static struct {
    int open, live;
    uint32_t generation;
} root_slots[8];
static unsigned pending_device;
static unsigned char *commands;
static unsigned mappings;
static unsigned destroyed_contexts, destroyed_surfaces, submit_batches, clear_commands;
static unsigned array_captures, array_restores;
static int fail_make_current, fail_create_context;
static int make_current_errno = EACCES;
static uint32_t next_backend_context = 31;
static uint32_t next_backend_surface = 131;
static int fail_surface_create;
static uint64_t max_surface_pixels = UINT64_MAX;
static unsigned surface_create_attempts, surface_presents;
static int surface_present_failure;
static uint32_t surface_target;
static int fail_surface_update;
static pthread_mutex_t overlap_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t overlap_cond = PTHREAD_COND_INITIALIZER;
static int overlap_phase, pause_foreign_bind;
static unsigned foreign_bind_calls;
static unsigned raw_discard_failure, raw_discard_queries;
static uint32_t surface_limits[3] = {8192,8192,67108864};
static unsigned surface_limit_queries, surface_limit_failure;
static int raw_reply_fail_malloc, raw_reply_fail_calloc;
static void overlap_reach(int phase) {
    pthread_mutex_lock(&overlap_mutex); overlap_phase = phase;
    pthread_cond_broadcast(&overlap_cond); pthread_mutex_unlock(&overlap_mutex);
}
static void overlap_wait(int phase) {
    pthread_mutex_lock(&overlap_mutex);
    while (overlap_phase < phase) pthread_cond_wait(&overlap_cond,&overlap_mutex);
    pthread_mutex_unlock(&overlap_mutex);
}
static uint32_t shader_names[2], program_names[2];
static unsigned shaders_created, programs_created;
static const char *lookup_expected;
static uint8_t *lookup_pending;
static uint32_t lookup_total, lookup_cursor, lookup_token, lookup_queries, lookup_chunks;
static int lookup_fail_action = -1, lookup_failure, lookup_fail_abort;
static unsigned uniform_count = 4, uniform_failure, uniform_queries, uniform_integer;
static int numeric_queries;
static int string_generation;
static unsigned context_create_calls;
static unsigned buffer_uploads;
static unsigned draw_commands;
static int indexed_queries;
static uint32_t indexed_max, query_scalar, query_gl_error, query_status;
static unsigned image_failure, image_queries, fail_image_storage, image_pixel_updates;
static unsigned bind_failure, bind_queries;
static unsigned buffer_bind_failure, buffer_delete_failure;
static unsigned image_mutation_failure, image_mutation_queries;
static EGLImageKHR nested_image_import, nested_image_state;
static struct wpk_gles_context *close_group_peer;
static unsigned close_group_reservations;
static unsigned scalar_queries;
static uint32_t core_total, core_offset, core_info[4];
static unsigned core_calls, core_fail_at, validate_commands;
static unsigned upload_queries, upload_chunks, upload_commits, upload_aborts;
static uint32_t upload_token, upload_total, upload_cursor;
static uint8_t *upload_pending, *upload_source;
static uint32_t upload_source_len;
static int fail_upload_action, upload_failure, fail_submit, fail_upload_abort;
static void protocol_trace(uint32_t kind, uint32_t op, const void *bytes, uint32_t length, uint32_t out_len) {
    const char *path = getenv("KANDELO_GRAPHICS_PROTOCOL_TRACE"); if (!path) return;
    FILE *file = fopen(path,"ab"); assert(file);
    const uint32_t header[4] = {kind,op,length,out_len};
    assert(fwrite(header,1,16,file) == 16 && fwrite(bytes,1,length,file) == length && !fclose(file));
}
static _Thread_local int record_dispatch_lock, observe_dispatch_lock;
static pthread_mutex_t *dispatch_lock;
static int pause_buffer_query;
int graphics_pthread_mutex_lock(pthread_mutex_t *mutex) {
    if (record_dispatch_lock) {
        record_dispatch_lock = 0;
        dispatch_lock = mutex;
    }
    if (observe_dispatch_lock) {
        observe_dispatch_lock = 0;
        assert(mutex == dispatch_lock);
        assert(pthread_mutex_trylock(mutex) == EBUSY);
        overlap_reach(2); // The peer is demonstrably blocked before lookup.
    }
    return pthread_mutex_lock(mutex);
}
static int capture_array_upload;
static unsigned char captured_bytes[524288];
static uint32_t captured_size, captured_type, captured_stride;
static unsigned captured_chunks;

/* Accepted C control operations plus actual encoder bytes. The source-browser
 * replay supplies kernel dispatch/identity translation, not guest marshalling. */
static void egl_trace(uint32_t kind, int fd, const void *bytes, uint32_t length) {
    const char *path = getenv("KANDELO_GRAPHICS_EGL_TRACE");
    if (!path)
        return;
    FILE *file = fopen(path, "ab");
    assert(file);
    const uint32_t header[3] = {kind, (uint32_t)fd, length};
    assert(fwrite(header, 1, 12, file) == 12);
    if (length)
        assert(fwrite(bytes, 1, length, file) == length);
    assert(!fclose(file));
}

static uint32_t *object_image_source(struct device_slot *slot, uint32_t kind, uint32_t name) {
    for (unsigned i = 0; i < 128; i++)
        if (image_groups[slot->image_group].image_sources[i].kind == kind &&
            image_groups[slot->image_group].image_sources[i].name == name)
            return &image_groups[slot->image_group].image_sources[i].source;
    for (unsigned i = 0; i < 128; i++)
        if (!image_groups[slot->image_group].image_sources[i].kind) {
            image_groups[slot->image_group].image_sources[i].kind = kind;
            image_groups[slot->image_group].image_sources[i].name = name;
            return &image_groups[slot->image_group].image_sources[i].source;
        }
    assert(!"image source fixture exhausted");
    return NULL;
}
static int native_buffer_bind(struct device_slot *slot, uint32_t target, uint32_t name) {
    if (buffer_bind_failure) {
        buffer_bind_failure = 0;
        query_gl_error = GL_OUT_OF_MEMORY;
        return 0;
    }
    if (target == GL_ARRAY_BUFFER)
        slot->array_binding = name;
    else {
        assert(target == GL_ELEMENT_ARRAY_BUFFER);
        slot->element_binding = name;
    }
    return 1;
}
static int native_buffer_delete(struct device_slot *slot, uint32_t name) {
    if (buffer_delete_failure) {
        buffer_delete_failure = 0;
        query_gl_error = GL_OUT_OF_MEMORY;
        return 0;
    }
    if (name && slot->array_binding == name)
        slot->array_binding = 0;
    if (name && slot->element_binding == name)
        slot->element_binding = 0;
    return 1;
}
static uint32_t *object_image_revision(struct device_slot *slot, uint32_t kind, uint32_t name) {
    (void)object_image_source(slot, kind, name);
    for (unsigned i = 0; i < 128; i++)
        if (image_groups[slot->image_group].image_sources[i].kind == kind &&
            image_groups[slot->image_group].image_sources[i].name == name)
            return &image_groups[slot->image_group].image_sources[i].revision;
    assert(0);
    return NULL;
}
static void orphan_image_source(struct device_slot *slot, uint32_t kind, uint32_t name) {
    uint32_t *source = object_image_source(slot, kind, name);
    if (*source)
        ++*object_image_revision(slot, kind, name);
    *source = 0;
}
/* Model definite native rejection on both legacy queued binds and checked
 * binding queries so the regression can execute against unchanged sources. */
static int native_image_bind(struct device_slot *slot, unsigned kind, GLenum target, GLuint name) {
    if (bind_failure == 2) {
        bind_failure = 0;
        query_gl_error = GL_OUT_OF_MEMORY;
        return 0;
    }
    if (kind == 2) {
        slot->renderbuffer_binding = name;
        return 1;
    }
    // A confirmed raw candidate is already a realized 2D native object,
    // even when the C name reservation has not accepted publication.
    if (image_groups[slot->image_group].raw_live &&
        name == image_groups[slot->image_group].raw_name && target != GL_TEXTURE_2D) {
        query_gl_error = GL_INVALID_OPERATION;
        return 0;
    }
    if (binding_model && name) {
        unsigned index = 0;
        while (index < 128 && slot->texture_targets[index].name &&
               slot->texture_targets[index].name != name)
            index++;
        assert(index < 128);
        if (slot->texture_targets[index].name && slot->texture_targets[index].target != target) {
            query_gl_error = GL_INVALID_OPERATION;
            return 0;
        }
        slot->texture_targets[index].name = name;
        slot->texture_targets[index].target = target;
    }
    assert(slot->texture_active < 128);
    if (target == GL_TEXTURE_2D) {
        bound_texture = name;
        slot->texture_2d[slot->texture_active] = name;
    } else if (target == GL_TEXTURE_CUBE_MAP)
        slot->texture_cube[slot->texture_active] = name;
    return 1;
}

int graphics_open(const char *path, int flags, ...) {
    (void)flags;
    assert(!strcmp(path, WPK_GL_DEVICE));
#ifdef WPK_GL_SESSION_DISPLAY
    display_opens++;
    if (!display_live) {
        unsigned i = 0;
        while (i < 8 && root_slots[i].open)
            i++;
        assert(i < 8);
        root_slots[i].open = 1;
        return 20 + (int)i;
    }
    unsigned i = 0;
    while (i < 8 && device_slots[i].object_open)
        i++;
    assert(i < 8);
    memset(&device_slots[i], 0, sizeof device_slots[i]);
    device_slots[i].object_open = 1;
    return 10 + (int)i;
#else
    return 10;
#endif
}
int graphics_close(int fd) {
    if (fd >= 200 && fd < 208) {
        assert(prime_exports[fd - 200].handle);
        prime_exports[fd - 200].handle = 0;
        export_closes++;
        return 0;
    }
#ifdef WPK_GL_SESSION_DISPLAY
    if (fd >= 20 && fd < 28) {
        assert(root_slots[fd - 20].open);
        root_slots[fd - 20].open = root_slots[fd - 20].live = 0;
        display_closes++;
        display_live = 0;
        for (unsigned i = 0; i < 8; i++)
            display_live |= root_slots[i].live;
        return 0;
    }
    assert(fd >= 10 && fd < 18 && device_slots[fd-10].object_open);
    assert(!transferred_handles[fd - 10]);
    imported_owners[fd - 10] = 0;
    egl_trace(9, fd, NULL, 0);
    device_slots[fd-10].object_open = 0; object_closes++;
    return 0;
#endif
    assert(fd == 10); return 0;
}
int graphics_fstat(int fd, struct stat *st) {
    assert(fd == 100);
    memset(st, 0, sizeof *st);
    st->st_size = 64 * 64 * 4;
    return 0;
}
void *graphics_mmap(void *a, size_t len, int prot, int flags, int fd, off_t offset) {
    (void)a; (void)prot; (void)flags; (void)offset;
    if (fd >= 10 && fd < 18) {
        assert(len == WPK_GL_CMDBUF_LEN);
        mappings++;
        commands = command_storage[fd - 10];
        device_slots[fd-10].commands = commands;
        egl_trace(1, fd, NULL, 0);
        return commands;
    }
    assert(fd == 100);
    errno = EINVAL; // GPU storage is not CPU mappable.
    return MAP_FAILED;
}
int graphics_munmap(void *a, size_t len) {
    int found = 0;
    for (unsigned i=0; i<8; i++) found |= a == command_storage[i];
    assert(found && len == WPK_GL_CMDBUF_LEN);
    return 0;
}
int graphics_ioctl(int fd, unsigned long request, ...) {
    va_list args; va_start(args, request);
    void *arg = va_arg(args, void *); va_end(args);
#ifdef WPK_GL_SESSION_DISPLAY
    if (request == GLIO_INIT) {
        struct gl_init_info *info = arg;
        assert(info->op_version == WPK_GL_OP_VERSION);
        if (fd >= 20 && fd < 28) {
            assert(info->role == WPK_GL_SESSION_DISPLAY && info->display_fd == -1 && !info->display_id);
            assert(root_slots[fd - 20].open);
            root_slots[fd - 20].live = display_live = 1;
            info->display_id = root_slots[fd - 20].generation = ++display_generation;
        } else {
            assert(fd >= 10 && fd < 18 && info->role == WPK_GL_SESSION_OBJECTS &&
                   info->display_fd >= 20 && info->display_fd < 28);
            assert(root_slots[info->display_fd - 20].live &&
                   info->display_id == root_slots[info->display_fd - 20].generation);
            device_slots[fd - 10].generation = info->display_id;
            if (fail_display_join) { errno = ENOMEM; return -1; }
        }
        return 0;
    }
    if (fd >= 20 && fd < 28) {
        assert(request == GLIO_TERMINATE && root_slots[fd - 20].live);
        root_slots[fd - 20].live = 0;
        display_live = 0;
        for (unsigned i = 0; i < 8; i++)
            display_live |= root_slots[i].live;
        return 0;
    }
#endif
    assert(fd >= 10 && fd < 18);
    struct device_slot *slot = &device_slots[fd-10];
    commands = slot->commands;
    if (request == 0xc00c642du) {
        if (fail_prime_export) {
            errno = ENOMEM;
            return -1;
        }
        uint32_t *words = arg;
        assert(words[0] == 77 || words[0] == 88 || words[0] == 99);
        unsigned i = 0;
        while (i < 8 && prime_exports[i].handle)
            i++;
        assert(i < 8);
        prime_exports[i].handle = words[0];
        prime_exports[i].source_fd = fd;
        words[2] = 200 + i;
    } else if (request == 0xc00c642eu) {
        uint32_t *words = arg;
        if (words[2] == 100) {
            words[0] = 77; // Repeated PRIME imports share one GEM handle.
            imported_owners[fd - 10] = 1;
            imports++;
        } else {
            assert(words[2] >= 200 && words[2] < 208 && prime_exports[words[2] - 200].handle);
            assert(prime_exports[words[2] - 200].source_fd != fd);
            if (fail_prime_import) {
                errno = ENOMEM;
                return -1;
            }
            if (imported_owners[fd - 10] && prime_exports[words[2] - 200].handle == 77) {
                words[0] = 77;
                return 0;
            }
            assert(!transferred_handles[fd - 10]);
            words[0] = transferred_handles[fd - 10] = 1000 + fd;
            transfers++;
        }
    } else if (request == 0x40086409u) {
        uint32_t handle = *(uint32_t *)arg;
        if (handle >= 1000) {
            assert(handle == transferred_handles[fd - 10]);
            transferred_handles[fd - 10] = 0;
            transfer_closes++;
        } else {
            assert(handle == 77 && imported_owners[fd - 10]);
            if (close_group_peer) {
                struct wpk_gles_context *peer = close_group_peer;
                close_group_peer = NULL;
                uint32_t name;
                assert(_wpk_gl_reserve_names(peer, 0, 1, &name) == GL_NO_ERROR && name == 1);
                close_group_reservations++;
            }
            imported_owners[fd - 10] = 0;
            closes++;
            slot->closes++;
        }
    } else if (request == 0xc01064e1u) {
        foreign_bind_calls++;
        uint32_t *words = arg;
        assert(words[0] == 77 || words[0] == transferred_handles[fd - 10]);
        assert(words[2] == slot->context);
        if (pause_foreign_bind) {
            overlap_reach(1); overlap_wait(2);
        }
        if (fail_foreign_texture) {
            errno = ENOMEM;
            return -1;
        }
        if (words[1] == 0x57504b49u)
            words[3] = 1u;
        else {
            if (!image_groups[slot->image_group].raw_name)
                image_groups[slot->image_group].raw_name = 0x60000000u;
            words[3] = image_groups[slot->image_group].raw_name;
            image_groups[slot->image_group].raw_live = 1;
            if (raw_reply_fail_malloc) fail_malloc = 1;
            if (raw_reply_fail_calloc) fail_calloc = 1;
            egl_trace(13,fd,words,16);
        }
    } else if (request == GLIO_CREATE_CONTEXT && fail_create_context) {
        errno = ENOMEM;
        return -1;
    } else if (request == GLIO_CREATE_CONTEXT) {
        if (slot->context) {
            errno = EBUSY;
            return -1;
        }
        context_create_calls++;
        struct gl_context_attrs *attrs = arg;
        assert(attrs->context_id == 0);
        if (attrs->share_context_id) {
            int found = 0;
            for (unsigned i = 0; i < sizeof device_slots / sizeof device_slots[0]; i++)
                if (device_slots[i].context == attrs->share_context_id) {
                    found = 1;
                    slot->image_group = device_slots[i].image_group;
                    break;
                }
            assert(found);
        } else {
            assert(next_image_group + 1 < sizeof image_groups / sizeof image_groups[0]);
            slot->image_group = ++next_image_group;
        }
        attrs->context_id = slot->context = next_backend_context++;
        egl_trace(2, fd, attrs, sizeof *attrs);
    } else if (request == GLIO_SUBMIT) {
        submit_batches++;
        const char *session_trace = getenv("KANDELO_GRAPHICS_SESSION_TRACE");
        if (session_trace) {
            struct gl_submit_info *frame = arg;
            FILE *trace = fopen(session_trace,"ab"); assert(trace);
            const uint32_t header[2] = {(uint32_t)fd,frame->length};
            assert(fwrite(header,1,8,trace) == 8);
            assert(fwrite(commands+frame->offset,1,frame->length,trace) == frame->length && !fclose(trace));
        }
        if (fail_submit) { errno = EIO; return -1; }
        struct gl_submit_info *submit = arg;
        protocol_trace(1,0,commands+submit->offset,submit->length,0);
        egl_trace(5, fd, commands + submit->offset, submit->length);
        const char *trace_path = getenv("KANDELO_GRAPHICS_COMMAND_TRACE");
        if (trace_path) {
            FILE *trace = fopen(trace_path,"ab"); assert(trace);
            assert(fwrite(commands+submit->offset,1,submit->length,trace) == submit->length);
            assert(!fclose(trace));
        }
        size_t at = submit->offset, end = at + submit->length;
        while (at < end) {
            uint16_t op, len;
            memcpy(&op, commands + at, 2);
            memcpy(&len, commands + at + 2, 2);
            assert(at + 4 + len <= end);
            uint32_t words[2] = {0};
            memcpy(words, commands + at + 4, len < 8 ? len : 8);
#ifdef OP_BEGIN_CLIENT_ARRAY
            if (op == OP_BEGIN_CLIENT_ARRAY) {
                assert(len == 0 && !slot->array_saved);
                slot->array_saved = 1;
                slot->saved_array_binding = slot->array_binding;
                array_captures++;
            }
            if (op == OP_END_CLIENT_ARRAY) {
                assert(len == 0 && slot->array_saved);
                slot->array_binding = slot->saved_array_binding;
                slot->array_saved = 0;
                array_restores++;
            }
            if (op == OP_DRAW_ARRAYS || op == OP_DRAW_ELEMENTS)
                assert(!slot->array_saved);
#endif
            if ((op == OP_DELETE_TEXTURES || op == OP_DELETE_RENDERBUFFERS ||
                 op == OP_DELETE_FRAMEBUFFERS || op == OP_FRAMEBUFFER_TEXTURE_2D ||
                 op == OP_FRAMEBUFFER_RENDERBUFFER || op == OP_BIND_FRAMEBUFFER) &&
                image_mutation_failure == 2) {
                image_mutation_failure = 0;
                query_gl_error = GL_OUT_OF_MEMORY;
                at += 4 + len;
                continue;
            }
            if (op == OP_BIND_BUFFER)
                (void)native_buffer_bind(slot, words[0], words[1]);
            if (op == OP_DELETE_BUFFERS)
                for (uint32_t i = 0; i < words[0]; i++) {
                    uint32_t name;
                    memcpy(&name, commands + at + 8 + i * 4, 4);
                    (void)native_buffer_delete(slot, name);
                }
            if (op == OP_ACTIVE_TEXTURE)
                slot->texture_active = words[0] - GL_TEXTURE0;
            if (op == OP_BIND_TEXTURE)
                (void)native_image_bind(slot, 1, words[0], words[1]);
            if (op == OP_BIND_RENDERBUFFER)
                (void)native_image_bind(slot, 2, words[0], words[1]);
            if (op == OP_DELETE_TEXTURES)
                for (uint32_t i = 0; i < words[0]; i++) {
                    uint32_t name;
                    memcpy(&name, commands + at + 8 + i * 4, 4);
                    if (!name)
                        continue;
                    for (unsigned u = 0; u < 128; u++) {
                        if (slot->texture_2d[u] == name)
                            slot->texture_2d[u] = 0;
                        if (slot->texture_cube[u] == name)
                            slot->texture_cube[u] = 0;
                    }
                    for (unsigned t = 0; t < 128; t++)
                        if (slot->texture_targets[t].name == name)
                            slot->texture_targets[t].name = 0;
                }
            if (op == OP_DELETE_RENDERBUFFERS)
                for (uint32_t i = 0; i < words[0]; i++) {
                    uint32_t name;
                    memcpy(&name, commands + at + 8 + i * 4, 4);
                    if (name && slot->renderbuffer_binding == name)
                        slot->renderbuffer_binding = 0;
                }
            if (op == OP_TEX_SUB_IMAGE_2D)
                image_pixel_updates++;
            if (op == OP_CLEAR) { clear_commands++; slot->clears++; }
            if (op == 0x030b) validate_commands++;
            if (op == OP_BUFFER_DATA) {
                buffer_uploads++;
                if (capture_array_upload && words[0] == GL_ARRAY_BUFFER) {
                    captured_size = words[1]; assert(captured_size <= sizeof captured_bytes);
                    memset(captured_bytes,0,captured_size);
                    if (len > 12) memcpy(captured_bytes,commands+at+12,captured_size);
                }
            }
            if (capture_array_upload && op == OP_BUFFER_SUB_DATA && words[0] == GL_ARRAY_BUFFER) {
                uint32_t data_len; memcpy(&data_len,commands+at+12,4);
                assert(data_len <= 65523 && words[1]+data_len <= captured_size);
                memcpy(captured_bytes+words[1],commands+at+16,data_len); captured_chunks++;
            }
            if (capture_array_upload && op == OP_VERTEX_ATTRIB_POINTER) {
                memcpy(&captured_type,commands+at+12,4); memcpy(&captured_stride,commands+at+20,4);
            }
            if (op == OP_DRAW_ARRAYS || op == OP_DRAW_ELEMENTS) draw_commands++;
            if (op == OP_TEX_IMAGE_2D) redefined_texture = bound_texture;
            if (op == OP_TEX_IMAGE_2D || op == OP_GENERATE_MIPMAP ||
                op == OP_COMPRESSED_TEX_IMAGE_2D || op == OP_COPY_TEX_IMAGE_2D) {
                if (fail_image_storage)
                    query_gl_error = GL_INVALID_VALUE;
                else if (words[0] == GL_TEXTURE_2D)
                    orphan_image_source(slot, 1, slot->texture_2d[slot->texture_active]);
            }
            if (op == OP_RENDERBUFFER_STORAGE) {
                if (fail_image_storage)
                    query_gl_error = GL_INVALID_VALUE;
                else
                    orphan_image_source(slot, 2, slot->renderbuffer_binding);
            }
            if (op == OP_CREATE_SHADER && shaders_created < 2)
                shader_names[shaders_created++] = words[1];
            if (op == OP_CREATE_PROGRAM && programs_created < 2)
                program_names[programs_created++] = words[0];
            at += 4 + len;
        }
    } else if (request == GLIO_CREATE_SURFACE) {
        struct gl_surface_create *request = arg;
        surface_create_attempts++;
        if (fail_surface_create || (uint64_t)request->attrs.width*request->attrs.height > max_surface_pixels) { errno = fail_surface_create == 2 ? EIO : ENOMEM; return -1; }
        assert(request->surface_id == 0);
        if (slot->surface) {
            errno = EBUSY;
            return -1;
        }
        surface_target = request->attrs.reserved[0];
        request->surface_id = slot->surface = next_backend_surface++;
        if (request->attrs.kind == WPK_SURFACE_DEFAULT) {
            if (!request->attrs.width) request->attrs.width = 64;
            if (!request->attrs.height) request->attrs.height = 32;
        } else assert(request->attrs.kind == WPK_SURFACE_PBUFFER && !surface_target);
        egl_trace(3, fd, request, sizeof *request);
    } else if (request == GLIO_UPDATE_SURFACE) {
        if (fail_surface_update) { errno = ENOMEM; return -1; }
        surface_target = ((struct gl_surface_attrs *)arg)->reserved[0];
    } else if (request == GLIO_MAKE_CURRENT) {
        if (fail_make_current) { errno = make_current_errno; return -1; }
        assert(arg);
        const struct gl_make_current *binding = arg;
        if (binding->context_id == 0) {
            assert(binding->draw_surface_id == 0 && binding->read_surface_id == 0);
            if (slot->has_current && pthread_equal(slot->current_thread, pthread_self())) { slot->has_current = 0; slot->current_surface = 0; }
        } else {
            assert(binding->context_id == slot->context);
            assert((binding->draw_surface_id == 0) == (binding->read_surface_id == 0));
            for (unsigned select = 0; select < 2; select++) {
                uint32_t id = select ? binding->read_surface_id : binding->draw_surface_id;
                if (!id)
                    continue;
                unsigned owner = 0;
                while (owner < 8 &&
                       (!device_slots[owner].object_open || device_slots[owner].surface != id))
                    owner++;
                assert(owner < 8 && device_slots[owner].generation == slot->generation);
                for (unsigned i = 0; i < 8; i++)
                    if (device_slots[i].has_current &&
                        !pthread_equal(device_slots[i].current_thread, pthread_self()) &&
                        (device_slots[i].current_surface == id ||
                         device_slots[i].current_read_surface == id)) {
                        errno = EACCES;
                        return -1;
                    }
            }
            if (slot->has_current && !pthread_equal(slot->current_thread, pthread_self())) { errno = EACCES; return -1; }
            for (unsigned i=0; i<8; i++) {
                struct device_slot *previous = &device_slots[i];
                if (previous->has_current && pthread_equal(previous->current_thread,pthread_self())) {
                    previous->has_current = 0; previous->current_surface = 0;
                }
            }
            slot->current_thread = pthread_self();
            slot->has_current = 1;
            slot->current_surface = binding->draw_surface_id;
            slot->current_read_surface = binding->read_surface_id;
        }
        egl_trace(4, fd, binding, sizeof *binding);
    } else if (request == GLIO_DESTROY_CONTEXT) {
        if (slot->has_current) {
            errno = EBUSY;
            return -1;
        }
        egl_trace(6, fd, &slot->context, 4);
        slot->context = 0;
        int group_live = 0;
        for (unsigned i = 0; i < 8; i++)
            group_live |= device_slots[i].context && device_slots[i].image_group == slot->image_group;
        if (!group_live) image_groups[slot->image_group].raw_live = 0;
        destroyed_contexts++;
        const char *session_trace = getenv("KANDELO_GRAPHICS_SESSION_TRACE");
        if (session_trace) {
            FILE *trace = fopen(session_trace,"ab"); assert(trace);
            const uint32_t header[2] = {(uint32_t)fd,0};
            assert(fwrite(header,1,8,trace) == 8 && !fclose(trace));
        }
        free(upload_pending); upload_pending = NULL;
    } else if (request == GLIO_DESTROY_SURFACE) {
        for (unsigned i = 0; i < 8; i++)
            if (device_slots[i].has_current &&
                (device_slots[i].current_surface == slot->surface ||
                 device_slots[i].current_read_surface == slot->surface)) {
                errno = EBUSY;
                return -1;
            }
        egl_trace(7, fd, &slot->surface, 4);
        slot->surface = 0;
        destroyed_surfaces++;
    } else if (request == GLIO_PRESENT) {
        surface_presents++;
        if (surface_present_failure) { errno = EACCES; return -1; }
        egl_trace(8, fd, NULL, 0);
    } else if (request == GLIO_QUERY) {
        struct gl_query_info *q = arg;
        if (q->op == GRAPHICS_SURFACE_CAPABILITIES) {
            assert(q->in_buf_len == 0 && q->out_buf_len == 16 && q->reserved == 0);
            surface_limit_queries++;
            if (surface_limit_failure == 1) { errno = EIO; return -1; }
            uint32_t *reply = allocation_for(q->out_buf_ptr,16);
            memcpy(reply,surface_limits,12); reply[3] = surface_limit_failure == 2 ? 0 : WPK_GL_QUERY_REPLY_MAGIC;
            if (surface_limit_failure == 3) reply[0] = 0;
            if (surface_limit_failure == 4) reply[2] = UINT32_MAX;
            egl_trace(14,fd,reply,16);
            return 0;
        }
        if (q->op == 0x27 || q->op == 0x28 || q->op == 0x29 || q->op == 0x2a) {
            assert(q->out_buf_len == 12);
            assert(q->op == 0x29 ? q->in_buf_len == 20 || q->in_buf_len == 40
                                 : q->in_buf_len == (q->op == 0x28 ? 24u : 8u));
            const uint32_t *input = allocation_for(q->in_buf_ptr, q->in_buf_len);
            uint32_t *reply = allocation_for(q->out_buf_ptr, 12);
            unsigned failure = image_mutation_failure;
            image_mutation_failure = 0;
            image_mutation_queries++;
            if (q->op == 0x27 && input[0] == 1 && input[1] == 0x60000000u) {
                raw_discard_queries++;
                if (raw_discard_failure) failure = raw_discard_failure;
            }
            int storage_error = q->op == 0x29 && fail_image_storage;
            if (storage_error && !failure)
                failure = 2;
            if (failure == 1) {
                errno = EIO;
                return -1;
            }
            if (failure == 2)
                query_gl_error = storage_error ? GL_INVALID_VALUE : GL_OUT_OF_MEMORY;
            reply[0] = failure == 2 ? 1u : failure == 5 ? 2u : 0u;
            reply[1] = failure == 2 ? 0u : failure == 4 ? 9u : 1u;
            reply[2] = failure == 3 || failure == 6 ? 0u : 0x47514c33u;
            if (q->op == 0x27 && (!failure || failure == 6) && input[1]) {
                if (input[0] == 1 && image_groups[slot->image_group].raw_name == input[1]) {
                    image_groups[slot->image_group].raw_name++;
                    image_groups[slot->image_group].raw_live = 0;
                }
                if (input[0] == 1) {
                    for (unsigned u = 0; u < 128; u++) {
                        if (slot->texture_2d[u] == input[1])
                            slot->texture_2d[u] = 0;
                        if (slot->texture_cube[u] == input[1])
                            slot->texture_cube[u] = 0;
                    }
                    for (unsigned t = 0; t < 128; t++)
                        if (slot->texture_targets[t].name == input[1])
                            slot->texture_targets[t].name = 0;
                } else if (input[0] == 2 && slot->renderbuffer_binding == input[1])
                    slot->renderbuffer_binding = 0;
            }
            if (q->op == 0x29 && !failure) {
                if (input[0] == OP_TEX_IMAGE_2D) {
                    assert(q->in_buf_len == 40 && input[9] == 0);
                    redefined_texture = bound_texture;
                    if (input[1] == GL_TEXTURE_2D)
                        orphan_image_source(slot, 1, slot->texture_2d[slot->texture_active]);
                } else {
                    assert(input[0] == OP_RENDERBUFFER_STORAGE && q->in_buf_len == 20);
                    orphan_image_source(slot, 2, slot->renderbuffer_binding);
                }
            }
            uint32_t trace[13] = {q->op, 12, reply[0]};
            memcpy(trace + 3, input, q->in_buf_len);
            egl_trace(11, fd, trace, 12 + q->in_buf_len);
            protocol_trace(2, q->op, input, q->in_buf_len, 12);
            return 0;
        }
        if (q->op == 0x2c) {
            assert(q->in_buf_len == 4 && q->out_buf_len == 12);
            const uint32_t *input = allocation_for(q->in_buf_ptr, 4);
            uint32_t *reply = allocation_for(q->out_buf_ptr, 12);
            reply[0] = native_buffer_delete(slot, input[0]) ? 0u : 1u;
            reply[1] = reply[0] ? 0u : 1u;
            reply[2] = 0x47514c33u;
            uint32_t trace[4] = {q->op, 12, reply[0], input[0]};
            egl_trace(11, fd, trace, sizeof trace);
            protocol_trace(2, q->op, input, 4, 12);
            return 0;
        }
        if (q->op == 0x2b) {
            if (pause_buffer_query) {
                pause_buffer_query = 0;
                overlap_reach(1);
                overlap_wait(3);
            }
            assert(q->in_buf_len == 8 && q->out_buf_len == 12);
            const uint32_t *input = allocation_for(q->in_buf_ptr, 8);
            uint32_t *reply = allocation_for(q->out_buf_ptr, 12);
            reply[0] = native_buffer_bind(slot, input[0], input[1]) ? 0u : 1u;
            reply[1] = reply[0] ? 0u : 1u;
            reply[2] = 0x47514c33u;
            uint32_t trace[5] = {q->op, 12, reply[0], input[0], input[1]};
            egl_trace(11, fd, trace, sizeof trace);
            protocol_trace(2, q->op, input, 8, 12);
            return 0;
        }
        if (q->op == 0x25 || q->op == 0x26) {
            assert(q->in_buf_len == (q->op == 0x25 ? 12u : 8u) && q->out_buf_len == 16);
            const uint32_t *input = allocation_for(q->in_buf_ptr, q->in_buf_len);
            uint32_t *reply = allocation_for(q->out_buf_ptr, 16);
            assert((input[0] == 1 && input[1] == GL_TEXTURE_2D) ||
                   (input[0] == 2 && input[1] == GL_RENDERBUFFER));
            uint32_t name =
                input[0] == 1 ? slot->texture_2d[slot->texture_active] : slot->renderbuffer_binding;
            assert(name);
            unsigned failure = image_failure;
            image_failure = 0;
            image_queries++;
            if (q->op == 0x25 && failure != 2) {
                *object_image_source(slot, input[0], name) = input[2];
                ++*object_image_revision(slot, input[0], name);
            }
            if (failure == 1) {
                errno = EIO;
                return -1;
            }
            reply[0] = failure == 2 ? 1u : 0u;
            reply[1] = *object_image_source(slot, input[0], name);
            reply[2] = *object_image_revision(slot, input[0], name);
            reply[3] = failure == 3 ? 0u : 0x47514c33u;
            if (failure == 2)
                query_gl_error = GL_OUT_OF_MEMORY;
            uint32_t trace[7] = {q->op, reply[0], reply[1], reply[2]};
            memcpy(trace + 4, input, q->in_buf_len);
            egl_trace(12, fd, trace, 16 + q->in_buf_len);
            protocol_trace(2, q->op, input, q->in_buf_len, 16);
            // Complete a newer accepted import before delivering this older
            // reply to C. This models completion interleaving, not public
            // context/thread sharing or real GPU execution.
            EGLImageKHR nested = q->op == 0x25 ? nested_image_import : nested_image_state;
            if (nested) {
                if (q->op == 0x25)
                    nested_image_import = NULL;
                else
                    nested_image_state = NULL;
                if (input[0] == 1)
                    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, nested);
                else
                    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, nested);
            }
            return 0;
        }
        if (q->op == 0x23 || q->op == 0x24) {
            assert(q->in_buf_len == (q->op == 0x23 ? 12u : 8u) && q->out_buf_len == 12);
            const uint32_t *input = allocation_for(q->in_buf_ptr, q->in_buf_len);
            uint32_t *reply = allocation_for(q->out_buf_ptr, 12);
            image_queries++;
            unsigned failure = image_failure;
            image_failure = 0;
            if (failure == 1) {
                errno = EIO;
                return -1;
            }
            if (q->op == 0x23 && !failure)
                *object_image_source(slot, input[0], input[1]) = input[2];
            reply[0] = failure == 2 ? 1 : 0;
            reply[1] = *object_image_source(slot, input[0], input[1]);
            reply[2] = failure == 3 ? 0 : 0x47514c33u;
            if (failure == 2)
                query_gl_error = GL_OUT_OF_MEMORY;
            return 0;
        }
        if (q->op == 0x22) {
            assert(q->in_buf_len == 12 && q->out_buf_len == 12);
            const uint32_t *input = allocation_for(q->in_buf_ptr, 12);
            uint32_t *reply = allocation_for(q->out_buf_ptr, 12);
            bind_queries++;
            unsigned failure = bind_failure;
            if (failure == 1) {
                bind_failure = 0;
                errno = EIO;
                return -1;
            }
            int accepted = failure >= 3 ? 0 : native_image_bind(slot, input[0], input[1], input[2]);
            if (failure >= 3)
                bind_failure = 0;
            reply[0] = accepted ? 0 : failure == 3 ? 0 : failure == 5 ? 2 : 1;
            reply[1] = accepted ? 1 : 0;
            reply[2] = failure == 4 ? 0 : 0x47514c33u;
            uint32_t trace[4] = {input[0], input[1], input[2], reply[0]};
            egl_trace(10, fd, trace, 16);
            return 0;
        }
        if (q->op == 0x1e) {
            assert(q->in_buf_len >= 16 && q->in_buf_len <= 65536 && q->out_buf_len == 12);
            const uint8_t *input = allocation_for(q->in_buf_ptr,q->in_buf_len);
            uint8_t *output = allocation_for(q->out_buf_ptr,12);
            uint32_t header[4]; memcpy(header,input,16); upload_queries++;
            protocol_trace(2,q->op,input,q->in_buf_len,q->out_buf_len);
            const unsigned action = header[0]; const uint32_t token = header[2];
            if (action == 4 && fail_upload_abort) { errno = EIO; return -1; }
            int failure = action == (unsigned)fail_upload_action ? upload_failure : 0;
            if (failure) fail_upload_action = 0;
            if (failure == 1) { errno = EIO; return -1; }
            if (failure == 2) { free(upload_pending); upload_pending = NULL; query_gl_error = GL_OUT_OF_MEMORY; }
            else if (action == 1) {
                free(upload_pending); upload_pending = malloc(header[3]); assert(upload_pending);
                upload_total = header[3]; upload_cursor = 0; upload_token = token;
            } else if (action == 2) {
                assert(upload_pending && token == upload_token && header[3] == upload_cursor);
                assert(q->in_buf_len-16 <= upload_total-upload_cursor);
                memcpy(upload_pending+upload_cursor,input+16,q->in_buf_len-16); upload_cursor += q->in_buf_len-16; upload_chunks++;
            } else if (action == 3) {
                assert(upload_pending && upload_cursor == upload_total && token == upload_token);
                free(upload_source); upload_source = upload_pending; upload_source_len = upload_total; upload_pending = NULL; upload_commits++;
            } else { assert(action == 4); free(upload_pending); upload_pending = NULL; upload_aborts++; }
            const uint32_t reply[3] = {failure == 2 ? 1u : 0u,failure == 2 ? 0 : failure == 4 ? token+1 : token,failure == 3 ? 0 : 0x47514c33u};
            memcpy(output,reply,12); return 0;
        }
        if (q->op == 0x21) {
            assert(q->in_buf_len >= 16 && q->in_buf_len <= 65536 && q->out_buf_len == 16);
            const uint8_t *input = allocation_for(q->in_buf_ptr, q->in_buf_len);
            uint8_t *reply = allocation_for(q->out_buf_ptr, 16);
            uint32_t header[4];
            memcpy(header, input, 16);
            unsigned action = header[0];
            lookup_queries++;
            if (action == 4 && lookup_fail_abort) {
                errno = EIO;
                return -1;
            }
            unsigned failure = action == (unsigned)lookup_fail_action ? lookup_failure : 0;
            if (failure)
                lookup_fail_action = -1;
            if (failure == 1) {
                errno = EIO;
                return -1;
            }
            GLint location = -1;
            if (!failure) {
                if (action == 0) {
                    assert(header[3] == q->in_buf_len - 16);
                    assert(lookup_expected && strlen(lookup_expected) == header[3] &&
                           !memcmp(input + 16, lookup_expected, header[3]));
                    location = 7;
                } else if (action == 1) {
                    free(lookup_pending);
                    lookup_pending = malloc(header[3]);
                    assert(lookup_pending);
                    lookup_total = header[3];
                    lookup_cursor = 0;
                    lookup_token = header[2];
                } else if (action == 2) {
                    assert(lookup_pending && lookup_token == header[2] &&
                           header[3] == lookup_cursor);
                    memcpy(lookup_pending + lookup_cursor, input + 16, q->in_buf_len - 16);
                    lookup_cursor += q->in_buf_len - 16;
                    lookup_chunks++;
                } else if (action == 3) {
                    assert(lookup_pending && lookup_cursor == lookup_total && lookup_expected &&
                           strlen(lookup_expected) == lookup_total &&
                           !memcmp(lookup_expected, lookup_pending, lookup_total));
                    free(lookup_pending);
                    lookup_pending = NULL;
                    location = 7;
                } else {
                    assert(action == 4);
                    free(lookup_pending);
                    lookup_pending = NULL;
                }
            }
            if (failure == 2)
                query_gl_error = GL_INVALID_OPERATION;
            const uint32_t words[4] = {failure == 2 ? 1u : 0u,
                                       failure == 3 ? header[2] + 1 : header[2], (uint32_t)location,
                                       failure == 4 ? 0 : 0x47514c33u};
            memcpy(reply, words, 16);
            return 0;
        }
        if (q->op == 0x1f || q->op == 0x10 || q->op == 0x11) {
            assert(latest_allocation);
            uniform_queries++;
            const GLfloat values[4] = {0.25f, -1.75f, 2.5f, 1.0f};
            if (q->op == 0x1f) {
                assert(q->in_buf_len == 12 && q->out_buf_len == 76);
                if (uniform_failure == 1) {
                    errno = EIO;
                    return -1;
                }
                uint8_t *reply = latest_allocation;
                memset(reply, 0, 76);
                const uint32_t count = uniform_failure == 3 ? 17 : uniform_count,
                               magic = uniform_failure == 4 ? 0 : 0x47514c33u,
                               status = uniform_failure == 2 ? 1 : 0;
                memcpy(reply, &status, 4);
                memcpy(reply + 4, &count, 4);
                memcpy(reply + 72, &magic, 4);
                for (unsigned i = 0; i < uniform_count; i++) {
                    if (uniform_integer) {
                        const GLint value = (GLint)i - 2;
                        memcpy(reply + 8 + i * 4, &value, 4);
                    } else {
                        GLfloat value = uniform_count == 4 ? values[i] : (GLfloat)i + .25f;
                        memcpy(reply + 8 + i * 4, &value, 4);
                    }
                }
            } else
                memcpy(latest_allocation, values, q->out_buf_len < 16 ? q->out_buf_len : 16);
            return 0;
        }
        if (advertised_texture_units && q->op == QOP_GET_INTEGERV && !binding_query_kind) {
            assert(q->out_buf_len == 4 && latest_allocation);
            memcpy(latest_allocation, &advertised_texture_units, 4);
            return 0;
        }
        if (binding_query_kind && (q->op == QOP_GET_INTEGERV || q->op == QOP_GET_FLOATV)) {
            assert(q->out_buf_len == 4 && latest_allocation);
            GLuint value = binding_query_kind == GL_TEXTURE_BINDING_2D
                               ? slot->texture_2d[slot->texture_active]
                           : binding_query_kind == GL_TEXTURE_BINDING_CUBE_MAP
                               ? slot->texture_cube[slot->texture_active]
                               : slot->renderbuffer_binding;
            if (q->op == QOP_GET_FLOATV) {
                const GLfloat result = (GLfloat)value;
                memcpy(latest_allocation, &result, 4);
            } else
                memcpy(latest_allocation, &value, 4);
            return 0;
        }
        if (q->op == QOP_GET_STRING && string_generation) {
            const char *value = string_generation == 1 ? "renderer A" : "renderer B";
            uint32_t length = (uint32_t)strlen(value);
            assert(latest_allocation && q->out_buf_len >= 4 + length);
            memcpy(latest_allocation,&length,4);
            memcpy((uint8_t *)latest_allocation+4,value,length);
            return 0;
        }
        if (numeric_queries == 3) { errno = EINVAL; return -1; }
        if (q->op == QOP_GET_ERROR && query_gl_error) {
            memcpy(latest_allocation,&query_gl_error,4); query_gl_error = 0; return 0;
        }
        if ((q->op >= 0x18 && q->op <= 0x1d) || q->op == 0x20) {
            core_calls++;
            if (core_fail_at && core_calls == core_fail_at) { errno = EIO; return -1; }
            assert(latest_allocation && q->out_buf_len <= 65536);
            uint8_t *reply = latest_allocation;
            memset(reply,0,q->out_buf_len); memcpy(reply,&query_status,4);
            if (q->op <= 0x1a || q->op == 0x20) {
                const unsigned header = q->op == 0x18 || q->op == 0x20 ? 12 : 4,
                               unit = q->op == 0x19 ? 4 : 1;
                assert(q->in_buf_len == ((q->op == 0x18 || q->op == 0x20) ? 16u : 12u));
                const unsigned cap = (q->out_buf_len-header-8)/unit;
                if (!cap) core_offset = 0;
                memcpy(reply+4,&core_total,4);
                if (header == 12) { const uint32_t meta[2] = {1,GL_FLOAT_VEC4}; memcpy(reply+8,meta,8); }
                for (unsigned i=0; i<cap; i++) {
                    if (unit == 4) { const uint32_t shader = 11+core_offset+i; memcpy(reply+8+4*i,&shader,4); }
                    else reply[4+header+i] = (uint8_t)('a'+(core_offset+i)%26);
                }
                core_offset += cap;
            } else if (q->op == 0x1b) {
                assert(q->out_buf_len == 24); memcpy(reply+4,core_info,16);
            } else {
                assert(q->out_buf_len == 12);
                memcpy(reply + 4, &query_scalar, 4);
            }
            const uint32_t magic = 0x47514c33u;
            memcpy(reply+q->out_buf_len-4,&magic,4); return 0;
        }
        if (q->op == 0x17 && indexed_queries) {
            assert(q->in_buf_len == 12 && q->out_buf_len == 8204 && latest_allocation);
            if (indexed_queries == 2) { errno = EIO; return -1; }
            memset(latest_allocation,0,8204);
            const uint32_t status = indexed_queries == 4 ? 1 : 0;
            memcpy(latest_allocation,&status,4); memcpy((uint8_t *)latest_allocation+4,&indexed_max,4);
            ((uint8_t *)latest_allocation)[8+indexed_max/8] |= (uint8_t)(1u << (indexed_max%8));
            const uint32_t footer = indexed_queries == 3 ? 0 : 0x47514c33u;
            memcpy((uint8_t *)latest_allocation+8200,&footer,4); return 0;
        }
        if (q->op == 0x12 || q->op == 0x15 || q->op == 0x16) {
            scalar_queries++;
            assert(q->out_buf_len == 12 && latest_allocation);
            memset(latest_allocation,0,12); memcpy(latest_allocation,&query_status,4); memcpy((uint8_t *)latest_allocation+4,&query_scalar,4);
            const uint32_t footer = 0x47514c33u; memcpy((uint8_t *)latest_allocation+8,&footer,4); return 0;
        }
        if (q->op == 0x13 || q->op == 0x14) {
            assert(q->in_buf_len == 8 && q->out_buf_len == 24 && latest_allocation);
            const GLfloat f[4] = {-1.75f,0.25f,2.5f,1}; const GLint i[4] = {-2,0,3,1};
            memset(latest_allocation,0,24); memcpy((uint8_t *)latest_allocation+4,q->op == 0x14 ? (const void *)f : (const void *)i,16);
            const uint32_t footer = 0x47514c33u; memcpy((uint8_t *)latest_allocation+20,&footer,4); return 0;
        }
        if (numeric_queries) {
            assert(latest_allocation);
            assert(q->out_buf_ptr == (uint32_t)(uintptr_t)latest_allocation);
            if (numeric_queries == 2 && q->out_buf_len == 4) {
                assert(q->op == QOP_GET_INTEGERV);
                const GLint count = 6;
                memcpy(latest_allocation, &count, 4);
                return 0;
            }
            assert(q->out_buf_len == (numeric_queries == 2 ? 24 : 16));
            const GLfloat floats[6] = { 0.0f, 0.25f, -0.5f, 1.0f, 0.0f, 2.0f };
            const GLint integers[6] = { 0, 0, 0, 1, 0, 2 };
            assert(q->op == QOP_GET_FLOATV || q->op == QOP_GET_INTEGERV);
            memcpy(latest_allocation,
                q->op == QOP_GET_FLOATV ? (const void *)floats : (const void *)integers,
                q->out_buf_len);
        }
    }
    return 0;
}

static EGLImageKHR image(EGLDisplay dpy) {
    const EGLint attrs[] = {
        EGL_WIDTH, 64, EGL_HEIGHT, 64,
        EGL_LINUX_DRM_FOURCC_EXT, 0x34324241,
        EGL_DMA_BUF_PLANE0_FD_EXT, 100,
        EGL_DMA_BUF_PLANE0_OFFSET_EXT, 0,
        EGL_DMA_BUF_PLANE0_PITCH_EXT, 256, EGL_NONE,
    };
    EGLImageKHR img = eglCreateImageKHR(dpy, EGL_NO_CONTEXT,
        EGL_LINUX_DMA_BUF_EXT, NULL, attrs);
    assert(img != EGL_NO_IMAGE_KHR);
    return img;
}

struct generation_thread_input {
    EGLDisplay display;
    EGLContext context;
    EGLImageKHR old_image, new_image;
};
static void *generation_thread(void *data) {
    struct generation_thread_input *input = data;
    assert(eglMakeCurrent(input->display,EGL_NO_SURFACE,EGL_NO_SURFACE,input->context));
    GLuint texture; glGenTextures(1,&texture); glBindTexture(GL_TEXTURE_2D,texture);
    if (input->old_image) {
        /* The device call pauses after library image lookup. Termination
         * must not free that temporary reference before alias installation. */
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,input->old_image);
        assert(glGetError() == GL_NO_ERROR);
    } else { overlap_reach(1); overlap_wait(2); }
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,input->new_image);
    assert(glGetError() == GL_INVALID_VALUE);
    glClear(GL_COLOR_BUFFER_BIT); glFlush();
    glDeleteTextures(1,&texture);
    assert(eglGetCurrentContext() == input->context);
    assert(eglReleaseThread());
    return NULL;
}

static void *check_thread_error(void *unused) {
    (void)unused;
    assert(eglGetError() == EGL_SUCCESS);
    assert(eglQueryAPI() == EGL_OPENGL_ES_API);
    assert(!eglBindAPI(EGL_OPENGL_API));
    assert(eglGetError() == EGL_BAD_PARAMETER);
    assert(eglQueryAPI() == EGL_OPENGL_ES_API);
    return NULL;
}

struct thread_context { EGLDisplay display; EGLContext context; };
static void *change_without_current_context(void *arg) {
    (void)arg;
    assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
    glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT, 19);
    assert(glCreateShader(0) == 0);
    GLuint untouched = 97;
    glGenBuffers(1, &untouched);
    (void)glGetString(GL_EXTENSIONS);
    return NULL;
}
static void *transfer_encoder_context(void *arg) {
    struct thread_context *input = arg;
    assert(eglMakeCurrent(input->display,EGL_NO_SURFACE,EGL_NO_SURFACE,input->context));
    GLint row_length = 0;
    glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT,&row_length);
    assert(row_length == 7);
    assert(glGetError() == GL_INVALID_ENUM);
    glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT,11);
    glClear(GL_COLOR_BUFFER_BIT);
    assert(eglReleaseThread());
    return NULL;
}
static void *check_busy_context(void *arg) {
    struct thread_context *input = arg;
    assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
    assert(eglGetCurrentDisplay() == EGL_NO_DISPLAY);
    assert(eglGetCurrentSurface(EGL_DRAW) == EGL_NO_SURFACE);
    assert(!eglMakeCurrent(input->display, EGL_NO_SURFACE, EGL_NO_SURFACE, input->context));
    assert(eglGetError() == EGL_BAD_ACCESS);
    assert(eglReleaseThread());
    assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
    return NULL;
}

static void *take_context_then_exit(void *arg) {
    struct thread_context *input = arg;
    assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
    assert(eglMakeCurrent(input->display, EGL_NO_SURFACE, EGL_NO_SURFACE, input->context));
    glClear(GL_COLOR_BUFFER_BIT);
    /* Thread destruction must flush and release this current reference. */
    return NULL;
}

struct record_thread {
    EGLDisplay display;
    EGLContext context;
    EGLSurface busy, own;
};
static void *hold_independent_records(void *data) {
    struct record_thread *input = data;
    assert(!eglMakeCurrent(input->display, input->busy, input->own, input->context));
    assert(eglGetError() == EGL_BAD_ACCESS && eglGetCurrentContext() == EGL_NO_CONTEXT);
    assert(eglMakeCurrent(input->display, input->own, input->own, input->context));
    GLint row = -1;
    glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT, &row);
    assert(row == 0);
    glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT, 23);
    overlap_reach(1);
    overlap_wait(2);
    assert(eglGetCurrentContext() == input->context &&
           eglGetCurrentSurface(EGL_READ) == input->own);
    glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT, &row);
    assert(row == 23);
    assert(!eglSwapBuffers(input->display, input->own) && eglGetError() == EGL_BAD_SURFACE);
    glClear(GL_COLOR_BUFFER_BIT);
    assert(eglReleaseThread());
    return NULL;
}

#ifdef WPK_GL_OBJECT_GROUPS
struct group_reservation_start {
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    unsigned ready;
    int run;
};
struct group_reservation_thread {
    struct wpk_gles_context *state;
    struct group_reservation_start *start;
    uint32_t names[128];
};
static void *reserve_group_names(void *data) {
    struct group_reservation_thread *input = data;
    pthread_mutex_lock(&input->start->mutex);
    input->start->ready++;
    pthread_cond_broadcast(&input->start->condition);
    while (!input->start->run)
        pthread_cond_wait(&input->start->condition, &input->start->mutex);
    pthread_mutex_unlock(&input->start->mutex);
    for (unsigned i = 0; i < 32; i++)
        assert(_wpk_gl_reserve_names(input->state, 0, 4, &input->names[i * 4]) == GL_NO_ERROR);
    return NULL;
}
#endif

extern unsigned wpkEglBindBoTexture(EGLDisplay, unsigned, unsigned);
struct sharing_thread {
    EGLDisplay display;
    EGLContext context;
    int cancel;
};
static void *raw_name_publisher(void *data) {
    struct sharing_thread *input = data;
    assert(eglMakeCurrent(input->display, EGL_NO_SURFACE, EGL_NO_SURFACE, input->context));
    record_dispatch_lock = 1;
    assert(wpkEglBindBoTexture(input->display, 77, GL_TEXTURE_2D) != 0);
    assert(glGetError() == GL_NO_ERROR && eglReleaseThread());
    return NULL;
}
static void *shared_name_binder(void *data) {
    struct sharing_thread *input = data;
    assert(eglMakeCurrent(input->display, EGL_NO_SURFACE, EGL_NO_SURFACE, input->context));
    record_dispatch_lock = 1;
    glBindBuffer(GL_ARRAY_BUFFER, 17);
    if (input->cancel)
        pthread_testcancel();
    overlap_wait(5);
    // The peer replaced public name 17. Deleting that replacement must not
    // clear this context's still-retained old binding with the same number.
    const GLuint name = 17;
    glDeleteBuffers(1, &name);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, NULL);
    GLint bound = -1;
    glGetVertexAttribiv(0, GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, &bound);
    assert(bound == 17 && glGetError() == GL_NO_ERROR);
    assert(eglReleaseThread());
    return NULL;
}
static void *shared_name_peer(void *data) {
    struct sharing_thread *input = data;
    assert(eglMakeCurrent(input->display, EGL_NO_SURFACE, EGL_NO_SURFACE, input->context));
    overlap_wait(1);
    observe_dispatch_lock = 1;
    const GLuint name = 17;
    glDeleteBuffers(1, &name);
    glBindBuffer(GL_ARRAY_BUFFER, 17);
    assert(glGetError() == GL_NO_ERROR && eglReleaseThread());
    overlap_reach(5);
    return NULL;
}

int main(int argc, char **argv) {
    assert(argc == 2);
    EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (!strcmp(argv[1], "config-validation")) {
        EGLint value = 17;
        assert(!eglGetConfigAttrib(dpy, (EGLConfig)1, EGL_RED_SIZE, &value));
        assert(eglGetError() == EGL_NOT_INITIALIZED && value == 17);
    }
    if (!strcmp(argv[1], "display-join-rollback")) {
        fail_display_join = 1; EGLint major = 17, minor = 18;
        assert(!eglInitialize(dpy,&major,&minor)); assert(eglGetError() == EGL_NOT_INITIALIZED);
        assert(major == 17 && minor == 18 && display_closes == 1 && object_closes == 1);
        fail_display_join = 0; assert(eglInitialize(dpy,&major,&minor));
        assert(major == 1 && minor == 5 && display_live);
        assert(eglTerminate(dpy) && !display_live && display_closes == 2 && object_closes == 2);
        puts("PASS display-join-rollback"); return 0;
    }
    assert(eglInitialize(dpy, NULL, NULL));
    const EGLint attrs[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    if (!strncmp(argv[1],"pbuffer-",8)) {
        if (!strcmp(argv[1],"pbuffer-grid")) {
            surface_limits[0] = surface_limits[1] = 8; surface_limits[2] = 64;
            for (EGLint w=1;w<=8;w++) for (EGLint h=1;h<=8;h++) for (unsigned capacity=1;capacity<=(unsigned)(w*h);capacity++) {
                max_surface_pixels = capacity;
                const EGLint list[] = {EGL_WIDTH,w,EGL_HEIGHT,h,EGL_LARGEST_PBUFFER,EGL_TRUE,EGL_NONE};
                EGLSurface pbuffer = eglCreatePbufferSurface(dpy,(EGLConfig)1,list); assert(pbuffer);
                EGLint actual_w,actual_h;
                assert(eglQuerySurface(dpy,pbuffer,EGL_WIDTH,&actual_w) && eglQuerySurface(dpy,pbuffer,EGL_HEIGHT,&actual_h));
                unsigned maximum=0;
                for (unsigned x=1;x<=(unsigned)w;x++) for (unsigned y=1;y<=(unsigned)h;y++)
                    if (x*y<=capacity && x*y>maximum) maximum=x*y;
                assert(actual_w*actual_h == (EGLint)maximum);
                assert(eglDestroySurface(dpy,pbuffer));
            }
        } else if (!strcmp(argv[1],"pbuffer-invalid")) {
            const EGLint invalid[][3] = {{EGL_WIDTH,-1,EGL_NONE},{EGL_HEIGHT,-2,EGL_NONE},
                {EGL_LARGEST_PBUFFER,2,EGL_NONE},{EGL_MIPMAP_TEXTURE,2,EGL_NONE},
                {EGL_TEXTURE_TARGET,42,EGL_NONE},{EGL_TEXTURE_FORMAT,42,EGL_NONE},
                {0xdead,0,EGL_NONE}};
            for (unsigned i=0;i<sizeof invalid/sizeof invalid[0];i++) {
                assert(!eglCreatePbufferSurface(dpy,(EGLConfig)1,invalid[i]));
                assert(eglGetError() == (i<2 ? EGL_BAD_PARAMETER : EGL_BAD_ATTRIBUTE));
            }
            const EGLint texture[] = {EGL_TEXTURE_FORMAT,EGL_TEXTURE_RGBA,EGL_TEXTURE_TARGET,EGL_TEXTURE_2D,EGL_NONE};
            assert(!eglCreatePbufferSurface(dpy,(EGLConfig)1,texture) && eglGetError() == EGL_BAD_MATCH);
            assert(!eglCreatePbufferSurface(dpy,(EGLConfig)99,NULL) && eglGetError() == EGL_BAD_CONFIG);
            assert(surface_create_attempts == 0);
        } else if (!strcmp(argv[1],"pbuffer-guard")) {
            const size_t page = (size_t)sysconf(_SC_PAGESIZE);
            char *memory = mmap(NULL,page*2,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0); assert(memory != MAP_FAILED);
            assert(!mprotect(memory+page,page,PROT_NONE));
            EGLint *last = (EGLint *)(memory+page-sizeof(EGLint)); *last = 0xdead;
            assert(!eglCreatePbufferSurface(dpy,(EGLConfig)1,last) && eglGetError() == EGL_BAD_ATTRIBUTE);
            munmap(memory,page*2);
        } else {
            EGLint attributes[] = {EGL_WIDTH,4,EGL_HEIGHT,3,EGL_LARGEST_PBUFFER,EGL_FALSE,EGL_MIPMAP_TEXTURE,EGL_TRUE,EGL_NONE};
            if (!strcmp(argv[1],"pbuffer-zero")) attributes[1] = attributes[3] = 0;
            if (!strcmp(argv[1],"pbuffer-limits")) {
                surface_limits[0] = 4; surface_limits[1] = 3; surface_limits[2] = 11;
                assert(!eglCreatePbufferSurface(dpy,(EGLConfig)1,attributes) && eglGetError() == EGL_BAD_ALLOC);
                attributes[5] = EGL_TRUE;
            }
            if (!strcmp(argv[1],"pbuffer-pressure")) { max_surface_pixels = 9; attributes[5] = EGL_TRUE; }
            if (!strcmp(argv[1],"pbuffer-unknown")) {
                fail_surface_create = 2; attributes[5] = EGL_TRUE;
                assert(!eglCreatePbufferSurface(dpy,(EGLConfig)1,attributes) && eglGetError() == EGL_BAD_ALLOC);
                assert(surface_create_attempts == 1); fail_surface_create = 0;
            }
            EGLSurface surface = eglCreatePbufferSurface(dpy,(EGLConfig)1,attributes); assert(surface);
            EGLint width=-1,height=-1,value=-1;
            assert(eglQuerySurface(dpy,surface,EGL_WIDTH,&width) && eglQuerySurface(dpy,surface,EGL_HEIGHT,&height));
            assert(width >= 0 && width <= attributes[1] && height >= 0 && height <= attributes[3]);
            if (!strcmp(argv[1],"pbuffer-pressure")) assert(width*height == 9 && surface_create_attempts > 1);
            if (!strcmp(argv[1],"pbuffer-limits")) assert(width*height == 9);
            if (!strcmp(argv[1],"pbuffer-zero")) assert(width == 0 && height == 0);
            assert(eglQuerySurface(dpy,surface,EGL_LARGEST_PBUFFER,&value) && value == attributes[5]);
            assert(eglQuerySurface(dpy,surface,EGL_TEXTURE_FORMAT,&value) && value == EGL_NO_TEXTURE);
            assert(eglQuerySurface(dpy,surface,EGL_TEXTURE_TARGET,&value) && value == EGL_NO_TEXTURE);
            assert(eglQuerySurface(dpy,surface,EGL_MIPMAP_TEXTURE,&value) && value == EGL_TRUE);
            assert(eglQuerySurface(dpy,surface,EGL_MIPMAP_LEVEL,&value) && value == 0);
            EGLConfig config=NULL; EGLint count=-1;
            const EGLint choose[] = {EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_NONE};
            assert(eglChooseConfig(dpy,choose,&config,1,&count) && count == 1 && config == (EGLConfig)1);
            assert(!eglSwapBuffers(dpy,surface) && eglGetError() == EGL_BAD_SURFACE);
            EGLContext context=eglCreateContext(dpy,(EGLConfig)1,EGL_NO_CONTEXT,attrs); assert(context);
            assert(eglMakeCurrent(dpy,surface,surface,context));
            surface_present_failure = 1;
            assert(!eglSwapBuffers(dpy,surface) && eglGetError() == EGL_BAD_ACCESS);
            assert(eglGetCurrentContext() == context); surface_present_failure = 0;
            glClearColor(1,0,0,1); glClear(GL_COLOR_BUFFER_BIT); assert(eglSwapBuffers(dpy,surface));
            glClearColor(0,1,0,1); glClear(GL_COLOR_BUFFER_BIT); glFlush();
            assert(surface_presents == 2);
            assert(eglDestroySurface(dpy,surface));
            assert(!eglQuerySurface(dpy,surface,EGL_WIDTH,&value) && eglGetError() == EGL_BAD_SURFACE);
            assert(eglDestroyContext(dpy,context) && eglReleaseThread());
        }
        assert(eglTerminate(dpy) && allocation_count() == 0); printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strncmp(argv[1],"surface-limits-",15)) {
        EGLContext current = EGL_NO_CONTEXT;
        if (!strcmp(argv[1],"surface-limits-current")) {
            current = eglCreateContext(dpy,(EGLConfig)1,EGL_NO_CONTEXT,attrs); assert(current);
            assert(eglMakeCurrent(dpy,EGL_NO_SURFACE,EGL_NO_SURFACE,current));
            glBindBuffer(0xdead,17);
        }
        if (!strcmp(argv[1],"surface-limits-reject")) {
            EGLint untouched = 71; fail_calloc = 1;
            assert(!eglGetConfigAttrib(dpy,(EGLConfig)1,EGL_MAX_PBUFFER_WIDTH,&untouched));
            fail_calloc = 0;
            assert(eglGetError() == EGL_BAD_ALLOC && untouched == 71 && surface_limit_queries == 0);
            for (surface_limit_failure = 1; surface_limit_failure <= 4; surface_limit_failure++) {
                assert(!eglGetConfigAttrib(dpy,(EGLConfig)1,EGL_MAX_PBUFFER_WIDTH,&untouched));
                assert(eglGetError() == EGL_BAD_ACCESS && untouched == 71);
            }
            surface_limit_failure = 0;
        }
        unsigned before = surface_limit_queries;
        for (unsigned i = 0; i < 3; i++) {
            const EGLint names[] = {EGL_MAX_PBUFFER_WIDTH,EGL_MAX_PBUFFER_HEIGHT,EGL_MAX_PBUFFER_PIXELS};
            EGLint value = -1;
            assert(eglGetConfigAttrib(dpy,(EGLConfig)1,names[i],&value) && (uint32_t)value == surface_limits[i]);
            assert(eglGetCurrentContext() == current);
        }
        assert(surface_limit_queries == before+1 && context_create_calls == !!current);
        if (!strcmp(argv[1],"surface-limits-render")) {
            EGLContext context = eglCreateContext(dpy,(EGLConfig)1,EGL_NO_CONTEXT,attrs); assert(context);
            EGLSurface surface = eglCreateWindowSurface(dpy,(EGLConfig)1,(EGLNativeWindowType)&record_windows[0],NULL); assert(surface);
            assert(eglMakeCurrent(dpy,surface,surface,context));
            glClearColor(1,0,0,1); glClear(GL_COLOR_BUFFER_BIT); glFlush();
            assert(eglTerminate(dpy) && eglInitialize(dpy,NULL,NULL)); EGLint width;
            assert(eglGetConfigAttrib(dpy,(EGLConfig)1,EGL_MAX_PBUFFER_WIDTH,&width) && (uint32_t)width == surface_limits[0]);
            assert(eglGetCurrentContext() == context && surface_limit_queries == before+2);
            glClearColor(0,1,0,1); glClear(GL_COLOR_BUFFER_BIT); glFlush();
            assert(eglReleaseThread() && eglTerminate(dpy) && allocation_count() == 0);
            puts("PASS surface-limits-render"); return 0;
        }
        if (current) {
            assert(glGetError() == GL_INVALID_ENUM && glGetError() == GL_NO_ERROR);
            assert(eglDestroyContext(dpy,current) && eglReleaseThread());
        }
        assert(eglTerminate(dpy));
        if (!strcmp(argv[1],"surface-limits-generation")) {
            surface_limits[0] = surface_limits[1] = 4096; surface_limits[2] = 16777216;
            assert(eglInitialize(dpy,NULL,NULL)); EGLint value;
            assert(eglGetConfigAttrib(dpy,(EGLConfig)1,EGL_MAX_PBUFFER_WIDTH,&value) && value == 4096);
            assert(surface_limit_queries == before+2 && eglTerminate(dpy));
        }
        assert(allocation_count() == 0); printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strcmp(argv[1], "encoder-allocation")) {
        fail_calloc = 1;
        assert(eglCreateContext(dpy,(EGLConfig)1,EGL_NO_CONTEXT,attrs) == EGL_NO_CONTEXT);
        assert(eglGetError() == EGL_BAD_ALLOC && context_create_calls == 0);
        fail_calloc = 0;
    }
    if (!strcmp(argv[1], "create-rollback")) {
        fail_create_context = 1;
        assert(eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs) == EGL_NO_CONTEXT);
        assert(eglGetError() == EGL_BAD_ALLOC);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
        EGLint value = 17;
        assert(!eglQueryContext(dpy, (EGLContext)1, EGL_CONTEXT_CLIENT_VERSION, &value));
        assert(eglGetError() == EGL_BAD_CONTEXT && value == 17);
        fail_create_context = 0;
    }
    EGLContext ctx = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
    assert(ctx != EGL_NO_CONTEXT);
    if (!strcmp(argv[1], "surfaceless-bind")) {
        fail_make_current = 1;
        assert(!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        assert(eglGetError() == EGL_BAD_ACCESS);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
        fail_make_current = 0;
    }
    assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
    if (!strncmp(argv[1], "raw-discard-",12)) {
        binding_model = 1;
        EGLImageKHR img = image(dpy);
        const GLuint reserved = 0x60000000u;
        const unsigned group = device_slots[0].image_group;
        const int record_failure = !strcmp(argv[1],"raw-discard-record");
        const int malloc_failure = !strcmp(argv[1],"raw-discard-malloc");
        const int unknown_before = !strcmp(argv[1],"raw-discard-unknown-before");
        const int unknown_after = !strcmp(argv[1],"raw-discard-unknown-after");
        EGLContext peer = EGL_NO_CONTEXT;
        if (!strcmp(argv[1],"raw-discard-peer")) {
            peer = eglCreateContext(dpy,(EGLConfig)1,ctx,attrs); assert(peer);
        }
        if (!record_failure) {
            bind_failure = 2; glBindTexture(GL_TEXTURE_2D,reserved);
            assert(glGetError() == GL_OUT_OF_MEMORY);
        }
        raw_reply_fail_malloc = malloc_failure; raw_reply_fail_calloc = record_failure;
        raw_discard_failure = unknown_before || record_failure ? 1 : unknown_after ? 6 : 2;
        assert(!wpkEglBindBoTexture(dpy,77,GL_TEXTURE_2D) && foreign_bind_calls == 1);
        fail_malloc = fail_calloc = raw_reply_fail_malloc = raw_reply_fail_calloc = 0;
        const EGLint bind_error = eglGetError();
        assert(glGetError() == (unknown_before || unknown_after ? GL_INVALID_OPERATION : GL_OUT_OF_MEMORY));
        assert(image_groups[group].raw_live == !unknown_after);
        if (!strcmp(argv[1],"raw-discard-block")) {
            const unsigned before = bind_queries;
            glBindTexture(GL_TEXTURE_CUBE_MAP,reserved);
            assert(bind_queries == before && glGetError() == GL_OUT_OF_MEMORY);
            glDeleteTextures(1,&reserved);
            assert(glGetError() == GL_OUT_OF_MEMORY);
            assert(!wpkEglBindBoTexture(dpy,77,GL_TEXTURE_2D) && foreign_bind_calls == 1);
            assert(eglGetError() == EGL_BAD_ACCESS && glGetError() == GL_OUT_OF_MEMORY);
        }
        if (!strcmp(argv[1],"raw-discard-query")) {
            unsigned before = scalar_queries;
            assert(!glIsTexture(reserved) && scalar_queries == before && glGetError() == GL_OUT_OF_MEMORY);
        }
        if (peer) {
            assert(eglMakeCurrent(dpy,EGL_NO_SURFACE,EGL_NO_SURFACE,peer));
            assert(eglDestroyContext(dpy,ctx)); ctx = peer;
            assert(destroyed_contexts == 1 && image_groups[group].raw_live);
        }
        if (!strcmp(argv[1],"raw-discard-last")) {
            assert(eglDestroyContext(dpy,ctx) && eglReleaseThread());
            assert(destroyed_contexts == 1 && !image_groups[group].raw_live);
            assert(eglDestroyImageKHR(dpy,img) && eglTerminate(dpy) && allocation_count() == 0);
            puts("PASS raw-discard-last"); return 0;
        }
        raw_discard_failure = 0;
        if (!strcmp(argv[1],"raw-discard-query")) {
            const unsigned before = raw_discard_queries;
            assert(!glIsTexture(reserved) && glGetError() == GL_NO_ERROR && raw_discard_queries == before+1);
        }
        const unsigned before = raw_discard_queries;
        glBindTexture(GL_TEXTURE_CUBE_MAP,reserved);
        assert(glGetError() == GL_NO_ERROR);
        assert(!image_groups[group].raw_live);
        assert(raw_discard_queries == before + (strcmp(argv[1],"raw-discard-query") ? 1u : 0u));
        assert(foreign_bind_calls == 1);
        const unsigned reconciled = raw_discard_queries;
        glBindTexture(GL_TEXTURE_CUBE_MAP,reserved);
        assert(glGetError() == GL_NO_ERROR && raw_discard_queries == reconciled);
        assert(bind_error == (record_failure ? EGL_BAD_ALLOC : EGL_BAD_ACCESS));
        if (!strcmp(argv[1],"raw-discard-render")) {
            for (unsigned face = 0; face < 6; face++)
                glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X+face,0,GL_RGBA,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
            GLuint framebuffer;
            glGenFramebuffers(1,&framebuffer); glBindFramebuffer(GL_FRAMEBUFFER,framebuffer);
            glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_CUBE_MAP_POSITIVE_X,reserved,0);
            glClearColor(1,0,0,1); glClear(GL_COLOR_BUFFER_BIT); glFlush();
            glClearColor(0,1,0,1); glClear(GL_COLOR_BUFFER_BIT); glFlush();
            glDeleteFramebuffers(1,&framebuffer);
        }
        glDeleteTextures(1,&reserved);
        assert(eglDestroyImageKHR(dpy,img));
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy) && allocation_count() == 0);
        printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strcmp(argv[1], "raw-reserved-name")) {
        EGLImageKHR img = image(dpy);
        const GLuint reserved = 0x60000000u;
        bind_failure = 2;
        glBindTexture(GL_TEXTURE_2D, reserved);
        assert(glGetError() == GL_OUT_OF_MEMORY);
        GLuint raw = wpkEglBindBoTexture(dpy, 77, GL_TEXTURE_2D);
        assert(raw == reserved + 1 && foreign_bind_calls == 2);
        glBindTexture(GL_TEXTURE_CUBE_MAP, reserved);
        assert(glGetError() == GL_NO_ERROR && eglGetError() == EGL_SUCCESS);
        glDeleteTextures(1, &reserved);
        glDeleteTextures(1, &raw);
        assert(eglDestroyImageKHR(dpy, img) && closes == 1);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS raw-reserved-name");
        return 0;
    }
    if (!strcmp(argv[1], "raw-flush-reject")) {
        EGLImageKHR img = image(dpy);
        glClear(GL_COLOR_BUFFER_BIT);
        fail_submit = 1;
        unsigned before = foreign_bind_calls;
        assert(!wpkEglBindBoTexture(dpy, 77, GL_TEXTURE_2D) && foreign_bind_calls == before);
        fail_submit = 0;
        assert(glGetError() == GL_INVALID_OPERATION);
        GLuint raw = wpkEglBindBoTexture(dpy, 77, GL_TEXTURE_2D);
        assert(raw && foreign_bind_calls == before + 1);
        glDeleteTextures(1, &raw);
        assert(eglDestroyImageKHR(dpy, img));
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS raw-flush-reject");
        return 0;
    }
    if (!strcmp(argv[1], "raw-publication-order")) {
        EGLImageKHR img = image(dpy);
        EGLContext peer = eglCreateContext(dpy, (EGLConfig)1, ctx, attrs);
        assert(peer);
        glBindBuffer(GL_ARRAY_BUFFER, 17);
        assert(eglReleaseThread());
        struct sharing_thread first_input = {dpy, ctx, 0}, second_input = {dpy, peer, 0};
        pthread_t first, second;
        pause_foreign_bind = 1;
        assert(!pthread_create(&first, NULL, raw_name_publisher, &first_input));
        overlap_wait(1);
        assert(!pthread_create(&second, NULL, shared_name_peer, &second_input));
        assert(!pthread_join(first, NULL) && !pthread_join(second, NULL));
        pause_foreign_bind = 0;
        assert(eglDestroyContext(dpy, ctx) && eglDestroyContext(dpy, peer) &&
               eglDestroyImageKHR(dpy, img));
        assert(eglReleaseThread() && eglTerminate(dpy) && allocation_count() == 0);
        puts("PASS raw-publication-order");
        return 0;
    }
    if (!strcmp(argv[1], "shared-create-rollback")) {
        GLuint name = 17;
        EGLImageKHR img = image(dpy);
        glBindTexture(GL_TEXTURE_2D, name);
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        assert(eglDestroyImageKHR(dpy, img));
        fail_create_context = 1;
        assert(!eglCreateContext(dpy, (EGLConfig)1, ctx, attrs) && eglGetError() == EGL_BAD_ALLOC);
        assert(eglGetCurrentContext() == ctx && closes == 0);
        fail_create_context = 0;
        EGLContext peer = eglCreateContext(dpy, (EGLConfig)1, ctx, attrs);
        assert(peer);
        assert(eglDestroyContext(dpy, ctx));
        assert(!eglCreateContext(dpy, (EGLConfig)1, ctx, attrs) &&
               eglGetError() == EGL_BAD_CONTEXT);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, peer) && closes == 0);
        glDeleteTextures(1, &name);
        assert(closes == 1 && glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy, peer) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS shared-create-rollback");
        return 0;
    }
    if (!strcmp(argv[1], "shared-records-render")) {
        EGLContext peer = eglCreateContext(dpy, (EGLConfig)1, ctx, attrs);
        assert(peer);
        GLuint texture = 17, source_fbo, peer_fbo;
        glBindTexture(GL_TEXTURE_2D, texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glGenFramebuffers(1, &source_fbo);
        glBindFramebuffer(GL_FRAMEBUFFER, source_fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
        glClearColor(1, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, peer));
        glGenFramebuffers(1, &peer_fbo);
        glBindFramebuffer(GL_FRAMEBUFFER, peer_fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
        glClearColor(0, 1, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglDestroyContext(dpy, ctx));
        glClearColor(0, 0, 1, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        glDeleteTextures(1, &texture);
        glBindTexture(GL_TEXTURE_2D, texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
        glClearColor(1, 1, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(glGetError() == GL_NO_ERROR && eglDestroyContext(dpy, peer) && eglReleaseThread() &&
               eglTerminate(dpy) && allocation_count() == 0);
        puts("PASS shared-records-render");
        return 0;
    }
    if (!strcmp(argv[1], "shared-name-order") || !strcmp(argv[1], "shared-name-cancel")) {
        EGLContext peer = eglCreateContext(dpy, (EGLConfig)1, ctx, attrs);
        assert(peer);
        glBindBuffer(GL_ARRAY_BUFFER, 17);
        assert(eglReleaseThread());
        struct sharing_thread binder = {dpy, ctx, !strcmp(argv[1], "shared-name-cancel")},
                              other = {dpy, peer, 0};
        pthread_t first, second;
        pause_buffer_query = 1;
        assert(!pthread_create(&first, NULL, shared_name_binder, &binder));
        overlap_wait(1);
        assert(!pthread_create(&second, NULL, shared_name_peer, &other));
        overlap_wait(2);
        if (binder.cancel)
            assert(!pthread_cancel(first));
        overlap_reach(3);
        void *result;
        assert(!pthread_join(first, &result));
        assert(result == (binder.cancel ? PTHREAD_CANCELED : NULL));
        assert(!pthread_join(second, NULL));
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, peer));
        glBindBuffer(GL_ARRAY_BUFFER, 18);
        assert(glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy, ctx) && eglDestroyContext(dpy, peer) && eglReleaseThread() &&
               eglTerminate(dpy) && allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "shared-image-texture") || !strcmp(argv[1], "shared-image-rbo")) {
        int texture = !strcmp(argv[1], "shared-image-texture");
        EGLContext peer = eglCreateContext(dpy, (EGLConfig)1, ctx, attrs);
        assert(peer);
        EGLImageKHR img = image(dpy);
        GLuint name = 17;
        if (texture) {
            glBindTexture(GL_TEXTURE_2D, name);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        } else {
            glBindRenderbuffer(GL_RENDERBUFFER, name);
            glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
        }
        assert(eglDestroyImageKHR(dpy, img) && closes == 0);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, peer));
        assert(eglDestroyContext(dpy, ctx) && closes == 0);
        if (texture) {
            glBindTexture(GL_TEXTURE_2D, name);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        } else {
            glBindRenderbuffer(GL_RENDERBUFFER, name);
            glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA4, 1, 1);
        }
        assert(glGetError() == GL_NO_ERROR && closes == 1);
        assert(eglDestroyContext(dpy, peer) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "image-stale-handles")) {
        EGLImageKHR stale[32];
        for (unsigned i=0; i<32; i++) {
            stale[i] = image(dpy);
            for (unsigned j=0; j<i; j++) {
                assert(stale[i] != stale[j]);
                assert(!eglDestroyImageKHR(dpy,stale[j]) && eglGetError() == EGL_BAD_PARAMETER);
            }
            /* A failed sibling installation must drop its lookup reference. */
            glBindTexture(GL_TEXTURE_2D,0);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,stale[i]);
            assert(glGetError() == GL_INVALID_OPERATION);
            assert(eglDestroyImageKHR(dpy,stale[i]) && closes == i+1);
        }
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        assert(eglInitialize(dpy,NULL,NULL));
        EGLImageKHR fresh = image(dpy);
        for (unsigned i=0; i<32; i++) {
            assert(fresh != stale[i]);
            assert(!eglDestroyImageKHR(dpy,stale[i]) && eglGetError() == EGL_BAD_PARAMETER);
        }
        assert(eglDestroyImageKHR(dpy,fresh) && closes == 33 && eglTerminate(dpy));
        puts("PASS image-stale-handles"); return 0;
    }
    if (!strcmp(argv[1], "display-generation-render")) {
        EGLSurface old = eglCreateWindowSurface(dpy,(EGLConfig)1,0,NULL);
        assert(old && eglMakeCurrent(dpy,old,old,ctx));
        glClearColor(1,0,0,1); glClear(GL_COLOR_BUFFER_BIT);
        assert(eglTerminate(dpy) && eglInitialize(dpy,NULL,NULL));
        EGLContext fresh = eglCreateContext(dpy,(EGLConfig)1,EGL_NO_CONTEXT,attrs);
        EGLSurface surface = eglCreateWindowSurface(dpy,(EGLConfig)1,0,NULL);
        assert(fresh && surface && _wpk_gl_fd() == 10);
        glFlush(); assert(device_slots[0].clears == 1 && device_slots[1].clears == 0);
        assert(eglMakeCurrent(dpy,surface,surface,fresh) && _wpk_gl_fd() == 11);
        glClearColor(0,0,1,1); glClear(GL_COLOR_BUFFER_BIT); glFlush();
        assert(device_slots[1].clears == 1 && destroyed_contexts == 1);
        assert(eglDestroySurface(dpy,surface) && eglDestroyContext(dpy,fresh));
        assert(eglReleaseThread() && eglTerminate(dpy) && destroyed_contexts == 2);
        puts("PASS display-generation-render"); return 0;
    }
    if (!strcmp(argv[1], "display-generation") || !strcmp(argv[1], "display-generation-allocation")
        || !strcmp(argv[1], "display-generation-release")) {
        EGLSurface old_surface = eglCreateWindowSurface(dpy,(EGLConfig)1,0,NULL);
        assert(old_surface && eglMakeCurrent(dpy,old_surface,old_surface,ctx));
        EGLImageKHR old_image = image(dpy);
        GLuint old_texture; glGenTextures(1,&old_texture); glBindTexture(GL_TEXTURE_2D,old_texture);
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,old_image);
        glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT,7); glClear(GL_COLOR_BUFFER_BIT);
        assert(eglTerminate(dpy) && eglGetCurrentContext() == ctx && destroyed_contexts == 0);
        assert(!eglDestroyImageKHR(dpy,old_image) && eglGetError() == EGL_NOT_INITIALIZED);
        EGLint uninitialized_value = 73;
        assert(!eglQueryContext(dpy,ctx,EGL_CONTEXT_CLIENT_VERSION,&uninitialized_value));
        assert(eglGetError() == EGL_NOT_INITIALIZED && uninitialized_value == 73);
        assert(!eglDestroyContext(dpy,ctx) && eglGetError() == EGL_NOT_INITIALIZED);
        assert(!eglDestroySurface(dpy,old_surface) && eglGetError() == EGL_NOT_INITIALIZED);
        assert(!eglSwapBuffers(dpy,old_surface) && eglGetError() == EGL_NOT_INITIALIZED);
        assert(eglCreateContext(dpy,(EGLConfig)1,EGL_NO_CONTEXT,attrs) == EGL_NO_CONTEXT);
        assert(eglGetError() == EGL_NOT_INITIALIZED);
        assert(eglCreateWindowSurface(dpy,(EGLConfig)1,0,NULL) == EGL_NO_SURFACE);
        assert(eglGetError() == EGL_NOT_INITIALIZED);
        assert(eglCreateImageKHR(dpy,EGL_NO_CONTEXT,EGL_LINUX_DMA_BUF_EXT,NULL,NULL) == EGL_NO_IMAGE_KHR);
        assert(eglGetError() == EGL_NOT_INITIALIZED && eglGetCurrentContext() == ctx);
        if (!strcmp(argv[1], "display-generation-allocation")) {
            EGLint major = 71, minor = 72; fail_calloc = 1;
            assert(!eglInitialize(dpy,&major,&minor)); fail_calloc = 0;
            assert(eglGetError() == EGL_BAD_ALLOC && major == 71 && minor == 72);
            assert(eglGetCurrentContext() == ctx && _wpk_gl_fd() == 10);
        }
        assert(eglInitialize(dpy,NULL,NULL));
        assert(!eglDestroyImageKHR(dpy,old_image) && eglGetError() == EGL_BAD_PARAMETER);
        assert(eglGetCurrentContext() == ctx && eglGetCurrentSurface(EGL_DRAW) == old_surface);
        assert(_wpk_gl_fd() == 10); glFlush(); assert(device_slots[0].clears == 1);
        GLint retained_row = -1; glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT,&retained_row); assert(retained_row == 7);
        assert(!eglDestroyContext(dpy,ctx) && eglGetError() == EGL_BAD_CONTEXT);
        assert(!eglDestroySurface(dpy,old_surface) && eglGetError() == EGL_BAD_SURFACE);
        EGLint value = 91;
        assert(!eglQueryContext(dpy,ctx,EGL_CONTEXT_CLIENT_VERSION,&value));
        assert(eglGetError() == EGL_BAD_CONTEXT && value == 91);
        EGLImageKHR fresh_image = image(dpy);
        EGLContext fresh = eglCreateContext(dpy,(EGLConfig)1,EGL_NO_CONTEXT,attrs);
        EGLSurface surface = eglCreateWindowSurface(dpy,(EGLConfig)1,0,NULL);
        assert(fresh && fresh != ctx && surface && surface != old_surface);
        fail_make_current = 1;
        assert(!eglMakeCurrent(dpy,surface,surface,fresh)); fail_make_current = 0;
        assert(eglGetError() == EGL_BAD_ACCESS && eglGetCurrentContext() == ctx && _wpk_gl_fd() == 10);
        assert(destroyed_contexts == 0 && closes == 0);
        if (!strcmp(argv[1], "display-generation-release")) {
            assert(eglReleaseThread()); assert(destroyed_contexts == 1 && closes == 1);
        }
        assert(eglMakeCurrent(dpy,surface,surface,fresh));
        assert(_wpk_gl_fd() == 11 && destroyed_contexts == 1 && destroyed_surfaces == 1);
        assert(device_slots[0].closes == 1 && device_slots[1].closes == 0);
        GLint row_length = -1; glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT,&row_length); assert(row_length == 0);
        GLuint texture; glGenTextures(1,&texture); glBindTexture(GL_TEXTURE_2D,texture);
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,fresh_image); assert(glGetError() == GL_NO_ERROR);
        glClear(GL_COLOR_BUFFER_BIT); glFlush(); assert(device_slots[1].clears == 1);
        assert(eglDestroyImageKHR(dpy,fresh_image) && closes == 1);
        glDeleteTextures(1,&texture); assert(closes == 2 && device_slots[1].closes == 1);
        assert(eglDestroySurface(dpy,surface) && eglDestroyContext(dpy,fresh));
        assert(eglReleaseThread() && eglTerminate(dpy) && destroyed_contexts == 2 && destroyed_surfaces == 2);
        printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strcmp(argv[1], "display-generation-thread") || !strcmp(argv[1], "display-image-acquire")) {
        const int acquire = !strcmp(argv[1], "display-image-acquire");
        struct generation_thread_input input = {dpy,ctx,EGL_NO_IMAGE_KHR,EGL_NO_IMAGE_KHR};
        if (acquire) input.old_image = image(dpy);
        assert(eglReleaseThread());
        pause_foreign_bind = acquire;
        pthread_t thread; assert(!pthread_create(&thread,NULL,generation_thread,&input));
        overlap_wait(1);
        assert(eglTerminate(dpy) && destroyed_contexts == 0);
        assert(eglInitialize(dpy,NULL,NULL));
        input.new_image = image(dpy);
        EGLContext fresh = eglCreateContext(dpy,(EGLConfig)1,EGL_NO_CONTEXT,attrs);
        assert(fresh && fresh != ctx && eglMakeCurrent(dpy,EGL_NO_SURFACE,EGL_NO_SURFACE,fresh));
        assert(_wpk_gl_fd() == 11);
        overlap_reach(2); assert(!pthread_join(thread,NULL)); pause_foreign_bind = 0;
        assert(destroyed_contexts == 1 && device_slots[0].clears == 1);
        assert(eglGetCurrentContext() == fresh && _wpk_gl_fd() == 11 && device_slots[1].closes == 0);
        assert(closes == (unsigned)acquire);
        GLuint texture; glGenTextures(1,&texture); glBindTexture(GL_TEXTURE_2D,texture);
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,input.new_image); assert(glGetError() == GL_NO_ERROR);
        assert(eglDestroyImageKHR(dpy,input.new_image)); glDeleteTextures(1,&texture);
        assert(closes == (unsigned)acquire+1 && device_slots[1].closes == 1);
        assert(eglDestroyContext(dpy,fresh) && eglReleaseThread() && eglTerminate(dpy));
        assert(destroyed_contexts == 2 && object_closes == 2 && display_closes == 2);
        printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strcmp(argv[1], "encoder-submit-failure")) {
        void (*get)(GLenum,GLenum,GLint *) = (void (*)(GLenum,GLenum,GLint *))eglGetProcAddress("glGetBufferParameteriv"); assert(get);
        GLuint buffer; glGenBuffers(1,&buffer); glBindBuffer(GL_ARRAY_BUFFER,buffer); glBufferData(GL_ARRAY_BUFFER,4,NULL,GL_STATIC_DRAW);
        GLint value = 87; query_scalar = 4; fail_submit = 1;
        get(GL_ARRAY_BUFFER,GL_BUFFER_SIZE,&value); fail_submit = 0;
        assert(value == 87 && scalar_queries == 0 && glGetError() == GL_INVALID_OPERATION && glGetError() == GL_NO_ERROR);
        glBindBuffer(GL_ARRAY_BUFFER,buffer); glBufferData(GL_ARRAY_BUFFER,4,NULL,GL_STATIC_DRAW);
        get(GL_ARRAY_BUFFER,GL_BUFFER_SIZE,&value); assert(value == 4 && scalar_queries == 1);
        fail_submit = 1;
        for (unsigned i=0; i<WPK_GL_CMDBUF_LEN/8+1; i++) glClear(GL_COLOR_BUFFER_BIT);
        fail_submit = 0; glFlush();
        assert(clear_commands == 0 && glGetError() == GL_INVALID_OPERATION && glGetError() == GL_NO_ERROR);
        glDeleteBuffers(1,&buffer); assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-submit-failure"); return 0;
    }
    if (!strcmp(argv[1], "encoder-shader-upload") || !strcmp(argv[1], "encoder-shader-errors") || !strcmp(argv[1], "encoder-shader-ack")) {
        const char *head = "precision mediump float; /*", *tail = "*/ void main(){gl_FragColor=vec4(0.,1.,1.,1.);}IGNORED";
        const GLint tail_len = (GLint)strlen(tail)-7;
        char *padding = malloc(140001); assert(padding); memset(padding,'X',140000); padding[140000] = '\0';
        const char *parts[4] = {head,"",padding,tail}; const GLint lengths[4] = {-1,0,140000,tail_len};
        GLuint vertex = glCreateShader(GL_VERTEX_SHADER); const char *vs = "void main(){gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=1.;}";
        glShaderSource(vertex,1,&vs,NULL); glCompileShader(vertex);
        GLuint fragment = glCreateShader(GL_FRAGMENT_SHADER); glShaderSource(fragment,4,parts,lengths);
        assert(upload_commits == 1 && upload_chunks == 3 && !upload_pending);
        assert(upload_source_len == strlen(head)+140000+(size_t)tail_len);
        assert(!memcmp(upload_source,head,strlen(head)) && !memcmp(upload_source+strlen(head),padding,140000));
        assert(!memcmp(upload_source+strlen(head)+140000,tail,(size_t)tail_len) && glGetError() == GL_NO_ERROR);
        if (!strcmp(argv[1], "encoder-shader-errors")) {
            uint8_t *previous = upload_source; const unsigned before = upload_queries;
            fail_malloc = 1; glShaderSource(fragment,4,parts,lengths); fail_malloc = 0;
            assert(upload_queries == before && glGetError() == GL_OUT_OF_MEMORY);
            const char *unreadable[3] = {(const char *)1,(const char *)1,(const char *)1};
            const GLint oversized[3] = {INT32_MAX,INT32_MAX,INT32_MAX};
            glShaderSource(fragment,3,unreadable,oversized);
            assert(upload_queries == before && glGetError() == GL_OUT_OF_MEMORY);
            for (int failure=1; failure<=4; failure++) {
                fail_upload_action = 2; upload_failure = failure; glShaderSource(fragment,4,parts,lengths);
                assert(!upload_pending && upload_source == previous && upload_commits == 1);
                assert(glGetError() == (failure == 2 ? GL_OUT_OF_MEMORY : GL_INVALID_OPERATION)); assert(glGetError() == GL_NO_ERROR);
            }
            fail_upload_action = 2; upload_failure = 1; fail_upload_abort = 1;
            glShaderSource(fragment,4,parts,lengths); fail_upload_abort = 0;
            assert(upload_pending && upload_source == previous && glGetError() == GL_INVALID_OPERATION && glGetError() == GL_NO_ERROR);
            const unsigned old_queries = upload_queries; glClear(GL_COLOR_BUFFER_BIT); fail_submit = 1;
            glShaderSource(fragment,4,parts,lengths); fail_submit = 0;
            assert(upload_queries == old_queries && glGetError() == GL_INVALID_OPERATION);
            glShaderSource(fragment,4,parts,lengths); assert(upload_commits == 2 && !upload_pending && glGetError() == GL_NO_ERROR);
        } else if (!strcmp(argv[1], "encoder-shader-ack")) {
            fail_upload_action = 3; upload_failure = 3; padding[0] = 'Y'; glShaderSource(fragment,4,parts,lengths);
            assert(upload_commits == 2 && !upload_pending && upload_source[strlen(head)] == 'Y');
            assert(glGetError() == GL_INVALID_OPERATION && glGetError() == GL_NO_ERROR);
        } else {
            glCompileShader(fragment); GLuint program = glCreateProgram(); glAttachShader(program,vertex); glAttachShader(program,fragment); glLinkProgram(program);
            glUseProgram(program); glViewport(0,0,1,1); glDrawArrays(GL_POINTS,0,1); glFlush(); assert(draw_commands == 1);
        }
        free(padding); free(upload_source); upload_source = NULL;
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy)); printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strcmp(argv[1], "encoder-core-source")) {
        void (*get)(GLuint,GLsizei,GLsizei *,GLchar *) = (void (*)(GLuint,GLsizei,GLsizei *,GLchar *))eglGetProcAddress("glGetShaderSource"); assert(get);
        char *text = malloc(70001); assert(text); memset(text,'!',70001);
        core_total = 70000; GLsizei length = -1; get(9,70001,&length,text);
        assert(length == 70000 && text[70000] == '\0' && core_calls == 3);
        for (unsigned i=0; i<70000; i++) assert(text[i] == 'a'+i%26);
        char small[4] = "!!!"; get(9,4,&length,small); assert(length == 3 && !strcmp(small,"abc"));
        get(9,0,&length,NULL); assert(length == 0);
        length = -1; get(9,-1,&length,small); assert(length == -1 && glGetError() == GL_INVALID_VALUE);
        memset(text,'!',70001); length = -1; core_calls = 0; core_fail_at = 3;
        get(9,70001,&length,text); assert(length == -1 && text[0] == '!' && text[70000] == '!' && glGetError() == GL_INVALID_OPERATION);
        core_fail_at = 0; query_status = 1; query_gl_error = GL_INVALID_VALUE;
        get(9,4,&length,small); query_status = 0; assert(length == -1 && !strcmp(small,"abc") && glGetError() == GL_INVALID_VALUE && glGetError() == GL_NO_ERROR);
        fail_malloc = 1; get(9,4,&length,small); fail_malloc = 0; assert(length == -1 && glGetError() == GL_OUT_OF_MEMORY);
        glShaderSource(9,-1,NULL,NULL); assert(glGetError() == GL_INVALID_VALUE);
        free(text); assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-core-source"); return 0;
    }
    if (!strcmp(argv[1], "encoder-uniform-lookup")) {
        char *name = malloc(140002);
        assert(name);
        for (unsigned length = 249; length <= 140001; length = length == 249     ? 300
                                                               : length == 300   ? 65520
                                                               : length == 65520 ? 140001
                                                                                 : 140002) {
            memset(name, 'u', length);
            name[length] = 0;
            lookup_expected = name;
            lookup_chunks = 0;
            assert(glGetUniformLocation(9, name) == 7);
            assert(lookup_pending == NULL);
            assert(lookup_chunks == (length > 65520 ? 3u : 0u));
        }
        unsigned calls = lookup_queries;
        assert(glGetUniformLocation(9, NULL) == -1 && lookup_queries == calls);
        free(name);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-uniform-lookup");
        return 0;
    }
    if (!strcmp(argv[1], "encoder-uniform-lookup-errors")) {
        char *name = malloc(70001);
        assert(name);
        memset(name, 'u', 70000);
        name[70000] = 0;
        lookup_expected = name;
        for (int action = 0; action <= 3; action++)
            for (int failure = 1; failure <= 4; failure++) {
                lookup_fail_action = action;
                lookup_failure = failure;
                if (action == 0)
                    name[300] = 0;
                else
                    name[300] = 'u';
                assert(glGetUniformLocation(9, name) == -1);
                assert(glGetError() == GL_INVALID_OPERATION);
                assert(lookup_pending == NULL);
                assert(glGetUniformLocation(9, name) == 7);
            }
        name[300] = 'u';
        lookup_fail_action = 2;
        lookup_failure = 1;
        lookup_fail_abort = 1;
        assert(glGetUniformLocation(9, name) == -1 && glGetError() == GL_INVALID_OPERATION &&
               lookup_pending);
        lookup_fail_abort = 0;
        assert(glGetUniformLocation(9, name) == 7 && lookup_pending == NULL);
        fail_malloc = 1;
        assert(glGetUniformLocation(9, name) == -1);
        fail_malloc = 0;
        assert(glGetError() == GL_OUT_OF_MEMORY);
        free(name);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-uniform-lookup-errors");
        return 0;
    }
    if (!strcmp(argv[1], "encoder-uniform-reflection")) {
        char *name = malloc(70001);
        assert(name);
        GLsizei length = -1;
        GLint size = -1;
        GLenum type = 0;
        core_total = 70000;
        glGetActiveUniform(9, 0, 70001, &length, &size, &type, name);
        assert(length == 70000 && name[70000] == 0 && size == 1 && type == GL_FLOAT_VEC4);
        for (unsigned i = 0; i < 70000; i++)
            assert(name[i] == 'a' + i % 26);
        char small[4] = "!!!";
        glGetActiveUniform(9, 0, 4, &length, &size, &type, small);
        assert(length == 3 && !strcmp(small, "abc"));
        glGetActiveUniform(9, 0, 0, &length, &size, &type, NULL);
        assert(length == 0 && size == 1 && type == GL_FLOAT_VEC4);
        length = -1;
        glGetActiveUniform(9, 0, -1, &length, &size, &type, small);
        assert(length == -1 && glGetError() == GL_INVALID_VALUE);
        core_calls = 0;
        core_fail_at = 3;
        length = -1;
        size = -1;
        type = 0;
        memset(name, '!', 70001);
        glGetActiveUniform(9, 0, 70001, &length, &size, &type, name);
        assert(length == -1 && size == -1 && type == 0 && name[0] == '!' && name[70000] == '!' &&
               glGetError() == GL_INVALID_OPERATION);
        core_fail_at = 0;
        fail_malloc = 1;
        glGetActiveUniform(9, 0, 4, &length, &size, &type, small);
        fail_malloc = 0;
        assert(length == -1 && glGetError() == GL_OUT_OF_MEMORY);
        query_status = 1;
        query_gl_error = GL_INVALID_VALUE;
        glGetActiveUniform(9, 0, 4, &length, &size, &type, small);
        query_status = 0;
        assert(length == -1 && size == -1 && type == 0 && !strcmp(small, "abc") &&
               glGetError() == GL_INVALID_VALUE);
        free(name);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-uniform-reflection");
        return 0;
    }
    if (!strcmp(argv[1], "encoder-uniform-values")) {
        GLfloat values[17];
        for (unsigned i = 0; i < 17; i++)
            values[i] = 99;
        glGetUniformfv(9, 7, values);
        assert(values[0] == 0.25f && values[1] == -1.75f && values[2] == 2.5f &&
               values[3] == 1.0f && values[4] == 99);
        for (unsigned count = 1; count <= 16; count++) {
            if (count != 1 && count != 2 && count != 3 && count != 9 && count != 16)
                continue;
            uniform_count = count;
            for (unsigned i = 0; i < 17; i++)
                values[i] = 99;
            glGetUniformfv(9, 7, values);
            for (unsigned i = 0; i < count; i++)
                assert(values[i] == (GLfloat)i + .25f);
            assert(values[count] == 99);
        }
        uniform_integer = 1;
        uniform_count = 4;
        GLint integers[5] = {99, 99, 99, 99, 99};
        glGetUniformiv(9, 7, integers);
        assert(integers[0] == -2 && integers[1] == -1 && integers[2] == 0 && integers[3] == 1 &&
               integers[4] == 99);
        uniform_integer = 0;
        unsigned queries = uniform_queries;
        glGetUniformfv(9, 7, NULL);
        assert(uniform_queries == queries);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-uniform-values");
        return 0;
    }
    if (!strcmp(argv[1], "encoder-uniform-errors")) {
        GLfloat values[5] = {99, 99, 99, 99, 99};
        for (unsigned failure = 1; failure <= 4; failure++) {
            uniform_failure = failure;
            if (failure == 2)
                query_gl_error = GL_INVALID_OPERATION;
            glGetUniformfv(9, 7, values);
            assert(glGetError() == GL_INVALID_OPERATION);
            for (unsigned i = 0; i < 5; i++)
                assert(values[i] == 99);
        }
        uniform_failure = 0;
        uniform_count = 0;
        glGetUniformfv(9, 7, values);
        assert(glGetError() == GL_INVALID_OPERATION && values[0] == 99);
        uniform_count = 4;
        fail_malloc = 1;
        glGetUniformfv(9, 7, values);
        fail_malloc = 0;
        assert(glGetError() == GL_OUT_OF_MEMORY && values[0] == 99);
        glGetUniformfv(9, 7, values);
        assert(values[3] == 1 && values[4] == 99);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-uniform-errors");
        return 0;
    }
    if (!strcmp(argv[1], "encoder-core-reflection")) {
        void (*active)(GLuint,GLuint,GLsizei,GLsizei *,GLint *,GLenum *,GLchar *) = (void (*)(GLuint,GLuint,GLsizei,GLsizei *,GLint *,GLenum *,GLchar *))eglGetProcAddress("glGetActiveAttrib");
        void (*attached)(GLuint,GLsizei,GLsizei *,GLuint *) = (void (*)(GLuint,GLsizei,GLsizei *,GLuint *))eglGetProcAddress("glGetAttachedShaders");
        void (*validate)(GLuint) = (void (*)(GLuint))eglGetProcAddress("glValidateProgram"); assert(active && attached && validate);
        char name[5] = "!!!!"; GLsizei length = -1; GLint size = -1; GLenum type = 0;
        core_total = 10; active(9,0,5,&length,&size,&type,name);
        assert(!strcmp(name,"abcd") && length == 4 && size == 1 && type == GL_FLOAT_VEC4);
        active(9,0,0,&length,&size,&type,NULL); assert(length == 0 && size == 1 && type == GL_FLOAT_VEC4);
        active(9,0,-1,&length,&size,&type,name); assert(glGetError() == GL_INVALID_VALUE);
        core_total = 2; GLuint names[3] = {87,87,87}; attached(9,1,&length,names);
        assert(length == 1 && names[0] == 11 && names[1] == 87);
        attached(9,3,&length,names); assert(length == 2 && names[0] == 11 && names[1] == 12 && names[2] == 87);
        attached(9,0,&length,NULL); assert(length == 0);
        attached(9,-1,&length,names); assert(glGetError() == GL_INVALID_VALUE);
        validate(9); glFlush(); assert(validate_commands == 1);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy)); puts("PASS encoder-core-reflection"); return 0;
    }
    if (!strcmp(argv[1], "encoder-core-params") || !strcmp(argv[1], "encoder-core-image")) {
        void (*texiv)(GLenum,GLenum,GLint *) = (void (*)(GLenum,GLenum,GLint *))eglGetProcAddress("glGetTexParameteriv");
        void (*texfv)(GLenum,GLenum,GLfloat *) = (void (*)(GLenum,GLenum,GLfloat *))eglGetProcAddress("glGetTexParameterfv");
        void (*rbo)(GLenum,GLenum,GLint *) = (void (*)(GLenum,GLenum,GLint *))eglGetProcAddress("glGetRenderbufferParameteriv");
        void (*fbo)(GLenum,GLenum,GLenum,GLint *) = (void (*)(GLenum,GLenum,GLenum,GLint *))eglGetProcAddress("glGetFramebufferAttachmentParameteriv"); assert(texiv && texfv && rbo && fbo);
        GLint value = -1; GLfloat floating = -1;
        if (!strcmp(argv[1], "encoder-core-image")) {
            EGLImageKHR img = image(dpy); GLuint renderbuffer, framebuffers[2];
            glGenRenderbuffers(1,&renderbuffer); glBindRenderbuffer(GL_RENDERBUFFER,renderbuffer);
            glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER,img); assert(eglDestroyImageKHR(dpy,img));
            query_scalar = 64;
            rbo(GL_RENDERBUFFER, GL_RENDERBUFFER_WIDTH, &value);
            assert(value == 64);
            query_scalar = 0x8058;
            rbo(GL_RENDERBUFFER, GL_RENDERBUFFER_INTERNAL_FORMAT, &value);
            assert(value == 0x8058);
            query_scalar = 8;
            rbo(GL_RENDERBUFFER, GL_RENDERBUFFER_ALPHA_SIZE, &value);
            assert(value == 8);
            glGenFramebuffers(2,framebuffers); glBindFramebuffer(GL_FRAMEBUFFER,framebuffers[0]);
            glFramebufferRenderbuffer(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,renderbuffer);
            core_info[0] = GL_RENDERBUFFER;
            core_info[1] = renderbuffer;
            fbo(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE,&value); assert(value == GL_RENDERBUFFER);
            fbo(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,&value); assert((GLuint)value == renderbuffer);
            value = 87; fbo(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL,&value); assert(value == 87 && glGetError() == GL_INVALID_ENUM);
            glBindFramebuffer(GL_FRAMEBUFFER,framebuffers[1]); glDeleteRenderbuffers(1,&renderbuffer);
            glBindFramebuffer(GL_FRAMEBUFFER,framebuffers[0]); fbo(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,&value); assert((GLuint)value == renderbuffer && closes == 0);
            glDeleteFramebuffers(2,framebuffers); assert(closes == 1);
        } else {
            query_scalar = GL_NEAREST; texiv(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,&value); texfv(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,&floating);
            assert(value == GL_NEAREST && floating == (GLfloat)GL_NEAREST);
            query_scalar = 32; rbo(GL_RENDERBUFFER,GL_RENDERBUFFER_WIDTH,&value); assert(value == 32);
            core_info[0] = GL_TEXTURE; core_info[1] = 7; core_info[2] = 0; core_info[3] = GL_TEXTURE_CUBE_MAP_NEGATIVE_X;
            fbo(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,&value); assert(value == 7);
            fbo(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE,&value); assert(value == GL_TEXTURE_CUBE_MAP_NEGATIVE_X);
            core_info[0] = GL_RENDERBUFFER; value = 87; fbo(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL,&value); assert(value == 87 && glGetError() == GL_INVALID_ENUM);
            core_info[0] = GL_NONE; fbo(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,&value); assert(value == 87 && glGetError() == GL_INVALID_ENUM);
            numeric_queries = 3; texiv(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,&value); numeric_queries = 0; assert(value == 87 && glGetError() == GL_INVALID_OPERATION);
        }
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy)); printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strcmp(argv[1], "encoder-buffer-query")) {
        void (*get)(GLenum,GLenum,GLint *) = (void (*)(GLenum,GLenum,GLint *))eglGetProcAddress("glGetBufferParameteriv");
        GLboolean (*is)(GLuint) = (GLboolean (*)(GLuint))eglGetProcAddress("glIsBuffer"); assert(get && is);
        GLuint buffer; glGenBuffers(1,&buffer); glBindBuffer(GL_ARRAY_BUFFER,buffer); glBufferData(GL_ARRAY_BUFFER,64,NULL,GL_STATIC_DRAW);
        GLint value = 87; query_scalar = 64; get(GL_ARRAY_BUFFER,GL_BUFFER_SIZE,&value); assert(value == 64);
        query_scalar = GL_STATIC_DRAW; get(GL_ARRAY_BUFFER,GL_BUFFER_USAGE,&value); assert(value == GL_STATIC_DRAW);
        value = 87; get(0xdead,GL_BUFFER_SIZE,&value); assert(value == 87 && glGetError() == GL_INVALID_ENUM);
        get(GL_ARRAY_BUFFER,0xdead,&value); assert(value == 87 && glGetError() == GL_INVALID_ENUM);
        numeric_queries = 3; get(GL_ARRAY_BUFFER,GL_BUFFER_SIZE,&value); numeric_queries = 0;
        assert(value == 87 && glGetError() == GL_INVALID_OPERATION);
        query_status = 1; query_gl_error = GL_INVALID_OPERATION; get(GL_ARRAY_BUFFER,GL_BUFFER_SIZE,&value); query_status = 0;
        assert(value == 87 && glGetError() == GL_INVALID_OPERATION && glGetError() == GL_NO_ERROR);
        fail_malloc = 1; get(GL_ARRAY_BUFFER,GL_BUFFER_SIZE,&value); fail_malloc = 0;
        assert(value == 87 && glGetError() == GL_OUT_OF_MEMORY);
        query_scalar = 1; assert(is(buffer)); glDeleteBuffers(1,&buffer); query_scalar = 0; assert(!is(buffer));
        glBufferData(GL_ARRAY_BUFFER,-1,NULL,GL_STATIC_DRAW); assert(glGetError() == GL_INVALID_VALUE);
        glBufferData(GL_ARRAY_BUFFER,4,NULL,GL_STATIC_DRAW); assert(glGetError() == GL_INVALID_OPERATION);
        glBufferSubData(GL_ARRAY_BUFFER,0,0,NULL); assert(glGetError() == GL_INVALID_OPERATION);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-buffer-query"); return 0;
    }
    if (!strcmp(argv[1], "encoder-vertex-query")) {
        void (*iv)(GLuint,GLenum,GLint *) = (void (*)(GLuint,GLenum,GLint *))eglGetProcAddress("glGetVertexAttribiv");
        void (*fv)(GLuint,GLenum,GLfloat *) = (void (*)(GLuint,GLenum,GLfloat *))eglGetProcAddress("glGetVertexAttribfv");
        void (*pv)(GLuint,GLenum,void **) = (void (*)(GLuint,GLenum,void **))eglGetProcAddress("glGetVertexAttribPointerv"); assert(iv && fv && pv);
        const GLfixed data[5] = {65536,0,0,0,0};
        glVertexAttribPointer(1,3,GL_FIXED,GL_TRUE,20,data); glEnableVertexAttribArray(1); glDrawArrays(GL_POINTS,0,1);
        GLint i = 87; GLfloat f = 87; void *pointer = NULL;
        iv(1,GL_VERTEX_ATTRIB_ARRAY_STRIDE,&i); assert(i == 20); fv(1,GL_VERTEX_ATTRIB_ARRAY_SIZE,&f); assert(f == 3);
        iv(1,GL_VERTEX_ATTRIB_ARRAY_TYPE,&i); assert(i == GL_FIXED); iv(1,GL_VERTEX_ATTRIB_ARRAY_NORMALIZED,&i); assert(i == 1);
        iv(1,GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,&i); assert(i == 0); pv(1,GL_VERTEX_ATTRIB_ARRAY_POINTER,&pointer); assert(pointer == data);
        GLint v[4]; GLfloat w[4]; iv(1,GL_CURRENT_VERTEX_ATTRIB,v); fv(1,GL_CURRENT_VERTEX_ATTRIB,w);
        assert(v[0] == -2 && v[2] == 3 && w[0] == -1.75f && w[2] == 2.5f);
        i = 87; iv(16,GL_VERTEX_ATTRIB_ARRAY_SIZE,&i); assert(i == 87 && glGetError() == GL_INVALID_VALUE);
        pv(1,0xdead,&pointer); assert(pointer == data && glGetError() == GL_INVALID_ENUM);
        GLuint buffer; glGenBuffers(1,&buffer); glBindBuffer(GL_ARRAY_BUFFER,buffer); glVertexAttribPointer(1,2,GL_FLOAT,GL_FALSE,0,(void *)8);
        iv(1,GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,&i); assert((GLuint)i == buffer); glDeleteBuffers(1,&buffer);
        iv(1,GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,&i); assert(i == 0); pv(1,GL_VERTEX_ATTRIB_ARRAY_POINTER,&pointer); assert(pointer == (void *)8);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-vertex-query"); return 0;
    }
    if (!strcmp(argv[1], "encoder-bound-errors")) {
        const GLfloat vertices[4] = {0,0,-0.5f,1.5f}; const GLushort index = 1;
        GLuint buffer; glGenBuffers(1,&buffer); glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,buffer); glBufferData(GL_ELEMENT_ARRAY_BUFFER,2,&index,GL_STATIC_DRAW);
        capture_array_upload = 1; glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,vertices); glEnableVertexAttribArray(0); indexed_max = 1;
        indexed_queries = 1; fail_malloc = 1; glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,NULL); fail_malloc = 0;
        assert(draw_commands == 0 && glGetError() == GL_OUT_OF_MEMORY);
        for (int failure=2; failure<=3; failure++) {
            indexed_queries = failure; glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,NULL);
            assert(draw_commands == 0 && captured_size == 0 && glGetError() == GL_INVALID_OPERATION);
        }
        indexed_queries = 4; query_gl_error = GL_OUT_OF_MEMORY; glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,NULL);
        assert(draw_commands == 0 && glGetError() == GL_OUT_OF_MEMORY && glGetError() == GL_NO_ERROR);
        indexed_queries = 1; glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,NULL); glFlush();
        assert(draw_commands == 1 && captured_size == 16 && glGetError() == GL_NO_ERROR);
        glDeleteBuffers(1,&buffer);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-bound-errors"); return 0;
    }
    if (!strcmp(argv[1], "encoder-draw-enums")) {
        glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,(const void *)1); glEnableVertexAttribArray(0);
        glDrawArrays(0xdead,0,1); assert(glGetError() == GL_INVALID_ENUM);
        glDrawElements(0xdead,1,GL_UNSIGNED_BYTE,(const void *)1); assert(glGetError() == GL_INVALID_ENUM);
        glDrawElements(GL_POINTS,1,GL_UNSIGNED_INT,(const void *)1); assert(glGetError() == GL_INVALID_ENUM);
        glFlush(); assert(draw_commands == 0 && buffer_uploads == 0);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-draw-enums"); return 0;
    }
    if (!strcmp(argv[1], "encoder-max-byte") || !strcmp(argv[1], "encoder-max-short") || !strcmp(argv[1], "encoder-bound-byte") || !strcmp(argv[1], "encoder-bound-short")) {
        const int wide = strstr(argv[1],"short") != NULL, bound = strstr(argv[1],"bound") != NULL;
        const unsigned maximum = wide ? 65535 : 255, count = 33000, width = wide ? 2 : 1;
        GLfloat *vertices = calloc((size_t)maximum+1,2*sizeof(GLfloat)); assert(vertices);
        vertices[maximum*2] = -0.5f; vertices[maximum*2+1] = 1.5f;
        unsigned char *indices = malloc(count*width); assert(indices);
        for (unsigned i=0; i<count; i++) {
            const GLushort value = (GLushort)maximum;
            if (wide) memcpy(indices+i*2,&value,2); else indices[i] = (unsigned char)maximum;
        }
        capture_array_upload = 1;
        glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,vertices); glEnableVertexAttribArray(0);
        GLuint buffer = 0;
        if (bound) { glGenBuffers(1,&buffer); glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,buffer); glBufferData(GL_ELEMENT_ARRAY_BUFFER,count*width,indices,GL_STATIC_DRAW); indexed_queries = 1; indexed_max = maximum; }
        glDrawElements(GL_POINTS,count,wide ? GL_UNSIGNED_SHORT : GL_UNSIGNED_BYTE,bound ? NULL : indices); glFlush();
        if (bound) glDeleteBuffers(1,&buffer);
        assert(draw_commands == 1 && glGetError() == GL_NO_ERROR);
        assert(captured_size == (maximum+1)*2*sizeof(GLfloat));
        assert(!memcmp(captured_bytes+maximum*2*sizeof(GLfloat),vertices+maximum*2,2*sizeof(GLfloat)));
        free(indices); free(vertices);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strcmp(argv[1], "encoder-client-scratch")) {
        const GLfloat vertices[6] = {1.5f,0,0,-2.5f,0,0};
        capture_array_upload = 1;
        glVertexAttribPointer(0,1,GL_FLOAT,GL_FALSE,12,vertices); glEnableVertexAttribArray(0);
        fail_malloc = 1; glDrawArrays(GL_POINTS,0,2); fail_malloc = 0; glFlush();
        assert(draw_commands == 0 && buffer_uploads == 0 && glGetError() == GL_OUT_OF_MEMORY);
        glDrawArrays(GL_POINTS,0,2); glFlush();
        assert(draw_commands == 1 && glGetError() == GL_NO_ERROR && captured_size == 8);
        assert(!memcmp(captured_bytes,(const GLfloat[]){1.5f,-2.5f},8));
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-client-scratch"); return 0;
    }
    if (!strcmp(argv[1], "encoder-client-guard") || !strcmp(argv[1], "encoder-index-guard") || !strcmp(argv[1], "encoder-client-prefix")) {
        const size_t page = (size_t)sysconf(_SC_PAGESIZE);
        unsigned char *memory = mmap(NULL,page*5,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0); assert(memory != MAP_FAILED);
        assert(!mprotect(memory+page*2,page,PROT_READ|PROT_WRITE));
        assert(!mprotect(memory+page*4,page,PROT_READ|PROT_WRITE));
        const GLfloat values[2] = {1.5f,-2.5f};
        memcpy(memory+page*2,values,4); memcpy(memory+page*4,values+1,4);
        const int gaps = !strcmp(argv[1], "encoder-client-guard");
        capture_array_upload = 1;
        glVertexAttribPointer(0,1,GL_FLOAT,GL_FALSE,(GLsizei)(page*2),gaps ? memory+page*2 : memory); glEnableVertexAttribArray(0);
        if (!strcmp(argv[1], "encoder-index-guard")) {
            const GLushort indices[2] = {1,1}; glDrawElements(GL_POINTS,2,GL_UNSIGNED_SHORT,indices);
        } else glDrawArrays(GL_POINTS,gaps ? 0 : 1,gaps ? 2 : 1);
        glFlush();
        assert(draw_commands == 1 && glGetError() == GL_NO_ERROR && captured_size == 8 && captured_stride == 0);
        assert(!memcmp(captured_bytes,gaps ? values : (const GLfloat[]){0,1.5f},8));
        assert(!munmap(memory,page*5));
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strcmp(argv[1], "encoder-client-overflow")) {
        glVertexAttribPointer(0,4,GL_FLOAT,GL_FALSE,0,(const void *)1); glEnableVertexAttribArray(0);
        glDrawArrays(GL_POINTS,INT32_MAX,1); glFlush();
        assert(draw_commands == 0 && buffer_uploads == 0 && glGetError() == GL_OUT_OF_MEMORY);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-client-overflow"); return 0;
    }
    if (!strcmp(argv[1], "encoder-large-client") || !strcmp(argv[1], "encoder-large-fixed")) {
        const int fixed = !strcmp(argv[1], "encoder-large-fixed");
        const unsigned count = 17000, stride = fixed ? 1024 : 8;
        const unsigned size = (count-1)*stride+(fixed ? 16 : 8);
        unsigned char *vertices = malloc(size); assert(vertices); memset(vertices,0xaa,size);
        for (unsigned i=0; i<count; i++) {
            const int32_t f[4] = {-32768,98304,16384,65536};
            const GLfloat v[2] = {-0.5f,1.5f};
            memcpy(vertices+i*stride,fixed ? (const void *)f : (const void *)v,fixed ? sizeof f : sizeof v);
        }
        const GLenum type = fixed ? GL_FIXED : GL_FLOAT;
        capture_array_upload = 1;
        glVertexAttribPointer(0,fixed ? 4 : 2,type,fixed ? GL_TRUE : GL_FALSE,fixed ? stride : 0,vertices); glEnableVertexAttribArray(0);
        glDrawArrays(GL_POINTS,0,count); glFlush();
        assert(draw_commands == 1 && glGetError() == GL_NO_ERROR);
        const unsigned element = fixed ? 16 : 8, packed_size = count*element;
        assert(captured_size == packed_size);
        for (unsigned i=0; i<count; i++) assert(!memcmp(captured_bytes+i*element,vertices+i*stride,element));
        assert(captured_chunks == (packed_size+65519)/65520 && captured_type == type && captured_stride == 0);
        free(vertices);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        printf("PASS %s\n",argv[1]); return 0;
    }
    if (!strcmp(argv[1], "encoder-buffer-names")) {
        glBindBuffer(GL_ARRAY_BUFFER,1);
        GLuint names[2] = {99,99}; glGenBuffers(2,names);
        assert(names[0] == 2 && names[1] == 3);
        GLuint failed[2] = {99,99}; calloc_before_failure = 1;
        glGenBuffers(2,failed); assert(failed[0] == 99 && failed[1] == 99);
        assert(glGetError() == GL_OUT_OF_MEMORY); calloc_before_failure = -1;
        glGenBuffers(2,failed); assert(failed[0] == 4 && failed[1] == 5);
        assert(glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-buffer-names"); return 0;
    }
#ifdef OP_BEGIN_CLIENT_ARRAY
    if (!strcmp(argv[1], "encoder-array-render") ||
        !strcmp(argv[1], "encoder-array-index-render")) {
        const EGLint dimensions[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
        EGLSurface surface = eglCreateWindowSurface(dpy, (EGLConfig)1, NULL, dimensions);
        assert(surface && eglMakeCurrent(dpy, surface, surface, ctx));
        glViewport(0, 0, 1, 1);
        const GLfloat position[2] = {0, 0}, red[4] = {1, 0, 0, 1};
        glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 0, position);
        glEnableVertexAttribArray(1);
        glVertexAttrib4f(0, 0, 1, 0, 1);
        if (!strcmp(argv[1], "encoder-array-index-render")) {
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 17);
            glBufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof red, red, GL_STATIC_DRAW);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
        }
        glBindBuffer(GL_ARRAY_BUFFER, 17);
        glBufferData(GL_ARRAY_BUFFER, sizeof red, red, GL_STATIC_DRAW);
        glDrawArrays(GL_POINTS, 0, 1);
        glFlush();
        glVertexAttribPointer(0, 4, GL_FLOAT, GL_FALSE, 0, NULL);
        glEnableVertexAttribArray(0);
        glDrawArrays(GL_POINTS, 0, 1);
        glFlush();
        assert(array_captures == 2 && array_restores == 2 && device_slots[0].array_binding == 17);
        assert(eglSwapBuffers(dpy, surface));
        GLuint buffer = 17;
        glDeleteBuffers(1, &buffer);
        assert(eglDestroySurface(dpy, surface) && eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread() && eglTerminate(dpy) && allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "encoder-array-save")) {
        const GLfloat vertex[2] = {0, 0};
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, vertex);
        glEnableVertexAttribArray(0);
        glBindBuffer(GL_ARRAY_BUFFER, 17);
        glBufferData(GL_ARRAY_BUFFER, 24, NULL, GL_STATIC_DRAW);
        glDrawArrays(GL_POINTS, 0, 1);
        glFlush();
        assert(array_captures == 1 && array_restores == 1 && device_slots[0].array_binding == 17 &&
               draw_commands == 1);
        calloc_before_failure = 0;
        glDrawArrays(GL_POINTS, 0, 1);
        calloc_before_failure = -1;
        glFlush();
        assert(glGetError() == GL_OUT_OF_MEMORY && array_captures == 2 && array_restores == 2 &&
               device_slots[0].array_binding == 17 && draw_commands == 1);
        const GLushort index = 0;
        glDrawElements(GL_POINTS, 1, GL_UNSIGNED_SHORT, &index);
        glFlush();
        assert(glGetError() == GL_NO_ERROR && array_captures == 3 && array_restores == 3 &&
               device_slots[0].array_binding == 17 && draw_commands == 2);
        glDisableVertexAttribArray(0);
        glDrawArrays(GL_POINTS, 0, 0);
        glFlush();
        assert(array_captures == 3 && array_restores == 3 && !device_slots[0].array_saved);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS encoder-array-save");
        return 0;
    }
#endif
    if (!strcmp(argv[1], "encoder-stage-allocation")) {
        const GLfloat vertex[2] = {0,0};
        for (unsigned i = 0; i < 2; i++) {
            glVertexAttribPointer(i,2,GL_FLOAT,GL_FALSE,0,vertex); glEnableVertexAttribArray(i);
        }
        GLuint application; glGenBuffers(1,&application); glBindBuffer(GL_ARRAY_BUFFER,application);
        calloc_before_failure = 1; // First staging buffer succeeds, second fails.
        glDrawArrays(GL_POINTS,0,1); glFlush();
        assert(draw_commands == 0 && buffer_uploads == 1 && glGetError() == GL_OUT_OF_MEMORY);
        calloc_before_failure = -1;
        glDrawArrays(GL_POINTS,0,1); glFlush();
        assert(draw_commands == 1 && buffer_uploads == 3 && glGetError() == GL_NO_ERROR);
        const GLushort index = 0;
        fail_calloc = 1;
        glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,&index); glFlush();
        assert(draw_commands == 1 && buffer_uploads == 3 && glGetError() == GL_OUT_OF_MEMORY);
        fail_calloc = 0;
        glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,&index); glFlush();
        assert(draw_commands == 2 && buffer_uploads == 6 && glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-stage-allocation"); return 0;
    }
    if (!strcmp(argv[1], "encoder-vao-name-reuse")) {
        GLuint array; glGenVertexArrays(1,&array); glBindVertexArray(array);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,71); glBindVertexArray(0);
        glDeleteBuffers(1,(const GLuint[]){71});
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,71); glBindVertexArray(array);
        glDeleteBuffers(1,(const GLuint[]){71});
        glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,NULL); glFlush();
        assert(draw_commands == 1 && buffer_uploads == 0 && glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-vao-name-reuse"); return 0;
    }
    if (!strcmp(argv[1], "encoder-delete-array")) {
        GLuint buffer; glGenBuffers(1,&buffer); glBindBuffer(GL_ARRAY_BUFFER,buffer);
        glDeleteBuffers(1,&buffer);
        const GLfloat vertex[2] = {0,0};
        glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,vertex); glEnableVertexAttribArray(0);
        glDrawArrays(GL_POINTS,0,1); glFlush();
        assert(buffer_uploads == 1 && glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-delete-array"); return 0;
    }
    if (!strcmp(argv[1], "encoder-delete-element")) {
        GLuint buffer; glGenBuffers(1,&buffer); glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,buffer);
        glDeleteBuffers(1,&buffer); const GLushort index = 0;
        glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,&index); glFlush();
        assert(buffer_uploads == 1 && glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-delete-element"); return 0;
    }
    if (!strcmp(argv[1], "encoder-vao-elements")) {
        GLuint arrays[2], buffer; glGenVertexArrays(2,arrays); glGenBuffers(1,&buffer);
        glBindVertexArray(arrays[0]); glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,buffer);
        glBindVertexArray(arrays[1]); const GLushort index = 0;
        glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,&index); glFlush();
        assert(buffer_uploads == 1);
        glBindVertexArray(arrays[0]); glDrawElements(GL_POINTS,1,GL_UNSIGNED_SHORT,NULL); glFlush();
        assert(buffer_uploads == 1 && glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-vao-elements"); return 0;
    }
    if (!strcmp(argv[1], "encoder-vao-attribs")) {
        const GLfloat vertex[2] = {0,0};
        glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,vertex); glEnableVertexAttribArray(0);
        GLuint array; glGenVertexArrays(1,&array); glBindVertexArray(array);
        glDrawArrays(GL_POINTS,0,1); glFlush(); assert(buffer_uploads == 0);
        glDeleteVertexArrays(1,&array); glDrawArrays(GL_POINTS,0,1); glFlush();
        assert(buffer_uploads == 1 && glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-vao-attribs"); return 0;
    }
    if (!strcmp(argv[1], "encoder-strings")) {
        string_generation = 1;
        assert(!strcmp((const char *)glGetString(GL_VENDOR),"renderer A"));
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread());
        string_generation = 2;
        ctx = eglCreateContext(dpy,(EGLConfig)1,EGL_NO_CONTEXT,attrs);
        assert(ctx != EGL_NO_CONTEXT && eglMakeCurrent(dpy,EGL_NO_SURFACE,EGL_NO_SURFACE,ctx));
        assert(!strcmp((const char *)glGetString(GL_VENDOR),"renderer B"));
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-strings"); return 0;
    }
    if (!strcmp(argv[1], "encoder-allocation")) {
        assert(context_create_calls == 1);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-allocation"); return 0;
    }
    if (!strcmp(argv[1], "encoder-unbound")) {
        glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT,7);
        pthread_t thread;
        assert(pthread_create(&thread,NULL,change_without_current_context,NULL) == 0);
        assert(pthread_join(thread,NULL) == 0);
        GLint row_length = 0;
        glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT,&row_length);
        assert(row_length == 7 && glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-unbound"); return 0;
    }
    if (!strcmp(argv[1], "encoder-transfer")) {
        glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT,7);
        assert(glCreateShader(0) == 0);
        assert(eglReleaseThread());
        struct thread_context input = {dpy,ctx}; pthread_t thread;
        assert(pthread_create(&thread,NULL,transfer_encoder_context,&input) == 0);
        assert(pthread_join(thread,NULL) == 0);
        assert(eglMakeCurrent(dpy,EGL_NO_SURFACE,EGL_NO_SURFACE,ctx));
        GLint row_length = 0;
        glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT,&row_length);
        assert(row_length == 11 && glGetError() == GL_NO_ERROR && clear_commands == 1);
        assert(eglDestroyContext(dpy,ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS encoder-transfer"); return 0;
    }
    if (!strcmp(argv[1], "names-render")) {
        GLuint implicit = 1, generated = 0, framebuffer;
        glBindTexture(GL_TEXTURE_2D, implicit);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glGenTextures(1, &generated);
        assert(generated == 2);
        glBindTexture(GL_TEXTURE_2D, generated);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glGenFramebuffers(1, &framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, implicit, 0);
        glClearColor(1, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, generated, 0);
        glClearColor(0, 1, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, implicit, 0);
        glClear(0);
        glFlush();
        glDeleteTextures(1, &implicit);
        glDeleteTextures(1, &generated);
        glDeleteFramebuffers(1, &framebuffer);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS names-render");
        return 0;
    }
    if (!strcmp(argv[1], "names-implicit")) {
        GLuint textures[2], renderbuffers[2];
        glBindTexture(GL_TEXTURE_2D, 1);
        glGenTextures(2, textures);
        assert(textures[0] == 2 && textures[1] == 3);
        glBindRenderbuffer(GL_RENDERBUFFER, 1);
        glGenRenderbuffers(2, renderbuffers);
        assert(renderbuffers[0] == 2 && renderbuffers[1] == 3);
        glDeleteTextures(2, textures);
        glDeleteRenderbuffers(2, renderbuffers);
        GLuint first = 1;
        glDeleteTextures(1, &first);
        glDeleteRenderbuffers(1, &first);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS names-implicit");
        return 0;
    }
#ifdef WPK_GL_OBJECT_GROUPS
    if (!strcmp(argv[1], "group-metadata")) {
        struct wpk_gles_context *source = _wpk_gl_current_encoder(),
                                *peer = _wpk_gl_create_shared_encoder(source);
        struct wpk_gles_context *independent = _wpk_gl_create_encoder();
        assert(peer && independent);
        GLuint a, b, c;
        glGenBuffers(1, &a);
        assert(a == 1);
        assert(_wpk_gl_reserve_names(peer, 0, 1, &b) == GL_NO_ERROR && b == 2);
        assert(_wpk_gl_reserve_names(independent, 0, 1, &c) == GL_NO_ERROR && c == 1);
        glBindBuffer(GL_ARRAY_BUFFER, 9);
        uint32_t batch[7];
        assert(_wpk_gl_reserve_names(peer, 0, 7, batch) == GL_NO_ERROR);
        const uint32_t expected[7] = {3, 4, 5, 6, 7, 8, 10};
        assert(!memcmp(batch, expected, sizeof batch));
        glBindTexture(GL_TEXTURE_2D, 1);
        glBindRenderbuffer(GL_RENDERBUFFER, 1);
        for (unsigned kind = 1; kind <= 2; kind++)
            assert(_wpk_gl_reserve_names(peer, kind, 1, &b) == GL_NO_ERROR && b == 2);
        uint32_t combined[2];
        assert(_wpk_gl_reserve_names(source, 3, 2, combined) == GL_NO_ERROR && combined[0] == 1 &&
               combined[1] == 2);
        assert(_wpk_gl_reserve_names(peer, 3, 1, &b) == GL_NO_ERROR && b == 3);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread());
        assert(_wpk_gl_reserve_names(peer, 0, 1, &b) == GL_NO_ERROR && b == 11);
        _wpk_gl_destroy_encoder(independent);
        _wpk_gl_destroy_encoder(peer);
        assert(eglTerminate(dpy) && allocation_count() == 0);
        puts("PASS group-metadata");
        return 0;
    }
    if (!strcmp(argv[1], "group-parallel")) {
        struct wpk_gles_context *source = _wpk_gl_current_encoder(),
                                *peer = _wpk_gl_create_shared_encoder(source);
        assert(peer);
        struct group_reservation_start start = {.mutex = PTHREAD_MUTEX_INITIALIZER,
                                                .condition = PTHREAD_COND_INITIALIZER};
        struct group_reservation_thread input[2] = {{.state = source, .start = &start},
                                                    {.state = peer, .start = &start}};
        pthread_t threads[2];
        for (unsigned i = 0; i < 2; i++)
            assert(!pthread_create(&threads[i], NULL, reserve_group_names, &input[i]));
        pthread_mutex_lock(&start.mutex);
        while (start.ready != 2)
            pthread_cond_wait(&start.condition, &start.mutex);
        start.run = 1;
        pthread_cond_broadcast(&start.condition);
        pthread_mutex_unlock(&start.mutex);
        for (unsigned i = 0; i < 2; i++)
            assert(!pthread_join(threads[i], NULL));
        assert(!pthread_cond_destroy(&start.condition) && !pthread_mutex_destroy(&start.mutex));
        uint8_t seen[257] = {0};
        for (unsigned i = 0; i < 2; i++)
            for (unsigned j = 0; j < 128; j++) {
                uint32_t name = input[i].names[j];
                assert(name && name <= 256 && !seen[name]);
                seen[name] = 1;
            }
        GLuint next;
        glGenBuffers(1, &next);
        assert(next == 257);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread());
        _wpk_gl_destroy_encoder(peer);
        assert(eglTerminate(dpy) && allocation_count() == 0);
        puts("PASS group-parallel");
        return 0;
    }
    if (!strcmp(argv[1], "names-rollback")) {
        struct wpk_gles_context *source = _wpk_gl_current_encoder();
        const unsigned before = allocation_count();
        fail_calloc = 1;
        assert(!_wpk_gl_create_shared_encoder(source));
        fail_calloc = 0;
        calloc_before_failure = 1;
        assert(!_wpk_gl_create_encoder());
        calloc_before_failure = -1;
        assert(allocation_count() == before);
        glBindTexture(0xdead, 1);
        assert(glGetError() == GL_INVALID_ENUM && allocation_count() == before);
        glBindRenderbuffer(GL_TEXTURE_2D, 1);
        assert(glGetError() == GL_INVALID_ENUM && allocation_count() == before);
        fail_calloc = 1;
        glBindTexture(GL_TEXTURE_2D, 1);
        fail_calloc = 0;
        assert(glGetError() == GL_OUT_OF_MEMORY && allocation_count() == before);
        fail_calloc = 1;
        glBindRenderbuffer(GL_RENDERBUFFER, 1);
        fail_calloc = 0;
        assert(glGetError() == GL_OUT_OF_MEMORY && allocation_count() == before);
        for (unsigned kind = 0; kind < 3; kind++) {
            GLuint output[2] = {97, 98};
            calloc_before_failure = 1;
            assert(_wpk_gl_reserve_names(source, kind, 2, output) == GL_OUT_OF_MEMORY);
            calloc_before_failure = -1;
            assert(output[0] == 97 && output[1] == 98 && allocation_count() == before);
            assert(_wpk_gl_reserve_names(source, kind, 2, output) == GL_NO_ERROR &&
                   output[0] == 1 && output[1] == 2);
            if (kind == 0)
                glDeleteBuffers(2, output);
            else if (kind == 1)
                glDeleteTextures(2, output);
            else
                glDeleteRenderbuffers(2, output);
            assert(allocation_count() == before);
        }
        uint32_t unchanged = 99;
        assert(_wpk_gl_reserve_names(source, 4, 1, &unchanged) == GL_INVALID_ENUM &&
               unchanged == 99);
        assert(_wpk_gl_reserve_names(source, 0, -1, &unchanged) == GL_INVALID_VALUE &&
               unchanged == 99);
        glGenTextures(-1, &unchanged);
        assert(glGetError() == GL_INVALID_VALUE && unchanged == 99);
        glGenRenderbuffers(-1, &unchanged);
        assert(glGetError() == GL_INVALID_VALUE && unchanged == 99);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS names-rollback");
        return 0;
    }
#endif
    if (!strcmp(argv[1], "image-attach-reject-texture") ||
        !strcmp(argv[1], "image-attach-reject-rbo") ||
        !strcmp(argv[1], "image-delete-reject-fbo")) {
        int texture = strcmp(argv[1], "image-attach-reject-rbo") != 0;
        int delete_fbo = !strcmp(argv[1], "image-delete-reject-fbo");
        GLuint name = 17, replacement = 18, framebuffers[2];
        EGLImageKHR img = image(dpy);
        glGenFramebuffers(2, framebuffers);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[0]);
        if (texture) {
            glBindTexture(GL_TEXTURE_2D, name);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, name, 0);
        } else {
            glBindRenderbuffer(GL_RENDERBUFFER, name);
            glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
            glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, name);
        }
        assert(eglDestroyImageKHR(dpy, img) && closes == 0);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[1]);
        if (texture)
            glDeleteTextures(1, &name);
        else
            glDeleteRenderbuffers(1, &name);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[0]);
        if (texture)
            glBindTexture(GL_TEXTURE_2D, replacement);
        else
            glBindRenderbuffer(GL_RENDERBUFFER, replacement);
        glFlush();
        assert(glGetError() == GL_NO_ERROR && closes == 0);
        image_mutation_failure = 2;
        for (unsigned retry = 0; retry < 2; retry++) {
            if (delete_fbo)
                glDeleteFramebuffers(1, framebuffers);
            else if (texture)
                glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                                       replacement, 0);
            else
                glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER,
                                          replacement);
            glFlush();
            assert(glGetError() == (retry ? GL_NO_ERROR : GL_OUT_OF_MEMORY));
            assert(closes == retry);
        }
        glDeleteFramebuffers(2, framebuffers);
        if (texture)
            glDeleteTextures(1, &replacement);
        else
            glDeleteRenderbuffers(1, &replacement);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "image-delete-reject-texture") ||
        !strcmp(argv[1], "image-delete-reject-rbo")) {
        int texture = !strcmp(argv[1], "image-delete-reject-texture");
        binding_model = 1;
        GLuint name = 17;
        EGLImageKHR img = image(dpy);
        if (texture) {
            glBindTexture(GL_TEXTURE_2D, name);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        } else {
            glBindRenderbuffer(GL_RENDERBUFFER, name);
            glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
        }
        assert(eglDestroyImageKHR(dpy, img) && closes == 0);
        image_mutation_failure = 2;
        for (unsigned retry = 0; retry < 2; retry++) {
            if (texture)
                glDeleteTextures(1, &name);
            else
                glDeleteRenderbuffers(1, &name);
            glFlush();
            assert(glGetError() == (retry ? GL_NO_ERROR : GL_OUT_OF_MEMORY));
            assert(closes == retry);
            GLint binding = -1;
            binding_query_kind = texture ? GL_TEXTURE_BINDING_2D : GL_RENDERBUFFER_BINDING;
            glGetIntegerv(binding_query_kind, &binding);
            binding_query_kind = 0;
            assert(binding == (retry ? 0 : (GLint)name));
        }
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "image-attach-unknown-texture") ||
        !strcmp(argv[1], "image-attach-unknown-rbo")) {
        int texture = !strcmp(argv[1], "image-attach-unknown-texture");
        struct wpk_gles_context *peer = _wpk_gl_create_shared_encoder(_wpk_gl_current_encoder());
        assert(peer);
        GLuint name = 17, framebuffer;
        glGenFramebuffers(1, &framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        for (unsigned failure = 1; failure <= 5; failure += failure == 1 ? 2 : 1) {
            EGLImageKHR img = image(dpy);
            if (texture) {
                glBindTexture(GL_TEXTURE_2D, name);
                glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
            } else {
                glBindRenderbuffer(GL_RENDERBUFFER, name);
                glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
            }
            image_mutation_failure = failure;
            if (texture)
                glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, name,
                                       0);
            else
                glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER,
                                          name);
            assert(glGetError() == GL_INVALID_OPERATION);
            assert(eglDestroyImageKHR(dpy, img));
            if (texture)
                glDeleteTextures(1, &name);
            else
                glDeleteRenderbuffers(1, &name);
            assert(closes == 0);
        }
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && closes == 0);
        _wpk_gl_destroy_encoder(peer);
        assert(closes == 1);
        assert(eglTerminate(dpy) && allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "buffer-delete-reject-array") ||
        !strcmp(argv[1], "buffer-delete-reject-element")) {
        int array = !strcmp(argv[1], "buffer-delete-reject-array");
        GLenum target = array ? GL_ARRAY_BUFFER : GL_ELEMENT_ARRAY_BUFFER;
        GLuint name = 17;
        glBindBuffer(target, name);
        if (array)
            glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, NULL);
        glFlush();
        buffer_delete_failure = 1;
        glDeleteBuffers(1, &name);
        glFlush();
        assert(glGetError() == GL_OUT_OF_MEMORY);
        assert((array ? device_slots[0].array_binding : device_slots[0].element_binding) == name);
        if (array) {
            GLint value = -1;
            glGetVertexAttribiv(0, GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, &value);
            assert(value == 17);
            glBufferData(target, 8, NULL, GL_STATIC_DRAW);
            glFlush();
            assert(buffer_uploads == 1 && glGetError() == GL_NO_ERROR);
        } else {
            glDrawElements(GL_POINTS, 1, GL_UNSIGNED_SHORT, NULL);
            glFlush();
            assert(draw_commands == 1 && buffer_uploads == 0 && glGetError() == GL_NO_ERROR);
        }
        glDeleteBuffers(1, &name);
        glFlush();
        assert((array ? device_slots[0].array_binding : device_slots[0].element_binding) == 0);
        if (array) {
            GLint value = -1;
            glGetVertexAttribiv(0, GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, &value);
            assert(value == 0);
        } else {
            const GLushort index = 0;
            glDrawElements(GL_POINTS, 1, GL_UNSIGNED_SHORT, &index);
            glFlush();
            assert(draw_commands == 2 && buffer_uploads == 1 && glGetError() == GL_NO_ERROR);
        }
        assert(glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "buffer-bind-reject-array") ||
        !strcmp(argv[1], "buffer-bind-reject-element")) {
        int array = !strcmp(argv[1], "buffer-bind-reject-array");
        GLenum target = array ? GL_ARRAY_BUFFER : GL_ELEMENT_ARRAY_BUFFER;
        glBindBuffer(target, 17);
        glFlush();
        buffer_bind_failure = 1;
        glBindBuffer(target, 0);
        glFlush();
        assert(glGetError() == GL_OUT_OF_MEMORY);
        assert((array ? device_slots[0].array_binding : device_slots[0].element_binding) == 17);
        if (array) {
            GLint value = -1;
            glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, NULL);
            glGetVertexAttribiv(0, GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, &value);
            assert(value == 17);
        } else {
            glDrawElements(GL_POINTS, 1, GL_UNSIGNED_SHORT, NULL);
            glFlush();
            assert(draw_commands == 1 && buffer_uploads == 0 && glGetError() == GL_NO_ERROR);
        }
        glBindBuffer(target, 0);
        glFlush();
        assert((array ? device_slots[0].array_binding : device_slots[0].element_binding) == 0);
        buffer_bind_failure = 1;
        glBindBuffer(target, 18);
        glFlush();
        assert(glGetError() == GL_OUT_OF_MEMORY);
        if (array) {
            GLint value = -1;
            const GLfloat vertex[2] = {0, 0};
            glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, vertex);
            glGetVertexAttribiv(0, GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, &value);
            assert(value == 0);
        } else {
            const GLushort index = 0;
            glDrawElements(GL_POINTS, 1, GL_UNSIGNED_SHORT, &index);
            glFlush();
            assert(draw_commands == 2 && buffer_uploads == 1 && glGetError() == GL_NO_ERROR);
        }
        glBindBuffer(target, 18);
        glFlush();
        assert((array ? device_slots[0].array_binding : device_slots[0].element_binding) == 18);
        assert(glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "image-object-close-texture") ||
        !strcmp(argv[1], "image-object-close-rbo")) {
        int texture = !strcmp(argv[1], "image-object-close-texture");
        struct wpk_gles_context *peer = _wpk_gl_create_shared_encoder(_wpk_gl_current_encoder());
        assert(peer);
        GLuint name = 17;
        EGLImageKHR img = image(dpy);
        if (texture) {
            glBindTexture(GL_TEXTURE_2D, name);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        } else {
            glBindRenderbuffer(GL_RENDERBUFFER, name);
            glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
        }
        assert(eglDestroyImageKHR(dpy, img) && closes == 0);
        close_group_peer = peer;
        if (texture)
            glDeleteTextures(1, &name);
        else
            glDeleteRenderbuffers(1, &name);
        assert(closes == 1 && close_group_reservations == 1 && !close_group_peer);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread());
        _wpk_gl_destroy_encoder(peer);
        assert(eglTerminate(dpy) && allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "image-object-revisions-texture") ||
        !strcmp(argv[1], "image-object-revisions-rbo")) {
        int texture = !strcmp(argv[1], "image-object-revisions-texture");
        GLuint name = 17;
        EGLImageKHR images[3] = {image(dpy), image(dpy), image(dpy)};
        nested_image_import = images[1];
        if (texture) {
            glBindTexture(GL_TEXTURE_2D, name);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, images[0]);
        } else {
            glBindRenderbuffer(GL_RENDERBUFFER, name);
            glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, images[0]);
        }
        assert(!nested_image_import && glGetError() == GL_NO_ERROR);
        for (unsigned i = 0; i < 3; i++) {
            struct wpk_egl_image *record = _wpk_egl_image_lookup(images[i]);
            assert(record && record->references == (i == 1 ? 3u : 2u));
            _wpk_egl_image_release(record);
        }
        const GLubyte blue[4] = {0, 0, 255, 255};
        unsigned before = image_pixel_updates;
        nested_image_state = images[2];
        if (texture)
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, blue);
        else
            glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA4, 1, 1);
        assert(!nested_image_state && glGetError() == GL_NO_ERROR && image_pixel_updates == before);
        for (unsigned i = 0; i < 3; i++) {
            struct wpk_egl_image *record = _wpk_egl_image_lookup(images[i]);
            assert(record && record->references == (i == 2 ? 3u : 2u));
            _wpk_egl_image_release(record);
        }
        if (texture)
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, blue);
        else
            glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA4, 1, 1);
        glFlush();
        assert(glGetError() == GL_NO_ERROR && (!texture || image_pixel_updates > before));
        for (unsigned i = 0; i < 3; i++) {
            struct wpk_egl_image *record = _wpk_egl_image_lookup(images[i]);
            assert(record && record->references == 2);
            _wpk_egl_image_release(record);
            assert(eglDestroyImageKHR(dpy, images[i]));
        }
        assert(closes == 1);
        if (texture)
            glDeleteTextures(1, &name);
        else
            glDeleteRenderbuffers(1, &name);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "image-group-namespace-texture") ||
        !strcmp(argv[1], "image-group-namespace-rbo")) {
        int texture = !strcmp(argv[1], "image-group-namespace-texture");
        struct wpk_gles_context *peer = _wpk_gl_create_shared_encoder(_wpk_gl_current_encoder());
        assert(peer);
        EGLImageKHR img = image(dpy);
        if (texture) {
            glBindTexture(GL_TEXTURE_2D, 17);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        } else {
            glBindRenderbuffer(GL_RENDERBUFFER, 17);
            glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
        }
        assert(glGetError() == GL_NO_ERROR && eglDestroyImageKHR(dpy, img) && closes == 0);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && closes == 0);
        // A still-named shared object belongs to the group even when only a
        // private metadata peer survives. No public sharing/rendering claim.
        _wpk_gl_destroy_encoder(peer);
        assert(closes == 1);
        assert(eglTerminate(dpy) && allocation_count() == 0);
        printf("PASS %s\n", argv[1]);
        return 0;
    }
    if (!strcmp(argv[1], "image-framebuffer-bind-reject")) {
        GLuint name = 17, framebuffers[2];
        EGLImageKHR img = image(dpy);
        glGenFramebuffers(2, framebuffers);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[0]);
        glBindTexture(GL_TEXTURE_2D, name);
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, name, 0);
        assert(eglDestroyImageKHR(dpy, img) && closes == 0);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[1]);
        glDeleteTextures(1, &name);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[0]);
        glFlush();
        image_mutation_failure = 2;
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[1]);
        glFlush();
        assert(glGetError() == GL_OUT_OF_MEMORY && closes == 0);
        // Accepted detachment must retire the old bound container's image,
        // not the numeric container whose native selection was rejected.
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
        assert(glGetError() == GL_NO_ERROR && closes == 1);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[1]);
        assert(glGetError() == GL_NO_ERROR);
        glDeleteFramebuffers(2, framebuffers);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-framebuffer-bind-reject");
        return 0;
    }
    if (!strcmp(argv[1], "image-owned-storage-reject")) {
        GLuint texture = 17;
        glBindTexture(GL_TEXTURE_2D, texture);
        const GLubyte blue[4] = {0, 0, 255, 255};
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, blue);
        glFlush();
        unsigned before = image_pixel_updates;
        assert(before > 0);
        fail_image_storage = 1;
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, blue);
        glFlush();
        assert(glGetError() == GL_INVALID_VALUE && image_pixel_updates == before);
        fail_image_storage = 0;
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, blue);
        glFlush();
        assert(glGetError() == GL_NO_ERROR && image_pixel_updates > before);
        glDeleteTextures(1, &texture);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-owned-storage-reject");
        return 0;
    }
    if (!strcmp(argv[1], "image-texture-rollback") || !strcmp(argv[1], "image-rbo-rollback")) {
        int texture = !strcmp(argv[1], "image-texture-rollback");
        GLuint name = 17;
        EGLImageKHR img = image(dpy);
        if (texture) {
            glBindTexture(GL_TEXTURE_2D, name);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        } else {
            glBindRenderbuffer(GL_RENDERBUFFER, name);
            glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
        }
        assert(eglDestroyImageKHR(dpy, img) && closes == 0);
        const GLubyte blue[16] = {0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255};
        unsigned updates = image_pixel_updates;
        fail_image_storage = 1;
        if (texture)
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, blue);
        else
            glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA4, 2, 2);
        assert(glGetError() == GL_INVALID_VALUE && closes == 0);
        assert(image_pixel_updates == updates);
        fail_image_storage = 0;
        if (texture)
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, blue);
        else
            glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA4, 2, 2);
        assert(glGetError() == GL_NO_ERROR && closes == 1);
        if (texture)
            assert(image_pixel_updates > updates);
        if (texture)
            glDeleteTextures(1, &name);
        else
            glDeleteRenderbuffers(1, &name);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts(texture ? "PASS image-texture-rollback" : "PASS image-rbo-rollback");
        return 0;
    }
    if (!strcmp(argv[1], "image-import-reject")) {
        GLuint name = 17;
        glBindTexture(GL_TEXTURE_2D, name);
        EGLImageKHR img = image(dpy);
        image_failure = 2;
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        assert(glGetError() == GL_OUT_OF_MEMORY);
        assert(eglDestroyImageKHR(dpy, img) && closes == 1);
        glDeleteTextures(1, &name);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-import-reject");
        return 0;
    }
    if (!strcmp(argv[1], "image-import-unknown-peer-texture") ||
        !strcmp(argv[1], "image-import-unknown-peer-rbo")) {
        int texture = !strcmp(argv[1], "image-import-unknown-peer-texture");
        struct wpk_gles_context *peer = _wpk_gl_create_shared_encoder(_wpk_gl_current_encoder());
        assert(peer);
        GLuint name = 17;
        if (texture)
            glBindTexture(GL_TEXTURE_2D, name);
        else
            glBindRenderbuffer(GL_RENDERBUFFER, name);
        for (unsigned failure = 1; failure <= 3; failure += 2) {
            EGLImageKHR img = image(dpy);
            image_failure = failure;
            if (texture)
                glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
            else
                glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
            assert(glGetError() == GL_INVALID_OPERATION);
            assert(eglDestroyImageKHR(dpy, img) && closes == 0);
        }
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && closes == 0);
        // Source encoder retirement alone cannot prove that a peer has stopped
        // using a candidate accepted before its acknowledgement was lost.
        // This private metadata peer has no public EGL context record, so retire
        // it before terminating the generation that owns the imported handles.
        _wpk_gl_destroy_encoder(peer);
        assert(closes == 1);
        assert(eglTerminate(dpy) && allocation_count() == 0);
        puts(texture ? "PASS image-import-unknown-peer-texture"
                     : "PASS image-import-unknown-peer-rbo");
        return 0;
    }
    if (!strcmp(argv[1], "image-import-unknown")) {
        GLuint name = 17;
        glBindTexture(GL_TEXTURE_2D, name);
        for (unsigned failure = 1; failure <= 3; failure += 2) {
            EGLImageKHR img = image(dpy);
            image_failure = failure;
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
            assert(glGetError() == GL_INVALID_OPERATION);
            assert(eglDestroyImageKHR(dpy, img) && closes == 0);
        }
        assert(eglDestroyContext(dpy, ctx) && closes == 0);
        assert(eglReleaseThread() && closes == 1 && eglTerminate(dpy) && allocation_count() == 0);
        puts("PASS image-import-unknown");
        return 0;
    }
    if (!strcmp(argv[1], "image-bind-ack")) {
        binding_model = 1;
        binding_query_kind = GL_TEXTURE_BINDING_2D;
        glBindTexture(GL_TEXTURE_2D, 17);
        glFlush();
        bind_failure = 2;
        glBindTexture(GL_TEXTURE_2D, 18);
        assert(glGetError() == GL_OUT_OF_MEMORY);
        glBindTexture(GL_TEXTURE_CUBE_MAP, 18);
        assert(glGetError() == GL_NO_ERROR);
        EGLImageKHR img = image(dpy);
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        GLint value = -1;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        assert(value == 17); // Failed native bind never replaced the C reference.
        glBindRenderbuffer(GL_RENDERBUFFER, 21);
        bind_failure = 2;
        glBindRenderbuffer(GL_RENDERBUFFER, 22);
        assert(glGetError() == GL_OUT_OF_MEMORY);
        glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
        glBindRenderbuffer(GL_RENDERBUFFER, 22);
        value = -1;
        // Native query test state distinguishes the imported old RBO from the
        // successfully bound new name: only the old record has image storage.
        query_scalar = 9;
        glGetRenderbufferParameteriv(GL_RENDERBUFFER, GL_RENDERBUFFER_WIDTH, &value);
        assert(value == 9);
        GLuint textures[2] = {17, 18}, rbos[2] = {21, 22};
        glDeleteTextures(2, textures);
        glDeleteRenderbuffers(2, rbos);
        assert(eglDestroyImageKHR(dpy, img));
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-bind-ack");
        return 0;
    }
    if (!strcmp(argv[1], "image-bind-errors")) {
        binding_model = 1;
        binding_query_kind = GL_TEXTURE_BINDING_2D;
        glBindTexture(GL_TEXTURE_2D, 17);
        glBindRenderbuffer(GL_RENDERBUFFER, 21);
        EGLImageKHR img = image(dpy);
        for (unsigned kind = 1; kind <= 2; kind++) {
            for (unsigned failure = 1; failure <= 5; failure++) {
                glFlush();
                bind_failure = failure;
                if (kind == 1)
                    glBindTexture(GL_TEXTURE_2D, 18);
                else
                    glBindRenderbuffer(GL_RENDERBUFFER, 22);
                assert(glGetError() == (failure == 2 ? GL_OUT_OF_MEMORY : GL_INVALID_OPERATION));
                if (kind == 1) {
                    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
                    GLint value = 0;
                    glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
                    assert(value == 17);
                } else
                    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, img);
            }
        }
        unsigned queried = bind_queries;
        fail_malloc = 1;
        glBindTexture(GL_TEXTURE_2D, 18);
        fail_malloc = 0;
        assert(glGetError() == GL_OUT_OF_MEMORY && bind_queries == queried);
        malloc_before_failure = 1; // Request succeeds, response allocation fails.
        glBindTexture(GL_TEXTURE_2D, 18);
        malloc_before_failure = -1;
        assert(glGetError() == GL_OUT_OF_MEMORY && bind_queries == queried);
        glClear(GL_COLOR_BUFFER_BIT);
        fail_submit = 1;
        glBindTexture(GL_TEXTURE_2D, 18);
        fail_submit = 0;
        assert(glGetError() == GL_INVALID_OPERATION && bind_queries == queried);
        GLint logical = 0;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &logical);
        assert(logical == 17);
        glBindTexture(GL_TEXTURE_CUBE_MAP, 18);
        assert(glGetError() == GL_NO_ERROR);
        GLuint textures[2] = {17, 18}, rbos[2] = {21, 22};
        glDeleteTextures(2, textures);
        glDeleteRenderbuffers(2, rbos);
        assert(eglDestroyImageKHR(dpy, img));
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-bind-errors");
        return 0;
    }
    if (!strcmp(argv[1], "image-bind-render")) {
        binding_model = 1;
        GLuint old = 18, candidate = 17, fbo;
        glBindTexture(GL_TEXTURE_2D, old);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glGenFramebuffers(1, &fbo);
        glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, old, 0);
        glClearColor(1, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        bind_failure = 2;
        glBindTexture(GL_TEXTURE_2D, candidate);
        assert(glGetError() == GL_OUT_OF_MEMORY);
        glBindTexture(GL_TEXTURE_CUBE_MAP, candidate);
        assert(glGetError() == GL_NO_ERROR);
        glDeleteTextures(1, &candidate);
        const GLubyte blue[4] = {0, 0, 255, 255};
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, blue);
        glFlush();
        assert(glGetError() == GL_NO_ERROR);
        glDeleteFramebuffers(1, &fbo);
        glDeleteTextures(1, &old);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-bind-render");
        return 0;
    }
    if (!strcmp(argv[1], "image-external-name")) {
        binding_model = 1;
        EGLImageKHR img = image(dpy);
        assert(img);
        extern unsigned wpkEglBindBoTexture(EGLDisplay, unsigned, unsigned);
        assert(!wpkEglBindBoTexture(dpy, 77, GL_TEXTURE_CUBE_MAP) &&
               eglGetError() == EGL_BAD_PARAMETER);
        assert(!wpkEglBindBoTexture(dpy, 77, 0x57504b49u) && eglGetError() == EGL_BAD_PARAMETER);
        GLuint texture = wpkEglBindBoTexture(dpy, 77, GL_TEXTURE_2D);
        assert(texture == 0x60000000u);
        query_scalar = 1;
        GLuint framebuffer;
        glGenFramebuffers(1, &framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
        assert(glGetError() == GL_NO_ERROR);
        glBindTexture(GL_TEXTURE_CUBE_MAP, texture);
        assert(glGetError() == GL_INVALID_OPERATION);
        glBindTexture(GL_TEXTURE_2D, texture);
        binding_query_kind = GL_TEXTURE_BINDING_2D;
        GLint value = 0;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        assert((GLuint)value == texture);
        // Model the host's BO-owner revocation independently of C bindings.
        query_scalar = 0;
        image_groups[device_slots[0].image_group].raw_live = 0;
        device_slots[0].texture_2d[0] = 0;
        for (unsigned i = 0; i < 128; i++)
            if (device_slots[0].texture_targets[i].name == texture)
                device_slots[0].texture_targets[i].name = 0;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        assert(value == 0);
        glBindTexture(GL_TEXTURE_CUBE_MAP, texture);
        assert(glGetError() == GL_NO_ERROR);
        glDeleteTextures(1, &texture);
        glDeleteFramebuffers(1, &framebuffer);
        assert(eglDestroyImageKHR(dpy, img));
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-external-name");
        return 0;
    }
    if (!strcmp(argv[1], "image-attachment-errors")) {
        const unsigned baseline = allocation_count();
        GLuint texture = 17, unused, renderbuffer = 18, framebuffer;
        glBindTexture(GL_TEXTURE_2D, texture);
        glBindRenderbuffer(GL_RENDERBUFFER, renderbuffer);
        glGenFramebuffers(1, &framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
        glGenTextures(1, &unused);
        const unsigned retained = allocation_count();
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, unused, 0);
        assert(glGetError() == GL_INVALID_OPERATION && allocation_count() == retained);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_CUBE_MAP_POSITIVE_X,
                               texture, 0);
        assert(glGetError() == GL_INVALID_OPERATION && allocation_count() == retained);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glDeleteTextures(1, &texture);
        assert(allocation_count() == retained);
        glDeleteTextures(1, &unused);
        glDeleteRenderbuffers(1, &renderbuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
        assert(allocation_count() == baseline);
        glBindTexture(GL_TEXTURE_2D, texture);
        const unsigned before = allocation_count();
        fail_calloc = 1;
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
        fail_calloc = 0;
        assert(glGetError() == GL_OUT_OF_MEMORY && allocation_count() == before);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
        assert(glGetError() == GL_INVALID_OPERATION);
        glDeleteTextures(1, &texture);
        glDeleteFramebuffers(1, &framebuffer);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-attachment-errors");
        return 0;
    }
    if (!strcmp(argv[1], "image-target-render")) {
        binding_model = 1;
        GLuint cube = 17, texture = 18, framebuffer;
        glBindTexture(GL_TEXTURE_CUBE_MAP, cube);
        glBindTexture(GL_TEXTURE_2D, texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glGenFramebuffers(1, &framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
        glClearColor(1, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        glBindTexture(GL_TEXTURE_2D, cube);
        assert(glGetError() == GL_INVALID_OPERATION);
        glDeleteTextures(1, &cube);
        binding_query_kind = GL_TEXTURE_BINDING_2D;
        GLint binding = -1;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
        assert(binding == 18);
        const unsigned char blue[4] = {0, 0, 255, 255};
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, blue);
        glFlush();
        glDeleteTextures(1, &texture);
        glDeleteFramebuffers(1, &framebuffer);
        assert(glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-target-render");
        return 0;
    }
    if (!strcmp(argv[1], "image-unit-growth")) {
        binding_model = 1;
        advertised_texture_units = 64;
        GLuint low = 17, high = 18;
        glBindTexture(GL_TEXTURE_2D, low);
        fail_calloc = 1;
        glActiveTexture(GL_TEXTURE0 + 63);
        fail_calloc = 0;
        assert(glGetError() == GL_OUT_OF_MEMORY);
        binding_query_kind = GL_TEXTURE_BINDING_2D;
        GLint value = -1;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        assert(value == 17);
        binding_query_kind = 0;
        glActiveTexture(GL_TEXTURE0 + 63);
        glBindTexture(GL_TEXTURE_2D, high);
        binding_query_kind = GL_TEXTURE_BINDING_2D;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        assert(value == 18);
        glActiveTexture(GL_TEXTURE0 + 64);
        assert(glGetError() == GL_INVALID_ENUM);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        assert(value == 18);
        glActiveTexture(GL_TEXTURE0);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        assert(value == 17);
        glDeleteTextures(1, &high);
        glActiveTexture(GL_TEXTURE0 + 63);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        assert(value == 0);
        glDeleteTextures(1, &low);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-unit-growth");
        return 0;
    }
    if (!strcmp(argv[1], "image-logical-bindings")) {
        binding_model = 1;
        advertised_texture_units = 32;
        EGLImageKHR img = image(dpy);
        GLuint texture = 17, renderbuffer = 23;
        glBindTexture(GL_TEXTURE_2D, texture);
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        assert(eglDestroyImageKHR(dpy, img));
        binding_query_kind = GL_TEXTURE_BINDING_2D;
        GLint integer = -1;
        GLfloat floating = -1;
        GLboolean boolean = GL_FALSE;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &integer);
        assert(integer == 17);
        glGetFloatv(GL_TEXTURE_BINDING_2D, &floating);
        assert(floating == 17);
        glGetBooleanv(GL_TEXTURE_BINDING_2D, &boolean);
        assert(boolean == GL_TRUE);
        binding_query_kind = 0;
        glActiveTexture(GL_TEXTURE1);
        binding_query_kind = GL_TEXTURE_BINDING_2D;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &integer);
        assert(integer == 0);
        glBindTexture(GL_TEXTURE_CUBE_MAP, 19);
        binding_query_kind = GL_TEXTURE_BINDING_CUBE_MAP;
        glGetIntegerv(GL_TEXTURE_BINDING_CUBE_MAP, &integer);
        assert(integer == 19);
        glGetFloatv(GL_TEXTURE_BINDING_CUBE_MAP, &floating);
        assert(floating == 19);
        glBindRenderbuffer(GL_RENDERBUFFER, renderbuffer);
        binding_query_kind = GL_RENDERBUFFER_BINDING;
        glGetIntegerv(GL_RENDERBUFFER_BINDING, &integer);
        assert(integer == 23);
        glGetBooleanv(GL_RENDERBUFFER_BINDING, &boolean);
        assert(boolean == GL_TRUE);
        glDeleteRenderbuffers(1, &renderbuffer);
        glGetIntegerv(GL_RENDERBUFFER_BINDING, &integer);
        assert(integer == 0);
        glDeleteTextures(1, &texture);
        assert(closes == 1);
        assert(glGetError() == GL_NO_ERROR);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-logical-bindings");
        return 0;
    }
    if (!strcmp(argv[1], "image-target-identity")) {
        binding_model = 1;
        GLuint cube = 17, texture = 18;
        glBindTexture(GL_TEXTURE_CUBE_MAP, cube);
        glBindTexture(GL_TEXTURE_2D, texture);
        glBindTexture(GL_TEXTURE_2D, cube);
        assert(glGetError() == GL_INVALID_OPERATION);
        glDeleteTextures(1, &cube);
        binding_query_kind = GL_TEXTURE_BINDING_2D;
        GLint value = -1;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        assert(value == 18);
        binding_query_kind = GL_TEXTURE_BINDING_CUBE_MAP;
        glGetIntegerv(GL_TEXTURE_BINDING_CUBE_MAP, &value);
        assert(value == 0);
        glBindTexture(GL_TEXTURE_2D, cube);
        assert(glGetError() == GL_NO_ERROR); // Reuse creates a new type identity.
        glBindTexture(GL_TEXTURE_CUBE_MAP, cube);
        assert(glGetError() == GL_INVALID_OPERATION);
        glDeleteTextures(1, &cube);
        glDeleteTextures(1, &texture);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-target-identity");
        return 0;
    }
    if (!strcmp(argv[1], "image-record-lifetime")) {
        const unsigned baseline = allocation_count();
        for (unsigned i = 0; i < 100; i++) {
            GLuint name = 17, framebuffers[2];
            glGenFramebuffers(2, framebuffers);
            glBindTexture(GL_TEXTURE_2D, name);
            glBindRenderbuffer(GL_RENDERBUFFER, name);
            glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[0]);
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, name, 0);
            glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[1]);
            glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, name);
            glBindFramebuffer(GL_FRAMEBUFFER, 0);
            glDeleteTextures(1, &name);
            glDeleteRenderbuffers(1, &name);
            assert(allocation_count() ==
                   baseline + 4); // Two retained records and two attachment records.
            glBindTexture(GL_TEXTURE_CUBE_MAP, name);
            glBindRenderbuffer(GL_RENDERBUFFER, name);
            glDeleteTextures(1, &name);
            glDeleteRenderbuffers(1, &name);
            assert(allocation_count() == baseline + 4);
            glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[0]);
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
            glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[1]);
            glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, 0);
            glDeleteFramebuffers(2, framebuffers);
            glFlush();
            assert(allocation_count() == baseline);
        }
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS image-record-lifetime");
        return 0;
    }
    if (!strcmp(argv[1], "names-lifetime")) {
        const unsigned baseline = allocation_count();
        for (unsigned i = 0; i < 100; i++) {
            GLuint buffer = 17, vao;
            glGenVertexArrays(1, &vao);
            glBindVertexArray(vao);
            glBindBuffer(GL_ARRAY_BUFFER, buffer);
            glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, NULL);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, buffer);
            glBindVertexArray(0);
            glDeleteBuffers(1, &buffer);
            glBindBuffer(GL_ARRAY_BUFFER, buffer);
            glDeleteBuffers(1, &buffer);
            glBindVertexArray(vao);
            GLint retained = 0;
            glGetVertexAttribiv(0, GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, &retained);
            assert(retained == 17);
            glDeleteVertexArrays(1, &vao);
            glFlush();
            assert(allocation_count() == baseline);
        }
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy) &&
               allocation_count() == 0);
        puts("PASS names-lifetime");
        return 0;
    }
    if (!strcmp(argv[1], "records-transfer-existing")) {
        EGLContext second = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(second);
        EGLSurface other = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[0], NULL);
        assert(other);
        EGLImageKHR img = image(dpy);
        assert(imports == 1);
        native_window_bo = 77;
        native_window_fd = 11;
        EGLSurface surface = eglCreateWindowSurface(dpy, (EGLConfig)1, &native_window, NULL);
        assert(surface && surface_target == 77 && export_closes == 1 && closes == 0 &&
               transfer_closes == 0);
        assert(eglDestroySurface(dpy, surface) && eglDestroySurface(dpy, other) && closes == 0);
        assert(eglDestroyImageKHR(dpy, img) && closes == 1);
        assert(eglDestroyContext(dpy, second) && eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread() && eglTerminate(dpy));
        puts("PASS records-transfer-existing");
        return 0;
    }
    if (!strcmp(argv[1], "records-query")) {
        EGLSurface surface = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[1], NULL);
        assert(surface && eglGetProcAddress("eglQuerySurface"));
        EGLint value = -7;
        assert(eglQuerySurface(dpy, surface, EGL_WIDTH, &value) && value == 33);
        assert(eglQuerySurface(dpy, surface, EGL_HEIGHT, &value) && value == 25);
        assert(eglQuerySurface(dpy, surface, EGL_CONFIG_ID, &value) && value == 1);
        assert(eglQuerySurface(dpy, surface, EGL_GL_COLORSPACE, &value) &&
               value == EGL_GL_COLORSPACE_LINEAR);
        assert(eglQuerySurface(dpy, surface, EGL_RENDER_BUFFER, &value) &&
               value == EGL_BACK_BUFFER);
        assert(eglQuerySurface(dpy, surface, EGL_SWAP_BEHAVIOR, &value) &&
               value == EGL_BUFFER_DESTROYED);
        assert(eglQuerySurface(dpy, surface, EGL_HORIZONTAL_RESOLUTION, &value) &&
               value == EGL_UNKNOWN);
        const EGLint ignored[] = {EGL_LARGEST_PBUFFER, EGL_TEXTURE_FORMAT, EGL_TEXTURE_TARGET,
                                  EGL_MIPMAP_TEXTURE, EGL_MIPMAP_LEVEL};
        for (unsigned i = 0; i < sizeof ignored / sizeof ignored[0]; i++) {
            value = 91;
            assert(eglQuerySurface(dpy, surface, ignored[i], &value) && value == 91);
        }
        assert(!eglQuerySurface(dpy, surface, 0x7fffffff, &value) &&
               eglGetError() == EGL_BAD_ATTRIBUTE && value == 91);
        assert(!eglQuerySurface(dpy, (EGLSurface)ctx, EGL_WIDTH, &value) &&
               eglGetError() == EGL_BAD_SURFACE && value == 91);
        assert(!eglQuerySurface(dpy, surface, EGL_WIDTH, NULL) &&
               eglGetError() == EGL_BAD_PARAMETER);
        assert(eglMakeCurrent(dpy, surface, surface, ctx) && eglDestroySurface(dpy, surface));
        assert(!eglQuerySurface(dpy, surface, EGL_WIDTH, &value) &&
               eglGetError() == EGL_BAD_SURFACE && value == 91);
        assert(eglGetCurrentSurface(EGL_READ) == surface);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        assert(!eglQuerySurface(dpy, surface, EGL_WIDTH, &value) &&
               eglGetError() == EGL_NOT_INITIALIZED && value == 91);
        puts("PASS records-query");
        return 0;
    }
    if (!strcmp(argv[1], "records-rollback")) {
        EGLSurface first = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[0], NULL);
        assert(first && eglMakeCurrent(dpy, first, first, ctx));
        fail_create_context = 1;
        assert(!eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs) &&
               eglGetError() == EGL_BAD_ALLOC);
        assert(eglGetCurrentContext() == ctx && eglGetCurrentSurface(EGL_DRAW) == first);
        fail_create_context = 0;
        EGLContext second = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(second);
        fail_surface_create = 1;
        assert(!eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[1], NULL) &&
               eglGetError() == EGL_BAD_ALLOC);
        fail_surface_create = 0;
        EGLSurface other = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[1], NULL);
        assert(other);
        fail_make_current = 1;
        assert(!eglMakeCurrent(dpy, other, first, second) && eglGetError() == EGL_BAD_ACCESS);
        assert(eglGetCurrentContext() == ctx && eglGetCurrentSurface(EGL_DRAW) == first &&
               eglGetCurrentSurface(EGL_READ) == first);
        fail_make_current = 0;
        assert(!eglSwapBuffers(dpy, other) && eglGetError() == EGL_BAD_SURFACE);
        assert(eglMakeCurrent(dpy, other, first, second));
        assert(eglDestroyContext(dpy, ctx)); // first remains a usable read surface.
        assert(eglGetCurrentContext() == second && eglGetCurrentSurface(EGL_READ) == first);
        assert(eglDestroySurface(dpy, first) && eglDestroySurface(dpy, other) &&
               eglDestroyContext(dpy, second));
        assert(eglReleaseThread() && eglTerminate(dpy) && destroyed_contexts == 2 &&
               destroyed_surfaces == 2);
        puts("PASS records-rollback");
        return 0;
    }
    if (!strcmp(argv[1], "records-transfer")) {
        EGLSurface first = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[0], NULL);
        assert(first);
        EGLContext second = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(second);
        EGLImageKHR img = image(dpy);
        GLuint texture;
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, second));
        glGenTextures(1, &texture);
        glBindTexture(GL_TEXTURE_2D, texture);
        fail_prime_export = 1;
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        fail_prime_export = 0;
        assert(glGetError() == GL_INVALID_OPERATION && transfers == 0 && export_closes == 0);
        fail_prime_import = 1;
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        fail_prime_import = 0;
        assert(glGetError() == GL_INVALID_OPERATION && transfers == 0 && export_closes == 1);
        fail_foreign_texture = 1;
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        fail_foreign_texture = 0;
        assert(glGetError() == GL_INVALID_OPERATION && transfers == 1 && transfer_closes == 1 &&
               export_closes == 2);
        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
        assert(glGetError() == GL_NO_ERROR && transfers == 2 && transfer_closes == 2 &&
               export_closes == 3);
        assert(eglDestroyImageKHR(dpy, img) && closes == 0);
        native_window_bo = 88;
        native_window_fd = 10;
        fail_surface_create = 1;
        assert(!eglCreateWindowSurface(dpy, (EGLConfig)1, &native_window, NULL) &&
               eglGetError() == EGL_BAD_ALLOC);
        assert(transfers == 3 && transfer_closes == 3 && export_closes == 4);
        fail_surface_create = 0;
        EGLSurface other = eglCreateWindowSurface(dpy, (EGLConfig)1, &native_window, NULL);
        assert(other);
        assert(surface_target == 1011 && transfers == 4 && transfer_closes == 4 &&
               export_closes == 5);
        assert(eglMakeCurrent(dpy, other, first, second));
        native_window_bo = 99;
        native_window_width = 80;
        native_window_height = 48;
        fail_surface_update = 1;
        assert(!_wpk_egl_window_retarget(&native_window));
        fail_surface_update = 0;
        EGLint width;
        assert(eglQuerySurface(dpy, other, EGL_WIDTH, &width) && width == 64);
        assert(_wpk_egl_window_retarget(&native_window));
        assert(eglQuerySurface(dpy, other, EGL_WIDTH, &width) && width == 80);
        assert(transfers == 6 && transfer_closes == 6 && export_closes == 7);
        glDeleteTextures(1, &texture);
        assert(closes == 1 && device_slots[0].closes == 1);
        assert(eglDestroySurface(dpy, first) && eglDestroySurface(dpy, other));
        assert(eglDestroyContext(dpy, ctx) && eglDestroyContext(dpy, second));
        assert(eglReleaseThread() && eglTerminate(dpy));
        for (unsigned i = 0; i < 8; i++)
            assert(!prime_exports[i].handle && !transferred_handles[i]);
        puts("PASS records-transfer");
        return 0;
    }
    if (!strcmp(argv[1], "records-attributes")) {
        assert(!eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, NULL) &&
               eglGetError() == EGL_BAD_MATCH);
        const EGLint bad[] = {0x7fffffff, 1, EGL_NONE};
        assert(!eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, bad) &&
               eglGetError() == EGL_BAD_ATTRIBUTE);
        assert(!eglCreateContext(dpy, (EGLConfig)1, (EGLContext)0x7fffffff, attrs) &&
               eglGetError() == EGL_BAD_CONTEXT);
        EGLContext shared = eglCreateContext(dpy, (EGLConfig)1, ctx, attrs);
        assert(shared && eglDestroyContext(dpy, shared));
        EGLContext no_config = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, attrs);
        assert(no_config);
        EGLint value = -1;
        assert(eglQueryContext(dpy, no_config, EGL_CONFIG_ID, &value) && value == 0);
        assert(eglDestroyContext(dpy, no_config) && eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread() && eglTerminate(dpy));
        puts("PASS records-attributes");
        return 0;
    }
    if (!strcmp(argv[1], "records-thread")) {
        EGLContext second = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(second);
        EGLSurface first = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[0], NULL);
        EGLSurface other = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[1], NULL);
        assert(first && other && eglMakeCurrent(dpy, first, first, ctx));
        glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT, 13);
        struct record_thread input = {dpy, second, first, other};
        pthread_t thread;
        assert(!pthread_create(&thread, NULL, hold_independent_records, &input));
        overlap_wait(1);
        assert(eglDestroyContext(dpy, second) && eglDestroySurface(dpy, other));
        assert(destroyed_contexts == 0 && destroyed_surfaces == 0);
        assert(eglGetCurrentContext() == ctx && eglGetCurrentSurface(EGL_DRAW) == first);
        GLint row;
        glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT, &row);
        assert(row == 13);
        overlap_reach(2);
        assert(!pthread_join(thread, NULL));
        assert(destroyed_contexts == 1 && destroyed_surfaces == 1);
        assert(eglDestroySurface(dpy, first) && eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread() && eglTerminate(dpy) && destroyed_contexts == 2 &&
               destroyed_surfaces == 2);
        puts("PASS records-thread");
        return 0;
    }
    if (!strcmp(argv[1], "records-basic")) {
        EGLContext second = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(second != EGL_NO_CONTEXT && second != ctx);
        EGLSurface first = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[0], NULL);
        EGLSurface other = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[1], NULL);
        EGLSurface third = eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[2], NULL);
        assert(first && other && third && first != other && other != third);
        GLuint a, b, next;
        assert(eglMakeCurrent(dpy, first, first, ctx));
        glGenBuffers(1, &a);
        glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT, 11);
        glClearColor(1, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglMakeCurrent(dpy, other, other, second));
        GLint row = 99;
        glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT, &row);
        assert(row == 0);
        glGenBuffers(1, &b);
        glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT, 7);
        assert(a == 1 && b == 1);
        glClearColor(0, 1, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglMakeCurrent(dpy, first, other, ctx));
        assert(eglGetCurrentSurface(EGL_DRAW) == first && eglGetCurrentSurface(EGL_READ) == other);
        glGetIntegerv(GL_UNPACK_ROW_LENGTH_EXT, &row);
        assert(row == 11);
        glGenBuffers(1, &next);
        assert(next == 2);
        glClearColor(0, 0, 1, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglMakeCurrent(dpy, first, first, ctx));
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglMakeCurrent(dpy, first, other, ctx));
        assert(eglDestroyContext(dpy, second));
        glClearColor(1, 1, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglDestroySurface(dpy, other));
        assert(eglGetCurrentSurface(EGL_READ) == other);
        assert(!eglCreateWindowSurface(dpy, (EGLConfig)1, &record_windows[1], NULL));
        assert(eglGetError() == EGL_BAD_ALLOC);
        assert(!eglMakeCurrent(dpy, first, other, ctx) && eglGetError() == EGL_BAD_SURFACE);
        glClearColor(0, 0, 1, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglSwapBuffers(dpy, first));
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglDestroySurface(dpy, first) && eglDestroySurface(dpy, third));
        assert(eglTerminate(dpy) && destroyed_contexts == 2 && destroyed_surfaces == 3);
        puts("PASS records-basic");
        return 0;
    }
    if (!strcmp(argv[1], "surface-create-ack")) {
        fail_surface_create = 1;
        assert(eglCreateWindowSurface(dpy,(EGLConfig)1,NULL,NULL) == EGL_NO_SURFACE);
        assert(eglGetError() == EGL_BAD_ALLOC && eglGetCurrentContext() == ctx);
        fail_surface_create = 0;
        EGLSurface surface = eglCreateWindowSurface(dpy,(EGLConfig)1,NULL,NULL);
        assert(surface != EGL_NO_SURFACE && eglMakeCurrent(dpy,surface,surface,ctx));
        uint32_t first = device_slots[0].current_surface;
        assert(first >= 131);
        assert(eglDestroySurface(dpy,surface));
        assert(eglMakeCurrent(dpy,EGL_NO_SURFACE,EGL_NO_SURFACE,ctx));
        surface = eglCreateWindowSurface(dpy,(EGLConfig)1,NULL,NULL);
        assert(surface != EGL_NO_SURFACE && eglMakeCurrent(dpy,surface,surface,ctx));
        assert(device_slots[0].current_surface > first);
        assert(eglDestroySurface(dpy,surface) && eglDestroyContext(dpy,ctx));
        assert(eglReleaseThread() && eglTerminate(dpy));
        puts("PASS surface-create-ack"); return 0;
    }
    if (!strcmp(argv[1], "surface-retarget")) {
        native_window_bo = 77;
        EGLSurface surface = eglCreateWindowSurface(dpy, (EGLConfig)1, &native_window, NULL);
        assert(surface != EGL_NO_SURFACE && surface_target == 77);
        assert(eglMakeCurrent(dpy, surface, surface, ctx));
        native_window_bo = 78;
        assert(_wpk_egl_window_retarget(&native_window));
        assert(surface_target == 78 && destroyed_surfaces == 0);
        assert(eglGetCurrentSurface(EGL_DRAW) == surface && eglGetCurrentContext() == ctx);
        fail_surface_update = 1; native_window_bo = 79;
        assert(!_wpk_egl_window_retarget(&native_window));
        assert(surface_target == 78 && destroyed_surfaces == 0);
        assert(eglGetCurrentSurface(EGL_DRAW) == surface && eglSwapBuffers(dpy, surface));
        assert(eglDestroySurface(dpy, surface));
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS surface-retarget");
        return 0;
    }
    if (!strcmp(argv[1], "bind-errors")) {
        const int failures[] = { EACCES, ENOMEM, EIO };
        const EGLint errors[] = { EGL_BAD_ACCESS, EGL_BAD_ALLOC, EGL_CONTEXT_LOST };
        fail_make_current = 1;
        for (unsigned i = 0; i < 3; i++) {
            make_current_errno = failures[i];
            assert(!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
            assert(eglGetError() == errors[i] && eglGetCurrentContext() == ctx);
        }
        fail_make_current = 0;
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS bind-errors");
        return 0;
    }
    if (!strcmp(argv[1], "release-rollback")) {
        assert(eglDestroyContext(dpy, ctx));
        fail_make_current = 1;
        assert(!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT));
        assert(eglGetError() == EGL_BAD_ACCESS && eglGetCurrentContext() == ctx);
        assert(destroyed_contexts == 0);
        assert(!eglReleaseThread());
        assert(eglGetError() == EGL_BAD_ACCESS && eglGetCurrentContext() == ctx);
        fail_make_current = 0;
        assert(eglReleaseThread() && destroyed_contexts == 1 && eglTerminate(dpy));
        puts("PASS release-rollback");
        return 0;
    }
    if (!strcmp(argv[1], "surfaceless-bind")) {
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS surfaceless-bind");
        return 0;
    }
    if (!strcmp(argv[1], "create-rollback")) {
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS create-rollback");
        return 0;
    }
    if (!strcmp(argv[1], "bind-rollback")) {
        EGLSurface surface = eglCreateWindowSurface(dpy, (EGLConfig)1, 0, NULL);
        assert(surface != EGL_NO_SURFACE);
        fail_make_current = 1;
        assert(!eglMakeCurrent(dpy, surface, surface, ctx));
        assert(eglGetError() == EGL_BAD_ACCESS);
        assert(eglGetCurrentContext() == ctx);
        assert(eglGetCurrentSurface(EGL_DRAW) == EGL_NO_SURFACE);
        assert(eglGetCurrentSurface(EGL_READ) == EGL_NO_SURFACE);
        fail_make_current = 0;
        assert(eglDestroySurface(dpy, surface) && destroyed_surfaces == 1);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS bind-rollback");
        return 0;
    }
    if (!strcmp(argv[1], "terminate-current")) {
        assert(eglTerminate(dpy));
        assert(eglGetCurrentContext() == ctx);
        assert(destroyed_contexts == 0);
        glClear(GL_COLOR_BUFFER_BIT);
        assert(eglReleaseThread());
        assert(destroyed_contexts == 1 && submit_batches == 1 && clear_commands == 1);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
        assert(eglInitialize(dpy, NULL, NULL));
        EGLContext replacement = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(replacement != EGL_NO_CONTEXT && replacement != ctx);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, replacement));
        assert(eglDestroyContext(dpy, replacement) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS terminate-current");
        return 0;
    }
    if (!strcmp(argv[1], "thread-current")) {
        pthread_t thread;
        struct thread_context input = { dpy, ctx };
        assert(pthread_create(&thread, NULL, check_busy_context, &input) == 0);
        assert(pthread_join(thread, NULL) == 0);
        assert(eglGetCurrentContext() == ctx);
        assert(!eglBindAPI(EGL_OPENGL_API));
        assert(eglReleaseThread());
        assert(eglGetError() == EGL_SUCCESS);
        assert(eglQueryAPI() == EGL_OPENGL_ES_API);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
        EGLint config_id = 0;
        assert(eglQueryContext(dpy, ctx, EGL_CONFIG_ID, &config_id) && config_id == 1);
        const unsigned before = submit_batches;
        assert(pthread_create(&thread, NULL, take_context_then_exit, &input) == 0);
        assert(pthread_join(thread, NULL) == 0);
        assert(submit_batches == before + 1 && clear_commands == 1);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(destroyed_contexts == 1);
        assert(eglTerminate(dpy));
        puts("PASS thread-current");
        return 0;
    }
    if (!strcmp(argv[1], "destroy-current")) {
        glClear(GL_COLOR_BUFFER_BIT);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglGetCurrentContext() == ctx);
        assert(destroyed_contexts == 0 && submit_batches == 0);
        glClear(GL_COLOR_BUFFER_BIT);
        assert(eglMakeCurrent(EGL_NO_DISPLAY, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT));
        assert(destroyed_contexts == 1 && submit_batches == 1 && clear_commands == 2);
        EGLint value = 17;
        assert(!eglQueryContext(dpy, ctx, EGL_CONFIG_ID, &value));
        assert(eglGetError() == EGL_BAD_CONTEXT && value == 17);
        EGLContext replacement = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(replacement != EGL_NO_CONTEXT && replacement != ctx);
        assert(!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        assert(eglGetError() == EGL_BAD_CONTEXT);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, replacement));
        assert(eglDestroyContext(dpy, replacement) && eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS destroy-current");
        return 0;
    }
    if (!strcmp(argv[1], "surface-current")) {
        const EGLint size[] = { EGL_WIDTH, 64, EGL_HEIGHT, 64, EGL_NONE };
        EGLSurface surface = eglCreateWindowSurface(dpy, (EGLConfig)1, 0, size);
        assert(surface != EGL_NO_SURFACE);
        assert(eglMakeCurrent(dpy, surface, surface, ctx));
        assert(eglDestroySurface(dpy, surface));
        assert(eglGetCurrentSurface(EGL_DRAW) == surface);
        assert(destroyed_surfaces == 0);
        assert(!eglSwapBuffers(dpy, surface) && eglGetError() == EGL_BAD_SURFACE);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        assert(destroyed_surfaces == 1);
        assert(eglGetCurrentSurface(EGL_DRAW) == EGL_NO_SURFACE);
        EGLSurface replacement = eglCreateWindowSurface(dpy, (EGLConfig)1, 0, size);
        assert(replacement != EGL_NO_SURFACE && replacement != surface);
        assert(!eglMakeCurrent(dpy, surface, surface, ctx));
        assert(eglGetError() == EGL_BAD_SURFACE);
        assert(eglDestroySurface(dpy, replacement));
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS surface-current");
        return 0;
    }
    if (!strcmp(argv[1], "thread-error")) {
        assert(!eglInitialize(EGL_NO_DISPLAY, NULL, NULL));
        pthread_t thread;
        assert(pthread_create(&thread, NULL, check_thread_error, NULL) == 0);
        assert(pthread_join(thread, NULL) == 0);
        assert(eglGetError() == EGL_BAD_DISPLAY);
        assert(eglGetError() == EGL_SUCCESS);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS thread-error");
        return 0;
    }
    if (!strcmp(argv[1], "api-error")) {
        for (unsigned i = 0; i < 3; i++) {
            const EGLenum invalid[] = { EGL_OPENGL_API, EGL_OPENVG_API, 0xffffffffu };
            assert(!eglBindAPI(invalid[i]));
            assert(eglGetError() == EGL_BAD_PARAMETER);
            assert(eglQueryAPI() == EGL_OPENGL_ES_API);
        }
        assert(eglBindAPI(EGL_OPENGL_ES_API));
        assert(eglGetError() == EGL_SUCCESS);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS api-error");
        return 0;
    }
    if (!strcmp(argv[1], "config-selection")) {
        const EGLint requests[][7] = {
            { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_RED_SIZE, 9, EGL_NONE },
            { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SAMPLE_BUFFERS, 1, EGL_NONE },
            { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SURFACE_TYPE, EGL_PIXMAP_BIT, EGL_NONE },
        };
        for (unsigned i = 0; i < sizeof requests / sizeof requests[0]; i++) {
            EGLConfig selected = (EGLConfig)(uintptr_t)0x1234;
            EGLint count = 17;
            assert(eglChooseConfig(dpy, requests[i], &selected, 1, &count));
            assert(count == 0 && selected == (EGLConfig)(uintptr_t)0x1234);
        }
        const EGLint matching[] = { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
            EGL_RED_SIZE, 8, EGL_DEPTH_SIZE, 16, EGL_NONE };
        EGLConfig selected = NULL;
        EGLint count = 17;
        assert(eglChooseConfig(dpy, matching, &selected, 1, &count));
        assert(count == 1 && selected == (EGLConfig)1);
        /* A configuration ID overrides otherwise incompatible selection. */
        const EGLint by_id[] = { EGL_CONFIG_ID, 1, EGL_RED_SIZE, 99, EGL_NONE };
        assert(eglChooseConfig(dpy, by_id, &selected, 1, &count));
        assert(count == 1 && selected == (EGLConfig)1);
        const EGLint by_missing_id[] = { EGL_CONFIG_ID, 2, EGL_NONE };
        assert(eglChooseConfig(dpy, by_missing_id, &selected, 1, &count));
        assert(count == 0);
        /* Default renderable type is ES1; this config already advertises
         * ES2 only. Enumeration must use eglGetConfigs, not this filter. */
        assert(eglChooseConfig(dpy, NULL, &selected, 1, &count) && count == 0);
        const EGLint masks[] = { EGL_RENDERABLE_TYPE, 0, EGL_SURFACE_TYPE, 0,
            EGL_RED_SIZE, EGL_DONT_CARE, EGL_NONE };
        assert(eglChooseConfig(dpy, masks, &selected, 1, &count) && count == 1);
        const EGLint duplicate[] = { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
            EGL_RED_SIZE, 99, EGL_RED_SIZE, 8, EGL_NONE };
        assert(eglChooseConfig(dpy, duplicate, &selected, 1, &count) && count == 1);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS config-selection");
        return 0;
    }
    if (!strcmp(argv[1], "config-validation")) {
        const EGLint invalid[][3] = {
            { EGL_RED_SIZE, -2, EGL_NONE }, { EGL_BIND_TO_TEXTURE_RGB, 4, EGL_NONE },
            { EGL_COLOR_BUFFER_TYPE, 0, EGL_NONE }, { EGL_NATIVE_RENDERABLE, 6, EGL_NONE },
            { EGL_TRANSPARENT_TYPE, 6, EGL_NONE }, { EGL_LEVEL, EGL_DONT_CARE, EGL_NONE },
            { -1 }, /* Undefined name must be rejected without reading its value. */
        };
        for (unsigned i = 0; i < sizeof invalid / sizeof invalid[0]; i++) {
            EGLConfig selected = (EGLConfig)(uintptr_t)0x1234;
            EGLint count = 17;
            assert(!eglChooseConfig(dpy, invalid[i], &selected, 1, &count));
            assert(eglGetError() == EGL_BAD_ATTRIBUTE);
            assert(count == 17 && selected == (EGLConfig)(uintptr_t)0x1234);
        }
        EGLint value = 17;
        assert(!eglGetConfigAttrib(dpy, (EGLConfig)2, EGL_RED_SIZE, &value));
        assert(eglGetError() == EGL_BAD_CONFIG && value == 17);
        assert(!eglGetConfigAttrib(dpy, (EGLConfig)1, 0, &value));
        assert(eglGetError() == EGL_BAD_ATTRIBUTE && value == 17);
        assert(!eglGetConfigAttrib(dpy, (EGLConfig)1, EGL_RED_SIZE, NULL));
        assert(eglGetError() == EGL_BAD_PARAMETER);
        assert(!eglChooseConfig(dpy, NULL, NULL, 0, NULL));
        assert(eglGetError() == EGL_BAD_PARAMETER);
        const EGLint invalid_after_mismatch[] = { EGL_RED_SIZE, 99,
            EGL_NATIVE_RENDERABLE, 6, EGL_NONE };
        EGLConfig selected = (EGLConfig)(uintptr_t)0x1234;
        EGLint count = 17;
        assert(!eglChooseConfig(dpy, invalid_after_mismatch, &selected, 1, &count));
        assert(eglGetError() == EGL_BAD_ATTRIBUTE && count == 17);
        const EGLint undefined_name[] = { -1 };
        assert(!eglChooseConfig(dpy, undefined_name, &selected, 1, &count));
        assert(eglGetError() == EGL_BAD_ATTRIBUTE && count == 17);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS config-validation");
        return 0;
    }
    if (!strcmp(argv[1], "config-list")) {
        PFNEGLGETCONFIGSPROC enumerate = (PFNEGLGETCONFIGSPROC)eglGetProcAddress("eglGetConfigs");
        assert(enumerate != NULL);
        EGLint count = 17;
        assert(enumerate(dpy, NULL, 0, &count) && count == 1);
        EGLConfig configs[2] = { NULL, (EGLConfig)(uintptr_t)0x1234 };
        assert(enumerate(dpy, configs, 0, &count) && count == 0);
        assert(configs[0] == NULL);
        assert(enumerate(dpy, configs, 2, &count) && count == 1);
        assert(configs[0] == (EGLConfig)1 && configs[1] == (EGLConfig)(uintptr_t)0x1234);
        EGLint buffer_bits = 17;
        assert(eglGetConfigAttrib(dpy, configs[0], EGL_BUFFER_SIZE, &buffer_bits));
        assert(buffer_bits == 32);
        assert(eglGetProcAddress("eglGetConfigs") != NULL);
        assert(!enumerate(dpy, configs, -1, &count));
        assert(eglGetError() == EGL_BAD_PARAMETER);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        count = 17;
        assert(!enumerate(dpy, configs, 2, &count));
        assert(eglGetError() == EGL_NOT_INITIALIZED && count == 17);
        puts("PASS config-list");
        return 0;
    }
    if (!strcmp(argv[1], "namespace")) {
        GLuint names[] = { glCreateShader(GL_VERTEX_SHADER), glCreateProgram(),
            glCreateShader(GL_FRAGMENT_SHADER), glCreateProgram() };
        for (unsigned i = 0; i < 4; i++) {
            assert(names[i] != 0);
            for (unsigned j = 0; j < i; j++) assert(names[i] != names[j]);
        }
        glFlush();
        assert(shaders_created == 2 && programs_created == 2);
        assert(shader_names[0] == names[0] && shader_names[1] == names[2]);
        assert(program_names[0] == names[1] && program_names[1] == names[3]);
        assert(glCreateShader(GL_TEXTURE_2D) == 0);
        assert(glGetError() == GL_INVALID_ENUM);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS namespace");
        return 0;
    }
    if (!strcmp(argv[1], "boolean")) {
        numeric_queries = 1;
        GLboolean result[4] = { 7, 7, 7, 7 };
        glGetBooleanv(GL_COLOR_CLEAR_VALUE, result);
        assert(result[0] == GL_FALSE && result[1] == GL_TRUE);
        assert(result[2] == GL_TRUE && result[3] == GL_TRUE);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS boolean");
        return 0;
    }
    if (!strcmp(argv[1], "query-vector")) {
        numeric_queries = 2;
        GLboolean result[8];
        memset(result, 7, sizeof result);
        glGetBooleanv(GL_COMPRESSED_TEXTURE_FORMATS, result);
        const GLboolean expected[8] = { 0, 1, 1, 1, 0, 1, 7, 7 };
        assert(!memcmp(result, expected, sizeof result));
        glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT, 7);
        GLfloat row_length = 0;
        glGetFloatv(GL_UNPACK_ROW_LENGTH_EXT, &row_length);
        assert(row_length == 7.0f);
        glGetBooleanv(GL_UNPACK_ROW_LENGTH_EXT, result);
        assert(result[0] == GL_TRUE);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS query-vector");
        return 0;
    }
    if (!strcmp(argv[1], "query-error")) {
        numeric_queries = 3;
        GLint integer = 17;
        GLfloat floating = 6.25f;
        GLboolean boolean = 7;
        glGetIntegerv(0xffffffffu, &integer);
        glGetFloatv(0xffffffffu, &floating);
        glGetBooleanv(0xffffffffu, &boolean);
        assert(integer == 17 && floating == 6.25f && boolean == 7);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS query-error");
        return 0;
    }
    EGLImageKHR first = image(dpy), second = image(dpy);
    assert(imports == 2);
    GLuint tex, rb;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, first);
    glGenRenderbuffers(1, &rb);
    glBindRenderbuffer(GL_RENDERBUFFER, rb);
    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, second);
    assert(eglDestroyImageKHR(dpy, first));
    assert(eglDestroyImageKHR(dpy, second));
    if (!strcmp(argv[1], "lifetime")) {
        assert(closes == 0); // The texture and renderbuffer retain storage.
        glDeleteTextures(1, &tex);
        assert(closes == 0); // The other image's sibling remains live.
        glDeleteRenderbuffers(1, &rb);
        assert(closes == 1); // Final reference retires exactly one handle.
    } else if (!strcmp(argv[1], "redefine")) {
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0,
            GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glFlush();
        assert(redefined_texture == tex); // Never respecify the shared BO.
        assert(closes == 0);
        glDeleteRenderbuffers(1, &rb);
        assert(closes == 1);
        glDeleteTextures(1, &tex);
    } else if (!strcmp(argv[1], "framebuffer")) {
        GLuint fb;
        glGenFramebuffers(1, &fb);
        glBindFramebuffer(GL_FRAMEBUFFER, fb);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
            GL_TEXTURE_2D, tex, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glDeleteTextures(1, &tex);
        glDeleteRenderbuffers(1, &rb);
        assert(closes == 0); // An unbound FBO still retains the image storage.
        glDeleteFramebuffers(1, &fb);
        assert(closes == 1);
    } else if (!strcmp(argv[1], "context")) {
        assert(eglDestroyContext(dpy, ctx));
        assert(closes == 0); // Current reference keeps siblings alive.
        assert(eglReleaseThread());
        assert(closes == 1);
        assert(eglTerminate(dpy));
        puts("PASS context");
        return 0;
    } else if (!strcmp(argv[1], "cycle")) {
        // Leave siblings live; teardown must retire them and reset the encoder.
    } else {
        assert(!strcmp(argv[1], "invalid"));
        assert(!eglDestroyImageKHR(dpy, first));
        assert(eglGetError() == EGL_BAD_PARAMETER);
        assert(!eglDestroyImageKHR(dpy, (EGLImageKHR)(uintptr_t)0x1234));
        assert(eglGetError() == EGL_BAD_PARAMETER);
    }
    assert(eglDestroyContext(dpy, ctx));
    assert(eglReleaseThread());
    assert(eglTerminate(dpy));
    assert(closes == 1);
    if (!strcmp(argv[1], "cycle")) {
        assert(eglInitialize(dpy, NULL, NULL));
        ctx = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(ctx != EGL_NO_CONTEXT);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
    }
    printf("PASS %s\n", argv[1]);
}
