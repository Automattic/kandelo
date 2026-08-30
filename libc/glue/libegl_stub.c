/*
 * libEGL stub for wasm-posix-kernel.
 *
 * Drives session setup against /dev/dri/renderD128: GLIO_INIT (with
 * OP_VERSION handshake), GLIO_CREATE_CONTEXT, GLIO_CREATE_SURFACE,
 * GLIO_MAKE_CURRENT. Mmap of the cmdbuf is what makes the libGLESv2
 * encoder work — flushing without a base/cursor is a no-op.
 *
 * State is process-global (single context, single surface in v1, per
 * the FB0_OWNER posture). Sharing it across libEGL.a and libGLESv2.a
 * is done through the three accessor functions in gl_abi.h, resolved
 * at link time when both archives are pulled in.
 */

#include <EGL/egl.h>
#include <fcntl.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include "gl_abi.h"

static int      g_fd            = -1;
static uint8_t *g_cmdbuf_base   = NULL;
static EGLint   g_last_error    = EGL_SUCCESS;
static int      g_initialized   = 0;
static int      g_context_made  = 0;
static int      g_surface_made  = 0;

#define EGL_DPY_HANDLE      ((EGLDisplay)(uintptr_t)1)
#define EGL_CONFIG_HANDLE   ((EGLConfig) (uintptr_t)1)
#define EGL_CONTEXT_HANDLE  ((EGLContext)(uintptr_t)1)
#define EGL_SURFACE_HANDLE  ((EGLSurface)(uintptr_t)1)

int      _wpk_gl_fd(void)           { return g_fd; }
uint8_t *_wpk_gl_cmdbuf_base(void)  { return g_cmdbuf_base; }

EGLDisplay eglGetDisplay(EGLNativeDisplayType display_id) {
    (void)display_id;
    return EGL_DPY_HANDLE;
}

EGLBoolean eglInitialize(EGLDisplay dpy, EGLint *major, EGLint *minor) {
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_FALSE;
    }
    if (g_initialized) {
        if (major) *major = 1;
        if (minor) *minor = 5;
        return EGL_TRUE;
    }

    int fd = open(WPK_GL_DEVICE, O_RDWR);
    if (fd < 0) {
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_FALSE;
    }

    uint32_t op_version = WPK_GL_OP_VERSION;
    if (ioctl(fd, GLIO_INIT, &op_version) != 0) {
        close(fd);
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_FALSE;
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
        close(fd);
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_FALSE;
    }
    g_cmdbuf_base = (uint8_t *)p;

    g_fd = fd;
    g_initialized = 1;
    if (major) *major = 1;
    if (minor) *minor = 5;
    return EGL_TRUE;
}

EGLBoolean eglChooseConfig(EGLDisplay dpy, const EGLint *attrib_list,
                           EGLConfig *configs, EGLint config_size,
                           EGLint *num_config) {
    (void)attrib_list;
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_FALSE; }
    if (configs && config_size > 0) configs[0] = EGL_CONFIG_HANDLE;
    if (num_config) *num_config = 1;
    return EGL_TRUE;
}

EGLBoolean eglGetConfigAttrib(EGLDisplay dpy, EGLConfig config,
                              EGLint attribute, EGLint *value) {
    (void)config;
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_FALSE; }
    if (!value) return EGL_FALSE;
    switch (attribute) {
        case EGL_CONFIG_ID:        *value = 1; break;
        case EGL_RED_SIZE:
        case EGL_GREEN_SIZE:
        case EGL_BLUE_SIZE:
        case EGL_ALPHA_SIZE:       *value = 8; break;
        case EGL_DEPTH_SIZE:       *value = 24; break;
        case EGL_STENCIL_SIZE:     *value = 8; break;
        case EGL_SURFACE_TYPE:     *value = EGL_WINDOW_BIT; break;
        case EGL_RENDERABLE_TYPE:  *value = EGL_OPENGL_ES2_BIT; break;
        default:                   *value = 0; break;
    }
    return EGL_TRUE;
}

EGLBoolean eglBindAPI(EGLenum api) {
    return api == EGL_OPENGL_ES_API ? EGL_TRUE : EGL_FALSE;
}

