/*
 * libEGL stub for wasm-posix-kernel.
 *
 * Drives session setup against /dev/dri/renderD128: GLIO_INIT (with
 * OP_VERSION and display-generation handshake), GLIO_CREATE_CONTEXT,
 * GLIO_CREATE_SURFACE, GLIO_MAKE_CURRENT. Mmap of the cmdbuf makes the libGLESv2
 * encoder work — flushing without a base/cursor is a no-op.
 *
 * A display root authorizes a separate object session; errors, API selection
 * and current bindings belong to threads. This facade still admits one
 * context and surface per generation. Overlapping generations retain their
 * own current resources; multi-context/share-group routing is tracked in the compatibility ledger.
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
struct egl_generation {
    int fd, display_fd;
    uint32_t id;
    uint8_t *cmdbuf_base;
    int initialized, context_made, surface_made;
    struct egl_thread_binding *context_owner;
    int surface_current, context_delete_pending, surface_delete_pending;
    int terminate_pending;
    EGLContext context_handle;
    uint32_t backend_context_id, backend_surface_id;
    uint32_t surface_width, surface_height;
    struct wpk_gles_context *encoder_state;
    EGLSurface surface_handle;
    EGLint client_version;
    uint32_t pending_surface_target_bo;
    void *current_egl_window;
    struct imported_bo_reference *imported_bos;
    struct egl_generation *next;
};
static struct egl_generation *g_active_generation, *g_generations;
/* Client thread records retain handles for queries and deferred destruction.
 * The kernel owns current-thread authority, including thread-exit cleanup.
 * Every bind reaches it, including surfaceless binding and release. */
