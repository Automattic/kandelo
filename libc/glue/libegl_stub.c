/*
 * libEGL stub for wasm-posix-kernel.
 *
 * Drives session setup against /dev/dri/renderD128: GLIO_INIT (with
 * OP_VERSION and display-generation handshake), GLIO_CREATE_CONTEXT,
 * GLIO_CREATE_SURFACE, GLIO_MAKE_CURRENT. Mmap of the cmdbuf makes the libGLESv2
 * encoder work — flushing without a base/cursor is a no-op.
 *
 * A display root authorizes a separate object session; errors, API selection
 * and current bindings belong to threads. This facade tracks
 * context/surface ownership separately within each generation. Current
 * records retain their original generation through termination/reinitialize.
 * Shared object groups remain tracked in the compatibility ledger.
 * libGLESv2 uses the accessor functions in gl_abi.h at link time.
 */

#define EGL_EGLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <pthread.h>

#include "gl_abi.h"

void glDrawBuffer(GLenum buf);
void glDrawBuffers(GLsizei n, const GLenum *bufs);
void glReadBuffer(GLenum src);
void glEGLImageTargetTexture2DOES(GLenum target, void *image);
void glEGLImageTargetRenderbufferStorageOES(GLenum target, void *image);

struct egl_generation;
static void retire_imported_images(struct egl_generation *generation);
static void invalidate_generation_images(struct egl_generation *generation);

static _Thread_local EGLint g_last_error = EGL_SUCCESS;
static _Thread_local EGLenum g_bound_api = EGL_OPENGL_ES_API;
struct imported_bo_reference;
struct egl_thread_binding;
/* Generation ownership outlives public display initialization when a current
 * context still retains it. Never route old current GL through the new root. */
struct egl_session {
    struct egl_generation *generation;
    int fd, base, context_used, surface_used;
    uint8_t *cmdbuf_base;
    struct egl_session *next;
};
struct egl_context_record {
    EGLContext handle;
    struct egl_session *session;
    struct wpk_gles_context *encoder;
    uint32_t backend_id;
    EGLint client_version, config_id;
    int delete_pending;
    struct egl_thread_binding *owner;
    struct egl_context_record *next;
};
struct egl_surface_record {
    EGLSurface handle;
    struct egl_session *session;
    uint32_t backend_id, width, height;
    unsigned current_references;
    int delete_pending, gbm_window, pbuffer;
    EGLint largest_pbuffer, mipmap_texture;
    void *native_window;
    struct egl_surface_record *next;
};
struct egl_generation {
    int fd, display_fd, initialized, terminate_pending;
    uint32_t id, pending_surface_target_bo;
    uint32_t pbuffer_limits[3];
    struct imported_bo_reference *imported_bos;
    struct egl_session *sessions;
    struct egl_context_record *contexts;
    struct egl_surface_record *surfaces;
    struct egl_generation *next;
};
static struct egl_generation *g_active_generation, *g_generations;
struct egl_thread_binding {
    int current, surfaceless;
    EGLContext context;
    EGLSurface surface, read_surface;
    struct wpk_gles_context *encoder;
    struct egl_generation *generation;
    struct egl_context_record *object;
    struct egl_surface_record *draw, *read;
};
static _Thread_local struct egl_thread_binding g_empty_binding;
static _Thread_local struct egl_thread_binding *g_destructor_binding;
static struct egl_thread_binding *thread_binding(void);
#define g_thread_binding (*thread_binding())
#define g_current (g_thread_binding.current)
#define g_current_surfaceless (g_thread_binding.surfaceless)
static pthread_mutex_t g_context_mutex = PTHREAD_MUTEX_INITIALIZER;
/* GL siblings can retire while another thread terminates/reinitializes EGL.
 * Keep image references and per-generation GEM owners under one lock. The
 * context lock precedes this lock; image operations never acquire it. */
static pthread_mutex_t g_image_mutex = PTHREAD_MUTEX_INITIALIZER;
/* One never-reused identity space also keeps object kinds disjoint from
 * each other and from the display/config token 1. */
static uintptr_t g_next_object_handle = 2;
static pthread_key_t g_binding_key;
static pthread_once_t g_binding_key_once = PTHREAD_ONCE_INIT;
static int g_binding_key_status = EAGAIN;
static void retire_pending_resources_locked(struct egl_generation *generation);
static void binding_thread_destructor(void *binding) {
    /* POSIX clears the key before invoking its destructor. Borrow the heap
     * record for the duration of cleanup, without allocating another key
     * value. Long-lived owner references never point into C TLS. */
    if (binding) {
        g_destructor_binding = binding;
        eglReleaseThread();
        g_destructor_binding = NULL;
    }
}
static void create_binding_key(void) {
    g_binding_key_status = pthread_key_create(&g_binding_key, binding_thread_destructor);
}
static struct egl_thread_binding *thread_binding(void) {
    if (g_destructor_binding) return g_destructor_binding;
    if (pthread_once(&g_binding_key_once, create_binding_key) != 0 || g_binding_key_status != 0)
        return &g_empty_binding;
    struct egl_thread_binding *binding = pthread_getspecific(g_binding_key);
    return binding ? binding : &g_empty_binding;
}
static int register_binding_thread(void) {
    if (pthread_once(&g_binding_key_once, create_binding_key) != 0 || g_binding_key_status != 0) return 0;
    if (pthread_getspecific(g_binding_key)) return 1;
    struct egl_thread_binding *binding = calloc(1, sizeof *binding);
    if (!binding) return 0;
    if (pthread_setspecific(g_binding_key, binding) != 0) { free(binding); return 0; }
    return 1;
}
/* libwayland-egl hooks (libc/glue/libwayland-egl.c). Weak so a program that
 * links libEGL WITHOUT libwayland-egl — a KMS/canvas GL client — still links;
 * the symbols resolve to NULL and the wayland-egl path is simply skipped. */
__attribute__((weak)) uint32_t _wpk_wlegl_bo_handle(void *egl_window);
__attribute__((weak)) int _wpk_wlegl_device_fd(void *egl_window);
__attribute__((weak)) int _wpk_wlegl_dimensions(void *egl_window, uint32_t *width,
                                                uint32_t *height);
__attribute__((weak)) void     _wpk_wlegl_present(void *egl_window);
/* A GBM native window carries its drawable size before the first modeset.
 * Weak: EGL clients using another window backend need not link libgbm. */
__attribute__((weak)) int _wpk_gbm_surface_dimensions(const void *window,
                                                     uint32_t *width, uint32_t *height);

#define EGL_DPY_HANDLE      ((EGLDisplay)(uintptr_t)1)
#define EGL_CONFIG_HANDLE ((EGLConfig)(uintptr_t)1)

int _wpk_gl_fd(void) {
    struct egl_context_record *context = g_thread_binding.object;
    return context ? context->session->fd : -1;
}
uint8_t *_wpk_gl_cmdbuf_base(void) {
    struct egl_context_record *context = g_thread_binding.object;
    return context ? context->session->cmdbuf_base : NULL;
}
struct wpk_gles_context *_wpk_gl_current_encoder(void) {
    return g_thread_binding.encoder;
}

EGLDisplay eglGetDisplay(EGLNativeDisplayType display_id) {
    (void)display_id;
    return EGL_DPY_HANDLE;
}

/* EGL 1.5 core. `eglQueryString(dpy, EGL_VERSION)` below reports 1.5, so
 * a client that believes us binds this entry point instead of the 1.0
 * `eglGetDisplay` — SDL2's `SDL_EGL_LoadLibrary` does exactly that, and
 * under `SDL_VIDEO_STATIC_ANGLE` the binding is a direct symbol
 * reference. It has to resolve from libEGL.a or `-Wl,--allow-undefined`
 * silently turns it into an `env.eglGetPlatformDisplay` import that the
 * host stubs with a throwing function.
 *
 * One display, one device: everything is driven through
 * WPK_GL_DEVICE. `EGL_PLATFORM_GBM_KHR` (== EGL_PLATFORM_GBM_MESA, the
 * enum SDL2's KMSDRM backend passes) is the only platform this backend
 * really is, so every other platform gets the EGL_BAD_PARAMETER the
 * spec asks for rather than a display that cannot work. `native_display`
 * is the caller's `gbm_device *`, which selects nothing here: the
 * libgbm shim opens the same device. */
EGLDisplay eglGetPlatformDisplay(EGLenum platform, void *native_display,
                                 const EGLAttrib *attrib_list) {
    (void)native_display;
    if (platform != EGL_PLATFORM_GBM_KHR) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_NO_DISPLAY;
    }
    /* No platform attributes are defined for this backend. The spec
     * requires EGL_BAD_ATTRIBUTE for anything we do not recognize; a NULL
     * or immediately EGL_NONE-terminated list is legal. */
    if (attrib_list && attrib_list[0] != EGL_NONE) {
        g_last_error = EGL_BAD_ATTRIBUTE;
        return EGL_NO_DISPLAY;
    }
    return EGL_DPY_HANDLE;
}

/* EGL_EXT_platform_base spelling of eglGetPlatformDisplay, with an
 * EGLint attribute list. */
EGLDisplay eglGetPlatformDisplayEXT(EGLenum platform, void *native_display,
                                    const EGLint *attrib_list) {
    if (attrib_list && attrib_list[0] != EGL_NONE) {
        g_last_error = EGL_BAD_ATTRIBUTE;
        return EGL_NO_DISPLAY;
    }
    return eglGetPlatformDisplay(platform, native_display, NULL);
}

static EGLBoolean initialize_locked(EGLDisplay dpy, EGLint *major, EGLint *minor);
EGLBoolean eglInitialize(EGLDisplay dpy, EGLint *major, EGLint *minor) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = initialize_locked(dpy, major, minor);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
static EGLBoolean initialize_locked(EGLDisplay dpy, EGLint *major, EGLint *minor) {
    struct egl_generation *generation = g_active_generation;
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_FALSE;
    }
    if (generation && generation->initialized) {
        if (major) *major = 1;
        if (minor) *minor = 5;
        return EGL_TRUE;
    }
    int display_fd = open(WPK_GL_DEVICE, O_RDWR | O_CLOEXEC);
    if (display_fd < 0) {
        fprintf(stderr, "eglInitialize: open(%s) failed: errno=%d\n",
                WPK_GL_DEVICE, errno);
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_FALSE;
    }

    struct gl_init_info root = {WPK_GL_OP_VERSION,WPK_GL_SESSION_DISPLAY,-1,0};
    if (ioctl(display_fd, GLIO_INIT, &root) != 0) {
        fprintf(stderr,
                "eglInitialize: GLIO_INIT(op_version=%u) failed: errno=%d\n",
                (unsigned)WPK_GL_OP_VERSION, errno);
        close(display_fd);
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_FALSE;
    }
    int fd = open(WPK_GL_DEVICE, O_RDWR | O_CLOEXEC);
    struct gl_init_info object = {WPK_GL_OP_VERSION,WPK_GL_SESSION_OBJECTS,display_fd,root.display_id};
    if (fd < 0 || ioctl(fd,GLIO_INIT,&object) != 0) {
        if (fd >= 0) close(fd);
        close(display_fd); g_last_error = EGL_NOT_INITIALIZED; return EGL_FALSE;
    }

    // Map the cmdbuf here, not in eglMakeCurrent, so the host's
    // gl_bind fires before any subsequent GLIO_CREATE_CONTEXT. The
    // host registry's pendingCanvases drain runs on bind, and
    // gl_create_context relies on `b.canvas` being set — without an
    // early bind the context is built with no canvas attached and
    // the OffscreenCanvas placeholder stays blank.
    void *p = mmap(NULL, WPK_GL_CMDBUF_LEN, PROT_READ | PROT_WRITE,
                   MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) {
        fprintf(stderr,
                "eglInitialize: cmdbuf mmap(len=%u) failed: errno=%d\n",
                (unsigned)WPK_GL_CMDBUF_LEN, errno);
        close(fd);
        close(display_fd);
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_FALSE;
    }
    generation = calloc(1, sizeof *generation);
    if (!generation) {
        munmap(p, WPK_GL_CMDBUF_LEN);
        close(fd); close(display_fd);
        g_last_error = EGL_BAD_ALLOC;
        return EGL_FALSE;
    }
    struct egl_session *session = calloc(1, sizeof *session);
    if (!session) {
        free(generation);
        munmap(p, WPK_GL_CMDBUF_LEN);
        close(fd);
        close(display_fd);
        g_last_error = EGL_BAD_ALLOC;
        return EGL_FALSE;
    }
    *session =
        (struct egl_session){.generation = generation, .fd = fd, .base = 1, .cmdbuf_base = p};
    generation->sessions = session;
    generation->fd = fd;
    generation->display_fd = display_fd;
    generation->id = root.display_id;
    generation->initialized = 1;
    generation->next = g_generations;
    g_generations = g_active_generation = generation;
    if (major) *major = 1;
    if (minor) *minor = 5;
    return EGL_TRUE;
}