EGLContext eglCreateContext(EGLDisplay dpy, EGLConfig config,
                            EGLContext share_context,
                            const EGLint *attrib_list) {
    (void)config; (void)share_context;
    if (dpy != EGL_DPY_HANDLE || g_fd < 0) {
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_NO_CONTEXT;
    }

    struct gl_context_attrs attrs = { .client_version = 2, .reserved = {0,0,0} };
    if (attrib_list) {
        for (const EGLint *a = attrib_list; a[0] != EGL_NONE; a += 2) {
            if (a[0] == EGL_CONTEXT_CLIENT_VERSION) attrs.client_version = (uint32_t)a[1];
        }
    }

    if (ioctl(g_fd, GLIO_CREATE_CONTEXT, &attrs) != 0) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_CONTEXT;
    }
    g_context_made = 1;
    return EGL_CONTEXT_HANDLE;
}

EGLSurface eglCreateWindowSurface(EGLDisplay dpy, EGLConfig config,
                                  EGLNativeWindowType win,
                                  const EGLint *attrib_list) {
    (void)config; (void)win;
    if (dpy != EGL_DPY_HANDLE || g_fd < 0) {
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_NO_SURFACE;
    }

    struct gl_surface_attrs surf = {
        .kind = WPK_SURFACE_DEFAULT,
        .width = 0, .height = 0, .config_id = 1,
        .reserved = {0,0,0,0},
    };
    /* Native window handles are opaque here (there is no real winsys), so
     * an explicit EGL_WIDTH/EGL_HEIGHT attrib pair is the only way a
     * caller can size the drawing buffer. The host resizes the backing
     * canvas to a non-zero request — a KMS compositor passes its mode
     * dims since it creates the surface before its first ADDFB (the
     * point where the host could otherwise infer a size). */
    if (attrib_list) {
        for (const EGLint *a = attrib_list; a[0] != EGL_NONE; a += 2) {
            if (a[0] == EGL_WIDTH)  surf.width  = (uint32_t)a[1];
            if (a[0] == EGL_HEIGHT) surf.height = (uint32_t)a[1];
        }
    }
    if (ioctl(g_fd, GLIO_CREATE_SURFACE, &surf) != 0) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_SURFACE;
    }
    g_surface_made = 1;
    return EGL_SURFACE_HANDLE;
}

EGLBoolean eglMakeCurrent(EGLDisplay dpy, EGLSurface draw,
                          EGLSurface read, EGLContext ctx) {
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_FALSE; }
    if (draw != EGL_SURFACE_HANDLE || read != EGL_SURFACE_HANDLE
        || ctx != EGL_CONTEXT_HANDLE) {
        g_last_error = EGL_BAD_MATCH;
        return EGL_FALSE;
    }
    if (!g_context_made || !g_surface_made) {
        g_last_error = EGL_BAD_MATCH;
        return EGL_FALSE;
    }

    if (ioctl(g_fd, GLIO_MAKE_CURRENT, NULL) != 0) {
        g_last_error = EGL_BAD_ACCESS;
        return EGL_FALSE;
    }
    // The cmdbuf was mmap'd in eglInitialize so the host's gl_bind
    // fires before GLIO_CREATE_CONTEXT — see the rationale there.
    return EGL_TRUE;
}

EGLBoolean eglSwapBuffers(EGLDisplay dpy, EGLSurface surface) {
    if (dpy != EGL_DPY_HANDLE || surface != EGL_SURFACE_HANDLE) {
        g_last_error = EGL_BAD_SURFACE;
        return EGL_FALSE;
    }
    _wpk_gl_flush();
    if (ioctl(g_fd, GLIO_PRESENT, NULL) != 0) {
        g_last_error = EGL_BAD_SURFACE;
        return EGL_FALSE;
    }
    return EGL_TRUE;
}

EGLBoolean eglDestroySurface(EGLDisplay dpy, EGLSurface surface) {
    if (dpy != EGL_DPY_HANDLE || surface != EGL_SURFACE_HANDLE) return EGL_FALSE;
    ioctl(g_fd, GLIO_DESTROY_SURFACE, NULL);
    g_surface_made = 0;
    return EGL_TRUE;
}

EGLBoolean eglDestroyContext(EGLDisplay dpy, EGLContext ctx) {
    if (dpy != EGL_DPY_HANDLE || ctx != EGL_CONTEXT_HANDLE) return EGL_FALSE;
    ioctl(g_fd, GLIO_DESTROY_CONTEXT, NULL);
    g_context_made = 0;
    return EGL_TRUE;
}