struct egl_thread_binding {
    int current, surfaceless;
    EGLContext context;
    EGLSurface surface;
    struct wpk_gles_context *encoder;
    struct egl_generation *generation;
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
static uintptr_t g_next_context_handle = 1, g_next_surface_handle = 1;
static uintptr_t g_next_image_handle = 1;
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
__attribute__((weak)) void     _wpk_wlegl_present(void *egl_window);
/* A GBM native window carries its drawable size before the first modeset.
 * Weak: EGL clients using another window backend need not link libgbm. */
__attribute__((weak)) int _wpk_gbm_surface_dimensions(const void *window,
                                                     uint32_t *width, uint32_t *height);

#define EGL_DPY_HANDLE      ((EGLDisplay)(uintptr_t)1)
#define EGL_CONFIG_HANDLE   ((EGLConfig) (uintptr_t)1)
#define EGL_CONTEXT_HANDLE  generation->context_handle
#define EGL_SURFACE_HANDLE  generation->surface_handle

int _wpk_gl_fd(void) {
    struct egl_generation *generation = g_thread_binding.generation;
    return generation ? generation->fd : -1;
}
uint8_t *_wpk_gl_cmdbuf_base(void) {
    struct egl_generation *generation = g_thread_binding.generation;
    return generation ? generation->cmdbuf_base : NULL;
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
    generation->cmdbuf_base = (uint8_t *)p;

    generation->fd = fd;
    generation->display_fd = display_fd;
    generation->id = root.display_id;
    generation->initialized = 1;
    generation->client_version = 2;
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
 * RGBA8/depth24/stencil8, non-multisampled window buffers. Pbuffers, native
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
    { EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_WINDOW_BIT, CFG_SURFACE_MASK },
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

EGLBoolean eglGetConfigAttrib(EGLDisplay dpy, EGLConfig config,
                              EGLint attribute, EGLint *value) {
    if (!config_display_ready(dpy)) return EGL_FALSE;
    if (config != EGL_CONFIG_HANDLE) { g_last_error = EGL_BAD_CONFIG; return EGL_FALSE; }
    if (!value) { g_last_error = EGL_BAD_PARAMETER; return EGL_FALSE; }
    const int i = config_attribute_index(attribute);
    if (i < 0 || attribute == EGL_MATCH_NATIVE_PIXMAP) { g_last_error = EGL_BAD_ATTRIBUTE; return EGL_FALSE; }
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

static EGLContext create_context_locked(EGLDisplay, EGLConfig, EGLContext, const EGLint *);
EGLContext eglCreateContext(EGLDisplay dpy, EGLConfig config,
                            EGLContext share_context, const EGLint *attrib_list) {
    pthread_mutex_lock(&g_context_mutex);
    EGLContext result = create_context_locked(dpy, config, share_context, attrib_list);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
static EGLContext create_context_locked(EGLDisplay dpy, EGLConfig config,
                            EGLContext share_context,
                            const EGLint *attrib_list) {
    struct egl_generation *generation = g_active_generation;
    (void)config; (void)share_context;
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_NO_CONTEXT; }
    if (!generation || !generation->initialized || generation->fd < 0) {
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_NO_CONTEXT;
    }
    if (g_next_context_handle == 0) { g_last_error = EGL_BAD_ALLOC; return EGL_NO_CONTEXT; }

    struct gl_context_attrs attrs = { .client_version = 2, .reserved = {0,0}, .context_id = 0 };
    /* EGL_KHR_no_config_context: `config` may be EGL_NO_CONFIG_KHR. There
     * is one config, and a context draws to any surface, so the config
     * selects nothing either way. */
    if (attrib_list) {
        for (const EGLint *a = attrib_list; a[0] != EGL_NONE; a += 2) {
            if (a[0] == EGL_CONTEXT_CLIENT_VERSION) attrs.client_version = (uint32_t)a[1];
        }
    }

    struct wpk_gles_context *encoder = _wpk_gl_create_encoder();
    if (!encoder) { g_last_error = EGL_BAD_ALLOC; return EGL_NO_CONTEXT; }
    if (ioctl(generation->fd, GLIO_CREATE_CONTEXT, &attrs) != 0) {
        _wpk_gl_destroy_encoder(encoder);
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_CONTEXT;
    }
    generation->encoder_state = encoder;
    generation->backend_context_id = attrs.context_id;
    generation->context_made = 1;
    generation->context_handle = (EGLContext)g_next_context_handle++;
    generation->context_delete_pending = 0;
    generation->client_version = (EGLint)attrs.client_version;
    return EGL_CONTEXT_HANDLE;
}

static EGLSurface create_window_surface_locked(EGLDisplay, EGLConfig, EGLNativeWindowType, const EGLint *);
EGLSurface eglCreateWindowSurface(EGLDisplay dpy, EGLConfig config,
                                  EGLNativeWindowType win, const EGLint *attrib_list) {
    pthread_mutex_lock(&g_context_mutex);
    EGLSurface result = create_window_surface_locked(dpy, config, win, attrib_list);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
static EGLSurface create_window_surface_locked(EGLDisplay dpy, EGLConfig config,
                                  EGLNativeWindowType win,
                                  const EGLint *attrib_list) {
    struct egl_generation *generation = g_active_generation;
    (void)config;
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_NO_SURFACE; }
    if (!generation || !generation->initialized || generation->fd < 0) {
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_NO_SURFACE;
    }
    if (g_next_surface_handle == 0) { g_last_error = EGL_BAD_ALLOC; return EGL_NO_SURFACE; }

    struct gl_surface_create request = { .attrs = {
        .kind = WPK_SURFACE_DEFAULT,
        .width = 0, .height = 0, .config_id = 1,
        .reserved = {0,0,0,0},
    }, .surface_id = 0 };
    struct gl_surface_attrs *surf = &request.attrs;
    int is_gbm = win && _wpk_gbm_surface_dimensions
        && _wpk_gbm_surface_dimensions((void *)win, &surf->width, &surf->height);
    /* Preserve explicit dimensions for existing canvas callers without a
     * native window. A real GBM window needs no application sizing hint. */
    if (attrib_list) {
        for (const EGLint *a = attrib_list; a[0] != EGL_NONE; a += 2) {
            if (a[0] == EGL_WIDTH)  surf->width  = (uint32_t)a[1];
            if (a[0] == EGL_HEIGHT) surf->height = (uint32_t)a[1];
        }
    }
    /* GPU-tier producer targeting: reserved[0] carries the target bo
     * handle. The kernel translates it to a global bo_id and the host
     * redirects this surface's default-framebuffer renders into that
     * bo's FBO (see GLIO_CREATE_SURFACE). Consumed once. 0 leaves the
     * ordinary canvas/scanout behavior untouched.
     *
     * An explicit wpkEglSetWindowSurfaceTarget wins; otherwise, when the
     * native window is a libwayland-egl wl_egl_window (SDL2's Wayland GL
     * backend), take the bo it allocated. Remember that window so
     * eglSwapBuffers can attach+commit it. */
    uint32_t target = generation->pending_surface_target_bo;
    if (!target && !is_gbm && win && _wpk_wlegl_bo_handle)
        target = _wpk_wlegl_bo_handle((void *)win);
    surf->reserved[0] = target;
    if (ioctl(generation->fd, GLIO_CREATE_SURFACE, &request) != 0) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_SURFACE;
    }
    if (!request.surface_id || surf->width > INT32_MAX || surf->height > INT32_MAX) {
        ioctl(generation->fd, GLIO_DESTROY_SURFACE, NULL);
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_SURFACE;
    }
    generation->backend_surface_id = request.surface_id;
    generation->surface_width = surf->width; generation->surface_height = surf->height;
    generation->surface_made = 1;
    generation->surface_handle = (EGLSurface)g_next_surface_handle++;
    generation->surface_delete_pending = 0;
    generation->pending_surface_target_bo = 0;
    generation->current_egl_window = is_gbm ? NULL : (void *)win;
    return EGL_SURFACE_HANDLE;
}

/* Native window resize replaces its backing buffer, not the EGL surface.
 * Publish a replacement only after the backend accepts it. The caller keeps
 * the old buffer alive until its successor is committed, or rolls back. */
int _wpk_egl_window_retarget(void *egl_window) {
    pthread_mutex_lock(&g_context_mutex);
    struct egl_generation *generation;
    int accepted = 1;
    for (generation = g_generations; generation; generation = generation->next)
        if (generation->current_egl_window == egl_window && generation->surface_made) break;
    if (!generation) goto done;
    if (!egl_window || egl_window != generation->current_egl_window || !generation->surface_made
        || generation->fd < 0 || !_wpk_wlegl_bo_handle)
        goto done;
    uint32_t target = _wpk_wlegl_bo_handle(egl_window);
    if (!target) { accepted = 0; goto done; }
    _wpk_gl_flush();
    struct gl_surface_attrs surf = {
        .kind = WPK_SURFACE_DEFAULT,
        .width = 0, .height = 0, .config_id = 1,
        .reserved = {target, 0, 0, 0},
    };
    accepted = ioctl(generation->fd, GLIO_UPDATE_SURFACE, &surf) == 0;
done:
    pthread_mutex_unlock(&g_context_mutex);
    return accepted;
}

static EGLint current_binding_error(void) {
    switch (errno) {
    case ENOMEM: return EGL_BAD_ALLOC;
    case EIO: case ENODEV: case EBADF: return EGL_CONTEXT_LOST;
    default: return EGL_BAD_ACCESS;
    }
}

static EGLBoolean release_current_locked(void) {
    struct egl_generation *generation = g_thread_binding.generation;
    if (generation && generation->context_owner == &g_thread_binding) {
        _wpk_gl_flush();
        const struct gl_make_current release = {0, 0, 0};
        if (ioctl(generation->fd, GLIO_MAKE_CURRENT, &release) != 0) {
            g_last_error = current_binding_error();
            return EGL_FALSE;
        }
        generation->context_owner = NULL;
        generation->surface_current = 0;
    }
    g_thread_binding = (struct egl_thread_binding){0};
    if (generation) retire_pending_resources_locked(generation);
    return EGL_TRUE;
}

EGLBoolean eglMakeCurrent(EGLDisplay dpy, EGLSurface draw,
                          EGLSurface read, EGLContext ctx) {
    EGLBoolean result = EGL_FALSE;
    pthread_mutex_lock(&g_context_mutex);
    struct egl_generation *generation = g_active_generation;
    if (ctx == EGL_NO_CONTEXT) {
        if (dpy != EGL_NO_DISPLAY && dpy != EGL_DPY_HANDLE) {
            g_last_error = EGL_BAD_DISPLAY;
        } else if (draw != EGL_NO_SURFACE || read != EGL_NO_SURFACE) {
            g_last_error = EGL_BAD_MATCH;
        } else {
            result = release_current_locked();
        }
        goto done;
    }
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; goto done; }
    if (!generation || !generation->initialized) { g_last_error = EGL_NOT_INITIALIZED; goto done; }
    if (!generation->context_made || ctx != EGL_CONTEXT_HANDLE) { g_last_error = EGL_BAD_CONTEXT; goto done; }
    if ((draw == EGL_NO_SURFACE) != (read == EGL_NO_SURFACE)) {
        g_last_error = EGL_BAD_MATCH;
        goto done;
    }
    const int surfaceless = draw == EGL_NO_SURFACE;
    if (!surfaceless && (!generation->surface_made || draw != EGL_SURFACE_HANDLE || read != EGL_SURFACE_HANDLE)) {
        g_last_error = EGL_BAD_SURFACE;
        goto done;
    }
    /* The kernel knows whether a former owner has exited, including a
     * thread that never ran its TLS destructor. A retained client pointer
     * must not overrule that authoritative lifetime check. */
    if (!register_binding_thread()) { g_last_error = EGL_BAD_ALLOC; goto done; }
    if (g_current) _wpk_gl_flush();
    const struct gl_make_current binding = {
        generation->backend_context_id, surfaceless ? 0 : generation->backend_surface_id,
        surfaceless ? 0 : generation->backend_surface_id,
    };
    if (ioctl(generation->fd, GLIO_MAKE_CURRENT, &binding) != 0) {
        g_last_error = current_binding_error();
        goto done;
    }
    struct egl_generation *previous = g_thread_binding.generation;
    if (previous && previous != generation) {
        previous->context_owner = NULL;
        previous->surface_current = 0;
    }
    generation->context_owner = &g_thread_binding;
    g_thread_binding = (struct egl_thread_binding){ 1, surfaceless, ctx, draw, generation->encoder_state, generation };
    if (previous && previous != generation) retire_pending_resources_locked(previous);
    generation->surface_current = !surfaceless;
    retire_pending_resources_locked(generation);
    result = EGL_TRUE;
done:
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}

EGLContext eglGetCurrentContext(void) {
    return g_current ? g_thread_binding.context : EGL_NO_CONTEXT;
}

EGLDisplay eglGetCurrentDisplay(void) {
    return g_current ? EGL_DPY_HANDLE : EGL_NO_DISPLAY;
}

EGLSurface eglGetCurrentSurface(EGLint readdraw) {
    if (readdraw != EGL_READ && readdraw != EGL_DRAW) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_NO_SURFACE;
    }
    return g_current && !g_current_surfaceless ? g_thread_binding.surface
                                               : EGL_NO_SURFACE;
}