enum config_match { CFG_MINIMUM, CFG_EXACT, CFG_BOOLEAN, CFG_COLOR, CFG_CAVEAT,
    CFG_TRANSPARENT, CFG_API_MASK, CFG_SURFACE_MASK, CFG_ID, CFG_LEVEL,
    CFG_IGNORED, CFG_TRANSPARENT_COMPONENT, CFG_PIXMAP };
struct config_attribute {
    EGLint name, value, default_value;
    enum config_match match;
};
/* One source for enumeration, selection and queries. These are the existing
 * RGBA8/depth24/stencil8, non-multisampled window and pbuffer storage. Native
 * rendering and API conformance are not inferred from WebGL2. */
static const struct config_attribute config_attributes[] = {
    { EGL_BUFFER_SIZE, 32, 0, CFG_MINIMUM },
    { EGL_RED_SIZE, 8, 0, CFG_MINIMUM },
    { EGL_GREEN_SIZE, 8, 0, CFG_MINIMUM },
    { EGL_BLUE_SIZE, 8, 0, CFG_MINIMUM },
    { EGL_ALPHA_SIZE, 8, 0, CFG_MINIMUM },
    { EGL_LUMINANCE_SIZE, 0, 0, CFG_MINIMUM },
    { EGL_ALPHA_MASK_SIZE, 0, 0, CFG_MINIMUM },
    { EGL_DEPTH_SIZE, 24, 0, CFG_MINIMUM },
    { EGL_STENCIL_SIZE, 8, 0, CFG_MINIMUM },
    { EGL_SAMPLE_BUFFERS, 0, 0, CFG_MINIMUM },
    { EGL_SAMPLES, 0, 0, CFG_MINIMUM },
    { EGL_BIND_TO_TEXTURE_RGB, EGL_FALSE, EGL_DONT_CARE, CFG_BOOLEAN },
    { EGL_BIND_TO_TEXTURE_RGBA, EGL_FALSE, EGL_DONT_CARE, CFG_BOOLEAN },
    { EGL_COLOR_BUFFER_TYPE, EGL_RGB_BUFFER, EGL_RGB_BUFFER, CFG_COLOR },
    { EGL_CONFIG_CAVEAT, EGL_NONE, EGL_DONT_CARE, CFG_CAVEAT },
    { EGL_CONFIG_ID, 1, EGL_DONT_CARE, CFG_ID },
    { EGL_CONFORMANT, 0, 0, CFG_API_MASK },
    { EGL_LEVEL, 0, 0, CFG_LEVEL },
    { EGL_MAX_SWAP_INTERVAL, 0, EGL_DONT_CARE, CFG_EXACT },
    { EGL_MIN_SWAP_INTERVAL, 0, EGL_DONT_CARE, CFG_EXACT },
    { EGL_NATIVE_RENDERABLE, EGL_FALSE, EGL_DONT_CARE, CFG_BOOLEAN },
    { EGL_NATIVE_VISUAL_ID, 0, EGL_DONT_CARE, CFG_IGNORED },
    { EGL_NATIVE_VISUAL_TYPE, EGL_NONE, EGL_DONT_CARE, CFG_IGNORED },
    { EGL_MAX_PBUFFER_WIDTH, 0, EGL_DONT_CARE, CFG_IGNORED },
    { EGL_MAX_PBUFFER_HEIGHT, 0, EGL_DONT_CARE, CFG_IGNORED },
    { EGL_MAX_PBUFFER_PIXELS, 0, EGL_DONT_CARE, CFG_IGNORED },
    { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_OPENGL_ES_BIT, CFG_API_MASK },
    { EGL_SURFACE_TYPE, EGL_WINDOW_BIT | EGL_PBUFFER_BIT, EGL_WINDOW_BIT, CFG_SURFACE_MASK },
    { EGL_TRANSPARENT_TYPE, EGL_NONE, EGL_NONE, CFG_TRANSPARENT },
    { EGL_TRANSPARENT_RED_VALUE, 0, EGL_DONT_CARE, CFG_TRANSPARENT_COMPONENT },
    { EGL_TRANSPARENT_GREEN_VALUE, 0, EGL_DONT_CARE, CFG_TRANSPARENT_COMPONENT },
    { EGL_TRANSPARENT_BLUE_VALUE, 0, EGL_DONT_CARE, CFG_TRANSPARENT_COMPONENT },
    { EGL_MATCH_NATIVE_PIXMAP, EGL_NONE, EGL_NONE, CFG_PIXMAP },
};
#define CONFIG_ATTRIBUTE_COUNT (sizeof config_attributes / sizeof config_attributes[0])

static int config_attribute_index(EGLint name) {
    for (unsigned i = 0; i < CONFIG_ATTRIBUTE_COUNT; i++)
        if (config_attributes[i].name == name) return (int)i;
    return -1;
}

static EGLBoolean config_display_ready(EGLDisplay dpy) {
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_FALSE; }
    pthread_mutex_lock(&g_context_mutex);
    int ready = g_active_generation && g_active_generation->initialized;
    pthread_mutex_unlock(&g_context_mutex);
    if (!ready) { g_last_error = EGL_NOT_INITIALIZED; return EGL_FALSE; }
    return EGL_TRUE;
}

static EGLBoolean return_configs(EGLConfig *configs, EGLint config_size,
                                 EGLint *num_config, int matches) {
    if (!num_config || (configs && config_size < 0)) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_FALSE;
    }
    const EGLint count = matches && (!configs || config_size > 0) ? 1 : 0;
    if (configs && count) configs[0] = EGL_CONFIG_HANDLE;
    *num_config = count;
    return EGL_TRUE;
}

EGLBoolean eglGetConfigs(EGLDisplay dpy, EGLConfig *configs,
                         EGLint config_size, EGLint *num_config) {
    if (!config_display_ready(dpy)) return EGL_FALSE;
    return return_configs(configs, config_size, num_config, 1);
}

EGLBoolean eglChooseConfig(EGLDisplay dpy, const EGLint *attrib_list,
                           EGLConfig *configs, EGLint config_size,
                           EGLint *num_config) {
    if (!config_display_ready(dpy)) return EGL_FALSE;
    if (!num_config || (configs && config_size < 0)) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_FALSE;
    }
    EGLint wanted[CONFIG_ATTRIBUTE_COUNT];
    for (unsigned i = 0; i < CONFIG_ATTRIBUTE_COUNT; i++) wanted[i] = config_attributes[i].default_value;
    if (attrib_list) {
        for (const EGLint *a = attrib_list; a[0] != EGL_NONE; a += 2) {
            const int i = config_attribute_index(a[0]);
            /* Reject an undefined name before reading its nonexistent value. */
            if (i < 0) { g_last_error = EGL_BAD_ATTRIBUTE; return EGL_FALSE; }
            wanted[i] = a[1];
        }
    }
    const EGLint id = wanted[config_attribute_index(EGL_CONFIG_ID)];
    if (id != EGL_DONT_CARE) return return_configs(configs, config_size, num_config, id == 1);
    const EGLint transparency = wanted[config_attribute_index(EGL_TRANSPARENT_TYPE)];
    int matches = 1;
    for (unsigned i = 0; i < CONFIG_ATTRIBUTE_COUNT; i++) {
        const struct config_attribute *attribute = &config_attributes[i];
        const EGLint value = wanted[i];
        const enum config_match kind = attribute->match;
        if (kind == CFG_IGNORED ||
            (kind == CFG_TRANSPARENT_COMPONENT && transparency == EGL_NONE)) continue;
        if (value == EGL_DONT_CARE && kind != CFG_LEVEL && kind != CFG_PIXMAP) continue;
        int valid = value >= 0;
        if (kind == CFG_LEVEL) valid = value != EGL_DONT_CARE;
        if (kind == CFG_BOOLEAN) valid = value == EGL_FALSE || value == EGL_TRUE;
        if (kind == CFG_COLOR) valid = value == EGL_RGB_BUFFER || value == EGL_LUMINANCE_BUFFER;
        if (kind == CFG_CAVEAT) valid = value == EGL_NONE || value == EGL_SLOW_CONFIG || value == EGL_NON_CONFORMANT_CONFIG;
        if (kind == CFG_TRANSPARENT) valid = value == EGL_NONE || value == EGL_TRANSPARENT_RGB;
        if (kind == CFG_PIXMAP) valid = value != EGL_DONT_CARE;
        if (kind == CFG_API_MASK) valid = value >= 0 && !(value & ~(EGL_OPENGL_ES_BIT |
            EGL_OPENVG_BIT | EGL_OPENGL_ES2_BIT | EGL_OPENGL_BIT | EGL_OPENGL_ES3_BIT));
        if (kind == CFG_SURFACE_MASK) valid = value >= 0 && !(value & ~(EGL_WINDOW_BIT |
            EGL_PIXMAP_BIT | EGL_PBUFFER_BIT | EGL_VG_COLORSPACE_LINEAR_BIT |
            EGL_VG_ALPHA_FORMAT_PRE_BIT | EGL_MULTISAMPLE_RESOLVE_BOX_BIT | EGL_SWAP_BEHAVIOR_PRESERVED_BIT));
        if (!valid) { g_last_error = EGL_BAD_ATTRIBUTE; return EGL_FALSE; }
        if (kind == CFG_MINIMUM) matches &= attribute->value >= value;
        else if (kind == CFG_API_MASK || kind == CFG_SURFACE_MASK) matches &= (attribute->value & value) == value;
        else matches &= attribute->value == value;
    }
    return return_configs(configs, config_size, num_config, matches);
}

/* Read immutable renderer limits through the initialized object session,
 * without creating a public context or changing any thread's current state. */
static int surface_limits_locked(struct egl_generation *generation) {
    if (generation->pbuffer_limits[0]) return 1;
    uint32_t *reply = calloc(4,sizeof *reply);
    if (!reply) { g_last_error = EGL_BAD_ALLOC; return 0; }
    const struct gl_query_info query = {.op = QOP_SURFACE_CAPABILITIES,
        .out_buf_ptr = (uint32_t)(uintptr_t)reply, .out_buf_len = 16};
    int accepted = ioctl(generation->fd,GLIO_QUERY,&query) == 0 && reply[3] == WPK_GL_QUERY_REPLY_MAGIC &&
        reply[0] > 0 && reply[0] <= INT32_MAX && reply[1] > 0 && reply[1] <= INT32_MAX &&
        reply[2] > 0 && reply[2] <= INT32_MAX && (uint64_t)reply[2] <= (uint64_t)reply[0]*reply[1];
    if (accepted) memcpy(generation->pbuffer_limits,reply,3*sizeof *reply);
    else g_last_error = EGL_BAD_ACCESS;
    free(reply); return accepted;
}
EGLBoolean eglGetConfigAttrib(EGLDisplay dpy, EGLConfig config,
                              EGLint attribute, EGLint *value) {
    if (!config_display_ready(dpy)) return EGL_FALSE;
    if (config != EGL_CONFIG_HANDLE) { g_last_error = EGL_BAD_CONFIG; return EGL_FALSE; }
    if (!value) { g_last_error = EGL_BAD_PARAMETER; return EGL_FALSE; }
    const int i = config_attribute_index(attribute);
    if (i < 0 || attribute == EGL_MATCH_NATIVE_PIXMAP) { g_last_error = EGL_BAD_ATTRIBUTE; return EGL_FALSE; }
    if (attribute == EGL_MAX_PBUFFER_WIDTH || attribute == EGL_MAX_PBUFFER_HEIGHT || attribute == EGL_MAX_PBUFFER_PIXELS) {
        pthread_mutex_lock(&g_context_mutex);
        struct egl_generation *generation = g_active_generation;
        int accepted = generation && generation->initialized;
        if (!accepted) g_last_error = EGL_NOT_INITIALIZED;
        else accepted = surface_limits_locked(generation);
        if (accepted) *value = (EGLint)generation->pbuffer_limits[attribute == EGL_MAX_PBUFFER_WIDTH ? 0 : attribute == EGL_MAX_PBUFFER_HEIGHT ? 1 : 2];
        pthread_mutex_unlock(&g_context_mutex);
        return accepted ? EGL_TRUE : EGL_FALSE;
    }
    *value = config_attributes[i].value;
    return EGL_TRUE;
}

