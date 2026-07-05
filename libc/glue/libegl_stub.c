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
#include <GLES2/gl2.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include "gl_abi.h"

void glDrawBuffer(GLenum buf);
void glDrawBuffers(GLsizei n, const GLenum *bufs);
void glReadBuffer(GLenum src);

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
    WPK_MAP_GL(glDrawBuffer);
    WPK_MAP_GL(glDrawBuffers);
    WPK_MAP_GL(glDrawElements);
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
    WPK_MAP_GL(glGetActiveUniform);
    WPK_MAP_GL(glGetAttachedShaders);
    WPK_MAP_GL(glGetAttribLocation);
    WPK_MAP_GL(glGetBooleanv);
    WPK_MAP_GL(glGetBufferParameteriv);
    WPK_MAP_GL(glGetError);
    WPK_MAP_GL(glGetFloatv);
    WPK_MAP_GL(glGetFramebufferAttachmentParameteriv);
    WPK_MAP_GL(glGetIntegerv);
    WPK_MAP_GL(glGetProgramiv);
    WPK_MAP_GL(glGetProgramInfoLog);
    WPK_MAP_GL(glGetRenderbufferParameteriv);
    WPK_MAP_GL(glGetShaderiv);
    WPK_MAP_GL(glGetShaderInfoLog);
    WPK_MAP_GL(glGetShaderPrecisionFormat);
    WPK_MAP_GL(glGetShaderSource);
    WPK_MAP_GL(glGetString);
    WPK_MAP_GL(glGetTexParameterfv);
    WPK_MAP_GL(glGetTexParameteriv);
    WPK_MAP_GL(glGetUniformfv);
    WPK_MAP_GL(glGetUniformiv);
    WPK_MAP_GL(glGetUniformLocation);
    WPK_MAP_GL(glGetVertexAttribfv);
    WPK_MAP_GL(glGetVertexAttribiv);
    WPK_MAP_GL(glGetVertexAttribPointerv);
    WPK_MAP_GL(glHint);
    WPK_MAP_GL(glIsBuffer);
    WPK_MAP_GL(glIsEnabled);
    WPK_MAP_GL(glIsFramebuffer);
    WPK_MAP_GL(glIsProgram);
    WPK_MAP_GL(glIsRenderbuffer);
    WPK_MAP_GL(glIsShader);
    WPK_MAP_GL(glIsTexture);
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
    WPK_MAP_GL(glValidateProgram);
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
    return NULL;
}

#undef WPK_MAP_GL

EGLBoolean eglWaitClient(void) {
    _wpk_gl_flush();
    return EGL_TRUE;
}

EGLBoolean eglReleaseThread(void) { return EGL_TRUE; }
