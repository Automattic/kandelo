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

#include "gl_abi.h"

void glDrawBuffer(GLenum buf);
void glDrawBuffers(GLsizei n, const GLenum *bufs);
void glReadBuffer(GLenum src);
void glEGLImageTargetTexture2DOES(GLenum target, void *image);
void glEGLImageTargetRenderbufferStorageOES(GLenum target, void *image);

static int      g_fd            = -1;
static uint8_t *g_cmdbuf_base   = NULL;
static EGLint   g_last_error    = EGL_SUCCESS;
static int      g_initialized   = 0;
static int      g_context_made  = 0;
static int      g_surface_made  = 0;
/* eglMakeCurrent state. The host has one GL context per process and keeps
 * no notion of "current", so binding and releasing are bookkeeping here;
 * a surfaceless bind (EGL_KHR_surfaceless_context) renders only into
 * framebuffer objects. */
static int      g_current       = 0;
static int      g_current_surfaceless = 0;
static EGLint   g_client_version = 2;
/* GPU-tier producer target: the bo handle (from PRIME_FD_TO_HANDLE /
 * gbm_bo) whose FBO the NEXT eglCreateWindowSurface renders into. Set by
 * wpkEglSetWindowSurfaceTarget, consumed once and cleared. 0 = an
 * ordinary canvas/scanout window surface (the default). */
static uint32_t g_pending_surface_target_bo = 0;
/* The native window (a struct wl_egl_window *) of the most recently created
 * window surface, remembered so eglSwapBuffers can drive its wl_surface
 * attach+commit. NULL for canvas/scanout surfaces (KMS compositor). */
static void    *g_current_egl_window = NULL;

/* libwayland-egl hooks (libc/glue/libwayland-egl.c). Weak so a program that
 * links libEGL WITHOUT libwayland-egl — a KMS/canvas GL client — still links;
 * the symbols resolve to NULL and the wayland-egl path is simply skipped. */
__attribute__((weak)) uint32_t _wpk_wlegl_bo_handle(void *egl_window);
__attribute__((weak)) void     _wpk_wlegl_present(void *egl_window);

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
        fprintf(stderr, "eglInitialize: open(%s) failed: errno=%d\n",
                WPK_GL_DEVICE, errno);
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_FALSE;
    }

    uint32_t op_version = WPK_GL_OP_VERSION;
    if (ioctl(fd, GLIO_INIT, &op_version) != 0) {
        fprintf(stderr,
                "eglInitialize: GLIO_INIT(op_version=%u) failed: errno=%d\n",
                (unsigned)WPK_GL_OP_VERSION, errno);
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
        fprintf(stderr,
                "eglInitialize: cmdbuf mmap(len=%u) failed: errno=%d\n",
                (unsigned)WPK_GL_CMDBUF_LEN, errno);
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
    /* EGL_KHR_no_config_context: `config` may be EGL_NO_CONFIG_KHR. There
     * is one config, and a context draws to any surface, so the config
     * selects nothing either way. */
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
    g_client_version = (EGLint)attrs.client_version;
    return EGL_CONTEXT_HANDLE;
}

EGLSurface eglCreateWindowSurface(EGLDisplay dpy, EGLConfig config,
                                  EGLNativeWindowType win,
                                  const EGLint *attrib_list) {
    (void)config;
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
    uint32_t target = g_pending_surface_target_bo;
    g_pending_surface_target_bo = 0;
    g_current_egl_window = (void *)win;
    if (!target && win && _wpk_wlegl_bo_handle)
        target = _wpk_wlegl_bo_handle((void *)win);
    surf.reserved[0] = target;
    if (ioctl(g_fd, GLIO_CREATE_SURFACE, &surf) != 0) {
        g_last_error = EGL_BAD_ALLOC;
        return EGL_NO_SURFACE;
    }
    g_surface_made = 1;
    return EGL_SURFACE_HANDLE;
}

/* Called by libwayland-egl after wl_egl_window_resize gave the window a new
 * bo: re-aim the live window surface's default framebuffer at it. The
 * surface is destroyed and re-created with the new target, which the host
 * applies at once because the context already exists. Commands queued
 * against the old target are flushed first, so they still land in the old
 * bo, which libwayland-egl keeps alive until its successor is committed. */
void _wpk_egl_window_retarget(void *egl_window) {
    if (!egl_window || egl_window != g_current_egl_window || !g_surface_made
        || g_fd < 0 || !_wpk_wlegl_bo_handle)
        return;
    uint32_t target = _wpk_wlegl_bo_handle(egl_window);
    if (!target) return;
    _wpk_gl_flush();
    ioctl(g_fd, GLIO_DESTROY_SURFACE, NULL);
    struct gl_surface_attrs surf = {
        .kind = WPK_SURFACE_DEFAULT,
        .width = 0, .height = 0, .config_id = 1,
        .reserved = {target, 0, 0, 0},
    };
    if (ioctl(g_fd, GLIO_CREATE_SURFACE, &surf) != 0) {
        /* The surface is gone and nothing replaced it: eglMakeCurrent and
         * eglSwapBuffers now fail rather than render into a stale target. */
        g_surface_made = 0;
        g_current_egl_window = NULL;
    }
}