EGLBoolean eglBindAPI(EGLenum api) {
    if (api != EGL_OPENGL_ES_API) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_FALSE;
    }
    g_bound_api = api;
    return EGL_TRUE;
}

static struct egl_context_record *find_context(struct egl_generation *generation,
                                               EGLContext handle) {
    for (struct egl_context_record *p = generation->contexts; p; p = p->next)
        if (p->handle == handle && !p->delete_pending)
            return p;
    return NULL;
}
static struct egl_surface_record *find_surface(struct egl_generation *generation,
                                               EGLSurface handle) {
    for (struct egl_surface_record *p = generation->surfaces; p; p = p->next)
        if (p->handle == handle && !p->delete_pending)
            return p;
    return NULL;
}
static uint32_t transfer_bo_handle(int source_fd, int target_fd, uint32_t handle);
static void release_transferred_bo(struct egl_generation *generation, int source_fd, int target_fd,
                                   uint32_t handle);
static struct egl_session *object_session(struct egl_generation *generation, int context) {
    for (struct egl_session *p = generation->sessions; p; p = p->next)
        if (!(context ? p->context_used : p->surface_used))
            return p;
    struct egl_session *p = calloc(1, sizeof *p);
    if (!p)
        return NULL;
    p->fd = open(WPK_GL_DEVICE, O_RDWR | O_CLOEXEC);
    struct gl_init_info info = {WPK_GL_OP_VERSION, WPK_GL_SESSION_OBJECTS, generation->display_fd,
                                generation->id};
    if (p->fd < 0 || ioctl(p->fd, GLIO_INIT, &info) != 0)
        goto fail;
    void *map = mmap(NULL, WPK_GL_CMDBUF_LEN, PROT_READ | PROT_WRITE, MAP_SHARED, p->fd, 0);
    if (map == MAP_FAILED)
        goto fail;
    p->generation = generation;
    p->cmdbuf_base = map;
    p->next = generation->sessions;
    generation->sessions = p;
    return p;
fail:
    if (p->fd >= 0)
        close(p->fd);
    free(p);
    return NULL;
}
static void retire_empty_sessions(struct egl_generation *generation) {
    struct egl_session **link = &generation->sessions;
    while (*link) {
        struct egl_session *p = *link;
        if (p->base || p->context_used || p->surface_used) {
            link = &p->next;
            continue;
        }
        *link = p->next;
        ioctl(p->fd, GLIO_TERMINATE, NULL);
        munmap(p->cmdbuf_base, WPK_GL_CMDBUF_LEN);
        close(p->fd);
        free(p);
    }
}
static EGLint current_binding_error(void) {
    switch (errno) {
    case ENOMEM:
        return EGL_BAD_ALLOC;
    case EIO:
    case ENODEV:
    case EBADF:
        return EGL_CONTEXT_LOST;
    case EINVAL:
        return EGL_BAD_MATCH;
    default:
        return EGL_BAD_ACCESS;
    }
}
static void detach_binding(struct egl_thread_binding *binding) {
    if (binding->object && binding->object->owner == binding)
        binding->object->owner = NULL;
    if (binding->draw)
        binding->draw->current_references--;
    if (binding->read && binding->read != binding->draw)
        binding->read->current_references--;
    *binding = (struct egl_thread_binding){0};
}
static EGLBoolean release_current_locked(void) {
    struct egl_thread_binding *binding = &g_thread_binding;
    struct egl_generation *generation = binding->generation;
    if (binding->object && binding->object->owner == binding) {
        _wpk_gl_flush();
        const struct gl_make_current release = {0, 0, 0};
        if (ioctl(binding->object->session->fd, GLIO_MAKE_CURRENT, &release) != 0) {
            g_last_error = current_binding_error();
            return EGL_FALSE;
        }
    }
    detach_binding(binding);
    if (generation)
        retire_pending_resources_locked(generation);
    return EGL_TRUE;
}
static EGLContext create_context_locked(EGLDisplay dpy, EGLConfig config, EGLContext share,
                                        const EGLint *list) {
    struct egl_generation *generation = g_active_generation;
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_NO_CONTEXT;
    }
    if (!generation || !generation->initialized) {
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_NO_CONTEXT;
    }
    if (config != EGL_CONFIG_HANDLE && config != EGL_NO_CONFIG_KHR) {
        g_last_error = EGL_BAD_CONFIG;
        return EGL_NO_CONTEXT;
    }
    struct egl_context_record *shared =
        share == EGL_NO_CONTEXT ? NULL : find_context(generation, share);
    if (share != EGL_NO_CONTEXT && !shared) {
        g_last_error = EGL_BAD_CONTEXT;
        return EGL_NO_CONTEXT;
    }
    EGLint version = 1;
    for (const EGLint *a = list; a && a[0] != EGL_NONE; a += 2) {
        if (a[0] == EGL_CONTEXT_CLIENT_VERSION)
            version = a[1];
        else if (a[0] == EGL_CONTEXT_MINOR_VERSION && a[1] == 0) {
        } else {
            g_last_error = EGL_BAD_ATTRIBUTE;
            return EGL_NO_CONTEXT;
        }
    }
    if (version != 2) {
        g_last_error = EGL_BAD_MATCH;
        return EGL_NO_CONTEXT;
    }
    if (!g_next_object_handle) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_CONTEXT;
    }
    struct egl_context_record *context = calloc(1, sizeof *context);
    if (!context) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_CONTEXT;
    }
    context->encoder =
        shared ? _wpk_gl_create_shared_encoder(shared->encoder) : _wpk_gl_create_encoder();
    if (!context->encoder) {
        free(context);
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_CONTEXT;
    }
    struct egl_session *session = object_session(generation, 1);
    if (!session)
        goto fail;
    struct gl_context_attrs attrs = {.client_version = (uint32_t)version,
                                     .share_context_id = shared ? shared->backend_id : 0};
    if (ioctl(session->fd, GLIO_CREATE_CONTEXT, &attrs) != 0 || !attrs.context_id)
        goto fail;
    context->handle = (EGLContext)g_next_object_handle++;
    context->session = session;
    context->backend_id = attrs.context_id;
    context->client_version = version;
    context->config_id = config == EGL_NO_CONFIG_KHR ? 0 : 1;
    context->next = generation->contexts;
    generation->contexts = context;
    session->context_used = 1;
    return context->handle;
fail:
    _wpk_gl_destroy_encoder(context->encoder);
    free(context);
    retire_empty_sessions(generation);
    g_last_error = EGL_BAD_ALLOC;
    return EGL_NO_CONTEXT;
}
EGLContext eglCreateContext(EGLDisplay dpy, EGLConfig config, EGLContext share,
                            const EGLint *list) {
    pthread_mutex_lock(&g_context_mutex);
    EGLContext result = create_context_locked(dpy, config, share, list);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
static EGLSurface create_window_surface_locked(EGLDisplay dpy, EGLConfig config,
                                               EGLNativeWindowType win, const EGLint *list) {
    struct egl_generation *generation = g_active_generation;
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_NO_SURFACE;
    }
    if (!generation || !generation->initialized) {
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_NO_SURFACE;
    }
    if (config != EGL_CONFIG_HANDLE) {
        g_last_error = EGL_BAD_CONFIG;
        return EGL_NO_SURFACE;
    }
    if (!g_next_object_handle) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_SURFACE;
    }
    for (struct egl_surface_record *p = generation->surfaces; p; p = p->next)
        if (win && p->native_window == (void *)win) {
            g_last_error = EGL_BAD_ALLOC;
            return EGL_NO_SURFACE;
        }
    struct gl_surface_create request = {.attrs = {.kind = WPK_SURFACE_DEFAULT, .config_id = 1}};
    int is_gbm =
        win && _wpk_gbm_surface_dimensions &&
        _wpk_gbm_surface_dimensions((void *)win, &request.attrs.width, &request.attrs.height);
    for (const EGLint *a = list; a && a[0] != EGL_NONE; a += 2) {
        if (a[0] == EGL_WIDTH && a[1] >= 0)
            request.attrs.width = (uint32_t)a[1];
        else if (a[0] == EGL_HEIGHT && a[1] >= 0)
            request.attrs.height = (uint32_t)a[1];
        else if (a[0] == EGL_RENDER_BUFFER && a[1] == EGL_BACK_BUFFER) {
        } else if (a[0] == EGL_GL_COLORSPACE && a[1] == EGL_GL_COLORSPACE_LINEAR) {
        } else {
            g_last_error = EGL_BAD_ATTRIBUTE;
            return EGL_NO_SURFACE;
        }
    }
    struct egl_surface_record *surface = calloc(1, sizeof *surface);
    if (!surface) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_SURFACE;
    }
    struct egl_session *session = object_session(generation, 0);
    if (!session)
        goto fail;
    uint32_t target = generation->pending_surface_target_bo;
    int source_fd = generation->fd;
    if (!target && !is_gbm && win && _wpk_wlegl_bo_handle) {
        target = _wpk_wlegl_bo_handle((void *)win);
        if (target && _wpk_wlegl_device_fd)
            source_fd = _wpk_wlegl_device_fd((void *)win);
        if (target && _wpk_wlegl_dimensions)
            _wpk_wlegl_dimensions((void *)win, &request.attrs.width, &request.attrs.height);
    }
    uint32_t local_target = target ? transfer_bo_handle(source_fd, session->fd, target) : 0;
    if (target && !local_target)
        goto fail;
    request.attrs.reserved[0] = local_target;
    int created = ioctl(session->fd, GLIO_CREATE_SURFACE, &request) == 0;
    release_transferred_bo(generation, source_fd, session->fd, local_target);
    if (!created)
        goto fail;
    if (!request.surface_id || request.attrs.width > INT32_MAX ||
        request.attrs.height > INT32_MAX) {
        ioctl(session->fd, GLIO_DESTROY_SURFACE, NULL);
        goto fail;
    }
    *surface = (struct egl_surface_record){.handle = (EGLSurface)g_next_object_handle++,
                                           .session = session,
                                           .backend_id = request.surface_id,
                                           .width = request.attrs.width,
                                           .height = request.attrs.height,
                                           .native_window = (void *)win};
    /* GBM windows have no Wayland attach/commit hook. */
    surface->gbm_window = is_gbm;
    surface->next = generation->surfaces;
    generation->surfaces = surface;
    session->surface_used = 1;
    generation->pending_surface_target_bo = 0;
    return surface->handle;