static EGLBoolean query_context_locked(EGLDisplay, EGLContext, EGLint, EGLint *);
EGLBoolean eglQueryContext(EGLDisplay dpy, EGLContext ctx, EGLint attribute, EGLint *value) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = query_context_locked(dpy, ctx, attribute, value);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
static EGLBoolean query_context_locked(EGLDisplay dpy, EGLContext ctx,
                                       EGLint attribute, EGLint *value) {
    struct egl_generation *generation = g_active_generation;
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_FALSE; }
    if (!generation) { g_last_error = EGL_NOT_INITIALIZED; return EGL_FALSE; }
    if (ctx != EGL_CONTEXT_HANDLE || !generation->context_made) {
        g_last_error = EGL_BAD_CONTEXT;
        return EGL_FALSE;
    }
    if (!value) { g_last_error = EGL_BAD_PARAMETER; return EGL_FALSE; }
    switch (attribute) {
        case EGL_CONFIG_ID:              *value = 1; break;
        case EGL_CONTEXT_CLIENT_TYPE:    *value = EGL_OPENGL_ES_API; break;
        case EGL_CONTEXT_CLIENT_VERSION: *value = generation->client_version; break;
        case EGL_RENDER_BUFFER:
            *value = generation->surface_current ? EGL_BACK_BUFFER
                                                         : EGL_NONE;
            break;
        default:
            g_last_error = EGL_BAD_ATTRIBUTE;
            return EGL_FALSE;
    }
    return EGL_TRUE;
}

