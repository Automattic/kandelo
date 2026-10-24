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
/* Existing bridge entry points; this fixture does not advertise GLES3. */
void glGenVertexArrays(GLsizei, GLuint *);
void glDeleteVertexArrays(GLsizei, const GLuint *);
void glBindVertexArray(GLuint);

/* Native pointers exceed the guest's u32 query fields. Resolve the query's
 * recorded allocation explicitly instead of dereferencing a truncated host
 * pointer. The library still allocates, queries and copies the actual reply. */
#undef malloc
#undef calloc
#undef free
#undef mmap
#undef munmap
static void *latest_allocation;
static int fail_calloc, fail_malloc;
static int calloc_before_failure = -1;
static struct { void *pointer; size_t size; } allocations[1024];
static void *record_allocation(void *pointer, size_t size) {
    if (!pointer) return pointer;
    for (unsigned i=0; i<1024; i++) if (!allocations[i].pointer) {
        allocations[i].pointer = pointer; allocations[i].size = size; return pointer;
    }
    assert(!"native allocation registry exhausted"); return NULL;
}
static void *allocation_for(uint32_t pointer, size_t size) {
    void *found = NULL;
    for (unsigned i=0; i<1024; i++) if (allocations[i].pointer && (uint32_t)(uintptr_t)allocations[i].pointer == pointer) {
        assert(!found && size <= allocations[i].size); found = allocations[i].pointer;
    }
    assert(found); return found;
}
void *graphics_calloc(size_t count, size_t size) {
    if (fail_calloc || calloc_before_failure == 0) { errno = ENOMEM; return NULL; }
    if (calloc_before_failure > 0) calloc_before_failure--;
    return record_allocation(calloc(count, size),count*size);
}
void *graphics_malloc(size_t size) { if (fail_malloc) return NULL; return latest_allocation = record_allocation(malloc(size),size); }
void graphics_free(void *ptr) {
    if (latest_allocation == ptr) latest_allocation = NULL;
    for (unsigned i=0; i<1024; i++) if (allocations[i].pointer == ptr) allocations[i].pointer = NULL;
    free(ptr);
}

/* A small native-window identity exercises the real EGL resize hook. */
static int native_window;
static uint32_t native_window_bo;
extern int _wpk_egl_window_retarget(void *);
uint32_t _wpk_wlegl_bo_handle(void *window) { return window == &native_window ? native_window_bo : 0; }
void _wpk_wlegl_present(void *window) { (void)window; }
int _wpk_gbm_surface_dimensions(const void *window, uint32_t *w, uint32_t *h) {
    (void)window; (void)w; (void)h; return 0;
}

static unsigned closes, imports;
static unsigned display_opens, display_closes, object_closes;
static uint32_t display_generation = 91;
static int display_live, fail_display_join;
static uint32_t bound_texture, redefined_texture;
static unsigned char command_storage[8][WPK_GL_CMDBUF_LEN];
struct device_slot {
    int root_open, object_open, root_live;
    uint32_t generation, context, surface;
    unsigned char *commands;
    int has_current;
    pthread_t current_thread;
    uint32_t current_surface;
    unsigned clears, closes;
};
static struct device_slot device_slots[8];
static unsigned pending_device;
static unsigned char *commands;
static unsigned mappings;
static unsigned destroyed_contexts, destroyed_surfaces, submit_batches, clear_commands;
static int fail_make_current, fail_create_context;
static int make_current_errno = EACCES;
static uint32_t next_backend_context = 31;
static uint32_t next_backend_surface = 131;
static int fail_surface_create;
static uint32_t surface_target;
static int fail_surface_update;
static pthread_mutex_t overlap_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t overlap_cond = PTHREAD_COND_INITIALIZER;
static int overlap_phase, pause_foreign_bind;
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
static int numeric_queries;
static int string_generation;
static unsigned context_create_calls;
static unsigned buffer_uploads;
static unsigned draw_commands;
static int indexed_queries;
static uint32_t indexed_max, query_scalar, query_gl_error, query_status;
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
static int capture_array_upload;
static unsigned char captured_bytes[524288];
static uint32_t captured_size, captured_type, captured_stride;
static unsigned captured_chunks;

int graphics_open(const char *path, int flags, ...) {
    (void)flags;
    assert(!strcmp(path, WPK_GL_DEVICE));
#ifdef WPK_GL_SESSION_DISPLAY
    if (display_opens++ % 2 == 0) {
        pending_device = 0;
        while (pending_device < 8 && (device_slots[pending_device].root_open || device_slots[pending_device].object_open)) pending_device++;
        assert(pending_device < 8);
        struct device_slot *slot = &device_slots[pending_device];
        memset(slot,0,sizeof *slot); slot->root_open = 1;
        return 20 + pending_device;
    }
    device_slots[pending_device].object_open = 1;
    return 10 + pending_device;
#else
    return 10;
#endif
}
int graphics_close(int fd) {
#ifdef WPK_GL_SESSION_DISPLAY
    if (fd >= 20 && fd < 28) {
        struct device_slot *slot = &device_slots[fd-20]; assert(slot->root_open);
        slot->root_open = slot->root_live = 0; display_closes++;
        display_live = 0;
        for (unsigned i=0; i<8; i++) display_live |= device_slots[i].root_live;
        return 0;
    }
    assert(fd >= 10 && fd < 18 && device_slots[fd-10].object_open);
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
        commands = command_storage[mappings++ % 8];
        device_slots[fd-10].commands = commands;
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
            struct device_slot *slot = &device_slots[fd-20];
            assert(slot->root_open); slot->root_live = display_live = 1;
            info->display_id = slot->generation = ++display_generation;
        } else {
            assert(fd >= 10 && fd < 18 && info->role == WPK_GL_SESSION_OBJECTS && info->display_fd == fd+10 && info->display_id == device_slots[fd-10].generation && device_slots[fd-10].root_live);
            if (fail_display_join) { errno = ENOMEM; return -1; }
        }
        return 0;
    }
    if (fd >= 20 && fd < 28) {
        assert(request == GLIO_TERMINATE && device_slots[fd-20].root_live);
        device_slots[fd-20].root_live = 0; display_live = 0;
        for (unsigned i=0; i<8; i++) display_live |= device_slots[i].root_live;
        return 0;
    }