fail:
    free(surface);
    retire_empty_sessions(generation);
    g_last_error = EGL_BAD_ALLOC;
    return EGL_NO_SURFACE;
}
EGLSurface eglCreateWindowSurface(EGLDisplay dpy, EGLConfig config, EGLNativeWindowType win,
                                  const EGLint *list) {
    pthread_mutex_lock(&g_context_mutex);
    EGLSurface result = create_window_surface_locked(dpy, config, win, list);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
int _wpk_egl_window_retarget(void *window) {
    pthread_mutex_lock(&g_context_mutex);
    int accepted = 1;
    for (struct egl_generation *g = g_generations; g; g = g->next) {
        for (struct egl_surface_record *p = g->surfaces; p; p = p->next) {
            if (!window || p->native_window != window || p->gbm_window)
                continue;
            uint32_t target = _wpk_wlegl_bo_handle ? _wpk_wlegl_bo_handle(window) : 0;
            if (!target) {
                accepted = 0;
                goto done;
            }
            int source_fd = _wpk_wlegl_device_fd ? _wpk_wlegl_device_fd(window) : g->fd;
            uint32_t local_target = transfer_bo_handle(source_fd, p->session->fd, target);
            if (!local_target) {
                accepted = 0;
                goto done;
            }
            _wpk_gl_flush();
            struct gl_surface_attrs attrs = {
                .kind = WPK_SURFACE_DEFAULT, .config_id = 1, .reserved = {local_target, 0, 0, 0}};
            if (_wpk_wlegl_dimensions)
                _wpk_wlegl_dimensions(window, &attrs.width, &attrs.height);
            accepted = ioctl(p->session->fd, GLIO_UPDATE_SURFACE, &attrs) == 0;
            release_transferred_bo(g, source_fd, p->session->fd, local_target);
            if (accepted && attrs.width && attrs.height) {
                p->width = attrs.width;
                p->height = attrs.height;
            }
            goto done;
        }
    }
done:
    pthread_mutex_unlock(&g_context_mutex);
    return accepted;
}
EGLBoolean eglMakeCurrent(EGLDisplay dpy, EGLSurface draw, EGLSurface read, EGLContext handle) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = EGL_FALSE;
    struct egl_generation *generation = g_active_generation;
    if (handle == EGL_NO_CONTEXT) {
        if (dpy != EGL_NO_DISPLAY && dpy != EGL_DPY_HANDLE)
            g_last_error = EGL_BAD_DISPLAY;
        else if (draw != EGL_NO_SURFACE || read != EGL_NO_SURFACE)
            g_last_error = EGL_BAD_MATCH;
        else
            result = release_current_locked();
        goto done;
    }
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        goto done;
    }
    if (!generation || !generation->initialized) {
        g_last_error = EGL_NOT_INITIALIZED;
        goto done;
    }
    struct egl_context_record *context = find_context(generation, handle);
    if (!context) {
        g_last_error = EGL_BAD_CONTEXT;
        goto done;
    }
    if ((draw == EGL_NO_SURFACE) != (read == EGL_NO_SURFACE)) {
        g_last_error = EGL_BAD_MATCH;
        goto done;
    }
    struct egl_surface_record *d = NULL, *r = NULL;
    if (draw != EGL_NO_SURFACE) {
        d = find_surface(generation, draw);
        r = find_surface(generation, read);
        if (!d || !r) {
            g_last_error = EGL_BAD_SURFACE;
            goto done;
        }
    }
    if (!register_binding_thread()) {
        g_last_error = EGL_BAD_ALLOC;
        goto done;
    }
    if (g_current)
        _wpk_gl_flush();
    struct gl_make_current binding = {context->backend_id, d ? d->backend_id : 0,
                                      r ? r->backend_id : 0};
    if (ioctl(context->session->fd, GLIO_MAKE_CURRENT, &binding) != 0) {
        g_last_error = current_binding_error();
        goto done;
    }
    struct egl_thread_binding *thread = &g_thread_binding;
    struct egl_generation *previous = thread->generation;
    /* Accepted kernel authority also invalidates stale C owners after a
     * thread ended without completing its user-space TLS cleanup. */
    for (struct egl_context_record *p = generation->contexts; p; p = p->next) {
        struct egl_thread_binding *owner = p->owner;
        if (!owner || owner == thread)
            continue;
        if (p == context || (d && (owner->draw == d || owner->read == d)) ||
            (r && (owner->draw == r || owner->read == r)))
            detach_binding(owner);
    }
    detach_binding(thread);
    context->owner = thread;
    if (d)
        d->current_references++;
    if (r && r != d)
        r->current_references++;
    *thread = (struct egl_thread_binding){.current = 1,
                                          .surfaceless = d == NULL,
                                          .context = handle,
                                          .surface = draw,
                                          .read_surface = read,
                                          .encoder = context->encoder,
                                          .generation = generation,
                                          .object = context,
                                          .draw = d,
                                          .read = r};
    if (previous && previous != generation)
        retire_pending_resources_locked(previous);
    retire_pending_resources_locked(generation);
    result = EGL_TRUE;
done:
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
EGLContext eglGetCurrentContext(void) {
    return g_current ? g_thread_binding.context : EGL_NO_CONTEXT;
}
EGLDisplay eglGetCurrentDisplay(void) { return g_current ? EGL_DPY_HANDLE : EGL_NO_DISPLAY; }
EGLSurface eglGetCurrentSurface(EGLint which) {
    if (which != EGL_READ && which != EGL_DRAW) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_NO_SURFACE;
    }
    return !g_current          ? EGL_NO_SURFACE
           : which == EGL_READ ? g_thread_binding.read_surface
                               : g_thread_binding.surface;
}
EGLBoolean eglQueryContext(EGLDisplay dpy, EGLContext handle, EGLint attribute, EGLint *value) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = EGL_FALSE;
    struct egl_generation *g = g_active_generation;
    if (dpy != EGL_DPY_HANDLE)
        g_last_error = EGL_BAD_DISPLAY;
    else if (!g)
        g_last_error = EGL_NOT_INITIALIZED;
    else {
        struct egl_context_record *p = find_context(g, handle);
        if (!p)
            g_last_error = EGL_BAD_CONTEXT;
        else if (!value)
            g_last_error = EGL_BAD_PARAMETER;
        else {
            EGLint out = 0;
            switch (attribute) {
            case EGL_CONFIG_ID:
                out = p->config_id;
                break;
            case EGL_CONTEXT_CLIENT_TYPE:
                out = EGL_OPENGL_ES_API;
                break;
            case EGL_CONTEXT_CLIENT_VERSION:
                out = p->client_version;
                break;
            case EGL_RENDER_BUFFER:
                out = p->owner && p->owner->draw ? EGL_BACK_BUFFER : EGL_NONE;
                break;
            default:
                g_last_error = EGL_BAD_ATTRIBUTE;
                goto done;
            }
            *value = out;
            result = EGL_TRUE;
        }
    }
done:
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
EGLBoolean eglQuerySurface(EGLDisplay dpy, EGLSurface handle, EGLint attribute, EGLint *value) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = EGL_FALSE;
    struct egl_generation *generation = g_active_generation;
    if (dpy != EGL_DPY_HANDLE)
        g_last_error = EGL_BAD_DISPLAY;
    else if (!generation)
        g_last_error = EGL_NOT_INITIALIZED;
    else {
        struct egl_surface_record *surface = find_surface(generation, handle);
        if (!surface)
            g_last_error = EGL_BAD_SURFACE;
        else if (!value)
            g_last_error = EGL_BAD_PARAMETER;
        else {
            EGLint out;
            switch (attribute) {
            case EGL_CONFIG_ID:
                out = 1;
                break;
            case EGL_WIDTH:
                out = (EGLint)surface->width;
                break;
            case EGL_HEIGHT:
                out = (EGLint)surface->height;
                break;
            case EGL_GL_COLORSPACE:
                out = EGL_GL_COLORSPACE_LINEAR;
                break;
            case EGL_VG_COLORSPACE:
                out = EGL_VG_COLORSPACE_sRGB;
                break;
            case EGL_VG_ALPHA_FORMAT:
                out = EGL_VG_ALPHA_FORMAT_NONPRE;
                break;
            case EGL_RENDER_BUFFER:
                out = EGL_BACK_BUFFER;
                break;
            case EGL_SWAP_BEHAVIOR:
                out = EGL_BUFFER_DESTROYED;
                break;
            case EGL_MULTISAMPLE_RESOLVE:
                out = EGL_MULTISAMPLE_RESOLVE_DEFAULT;
                break;
            case EGL_HORIZONTAL_RESOLUTION:
            case EGL_VERTICAL_RESOLUTION:
            case EGL_PIXEL_ASPECT_RATIO:
                out = EGL_UNKNOWN;
                break;
            /* EGL 1.5 section 3.5.6: pbuffer-only queries on a window
             * succeed without modifying the caller's output. */
            case EGL_LARGEST_PBUFFER:
            case EGL_TEXTURE_FORMAT:
            case EGL_TEXTURE_TARGET:
            case EGL_MIPMAP_TEXTURE:
            case EGL_MIPMAP_LEVEL:
                if (!surface->pbuffer) { result = EGL_TRUE; goto done; }
                out = attribute == EGL_LARGEST_PBUFFER ? surface->largest_pbuffer :
                    attribute == EGL_MIPMAP_TEXTURE ? surface->mipmap_texture :
                    attribute == EGL_MIPMAP_LEVEL ? 0 : EGL_NO_TEXTURE;
                break;
            default:
                g_last_error = EGL_BAD_ATTRIBUTE;
                goto done;
            }
            *value = out;
            result = EGL_TRUE;
        }
    }
done:
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
EGLBoolean eglSwapBuffers(EGLDisplay dpy, EGLSurface handle) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = EGL_FALSE;
    struct egl_generation *g = g_active_generation;
    if (dpy != EGL_DPY_HANDLE)
        g_last_error = EGL_BAD_DISPLAY;
    else if (!g)
        g_last_error = EGL_NOT_INITIALIZED;
    else {
        struct egl_surface_record *p = find_surface(g, handle);
        struct egl_context_record *context = g_thread_binding.object;
        if (!p || !context || g_thread_binding.generation != g || g_thread_binding.draw != p)
            g_last_error = EGL_BAD_SURFACE;
        else {
            _wpk_gl_flush();
            /* The host distinguishes offscreen no-post flushes from window
             * posting. Keep its failure channel for pbuffers as well. */
            if (ioctl(context->session->fd, GLIO_PRESENT, NULL) != 0)
                g_last_error = current_binding_error();
            else {
                if (p->native_window && !p->gbm_window && _wpk_wlegl_present)
                    _wpk_wlegl_present(p->native_window);
                result = EGL_TRUE;
            }
        }
    }
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
EGLBoolean eglDestroySurface(EGLDisplay dpy, EGLSurface handle) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = EGL_FALSE;
    struct egl_generation *g = g_active_generation;
    if (dpy != EGL_DPY_HANDLE)
        g_last_error = EGL_BAD_DISPLAY;
    else if (!g)
        g_last_error = EGL_NOT_INITIALIZED;
    else {
        struct egl_surface_record *p = find_surface(g, handle);
        if (!p)
            g_last_error = EGL_BAD_SURFACE;
        else {
            p->delete_pending = 1;
            retire_pending_resources_locked(g);
            result = EGL_TRUE;
        }
    }
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
EGLBoolean eglDestroyContext(EGLDisplay dpy, EGLContext handle) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = EGL_FALSE;
    struct egl_generation *g = g_active_generation;
    if (dpy != EGL_DPY_HANDLE)
        g_last_error = EGL_BAD_DISPLAY;
    else if (!g)
        g_last_error = EGL_NOT_INITIALIZED;
    else {
        struct egl_context_record *p = find_context(g, handle);
        if (!p)
            g_last_error = EGL_BAD_CONTEXT;
        else {
            p->delete_pending = 1;
            retire_pending_resources_locked(g);
            result = EGL_TRUE;
        }
    }
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
static void retire_pending_resources_locked(struct egl_generation *g) {
    struct egl_context_record **context = &g->contexts;
    while (*context) {
        struct egl_context_record *p = *context;
        if (!p->delete_pending) {
            context = &p->next;
            continue;
        }
        if (ioctl(p->session->fd, GLIO_DESTROY_CONTEXT, NULL) != 0) {
            context = &p->next;
            continue;
        }
        if (p->owner)
            detach_binding(p->owner);
        *context = p->next;
        _wpk_gl_destroy_encoder(p->encoder);
        p->session->context_used = 0;
        free(p);
    }
    struct egl_surface_record **surface = &g->surfaces;
    while (*surface) {
        struct egl_surface_record *p = *surface;
        if (!p->delete_pending) {
            surface = &p->next;
            continue;
        }
        if (ioctl(p->session->fd, GLIO_DESTROY_SURFACE, NULL) != 0) {
            surface = &p->next;
            continue;
        }
        for (struct egl_context_record *c = g->contexts; c; c = c->next)
            if (c->owner && (c->owner->draw == p || c->owner->read == p))
                detach_binding(c->owner);
        *surface = p->next;
        p->session->surface_used = 0;
        free(p);
    }
    retire_empty_sessions(g);
    if (!g->terminate_pending || g->contexts || g->surfaces)
        return;
    retire_imported_images(g);
    while (g->sessions) {
        struct egl_session *p = g->sessions;
        g->sessions = p->next;
        ioctl(p->fd, GLIO_TERMINATE, NULL);
        munmap(p->cmdbuf_base, WPK_GL_CMDBUF_LEN);
        close(p->fd);
        free(p);
    }
    if (g->display_fd >= 0)
        close(g->display_fd);
    struct egl_generation **link = &g_generations;
    while (*link && *link != g)
        link = &(*link)->next;
    if (*link)
        *link = g->next;
    free(g);
}
EGLBoolean eglTerminate(EGLDisplay dpy) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = EGL_FALSE;
    struct egl_generation *g = g_active_generation;
    if (dpy != EGL_DPY_HANDLE)
        g_last_error = EGL_BAD_DISPLAY;
    else if (!g)
        result = EGL_TRUE;
    else if (g->initialized && ioctl(g->display_fd, GLIO_TERMINATE, NULL) != 0)
        g_last_error = EGL_BAD_ACCESS;
    else {
        g->initialized = 0;
        g->terminate_pending = 1;
        g_active_generation = NULL;
        invalidate_generation_images(g);
        for (struct egl_context_record *p = g->contexts; p; p = p->next)
            p->delete_pending = 1;
        for (struct egl_surface_record *p = g->surfaces; p; p = p->next)
            p->delete_pending = 1;
        retire_pending_resources_locked(g);
        result = EGL_TRUE;
    }
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}

