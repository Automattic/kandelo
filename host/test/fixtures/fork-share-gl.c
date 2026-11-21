#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static int draw(float r, float g, float b) {
    unsigned char p[4] = {0};
    glViewport(0, 0, 8, 8); glClearColor(r, g, b, 1); glClear(GL_COLOR_BUFFER_BIT);
    glReadPixels(4, 4, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, p);
    return p[0] != (unsigned)(r * 255) || p[1] != (unsigned)(g * 255) || p[2] != (unsigned)(b * 255) || p[3] != 255
        || glGetError() != GL_NO_ERROR;
}

int main(void) {
    int card = open("/dev/dri/renderD128", O_RDWR);
    struct gbm_device *device = card < 0 ? NULL : gbm_create_device(card);
    if (!device) { perror("gbm"); return 3; }
    EGLDisplay display = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, device, NULL);
    if (display == EGL_NO_DISPLAY || !eglInitialize(display, NULL, NULL)) { printf("egl init failed\n"); return 4; }
    const EGLint choose[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
    EGLConfig config; EGLint count;
    if (!eglChooseConfig(display, choose, &config, 1, &count) || count != 1) { printf("config failed\n"); return 5; }
    const EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE}, size[] = {EGL_WIDTH, 8, EGL_HEIGHT, 8, EGL_NONE};
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, attrs);
    EGLSurface surface = eglCreatePbufferSurface(display, config, size);
    if (context == EGL_NO_CONTEXT || surface == EGL_NO_SURFACE || !eglMakeCurrent(display, surface, surface, context)) { printf("context failed\n"); return 6; }
    int failed = 0;
    failed |= draw(1, 0, 0) << 1;

    pid_t child = fork();
    if (child == 0) _exit(42);
    for (int i = 0; i < 200; i++) failed |= draw(0, i & 1, !(i & 1)) << 2;
    int status = -1;
    int code = waitpid(child, &status, 0) == child && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    for (int i = 0; i < 200; i++) failed |= draw(i & 1, 0, !(i & 1)) << 3;
    failed |= code != 42;
    printf("parent child=%d failed=%d\n", code, failed);
    return failed;
}