#endif
    assert(fd >= 10 && fd < 18);
    struct device_slot *slot = &device_slots[fd-10];
    commands = slot->commands;
    if (request == 0xc00c642eu) {
        uint32_t *words = arg;
        assert(words[2] == 100);
        words[0] = 77; // Repeated PRIME imports share one GEM handle.
        imports++;
    } else if (request == 0x40086409u) {
        assert(*(uint32_t *)arg == 77);
        closes++; slot->closes++;
    } else if (request == 0xc01064e1u) {
        uint32_t *words = arg;
        assert(words[0] == 77);
        assert(words[2] == slot->context);
        if (pause_foreign_bind) {
            overlap_reach(1); overlap_wait(2);
        }
        words[3] = 0x60000000u;
    } else if (request == GLIO_CREATE_CONTEXT && fail_create_context) {
        errno = ENOMEM;
        return -1;
    } else if (request == GLIO_CREATE_CONTEXT) {
        context_create_calls++;
        struct gl_context_attrs *attrs = arg;
        assert(attrs->context_id == 0);
        attrs->context_id = slot->context = next_backend_context++;
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
            if (op == OP_BIND_TEXTURE) bound_texture = words[1];
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
            if (op == OP_CREATE_SHADER && shaders_created < 2)
                shader_names[shaders_created++] = words[1];
            if (op == OP_CREATE_PROGRAM && programs_created < 2)
                program_names[programs_created++] = words[0];
            at += 4 + len;
        }
    } else if (request == GLIO_CREATE_SURFACE) {
        if (fail_surface_create) { errno = ENOMEM; return -1; }
        struct gl_surface_create *request = arg;
        assert(request->surface_id == 0);
        surface_target = request->attrs.reserved[0];
        request->surface_id = slot->surface = next_backend_surface++;
        if (!request->attrs.width) request->attrs.width = 64;
        if (!request->attrs.height) request->attrs.height = 32;
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
            assert(binding->draw_surface_id == binding->read_surface_id);
            assert(!binding->draw_surface_id || binding->draw_surface_id == slot->surface);
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
        }
    } else if (request == GLIO_DESTROY_CONTEXT) {
        assert(!slot->has_current);
        destroyed_contexts++;
        const char *session_trace = getenv("KANDELO_GRAPHICS_SESSION_TRACE");
        if (session_trace) {
            FILE *trace = fopen(session_trace,"ab"); assert(trace);
            const uint32_t header[2] = {(uint32_t)fd,0};
            assert(fwrite(header,1,8,trace) == 8 && !fclose(trace));
        }
        free(upload_pending); upload_pending = NULL;
    } else if (request == GLIO_DESTROY_SURFACE) {
        assert(slot->current_surface == 0);
        destroyed_surfaces++;
    } else if (request == GLIO_QUERY) {
        struct gl_query_info *q = arg;
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
        if (q->op >= 0x18 && q->op <= 0x1d) {
            core_calls++;
            if (core_fail_at && core_calls == core_fail_at) { errno = EIO; return -1; }
            assert(latest_allocation && q->out_buf_len <= 65536);
            uint8_t *reply = latest_allocation;
            memset(reply,0,q->out_buf_len); memcpy(reply,&query_status,4);
            if (q->op <= 0x1a) {
                const unsigned header = q->op == 0x18 ? 12 : 4, unit = q->op == 0x19 ? 4 : 1;
                assert(q->in_buf_len == (q->op == 0x18 ? 16u : 12u));
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
            } else { assert(q->out_buf_len == 12); memcpy(reply+4,&query_scalar,4); }
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
            rbo(GL_RENDERBUFFER,GL_RENDERBUFFER_WIDTH,&value); assert(value == 64);
            rbo(GL_RENDERBUFFER,GL_RENDERBUFFER_INTERNAL_FORMAT,&value); assert(value == 0x8058);
            rbo(GL_RENDERBUFFER,GL_RENDERBUFFER_ALPHA_SIZE,&value); assert(value == 8);
            glGenFramebuffers(2,framebuffers); glBindFramebuffer(GL_FRAMEBUFFER,framebuffers[0]);
            glFramebufferRenderbuffer(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,renderbuffer);
            core_info[0] = GL_TEXTURE; core_info[1] = 0x60000000u;
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
        assert(eglSwapBuffers(dpy, surface));
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
            { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_NONE },
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