static EGLBoolean swap_buffers_locked(EGLDisplay, EGLSurface);
EGLBoolean eglSwapBuffers(EGLDisplay dpy, EGLSurface surface) {
    pthread_mutex_lock(&g_context_mutex);
    EGLBoolean result = swap_buffers_locked(dpy, surface);
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}
static EGLBoolean swap_buffers_locked(EGLDisplay dpy, EGLSurface surface) {
    struct egl_generation *generation = g_active_generation;
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_FALSE; }
    if (!generation) { g_last_error = EGL_NOT_INITIALIZED; return EGL_FALSE; }
    if (surface != EGL_SURFACE_HANDLE || !generation->surface_made) {
        g_last_error = EGL_BAD_SURFACE;
        return EGL_FALSE;
    }
    _wpk_gl_flush();
    if (ioctl(generation->fd, GLIO_PRESENT, NULL) != 0) {
        g_last_error = EGL_BAD_SURFACE;
        return EGL_FALSE;
    }
    /* For a libwayland-egl window the flush + GLIO_PRESENT above is the
     * buffer-ready fence; now attach+commit the dmabuf buffer to the
     * wl_surface. No-op (skipped) for canvas/scanout surfaces. */
    if (generation->current_egl_window && _wpk_wlegl_present)
        _wpk_wlegl_present(generation->current_egl_window);
    return EGL_TRUE;
}