EGLBoolean eglMakeCurrent(EGLDisplay dpy, EGLSurface draw,
                          EGLSurface read, EGLContext ctx) {
    /* EGL 1.5 §3.7.3: releasing the current context takes no surfaces and
     * accepts EGL_NO_DISPLAY. Queued commands are submitted first, so
     * they run before whatever the caller does next with the buffers they
     * rendered. */
    if (ctx == EGL_NO_CONTEXT) {
        if (dpy != EGL_NO_DISPLAY && dpy != EGL_DPY_HANDLE) {
            g_last_error = EGL_BAD_DISPLAY;
            return EGL_FALSE;
        }
        if (draw != EGL_NO_SURFACE || read != EGL_NO_SURFACE) {
            g_last_error = EGL_BAD_MATCH;
            return EGL_FALSE;
        }
        _wpk_gl_flush();
        g_current = 0;
        g_current_surfaceless = 0;
        return EGL_TRUE;
    }
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_FALSE; }
    if (ctx != EGL_CONTEXT_HANDLE || !g_context_made) {
        g_last_error = EGL_BAD_CONTEXT;
        return EGL_FALSE;
    }
    if (draw == EGL_NO_SURFACE && read == EGL_NO_SURFACE) {
        g_current = 1;
        g_current_surfaceless = 1;
        return EGL_TRUE;
    }
    if (draw != EGL_SURFACE_HANDLE || read != EGL_SURFACE_HANDLE
        || !g_surface_made) {
        g_last_error = EGL_BAD_MATCH;
        return EGL_FALSE;
    }

    if (ioctl(g_fd, GLIO_MAKE_CURRENT, NULL) != 0) {
        g_last_error = EGL_BAD_ACCESS;
        return EGL_FALSE;
    }
    // The cmdbuf was mmap'd in eglInitialize so the host's gl_bind
    // fires before GLIO_CREATE_CONTEXT — see the rationale there.
    g_current = 1;
    g_current_surfaceless = 0;
    return EGL_TRUE;
}

EGLContext eglGetCurrentContext(void) {
    return g_current ? EGL_CONTEXT_HANDLE : EGL_NO_CONTEXT;
}

EGLDisplay eglGetCurrentDisplay(void) {
    return g_current ? EGL_DPY_HANDLE : EGL_NO_DISPLAY;
}

EGLSurface eglGetCurrentSurface(EGLint readdraw) {
    if (readdraw != EGL_READ && readdraw != EGL_DRAW) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_NO_SURFACE;
    }
    return g_current && !g_current_surfaceless ? EGL_SURFACE_HANDLE
                                               : EGL_NO_SURFACE;
}

EGLBoolean eglQueryContext(EGLDisplay dpy, EGLContext ctx,
                           EGLint attribute, EGLint *value) {
    if (dpy != EGL_DPY_HANDLE) { g_last_error = EGL_BAD_DISPLAY; return EGL_FALSE; }
    if (ctx != EGL_CONTEXT_HANDLE || !g_context_made) {
        g_last_error = EGL_BAD_CONTEXT;
        return EGL_FALSE;
    }
    if (!value) { g_last_error = EGL_BAD_PARAMETER; return EGL_FALSE; }
    switch (attribute) {
        case EGL_CONFIG_ID:              *value = 1; break;
        case EGL_CONTEXT_CLIENT_TYPE:    *value = EGL_OPENGL_ES_API; break;
        case EGL_CONTEXT_CLIENT_VERSION: *value = g_client_version; break;
        case EGL_RENDER_BUFFER:
            *value = g_current && !g_current_surfaceless ? EGL_BACK_BUFFER
                                                         : EGL_NONE;
            break;
        default:
            g_last_error = EGL_BAD_ATTRIBUTE;
            return EGL_FALSE;
    }
    return EGL_TRUE;
}

EGLBoolean eglSwapBuffers(EGLDisplay dpy, EGLSurface surface) {
    if (dpy != EGL_DPY_HANDLE || surface != EGL_SURFACE_HANDLE
        || !g_surface_made) {
        g_last_error = EGL_BAD_SURFACE;
        return EGL_FALSE;
    }
    _wpk_gl_flush();
    if (ioctl(g_fd, GLIO_PRESENT, NULL) != 0) {
        g_last_error = EGL_BAD_SURFACE;
        return EGL_FALSE;
    }
    /* For a libwayland-egl window the flush + GLIO_PRESENT above is the
     * buffer-ready fence; now attach+commit the dmabuf buffer to the
     * wl_surface. No-op (skipped) for canvas/scanout surfaces. */
    if (g_current_egl_window && _wpk_wlegl_present)
        _wpk_wlegl_present(g_current_egl_window);
    return EGL_TRUE;
}