EGLint eglGetError(void) {
    EGLint e = g_last_error;
    g_last_error = EGL_SUCCESS;
    return e;
}

/* The "1.5" below is the version clients branch on, and this archive
 * does not define the whole 1.5 entry-point set: the sync objects
 * (eglCreateSync/eglDestroySync/eglClientWaitSync/eglWaitSync/
 * eglGetSyncAttrib), the core images (eglCreateImage/eglDestroyImage;
 * EGL_KHR_image_base's eglCreateImageKHR imports dma-bufs),
 * eglCreatePlatformWindowSurface/eglCreatePlatformPixmapSurface, and
 * several 1.0-1.4 entry points (eglSurfaceAttrib, eglBindTexImage,
 * eglReleaseTexImage, eglCopyBuffers, eglCreatePixmapSurface,
 * eglCreatePbufferFromClientBuffer) are all absent. That gap is
 * deliberately left visible rather than papered over with a plausible
 * return value — `wasm_require_approved_reserved_env_imports` in
 * scripts/wasm-artifact-guards.sh refuses any artifact that references
 * one, so a new consumer fails its build here instead of trapping on a
 * throwing host import at run time. Implement the entry point when a
 * consumer needs it. Independent context/surface records now expose
 * accepted sizes and deferred lifetime; the remaining APIs are tracked. */
const char *eglQueryString(EGLDisplay dpy, EGLint name) {
    /* EGL_EXT_client_extensions: EGL_NO_DISPLAY answers the extensions
     * that exist before a display does. The GBM platform is the one this
     * backend is (see eglGetPlatformDisplay). */
    if (dpy == EGL_NO_DISPLAY && name == EGL_EXTENSIONS) {
        return "EGL_EXT_client_extensions EGL_EXT_platform_base "
               "EGL_KHR_platform_gbm EGL_MESA_platform_gbm";
    }
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return NULL;
    }
    switch (name) {
        case EGL_VENDOR:      return "wasm-posix-kernel";
        case EGL_VERSION:     return "1.5 wpk";
        case EGL_CLIENT_APIS: return "OpenGL_ES";
        case EGL_EXTENSIONS:
            return "EGL_EXT_image_dma_buf_import "
                   "EGL_EXT_image_dma_buf_import_modifiers "
                   "EGL_KHR_image_base EGL_KHR_no_config_context "
                   "EGL_KHR_surfaceless_context";
        default:              return NULL;
    }
}