EGLBoolean eglDestroySurface(EGLDisplay dpy, EGLSurface surface) {
    pthread_mutex_lock(&g_context_mutex);
    struct egl_generation *generation = g_active_generation;
    EGLBoolean result = EGL_FALSE;
    if (dpy != EGL_DPY_HANDLE) g_last_error = EGL_BAD_DISPLAY;
    else if (!generation) g_last_error = EGL_NOT_INITIALIZED;
    else if (!generation->surface_made || surface != EGL_SURFACE_HANDLE) g_last_error = EGL_BAD_SURFACE;
    else {
        generation->surface_delete_pending = 1;
        if (generation) retire_pending_resources_locked(generation);
        result = EGL_TRUE;
    }
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}

EGLBoolean eglDestroyContext(EGLDisplay dpy, EGLContext ctx) {
    pthread_mutex_lock(&g_context_mutex);
    struct egl_generation *generation = g_active_generation;
    EGLBoolean result = EGL_FALSE;
    if (dpy != EGL_DPY_HANDLE) g_last_error = EGL_BAD_DISPLAY;
    else if (!generation) g_last_error = EGL_NOT_INITIALIZED;
    else if (!generation->context_made || ctx != EGL_CONTEXT_HANDLE) g_last_error = EGL_BAD_CONTEXT;
    else {
        generation->context_delete_pending = 1;
        if (generation) retire_pending_resources_locked(generation);
        result = EGL_TRUE;
    }
    pthread_mutex_unlock(&g_context_mutex);
    return result;
}

static void retire_pending_resources_locked(struct egl_generation *generation) {
    if (generation->surface_delete_pending && !generation->surface_current) {
        ioctl(generation->fd, GLIO_DESTROY_SURFACE, NULL);
        generation->surface_made = generation->surface_delete_pending = 0;
        generation->surface_handle = EGL_NO_SURFACE;
        generation->backend_surface_id = generation->surface_width = generation->surface_height = 0;
        generation->current_egl_window = NULL;
    }
    if (generation->context_delete_pending && !generation->context_owner) {
        _wpk_gl_destroy_encoder(generation->encoder_state);
        generation->encoder_state = NULL;
        ioctl(generation->fd, GLIO_DESTROY_CONTEXT, NULL);
        generation->context_made = generation->context_delete_pending = 0;
        generation->context_handle = EGL_NO_CONTEXT;
        generation->backend_context_id = 0;
    }
    if (generation->terminate_pending && !generation->context_owner) {
        retire_imported_images(generation);
        ioctl(generation->fd, GLIO_TERMINATE, NULL);
        if (generation->cmdbuf_base) {
            munmap(generation->cmdbuf_base, WPK_GL_CMDBUF_LEN);
            generation->cmdbuf_base = NULL;
        }
        close(generation->fd);
        generation->fd = -1;
        if (generation->display_fd >= 0) close(generation->display_fd);
        generation->display_fd = -1; generation->id = 0;
        struct egl_generation **slot = &g_generations;
        while (*slot && *slot != generation) slot = &(*slot)->next;
        if (*slot) *slot = generation->next;
        free(generation);
    }
}