EGLBoolean eglDestroySurface(EGLDisplay dpy, EGLSurface surface) {
    if (dpy != EGL_DPY_HANDLE || surface != EGL_SURFACE_HANDLE) return EGL_FALSE;
    ioctl(g_fd, GLIO_DESTROY_SURFACE, NULL);
    g_surface_made = 0;
    g_current_egl_window = NULL;
    return EGL_TRUE;
}

EGLBoolean eglDestroyContext(EGLDisplay dpy, EGLContext ctx) {
    if (dpy != EGL_DPY_HANDLE || ctx != EGL_CONTEXT_HANDLE) return EGL_FALSE;
    ioctl(g_fd, GLIO_DESTROY_CONTEXT, NULL);
    g_context_made = 0;
    g_current = 0;
    g_current_surfaceless = 0;
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
    g_current = 0;
    g_current_surfaceless = 0;
    return EGL_TRUE;
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
 * several 1.0-1.4 queries (eglGetConfigs, eglQuerySurface,
 * eglSurfaceAttrib, eglBindTexImage,
 * eglReleaseTexImage, eglCopyBuffers, eglCreatePixmapSurface,
 * eglCreatePbufferFromClientBuffer) are all absent. That gap is
 * deliberately left visible rather than papered over with a plausible
 * return value — `wasm_require_approved_reserved_env_imports` in
 * scripts/wasm-artifact-guards.sh refuses any artifact that references
 * one, so a new consumer fails its build here instead of trapping on a
 * throwing host import at run time. Implement the entry point when a
 * consumer needs it; eglQuerySurface in particular needs the granted
 * surface size, which GLIO_CREATE_SURFACE does not report back today. */
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

/* Target the NEXT eglCreateWindowSurface at a GPU-tier bo's FBO: a
 * producer renders its frame into `bo_handle` (allocated via
 * gbm_bo_create with GPU usage, or imported via PRIME_FD_TO_HANDLE)
 * instead of a display canvas, and the compositor samples it zero-copy
 * with wpkEglBindBoTexture. Call immediately before eglCreateWindowSurface;
 * the target is consumed once. Passing 0 (or not calling this) yields an
 * ordinary window surface. No-op if the display isn't initialized. */
void wpkEglSetWindowSurfaceTarget(EGLDisplay dpy, unsigned bo_handle) {
    if (dpy != EGL_DPY_HANDLE) return;
    g_pending_surface_target_bo = bo_handle;
}

/* Release a handle from wpkEglImportDmabufHandle. */
void wpkEglCloseBoHandle(EGLDisplay dpy, unsigned bo_handle) {
    if (dpy != EGL_DPY_HANDLE || g_fd < 0) return;
    struct wpk_drm_gem_close req = { .handle = bo_handle, .pad = 0 };
    ioctl(g_fd, WPK_DRM_IOCTL_GEM_CLOSE, &req);
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
EGLImageKHR eglCreateImageKHR(EGLDisplay dpy, EGLContext ctx, EGLenum target,
                              EGLClientBuffer buffer,
                              const EGLint *attrib_list) {
    if (dpy != EGL_DPY_HANDLE || !g_initialized) {
        g_last_error = EGL_BAD_DISPLAY;
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
    image->handle = wpkEglImportDmabufHandle(dpy, fd);
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
        if (error == EGL_SUCCESS) return (EGLImageKHR)image;
        wpkEglCloseBoHandle(dpy, image->handle);
        free(image);
        g_last_error = error;
        return EGL_NO_IMAGE_KHR;
    }
    image->map = map;
    image->map_len = (size_t)st.st_size;
    image->pixels = (const uint8_t *)map + offset;
    return (EGLImageKHR)image;
}

EGLBoolean eglDestroyImageKHR(EGLDisplay dpy, EGLImageKHR image) {
    if (dpy != EGL_DPY_HANDLE) {
        g_last_error = EGL_BAD_DISPLAY;
        return EGL_FALSE;
    }
    struct wpk_egl_image *img = (struct wpk_egl_image *)image;
    if (!img) {
        g_last_error = EGL_BAD_PARAMETER;
        return EGL_FALSE;
    }
    if (img->map) munmap(img->map, img->map_len);
    wpkEglCloseBoHandle(dpy, img->handle);
    free(img);
    return EGL_TRUE;
}

uint32_t _wpk_egl_image_texture(const struct wpk_egl_image *image) {
    if (!image || image->pixels) return 0;
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