#define WPK_MAP_GL(name) \
    if (strcmp(procname, #name) == 0) return (__eglMustCastToProperFunctionPointerType)(uintptr_t)&name

__eglMustCastToProperFunctionPointerType eglGetProcAddress(const char *procname) {
    if (!procname) return NULL;
    WPK_MAP_GL(eglGetConfigs);
    WPK_MAP_GL(eglChooseConfig);
    WPK_MAP_GL(eglGetConfigAttrib);
    WPK_MAP_GL(glActiveTexture);
    WPK_MAP_GL(glAttachShader);
    WPK_MAP_GL(glBindAttribLocation);
    WPK_MAP_GL(glBindBuffer);
    WPK_MAP_GL(glBindFramebuffer);
    WPK_MAP_GL(glBindRenderbuffer);
    WPK_MAP_GL(glBindTexture);
    WPK_MAP_GL(glBlendColor);
    WPK_MAP_GL(glBlendEquation);
    WPK_MAP_GL(glBlendEquationSeparate);
    WPK_MAP_GL(glBlendFunc);
    WPK_MAP_GL(glBlendFuncSeparate);
    WPK_MAP_GL(glBufferData);
    WPK_MAP_GL(glBufferSubData);
    WPK_MAP_GL(glCheckFramebufferStatus);
    WPK_MAP_GL(glClear);
    WPK_MAP_GL(glClearColor);
    WPK_MAP_GL(glClearDepthf);
    WPK_MAP_GL(glClearStencil);
    WPK_MAP_GL(glColorMask);
    WPK_MAP_GL(glCompileShader);
    WPK_MAP_GL(glCompressedTexImage2D);
    WPK_MAP_GL(glCompressedTexSubImage2D);
    WPK_MAP_GL(glCopyTexImage2D);
    WPK_MAP_GL(glCopyTexSubImage2D);
    WPK_MAP_GL(glCreateProgram);
    WPK_MAP_GL(glCreateShader);
    WPK_MAP_GL(glCullFace);
    WPK_MAP_GL(glDeleteBuffers);
    WPK_MAP_GL(glDeleteFramebuffers);
    WPK_MAP_GL(glDeleteProgram);
    WPK_MAP_GL(glDeleteRenderbuffers);
    WPK_MAP_GL(glDeleteShader);
    WPK_MAP_GL(glDeleteTextures);
    WPK_MAP_GL(glDepthFunc);
    WPK_MAP_GL(glDepthMask);
    WPK_MAP_GL(glDepthRangef);
    WPK_MAP_GL(glDetachShader);
    WPK_MAP_GL(glDisable);
    WPK_MAP_GL(glDisableVertexAttribArray);
    WPK_MAP_GL(glDrawArrays);
    WPK_MAP_GL(glDrawElements);
    WPK_MAP_GL(glDrawBuffer);
    WPK_MAP_GL(glDrawBuffers);
    WPK_MAP_GL(glEGLImageTargetRenderbufferStorageOES);
    WPK_MAP_GL(glEGLImageTargetTexture2DOES);
    WPK_MAP_GL(glEnable);
    WPK_MAP_GL(glEnableVertexAttribArray);
    WPK_MAP_GL(glFinish);
    WPK_MAP_GL(glFlush);
    WPK_MAP_GL(glFramebufferRenderbuffer);
    WPK_MAP_GL(glFramebufferTexture2D);
    WPK_MAP_GL(glFrontFace);
    WPK_MAP_GL(glGenBuffers);
    WPK_MAP_GL(glGenerateMipmap);
    WPK_MAP_GL(glGenFramebuffers);
    WPK_MAP_GL(glGenRenderbuffers);
    WPK_MAP_GL(glGenTextures);

    WPK_MAP_GL(glGetActiveAttrib);
    WPK_MAP_GL(glGetAttachedShaders);
    WPK_MAP_GL(glGetFramebufferAttachmentParameteriv);
    WPK_MAP_GL(glGetRenderbufferParameteriv);
    WPK_MAP_GL(glGetShaderSource);
    WPK_MAP_GL(glGetTexParameterfv);
    WPK_MAP_GL(glGetTexParameteriv);
    WPK_MAP_GL(glValidateProgram);
    WPK_MAP_GL(glGetBufferParameteriv);
    WPK_MAP_GL(glGetVertexAttribiv);
    WPK_MAP_GL(glGetVertexAttribfv);
    WPK_MAP_GL(glGetVertexAttribPointerv);
    WPK_MAP_GL(glIsBuffer);
    WPK_MAP_GL(glIsTexture);
    WPK_MAP_GL(glIsRenderbuffer);
    WPK_MAP_GL(glIsFramebuffer);
    WPK_MAP_GL(glIsShader);
    WPK_MAP_GL(glIsProgram);
    WPK_MAP_GL(glIsEnabled);
    WPK_MAP_GL(glGetActiveUniform);

    WPK_MAP_GL(glGetAttribLocation);
    WPK_MAP_GL(glGetBooleanv);

    WPK_MAP_GL(glGetError);
    WPK_MAP_GL(glGetFloatv);

    WPK_MAP_GL(glGetIntegerv);
    WPK_MAP_GL(glGetProgramiv);
    WPK_MAP_GL(glGetProgramInfoLog);

    WPK_MAP_GL(glGetShaderiv);
    WPK_MAP_GL(glGetShaderInfoLog);
    WPK_MAP_GL(glGetShaderPrecisionFormat);

    WPK_MAP_GL(glGetString);


    WPK_MAP_GL(glGetUniformfv);
    WPK_MAP_GL(glGetUniformiv);
    WPK_MAP_GL(glGetUniformLocation);



    WPK_MAP_GL(glHint);







    WPK_MAP_GL(glLineWidth);
    WPK_MAP_GL(glLinkProgram);
    WPK_MAP_GL(glPixelStorei);
    WPK_MAP_GL(glPolygonOffset);
    WPK_MAP_GL(glReadBuffer);
    WPK_MAP_GL(glReadPixels);
    WPK_MAP_GL(glReleaseShaderCompiler);
    WPK_MAP_GL(glRenderbufferStorage);
    WPK_MAP_GL(glSampleCoverage);
    WPK_MAP_GL(glScissor);
    WPK_MAP_GL(glShaderBinary);
    WPK_MAP_GL(glShaderSource);
    WPK_MAP_GL(glStencilFunc);
    WPK_MAP_GL(glStencilFuncSeparate);
    WPK_MAP_GL(glStencilMask);
    WPK_MAP_GL(glStencilMaskSeparate);
    WPK_MAP_GL(glStencilOp);
    WPK_MAP_GL(glStencilOpSeparate);
    WPK_MAP_GL(glTexImage2D);
    WPK_MAP_GL(glTexParameterf);
    WPK_MAP_GL(glTexParameterfv);
    WPK_MAP_GL(glTexParameteri);
    WPK_MAP_GL(glTexParameteriv);
    WPK_MAP_GL(glTexSubImage2D);
    WPK_MAP_GL(glUniform1f);
    WPK_MAP_GL(glUniform1fv);
    WPK_MAP_GL(glUniform1i);
    WPK_MAP_GL(glUniform1iv);
    WPK_MAP_GL(glUniform2f);
    WPK_MAP_GL(glUniform2fv);
    WPK_MAP_GL(glUniform2i);
    WPK_MAP_GL(glUniform2iv);
    WPK_MAP_GL(glUniform3f);
    WPK_MAP_GL(glUniform3fv);
    WPK_MAP_GL(glUniform3i);
    WPK_MAP_GL(glUniform3iv);
    WPK_MAP_GL(glUniform4f);
    WPK_MAP_GL(glUniform4fv);
    WPK_MAP_GL(glUniform4i);
    WPK_MAP_GL(glUniform4iv);
    WPK_MAP_GL(glUniformMatrix2fv);
    WPK_MAP_GL(glUniformMatrix3fv);
    WPK_MAP_GL(glUniformMatrix4fv);
    WPK_MAP_GL(glUseProgram);

    WPK_MAP_GL(glVertexAttrib1f);
    WPK_MAP_GL(glVertexAttrib1fv);
    WPK_MAP_GL(glVertexAttrib2f);
    WPK_MAP_GL(glVertexAttrib2fv);
    WPK_MAP_GL(glVertexAttrib3f);
    WPK_MAP_GL(glVertexAttrib3fv);
    WPK_MAP_GL(glVertexAttrib4f);
    WPK_MAP_GL(glVertexAttrib4fv);
    WPK_MAP_GL(glVertexAttribPointer);
    WPK_MAP_GL(glViewport);
    WPK_MAP_GL(eglCreateImageKHR);
    WPK_MAP_GL(eglDestroyImageKHR);
    WPK_MAP_GL(eglGetPlatformDisplayEXT);
    WPK_MAP_GL(eglGetCurrentContext);
    WPK_MAP_GL(eglGetCurrentDisplay);
    WPK_MAP_GL(eglGetCurrentSurface);
    WPK_MAP_GL(eglQueryContext);
    WPK_MAP_GL(eglQuerySurface);
    WPK_MAP_GL(eglCreatePbufferSurface);
    WPK_MAP_GL(eglQueryDmaBufFormatsEXT);
    WPK_MAP_GL(eglQueryDmaBufModifiersEXT);
    return NULL;
}

#undef WPK_MAP_GL

EGLBoolean eglWaitClient(void) {
    _wpk_gl_flush();
    return EGL_TRUE;
}

EGLBoolean eglReleaseThread(void) {
    pthread_mutex_lock(&g_context_mutex);
    struct egl_thread_binding *binding = &g_thread_binding;
    if (!release_current_locked()) {
        pthread_mutex_unlock(&g_context_mutex);
        return EGL_FALSE;
    }
    if (g_binding_key_status == 0) {
        pthread_setspecific(g_binding_key, NULL);
        if (binding != &g_empty_binding) free(binding);
    }
    g_bound_api = EGL_OPENGL_ES_API;
    g_last_error = EGL_SUCCESS;
    pthread_mutex_unlock(&g_context_mutex);
    return EGL_TRUE;
}

/* ----- additional thin stubs required by SDL2 ------------------- */

/* SDL_egl.c's LOAD_FUNC under SDL_VIDEO_STATIC_ANGLE assigns these
 * symbols directly into `_this->egl_data->NAME`.  All of them must
 * therefore exist at link time even when their behaviour is a no-op
 * (SDL2 documents NULL returns + EGL_FALSE returns as "the
 * extension/feature isn't available", which is exactly the truth
 * for our single-window single-buffer surface). */

EGLBoolean eglSwapInterval(EGLDisplay dpy, EGLint interval) {
    (void) interval;
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_FALSE;
    }
    /* No vsync knob — the host bridge runs at the canvas's natural
     * cadence (rAF in the browser, hrtime tick on Node).  Accept
     * any interval and return EGL_TRUE so SDL2 doesn't surface an
     * error to the app. */
    return EGL_TRUE;
}

EGLBoolean eglWaitGL(void) {
    _wpk_gl_flush();
    return EGL_TRUE;
}

EGLBoolean eglWaitNative(EGLint engine) {
    (void) engine;
    return EGL_TRUE;
}

EGLenum eglQueryAPI(void) {
    return g_bound_api;
}

/* Find the maximum rectangle area under a pixel budget without scanning
 * every width. Equal quotients form intervals; the last width in each
 * interval maximizes that interval's area. Products and bounds stay u64. */
static void pbuffer_dimensions(uint32_t width, uint32_t height, uint64_t budget,
                               uint32_t *out_width, uint32_t *out_height) {
    uint64_t best = 0;
    *out_width = *out_height = 0;
    if (!width || !height) { *out_width = width; *out_height = height; return; }
    for (uint64_t first = 1; first <= width && first <= budget;) {
        uint64_t quotient = budget / first;
        uint64_t h = quotient < height ? quotient : height;
        uint64_t last = quotient >= height ? budget / height : budget / quotient;
        if (last > width) last = width;
        if (last*h >= best) { best = last*h; *out_width = (uint32_t)last; *out_height = (uint32_t)h; }
        first = last+1;
    }
}
static int create_pbuffer_candidate(struct egl_session *session, uint32_t width, uint32_t height,
                                    struct gl_surface_create *request) {
    *request = (struct gl_surface_create){.attrs = {.kind = WPK_SURFACE_PBUFFER,
        .config_id = 1, .width = width, .height = height}};
    if (ioctl(session->fd,GLIO_CREATE_SURFACE,request) != 0) return 0;
    if (!request->surface_id || request->attrs.width != width || request->attrs.height != height) {
        ioctl(session->fd,GLIO_DESTROY_SURFACE,NULL); errno = EIO; return 0;
    }
    return 1;
}
static EGLSurface create_pbuffer_locked(EGLDisplay dpy, EGLConfig config, const EGLint *list) {
    struct egl_generation *generation = g_active_generation;
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_NO_SURFACE; }
    if (!generation || !generation->initialized) { g_last_error = EGL_NOT_INITIALIZED; return EGL_NO_SURFACE; }
    if (config != EGL_CONFIG_HANDLE) { g_last_error = EGL_BAD_CONFIG; return EGL_NO_SURFACE; }
    EGLint width = 0, height = 0, largest = EGL_FALSE, mipmap = EGL_FALSE;
    EGLint format = EGL_NO_TEXTURE, target = EGL_NO_TEXTURE;
    for (const EGLint *a = list; a && a[0] != EGL_NONE; a += 2) {
        switch (a[0]) {
        case EGL_WIDTH: case EGL_HEIGHT:
            if (a[1] < 0) { g_last_error = EGL_BAD_PARAMETER; return EGL_NO_SURFACE; }
            if (a[0] == EGL_WIDTH) width = a[1]; else height = a[1]; break;
        case EGL_LARGEST_PBUFFER: case EGL_MIPMAP_TEXTURE:
            if (a[1] != EGL_FALSE && a[1] != EGL_TRUE) goto bad_attribute;
            if (a[0] == EGL_LARGEST_PBUFFER) largest = a[1]; else mipmap = a[1]; break;
        case EGL_TEXTURE_FORMAT:
            if (a[1] != EGL_NO_TEXTURE && a[1] != EGL_TEXTURE_RGB && a[1] != EGL_TEXTURE_RGBA) goto bad_attribute;
            format = a[1]; break;
        case EGL_TEXTURE_TARGET:
            if (a[1] != EGL_NO_TEXTURE && a[1] != EGL_TEXTURE_2D) goto bad_attribute;
            target = a[1]; break;
        case EGL_GL_COLORSPACE:
            if (a[1] != EGL_GL_COLORSPACE_LINEAR && a[1] != EGL_GL_COLORSPACE_SRGB) goto bad_attribute;
            if (a[1] != EGL_GL_COLORSPACE_LINEAR) goto bad_match;
            break;
        case EGL_VG_COLORSPACE:
            if (a[1] != EGL_VG_COLORSPACE_sRGB && a[1] != EGL_VG_COLORSPACE_LINEAR) goto bad_attribute;
            if (a[1] != EGL_VG_COLORSPACE_sRGB) goto bad_match;
            break;
        case EGL_VG_ALPHA_FORMAT:
            if (a[1] != EGL_VG_ALPHA_FORMAT_NONPRE && a[1] != EGL_VG_ALPHA_FORMAT_PRE) goto bad_attribute;
            if (a[1] != EGL_VG_ALPHA_FORMAT_NONPRE) goto bad_match;
            break;
        default: goto bad_attribute;
        }
    }
    /* This configuration supports ES2 rendering but advertises neither
     * BIND_TO_TEXTURE capability. Render-to-texture is optional in EGL. */
    if (format != EGL_NO_TEXTURE || target != EGL_NO_TEXTURE) goto bad_match;
    if (!surface_limits_locked(generation)) return EGL_NO_SURFACE;
    if (!largest && ((uint32_t)width > generation->pbuffer_limits[0] ||
        (uint32_t)height > generation->pbuffer_limits[1] ||
        (uint64_t)width*(uint32_t)height > generation->pbuffer_limits[2])) goto bad_alloc;
    if (!g_next_object_handle) goto bad_alloc;
    uint32_t max_width = (uint32_t)width, max_height = (uint32_t)height;
    if (max_width > generation->pbuffer_limits[0]) max_width = generation->pbuffer_limits[0];
    if (max_height > generation->pbuffer_limits[1]) max_height = generation->pbuffer_limits[1];
    uint64_t budget = (uint64_t)max_width*max_height;
    if (budget > generation->pbuffer_limits[2]) budget = generation->pbuffer_limits[2];
    struct egl_surface_record *surface = calloc(1,sizeof *surface);
    if (!surface) goto bad_alloc;
    struct egl_session *session = object_session(generation,0);
    if (!session) { free(surface); goto bad_alloc; }
    struct gl_surface_create request;
    uint32_t allocated_width, allocated_height;
    pbuffer_dimensions(max_width,max_height,budget,&allocated_width,&allocated_height);
    if (!create_pbuffer_candidate(session,allocated_width,allocated_height,&request)) {
        if (!largest || errno != ENOMEM || !budget) goto fail;
        // Search only after a definite allocation rejection. Unknown transport
        // completion and pending native repair must never authorize a retry.
        uint64_t low = 0, high = budget-1;
        uint32_t best_width = 0, best_height = 0;
        while (low < high) {
            uint64_t middle = low+(high-low+1)/2;
            pbuffer_dimensions(max_width,max_height,middle,&allocated_width,&allocated_height);
            uint64_t area = (uint64_t)allocated_width*allocated_height;
            if (area <= low) { low = middle; continue; }
            if (create_pbuffer_candidate(session,allocated_width,allocated_height,&request)) {
                best_width = allocated_width; best_height = allocated_height;
                if (ioctl(session->fd,GLIO_DESTROY_SURFACE,NULL) != 0) goto fail;
                low = middle;
            } else {
                if (errno != ENOMEM) goto fail;
                high = area-1;
            }
        }
        if (!best_width || !best_height || !create_pbuffer_candidate(session,best_width,best_height,&request)) goto fail;
    }
    *surface = (struct egl_surface_record){.handle = (EGLSurface)g_next_object_handle++,
        .session = session, .backend_id = request.surface_id,
        .width = request.attrs.width, .height = request.attrs.height,
        .pbuffer = 1, .largest_pbuffer = largest, .mipmap_texture = mipmap};
    surface->next = generation->surfaces; generation->surfaces = surface;
    session->surface_used = 1;
    return surface->handle;
fail:
    free(surface); retire_empty_sessions(generation);
bad_alloc:
    g_last_error = EGL_BAD_ALLOC; return EGL_NO_SURFACE;
bad_attribute:
    g_last_error = EGL_BAD_ATTRIBUTE; return EGL_NO_SURFACE;
bad_match:
    g_last_error = EGL_BAD_MATCH; return EGL_NO_SURFACE;
}
EGLSurface eglCreatePbufferSurface(EGLDisplay dpy, EGLConfig config, const EGLint *attrib_list) {
    pthread_mutex_lock(&g_context_mutex);
    EGLSurface result = create_pbuffer_locked(dpy,config,attrib_list);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}

/* ----- WPK dmabuf-import extension ------------------------------- */