EGLBoolean eglTerminate(EGLDisplay dpy) {
    pthread_mutex_lock(&g_context_mutex);
    struct egl_generation *generation = g_active_generation;
    EGLBoolean result = EGL_FALSE;
    if (dpy != EGL_DPY_HANDLE) g_last_error = EGL_BAD_DISPLAY;
    else if (!generation) result = EGL_TRUE;
    else {
        if (generation->initialized && generation->display_fd >= 0 && ioctl(generation->display_fd,GLIO_TERMINATE,NULL) != 0) {
            g_last_error = EGL_BAD_ACCESS;
            pthread_mutex_unlock(&g_context_mutex); return EGL_FALSE;
        }
        generation->initialized = 0;
        g_active_generation = NULL;
        invalidate_generation_images(generation);
        if (generation->fd >= 0) {
            generation->terminate_pending = 1;
            generation->context_delete_pending = generation->context_made;
            generation->surface_delete_pending = generation->surface_made;
            if (generation) retire_pending_resources_locked(generation);
        }
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
 * several 1.0-1.4 queries (eglQuerySurface,
 * eglSurfaceAttrib, eglBindTexImage,
 * eglReleaseTexImage, eglCopyBuffers, eglCreatePixmapSurface,
 * eglCreatePbufferFromClientBuffer) are all absent. That gap is
 * deliberately left visible rather than papered over with a plausible
 * return value — `wasm_require_approved_reserved_env_imports` in
 * scripts/wasm-artifact-guards.sh refuses any artifact that references
 * one, so a new consumer fails its build here instead of trapping on a
 * throwing host import at run time. Implement the entry point when a
 * consumer needs it. ABI 57 now records the granted surface size; the
 * complete public query and surface lifecycle APIs remain to implement. */
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

EGLSurface eglCreatePbufferSurface(EGLDisplay dpy, EGLConfig config,
                                   const EGLint *attrib_list) {
    (void) config; (void) attrib_list;
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_NO_SURFACE;
    }
    /* SDL2 only requests pbuffers under SDL_VIDEO_OFFSCREEN, which
     * we don't enable — return EGL_NO_SURFACE so any accidental
     * caller fails fast. */
    g_last_error = EGL_BAD_CONFIG;
    return EGL_NO_SURFACE;
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
unsigned wpkEglBindBoTexture(EGLDisplay dpy, unsigned bo_handle,
                             unsigned gl_target) {
    struct egl_generation *generation = g_thread_binding.generation;
    if (dpy != EGL_DPY_HANDLE || !generation || generation->fd < 0 || !generation->context_made) return 0;
    /* Flush queued GL ops first so host-side texture uploads and cmdbuf
     * draws execute in program order. */
    _wpk_gl_flush();
    struct wpk_drm_bind_foreign_texture req = {
        .bo_handle = bo_handle,
        .gl_target = gl_target,
        .ctx_id = generation->backend_context_id, /* kernel-issued identity on this EGL fd */
        .gl_texture_id = 0,
    };
    if (ioctl(generation->fd, WPK_DRM_IOCTL_BIND_FOREIGN_TEXTURE, &req) != 0) return 0;
    return req.gl_texture_id;
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
    if (!g_next_image_handle) { g_last_error = EGL_BAD_ALLOC; return EGL_NO_IMAGE_KHR; }
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
    image->public_handle = g_next_image_handle;
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
            g_next_image_handle++;
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
    g_next_image_handle++;
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
    return wpkEglBindBoTexture(EGL_DPY_HANDLE, image->handle, GL_TEXTURE_2D);
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