EGLBoolean eglTerminate(EGLDisplay dpy) {
    if (dpy != EGL_DPY_HANDLE) return EGL_FALSE;
    if (g_fd >= 0) {
        ioctl(g_fd, GLIO_TERMINATE, NULL);
        if (g_cmdbuf_base) {
            munmap(g_cmdbuf_base, WPK_GL_CMDBUF_LEN);
            g_cmdbuf_base = NULL;
        }
        close(g_fd);
        g_fd = -1;
    }
    g_initialized = 0;
    g_context_made = 0;
    g_surface_made = 0;
    return EGL_TRUE;
}

EGLint eglGetError(void) {
    EGLint e = g_last_error;
    g_last_error = EGL_SUCCESS;
    return e;
}

const char *eglQueryString(EGLDisplay dpy, EGLint name) {
    if (dpy != EGL_DPY_HANDLE) return NULL;
    switch (name) {
        case EGL_VENDOR:      return "wasm-posix-kernel";
        case EGL_VERSION:     return "1.5 wpk";
        case EGL_CLIENT_APIS: return "OpenGL_ES";
        case EGL_EXTENSIONS:  return "";
        default:              return NULL;
    }
}

EGLBoolean eglWaitClient(void) {
    _wpk_gl_flush();
    return EGL_TRUE;
}

EGLBoolean eglReleaseThread(void) { return EGL_TRUE; }

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
    return EGL_OPENGL_ES_API;
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

/* Import `prime_fd`'s bo as a GEM handle on the EGL device fd. Returns
 * the handle, or 0 on failure. The caller owns the handle and releases
 * it with wpkEglCloseBoHandle. */
unsigned wpkEglImportDmabufHandle(EGLDisplay dpy, int prime_fd) {
    if (dpy != EGL_DPY_HANDLE || g_fd < 0 || prime_fd < 0) return 0;
    struct wpk_drm_prime_handle req = { .handle = 0, .flags = 0, .fd = prime_fd };
    if (ioctl(g_fd, WPK_DRM_IOCTL_PRIME_FD_TO_HANDLE, &req) != 0) return 0;
    return req.handle;
}

/* (Re)bind an imported bo as a GL_TEXTURE_2D texture in the current
 * context, uploading the bo's pixels host-side (no cmdbuf marshalling).
 * Re-call after the producer commits to refresh the texture — the
 * returned id is stable per bo. Returns 0 on failure (no GL backing on
 * this host, unknown handle) — callers degrade to their CPU path. */
unsigned wpkEglBindBoTexture(EGLDisplay dpy, unsigned bo_handle,
                             unsigned gl_target) {
    if (dpy != EGL_DPY_HANDLE || g_fd < 0 || !g_context_made) return 0;
    /* Flush queued GL ops first so host-side texture uploads and cmdbuf
     * draws execute in program order. */
    _wpk_gl_flush();
    struct wpk_drm_bind_foreign_texture req = {
        .bo_handle = bo_handle,
        .gl_target = gl_target,
        .ctx_id = 1,            /* single-context v1, matches GLIO_CREATE_CONTEXT */
        .gl_texture_id = 0,
    };
    if (ioctl(g_fd, WPK_DRM_IOCTL_BIND_FOREIGN_TEXTURE, &req) != 0) return 0;
    return req.gl_texture_id;
}

/* Release a handle from wpkEglImportDmabufHandle. */
void wpkEglCloseBoHandle(EGLDisplay dpy, unsigned bo_handle) {
    if (dpy != EGL_DPY_HANDLE || g_fd < 0) return;
    struct wpk_drm_gem_close req = { .handle = bo_handle, .pad = 0 };
    ioctl(g_fd, WPK_DRM_IOCTL_GEM_CLOSE, &req);
}

/* eglGetProcAddress: SDL2's LOAD_FUNC_EGLEXT routes extension lookups
 * through this entry point.  We don't expose any of the EGL-side
 * extensions (eglCreateSyncKHR, eglQueryDevicesEXT, …), so returning
 * NULL is the documented "extension not present" answer.  Returning
 * NULL is also fine for the GLES2 entry-point fallback path —
 * libGLESv2.a exports gl* directly, so the program's calls resolve at
 * link time; SDL2 itself never calls a gl* through this pointer. */
void (*eglGetProcAddress(const char *procname))(void) {
    (void) procname;
    return NULL;
}