/* Kandelo's stand-in for EGL_EXT_image_dma_buf_import +
 * glEGLImageTargetTexture2DOES: import a prime fd on the EGL session's
 * renderD128 fd, then bind the bo as a texture in the current context.
 * Consumers (wlcompositor's GPU compositing path) declare these extern —
 * they resolve from libEGL.a at link time.
 *
 * The DRM ioctl numbers/structs below mirror Linux UAPI (and
 * wasm_posix_shared::dri) — libEGL must not depend on libdrm headers. */

#define WPK_DRM_IOCTL_GEM_CLOSE            0x40086409u
#define WPK_DRM_IOCTL_PRIME_HANDLE_TO_FD 0xc00c642du
#define WPK_DRM_IOCTL_PRIME_FD_TO_HANDLE   0xc00c642eu
#define WPK_DRM_IOCTL_BIND_FOREIGN_TEXTURE 0xc01064e1u

struct wpk_drm_prime_handle { uint32_t handle; uint32_t flags; int32_t fd; };
struct wpk_drm_gem_close    { uint32_t handle; uint32_t pad; };
struct wpk_drm_bind_foreign_texture {
    uint32_t bo_handle;
    uint32_t gl_target;
    uint32_t ctx_id;
    uint32_t gl_texture_id;   /* out */
};

/* PRIME import returns the existing handle for an already imported BO on
 * this open description. Library owners need independent references even
 * when their kernel handle names are equal. */
struct imported_bo_reference {
    uint32_t handle;
    unsigned references;
    struct imported_bo_reference *next;
};
/* GEM names belong to an open description. Surface and context sessions
 * cannot use the importing generation's name directly. The PRIME fd owns
 * storage across the transfer; the accepted surface/texture then retains
 * its own storage reference before this temporary local name is closed. */
static uint32_t transfer_bo_handle(int source_fd, int target_fd, uint32_t handle) {
    if (source_fd == target_fd)
        return handle;
    struct wpk_drm_prime_handle exported = {
        .handle = handle, .flags = O_CLOEXEC | O_RDWR, .fd = -1};
    if (ioctl(source_fd, WPK_DRM_IOCTL_PRIME_HANDLE_TO_FD, &exported) != 0)
        return 0;
    struct wpk_drm_prime_handle imported = {.fd = exported.fd};
    int accepted = ioctl(target_fd, WPK_DRM_IOCTL_PRIME_FD_TO_HANDLE, &imported) == 0;
    int error = errno;
    close(exported.fd);
    errno = error;
    return accepted ? imported.handle : 0;
}
static void release_transferred_bo(struct egl_generation *generation, int source_fd, int target_fd,
                                   uint32_t handle) {
    if (!handle || source_fd == target_fd)
        return;
    /* An idempotent import can return a name already owned by an image
     * on the generation's base descriptor. Do not revoke that owner. */
    int retained = 0;
    pthread_mutex_lock(&g_image_mutex);
    if (generation->fd == target_fd)
        for (struct imported_bo_reference *p = generation->imported_bos; p; p = p->next)
            if (p->handle == handle) {
                retained = 1;
                break;
            }
    pthread_mutex_unlock(&g_image_mutex);
    if (retained)
        return;
    struct wpk_drm_gem_close req = {.handle = handle};
    int error = errno;
    ioctl(target_fd, WPK_DRM_IOCTL_GEM_CLOSE, &req);
    errno = error;
}

static struct wpk_egl_image *g_images;

/* Import `prime_fd`'s bo as a GEM handle on the EGL device fd. Returns
 * the handle, or 0 on failure. The caller owns the handle and releases
 * it with wpkEglCloseBoHandle. */
static unsigned import_dmabuf_handle(struct egl_generation *generation, int prime_fd) {
    if (!generation || generation->fd < 0 || prime_fd < 0) return 0;
    struct imported_bo_reference *owner = calloc(1, sizeof *owner);
    if (!owner) return 0;
    struct wpk_drm_prime_handle req = { .handle = 0, .flags = 0, .fd = prime_fd };
    if (ioctl(generation->fd, WPK_DRM_IOCTL_PRIME_FD_TO_HANDLE, &req) != 0) {
        free(owner);
        return 0;
    }
    pthread_mutex_lock(&g_image_mutex);
    for (struct imported_bo_reference *existing = generation->imported_bos; existing;
         existing = existing->next) {
        if (existing->handle == req.handle) {
            existing->references++;
            free(owner);
            pthread_mutex_unlock(&g_image_mutex);
            return req.handle;
        }
    }
    owner->handle = req.handle;
    owner->references = 1;
    owner->next = generation->imported_bos;
    generation->imported_bos = owner;
    pthread_mutex_unlock(&g_image_mutex);
    return req.handle;
}

unsigned wpkEglImportDmabufHandle(EGLDisplay dpy, int prime_fd) {
    pthread_mutex_lock(&g_context_mutex);
    unsigned handle = dpy == EGL_DPY_HANDLE
        ? import_dmabuf_handle(g_active_generation, prime_fd) : 0;
    pthread_mutex_unlock(&g_context_mutex);
    return handle;
}

/* (Re)bind an imported bo as a GL_TEXTURE_2D texture in the current
 * context, uploading the bo's pixels host-side (no cmdbuf marshalling).
 * Re-call after the producer commits to refresh the texture — the
 * returned id is stable per bo. Returns 0 on failure (no GL backing on
 * this host, unknown handle) — callers degrade to their CPU path. */
static unsigned bind_bo_texture(EGLDisplay dpy, unsigned bo_handle, unsigned gl_target,
                                int publish) {
    struct egl_generation *generation = g_thread_binding.generation;
    struct egl_context_record *context = g_thread_binding.object;
    if (dpy != EGL_DPY_HANDLE || !generation || !context || context->session->fd < 0)
        return 0;
    struct wpk_gl_name_scope name_scope __attribute__((cleanup(_wpk_gl_end_name_scope))) =
        publish ? _wpk_gl_begin_name_scope(context->encoder) : (struct wpk_gl_name_scope){0};
    if (publish && !name_scope.group) {
        g_last_error = EGL_BAD_ACCESS;
        return 0;
    }
    /* Flush queued GL ops first so host-side texture uploads and cmdbuf
     * draws execute in program order. */
    if (_wpk_gl_flush_checked() != 0)
        return 0;
    uint32_t local_handle = transfer_bo_handle(generation->fd, context->session->fd, bo_handle);
    if (!local_handle)
        return 0;
    struct wpk_drm_bind_foreign_texture req = {
        .bo_handle = local_handle,
        .gl_target = gl_target,
        .ctx_id = context->backend_id,
        .gl_texture_id = 0,
    };
    unsigned result = 0;
    for (;;) {
        req.gl_texture_id = 0;
        if (ioctl(context->session->fd, WPK_DRM_IOCTL_BIND_FOREIGN_TEXTURE, &req) != 0 ||
            !req.gl_texture_id)
            break;
        if (!publish) {
            result = req.gl_texture_id;
            break;
        }
        uint32_t error = _wpk_gl_register_external_texture(context->encoder, req.gl_texture_id);
        if (!error) {
            result = req.gl_texture_id;
            break;
        }
        // Only the unpublished native candidate is removed. A reserved C
        // name remains available for its caller's later ordinary first bind.
        if (!_wpk_gl_discard_external_candidate(req.gl_texture_id)) {
            g_last_error = error == 0x505 ? EGL_BAD_ALLOC : EGL_BAD_ACCESS;
            break;
        }
        if (error != WPK_GL_EXTERNAL_NAME_COLLISION) {
            g_last_error = error == 0x505 ? EGL_BAD_ALLOC : EGL_BAD_MATCH;
            break;
        }
    }
    release_transferred_bo(generation, generation->fd, context->session->fd, local_handle);
    return result;
}

unsigned wpkEglBindBoTexture(EGLDisplay dpy, unsigned bo_handle, unsigned gl_target) {
    if (gl_target != GL_TEXTURE_2D) {
        g_last_error = EGL_BAD_PARAMETER;
        return 0;
    }
    return bind_bo_texture(dpy, bo_handle, gl_target, 1);
}

/* Target the NEXT eglCreateWindowSurface at a GPU-tier bo's FBO: a
 * producer renders its frame into `bo_handle` (allocated via
 * gbm_bo_create with GPU usage, or imported via PRIME_FD_TO_HANDLE)
 * instead of a display canvas, and the compositor samples it zero-copy
 * with wpkEglBindBoTexture. Call immediately before eglCreateWindowSurface;
 * the target is consumed once. Passing 0 (or not calling this) yields an
 * ordinary window surface. No-op if the display isn't initialized. */
void wpkEglSetWindowSurfaceTarget(EGLDisplay dpy, unsigned bo_handle) {
    if (dpy != EGL_DPY_HANDLE) return;
    pthread_mutex_lock(&g_context_mutex);
    if (g_active_generation) g_active_generation->pending_surface_target_bo = bo_handle;
    pthread_mutex_unlock(&g_context_mutex);
}

/* Release a handle from wpkEglImportDmabufHandle. */
static void close_bo_handle(struct egl_generation *generation, unsigned bo_handle) {
    if (!generation || generation->fd < 0) return;
    struct imported_bo_reference **owner = &generation->imported_bos;
    while (*owner && (*owner)->handle != bo_handle) owner = &(*owner)->next;
    if (!*owner) return;
    if (--(*owner)->references) return;
    struct imported_bo_reference *retired = *owner;
    *owner = retired->next;
    free(retired);
    struct wpk_drm_gem_close req = { .handle = bo_handle, .pad = 0 };
    ioctl(generation->fd, WPK_DRM_IOCTL_GEM_CLOSE, &req);
}

void wpkEglCloseBoHandle(EGLDisplay dpy, unsigned bo_handle) {
    if (dpy != EGL_DPY_HANDLE) return;
    pthread_mutex_lock(&g_context_mutex);
    pthread_mutex_lock(&g_image_mutex);
    close_bo_handle(g_active_generation, bo_handle);
    pthread_mutex_unlock(&g_image_mutex);
    pthread_mutex_unlock(&g_context_mutex);
}

/* ----- EGL_EXT_image_dma_buf_import ------------------------------- */

/* The dma-buf formats a bo can carry: the 32-bpp fourccs the kernel's
 * buffer allocators accept, each a single linear plane. Spelled out
 * because libEGL must not depend on libdrm headers. */
#define WPK_FOURCC_ARGB8888 0x34325241u /* 'AR24' */
#define WPK_FOURCC_XRGB8888 0x34325258u /* 'XR24' */
#define WPK_FOURCC_ABGR8888 0x34324241u /* 'AB24' */
#define WPK_FOURCC_XBGR8888 0x34324258u /* 'XB24' */
#define WPK_MOD_LINEAR      0x0000000000000000ull
#define WPK_MOD_INVALID     0x00ffffffffffffffull

static const EGLint k_dmabuf_formats[] = {
    (EGLint)WPK_FOURCC_ARGB8888, (EGLint)WPK_FOURCC_XRGB8888,
    (EGLint)WPK_FOURCC_ABGR8888, (EGLint)WPK_FOURCC_XBGR8888,
};
#define WPK_DMABUF_FORMAT_COUNT \
    ((EGLint)(sizeof k_dmabuf_formats / sizeof k_dmabuf_formats[0]))

static int dmabuf_format_supported(EGLint fourcc) {
    for (EGLint i = 0; i < WPK_DMABUF_FORMAT_COUNT; i++) {
        if (k_dmabuf_formats[i] == fourcc) return 1;
    }
    return 0;
}

/* Import plane 0 of a dma-buf. The import holds its own GEM reference, so
 * the caller may close the fd afterwards. Whether the bo has a CPU mapping
 * decides how GL reads it: a GPU-tier bo's PRIME fd refuses mmap with
 * EINVAL, and its pixels live only in the host texture the bo owns; a
 * CPU-tier bo stays mapped for the image's lifetime, so a texture bound to
 * it can be refreshed from memory. */
