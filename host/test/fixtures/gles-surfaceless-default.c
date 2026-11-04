/* Surfaceless default errors must leave the context and its sharing peer usable. */
#define EGL_EGLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void error(GLenum expected) {
    assert(glGetError() == expected);
    assert(glGetError() == GL_NO_ERROR);
}
static void missing_drawable(void) {
    assert(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_UNDEFINED_OES);
    glClear(GL_COLOR_BUFFER_BIT); error(GL_INVALID_FRAMEBUFFER_OPERATION);
    GLubyte bytes[4] = {19, 29, 39, 49};
    glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, bytes);
    error(GL_INVALID_FRAMEBUFFER_OPERATION);
    assert(bytes[0] == 19 && bytes[1] == 29 && bytes[2] == 39 && bytes[3] == 49);
    GLuint texture = 0; glGenTextures(1, &texture); assert(texture);
    glBindTexture(GL_TEXTURE_2D, texture); error(GL_NO_ERROR);
    glCopyTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 0, 0, 1, 1, 0);
    error(GL_INVALID_FRAMEBUFFER_OPERATION);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    error(GL_NO_ERROR);
    glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, 1, 1);
    error(GL_INVALID_FRAMEBUFFER_OPERATION);
    glDeleteTextures(1, &texture); error(GL_NO_ERROR);
}
static void draw(GLfloat r, GLfloat g, GLfloat b, unsigned red, unsigned green, unsigned blue) {
    glClearColor(r, g, b, 1); glClear(GL_COLOR_BUFFER_BIT); error(GL_NO_ERROR);
    GLubyte bytes[4] = {0}; glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, bytes);
    error(GL_NO_ERROR);
    assert(bytes[0] + 1 >= red && bytes[0] <= red + 1);
    assert(bytes[1] + 1 >= green && bytes[1] <= green + 1);
    assert(bytes[2] + 1 >= blue && bytes[2] <= blue + 1 && bytes[3] == 255);
}
int main(int argc, char **argv) {
    assert(argc == 2);
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY); assert(display != EGL_NO_DISPLAY);
    if (!strcmp(argv[1], "no-renderer")) {
        assert(!eglInitialize(display, NULL, NULL) && eglGetError() == EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal"); return 0;
    }
    assert(eglInitialize(display, NULL, NULL));
    PFNGLGETGRAPHICSRESETSTATUSKHRPROC status =
        (PFNGLGETGRAPHICSRESETSTATUSKHRPROC)eglGetProcAddress("glGetGraphicsResetStatusKHR");
    assert(status);
    const EGLint choose[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
    EGLConfig config; EGLint count;
    assert(eglChooseConfig(display, choose, &config, 1, &count) && count == 1);
    const EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 2,
        EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_KHR, EGL_LOSE_CONTEXT_ON_RESET_KHR, EGL_NONE};
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, attrs);
    EGLContext peer = eglCreateContext(display, config, context, attrs);
    assert(context != EGL_NO_CONTEXT && peer != EGL_NO_CONTEXT);
    assert(eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, context));
    missing_drawable(); assert(status() == GL_NO_ERROR);
    const EGLint dimensions[] = {EGL_WIDTH, 4, EGL_HEIGHT, 4, EGL_NONE};
    EGLSurface surface = eglCreatePbufferSurface(display, config, dimensions);
    assert(surface != EGL_NO_SURFACE && eglMakeCurrent(display, surface, surface, context));
    draw(.2f, .6f, .8f, 51, 153, 204); assert(status() == GL_NO_ERROR);
    assert(eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, peer));
    missing_drawable(); assert(status() == GL_NO_ERROR);
    assert(eglMakeCurrent(display, surface, surface, peer));
    draw(.6f, .2f, .4f, 153, 51, 102); assert(status() == GL_NO_ERROR);
    assert(eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT));
    assert(eglDestroyContext(display, context) && eglDestroyContext(display, peer));
    assert(eglDestroySurface(display, surface) && eglTerminate(display) && eglReleaseThread());
    puts("PASS surfaceless errors preserve context and shared peer rendering"); return 0;
}
