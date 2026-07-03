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
    (void)config; (void)win; (void)attrib_list;
    if (dpy != EGL_DPY_HANDLE || g_fd < 0) {
        g_last_error = EGL_NOT_INITIALIZED;
        return EGL_NO_SURFACE;
    }

    struct gl_surface_attrs surf = {
        .kind = WPK_SURFACE_DEFAULT,
        .width = 0, .height = 0, .config_id = 1,
        .reserved = {0,0,0,0},
    };
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
