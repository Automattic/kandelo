#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <assert.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "gl_abi.h"
int main(int argc, char **argv) {
    assert(argc == 2);
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    assert(display != EGL_NO_DISPLAY);
    if (!strcmp(argv[1], "no-renderer")) {
        assert(!eglInitialize(display, NULL, NULL));
        assert(eglGetError() == EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal"); return 0;
    }
    assert(eglInitialize(display, NULL, NULL));
    const EGLint config_attrs[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE};
    EGLConfig config; EGLint count;
    assert(eglChooseConfig(display, config_attrs, &config, 1, &count) && count == 1);
    const EGLint context_attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    const EGLint surface_attrs[] = {EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE};
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_attrs);
    EGLSurface surface = eglCreatePbufferSurface(display, config, surface_attrs);
    assert(context != EGL_NO_CONTEXT && surface != EGL_NO_SURFACE);
    assert(eglMakeCurrent(display, surface, surface, context));
    assert(glGetError() == GL_NO_ERROR);
    const uint64_t start = _wpk_gl_device_requests();
    for (unsigned i = 0; i < 3; ++i) {
        glClearColor(-1, 2, 0, 1); assert(glGetError() == GL_NO_ERROR);
        glBlendColor(-1, 2, 0, 1); assert(glGetError() == GL_NO_ERROR);
        glClearDepthf(-1); assert(glGetError() == GL_NO_ERROR);
        glClearStencil(INT_MIN); assert(glGetError() == GL_NO_ERROR);
        glColorMask(0, 2, 0, 1); assert(glGetError() == GL_NO_ERROR);
        glDepthMask(2); assert(glGetError() == GL_NO_ERROR);
        glStencilMask(UINT_MAX); assert(glGetError() == GL_NO_ERROR);
        glPolygonOffset(-1, 2); assert(glGetError() == GL_NO_ERROR);
        glDepthRangef(2, -1); assert(glGetError() == GL_NO_ERROR);
        glSampleCoverage(2, 2); assert(glGetError() == GL_NO_ERROR);
    }
    const uint64_t requests = _wpk_gl_device_requests() - start;
    printf("SCALAR_REQUESTS calls=30 requests=%llu\n", (unsigned long long)requests);
    assert(requests == (!strcmp(argv[1], "after") ? 0 : 30));
    glClearColor(0, 0, 0, 1); glEnable(0xdead); glBlendColor(0, 0, 0, 1);
    assert(glGetError() == GL_INVALID_ENUM && glGetError() == GL_NO_ERROR);
    glFlush(); assert(glGetError() == GL_NO_ERROR);
    assert(eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT));
    assert(eglDestroySurface(display, surface) && eglDestroyContext(display, context));
    assert(eglTerminate(display) && eglReleaseThread());
    puts("PASS real scalar GLES path and unknown-command fallback"); return 0;
}