static EGLImageKHR create_image_locked(EGLDisplay, EGLContext, EGLenum,
                                        EGLClientBuffer, const EGLint *);
EGLImageKHR eglCreateImageKHR(EGLDisplay dpy, EGLContext ctx, EGLenum target,
                              EGLClientBuffer buffer, const EGLint *attrib_list) {
    pthread_mutex_lock(&g_context_mutex);
    EGLImageKHR result = create_image_locked(dpy, ctx, target, buffer, attrib_list);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
static EGLImageKHR create_image_locked(EGLDisplay dpy, EGLContext ctx, EGLenum target,
                                      EGLClientBuffer buffer, const EGLint *attrib_list) {
    struct egl_generation *generation = g_active_generation;
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_NO_IMAGE_KHR;
    }
    if (!generation || !generation->initialized) {
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_NO_IMAGE_KHR;
    }
    if (!g_next_object_handle) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_IMAGE_KHR;
    }
    if (target != EGL_LINUX_DMA_BUF_EXT || ctx != EGL_NO_CONTEXT
        || buffer != NULL) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_NO_IMAGE_KHR;
    }
    EGLint width = -1, height = -1, fourcc = 0, fd = -1, offset = 0, pitch = -1;
    int has_lo = 0, has_hi = 0;
    uint32_t mod_lo = 0, mod_hi = 0;
    for (const EGLint *a = attrib_list; a && a[0] != EGL_NONE; a += 2) {
        switch (a[0]) {
            case EGL_WIDTH:                       width = a[1]; break;
            case EGL_HEIGHT:                      height = a[1]; break;
            case EGL_LINUX_DRM_FOURCC_EXT:        fourcc = a[1]; break;
            case EGL_DMA_BUF_PLANE0_FD_EXT:       fd = a[1]; break;
            case EGL_DMA_BUF_PLANE0_OFFSET_EXT:   offset = a[1]; break;
            case EGL_DMA_BUF_PLANE0_PITCH_EXT:    pitch = a[1]; break;
            case EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT:
                has_lo = 1; mod_lo = (uint32_t)a[1]; break;
            case EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT:
                has_hi = 1; mod_hi = (uint32_t)a[1]; break;
            /* Every image is preserved: binding never discards pixels. */
            case EGL_IMAGE_PRESERVED_KHR:         break;
            /* Every supported format has one plane. */
            case EGL_DMA_BUF_PLANE1_FD_EXT:
            case EGL_DMA_BUF_PLANE1_OFFSET_EXT:
            case EGL_DMA_BUF_PLANE1_PITCH_EXT:
            case EGL_DMA_BUF_PLANE1_MODIFIER_LO_EXT:
            case EGL_DMA_BUF_PLANE1_MODIFIER_HI_EXT:
            case EGL_DMA_BUF_PLANE2_FD_EXT:
            case EGL_DMA_BUF_PLANE2_OFFSET_EXT:
            case EGL_DMA_BUF_PLANE2_PITCH_EXT:
            case EGL_DMA_BUF_PLANE2_MODIFIER_LO_EXT:
            case EGL_DMA_BUF_PLANE2_MODIFIER_HI_EXT:
            case EGL_DMA_BUF_PLANE3_FD_EXT:
            case EGL_DMA_BUF_PLANE3_OFFSET_EXT:
            case EGL_DMA_BUF_PLANE3_PITCH_EXT:
            case EGL_DMA_BUF_PLANE3_MODIFIER_LO_EXT:
            case EGL_DMA_BUF_PLANE3_MODIFIER_HI_EXT:
                g_last_error = EGL_BAD_ATTRIBUTE;
                return EGL_NO_IMAGE_KHR;
            default:
                g_last_error = EGL_BAD_PARAMETER;
                return EGL_NO_IMAGE_KHR;
        }
    }
    if (width < 0 || height < 0 || fourcc == 0 || fd < 0 || pitch < 0
        || has_lo != has_hi) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_NO_IMAGE_KHR;
    }
    uint64_t modifier = has_lo ? ((uint64_t)mod_hi << 32) | mod_lo
                               : WPK_MOD_INVALID;
    if (!dmabuf_format_supported(fourcc)
        || (modifier != WPK_MOD_LINEAR && modifier != WPK_MOD_INVALID)) {
        g_last_error = EGL_BAD_MATCH;
        return EGL_NO_IMAGE_KHR;
    }
    if (width == 0 || height == 0 || offset < 0
        || (uint64_t)pitch < (uint64_t)width * 4u) {
        g_last_error = EGL_BAD_ACCESS;
        return EGL_NO_IMAGE_KHR;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
        g_last_error = EGL_BAD_ACCESS;
        return EGL_NO_IMAGE_KHR;
    }
    uint64_t last = (uint64_t)offset + (uint64_t)pitch * (uint64_t)(height - 1)
                  + (uint64_t)width * 4u;
    if (last > (uint64_t)st.st_size) {
        g_last_error = EGL_BAD_ACCESS;
        return EGL_NO_IMAGE_KHR;
    }

    struct wpk_egl_image *image = calloc(1, sizeof *image);
    if (!image) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_IMAGE_KHR;
    }
    image->generation = generation;
    image->public_handle = g_next_object_handle;
    image->handle = import_dmabuf_handle(generation, fd);
    if (image->handle == 0) {
        free(image);
        g_last_error = EGL_BAD_ACCESS;
        return EGL_NO_IMAGE_KHR;
    }
    image->width = (uint32_t)width;
    image->height = (uint32_t)height;
    image->fourcc = (uint32_t)fourcc;
    image->pitch = (uint32_t)pitch;

    void *map = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_SHARED, fd, 0);
    if (map == MAP_FAILED) {
        /* A GPU-tier bo has no CPU mapping (EINVAL). Its texture is the
         * whole bo, so it cannot honor a plane offset. */
        EGLint error = errno != EINVAL ? EGL_BAD_ALLOC
                     : offset != 0     ? EGL_BAD_ACCESS
                                       : EGL_SUCCESS;
        if (error == EGL_SUCCESS) {
            image->references = 1;
            image->public_live = 1;
            pthread_mutex_lock(&g_image_mutex);
            image->next = g_images;
            g_images = image;
            pthread_mutex_unlock(&g_image_mutex);
            g_next_object_handle++;
            return (EGLImageKHR)image->public_handle;
        }
        pthread_mutex_lock(&g_image_mutex);
        close_bo_handle(generation, image->handle);
        pthread_mutex_unlock(&g_image_mutex);
        free(image);
        g_last_error = error;
        return EGL_NO_IMAGE_KHR;
    }
    image->map = map;
    image->map_len = (size_t)st.st_size;
    image->pixels = (const uint8_t *)map + offset;
    image->references = 1;
    image->public_live = 1;
    pthread_mutex_lock(&g_image_mutex);
    image->next = g_images;
    g_images = image;
    pthread_mutex_unlock(&g_image_mutex);
    g_next_object_handle++;
    return (EGLImageKHR)image->public_handle;
}

/* Returns a retained reference so termination cannot retire the image
 * between public-handle validation and installation into a GL sibling. */
struct wpk_egl_image *_wpk_egl_image_lookup(const void *image) {
    struct wpk_egl_image *found = NULL;
    pthread_mutex_lock(&g_image_mutex);
    for (struct wpk_egl_image *candidate = g_images; candidate; candidate = candidate->next) {
        if (candidate->public_handle == (uintptr_t)image && candidate->public_live
            && candidate->generation == g_thread_binding.generation) {
            candidate->references++;
            found = candidate;
            break;
        }
    }
    pthread_mutex_unlock(&g_image_mutex);
    return found;
}

void _wpk_egl_image_retain(struct wpk_egl_image *image) {
    pthread_mutex_lock(&g_image_mutex);
    image->references++;
    pthread_mutex_unlock(&g_image_mutex);
}

static void image_release_locked(struct wpk_egl_image *image) {
    if (--image->references) return;
    struct wpk_egl_image **slot = &g_images;
    while (*slot && *slot != image) slot = &(*slot)->next;
    if (*slot) *slot = image->next;
    if (image->map) munmap(image->map, image->map_len);
    close_bo_handle(image->generation, image->handle);
    free(image);
}
void _wpk_egl_image_release(struct wpk_egl_image *image) {
    pthread_mutex_lock(&g_image_mutex);
    image_release_locked(image);
    pthread_mutex_unlock(&g_image_mutex);
}

EGLBoolean eglDestroyImageKHR(EGLDisplay dpy, EGLImageKHR image) {
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_FALSE; }
    pthread_mutex_lock(&g_context_mutex);
    if (!g_active_generation) {
        g_last_error = EGL_NOT_INITIALIZED;
        pthread_mutex_unlock(&g_context_mutex);
        return EGL_FALSE;
    }
    pthread_mutex_lock(&g_image_mutex);
    struct wpk_egl_image *img = g_images;
    while (img && (img->public_handle != (uintptr_t)image || !img->public_live
                  || img->generation != g_active_generation)) img = img->next;
    EGLBoolean result = EGL_FALSE;
    if (!img) g_last_error = EGL_BAD_PARAMETER;
    else {
        img->public_live = 0;
        image_release_locked(img);
        result = EGL_TRUE;
    }
    pthread_mutex_unlock(&g_image_mutex);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}

static void invalidate_generation_images(struct egl_generation *generation) {
    pthread_mutex_lock(&g_image_mutex);
    struct wpk_egl_image *image = g_images;
    while (image) {
        struct wpk_egl_image *next = image->next;
        if (image->generation == generation && image->public_live) {
            image->public_live = 0;
            image_release_locked(image);
        }
        image = next;
    }
    pthread_mutex_unlock(&g_image_mutex);
}

static void retire_imported_images(struct egl_generation *generation) {
    /* Public references ended at termination; encoder destruction released
     * sibling references. Final fd close ends any remaining raw imports. */
    pthread_mutex_lock(&g_image_mutex);
    while (generation->imported_bos) {
        struct imported_bo_reference *owner = generation->imported_bos;
        generation->imported_bos = owner->next;
        free(owner);
    }
    pthread_mutex_unlock(&g_image_mutex);
}

uint32_t _wpk_egl_image_texture(const struct wpk_egl_image *image) {
    if (!image || image->pixels || image->generation != g_thread_binding.generation) return 0;
    return bind_bo_texture(EGL_DPY_HANDLE, image->handle, WPK_GL_IMAGE_SOURCE_TARGET, 0);
}

EGLBoolean eglQueryDmaBufFormatsEXT(EGLDisplay dpy, EGLint max_formats,
                                    EGLint *formats, EGLint *num_formats) {
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_FALSE;
    }
    if (max_formats < 0 || !num_formats || (max_formats > 0 && !formats)) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_FALSE;
    }
    if (max_formats == 0) {
        *num_formats = WPK_DMABUF_FORMAT_COUNT;
        return EGL_TRUE;
    }
    EGLint n = max_formats < WPK_DMABUF_FORMAT_COUNT ? max_formats
                                                     : WPK_DMABUF_FORMAT_COUNT;
    for (EGLint i = 0; i < n; i++) formats[i] = k_dmabuf_formats[i];
    *num_formats = n;
    return EGL_TRUE;
}

/* Every format has exactly one layout, LINEAR, and it can be rendered to,
 * so no modifier is external-only. */
EGLBoolean eglQueryDmaBufModifiersEXT(EGLDisplay dpy, EGLint format,
                                      EGLint max_modifiers,
                                      EGLuint64KHR *modifiers,
                                      EGLBoolean *external_only,
                                      EGLint *num_modifiers) {
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_FALSE;
    }
    if (!dmabuf_format_supported(format) || max_modifiers < 0
        || !num_modifiers || (max_modifiers > 0 && !modifiers)) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_FALSE;
    }
    *num_modifiers = 1;
    if (max_modifiers == 0) return EGL_TRUE;
    modifiers[0] = WPK_MOD_LINEAR;
    if (external_only) external_only[0] = EGL_FALSE;
    return EGL_TRUE;
}
