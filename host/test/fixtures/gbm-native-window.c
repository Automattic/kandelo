#include <gbm.h>
#include <EGL/egl.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>

extern int _wpk_gbm_surface_dimensions(const void *, uint32_t *, uint32_t *);
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "failed: %s\n", #x); return 1; } } while (0)

int main(void) {
    int fd = open("/dev/dri/card0", O_RDWR);
    CHECK(fd >= 0);
    struct gbm_device *device = gbm_create_device(fd);
    CHECK(device);
    struct gbm_surface *first = gbm_surface_create(device, 640, 480, GBM_FORMAT_XRGB8888, GBM_BO_USE_SCANOUT);
    struct gbm_surface *second = gbm_surface_create(device, 800, 600, GBM_FORMAT_ABGR8888,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
    CHECK(first && second);
    uint32_t width = 0, height = 0, foreign_window[2] = {1, 2};
    CHECK(!_wpk_gbm_surface_dimensions(foreign_window, &width, &height));
    CHECK(width == 0 && height == 0);
    CHECK(_wpk_gbm_surface_dimensions(first, &width, &height) && width == 640 && height == 480);
    CHECK(_wpk_gbm_surface_dimensions(second, &width, &height) && width == 800 && height == 600);
    EGLDisplay display = eglGetDisplay((EGLNativeDisplayType)device);
    CHECK(eglInitialize(display, NULL, NULL));
    EGLConfig config;
    EGLint count;
    const EGLint config_attributes[] = {
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_NONE,
    };
    CHECK(eglChooseConfig(display, config_attributes, &config, 1, &count) && count == 1);
    EGLint native_visual;
    CHECK(eglGetConfigAttrib(display, config, EGL_NATIVE_VISUAL_ID, &native_visual));
    CHECK(native_visual == GBM_FORMAT_ABGR8888);
    EGLSurface surface = eglCreateWindowSurface(display, config, (EGLNativeWindowType)second, NULL);
    CHECK(surface != EGL_NO_SURFACE);
    CHECK(eglDestroySurface(display, surface));
    CHECK(eglTerminate(display));
    gbm_surface_destroy(first);
    CHECK(!_wpk_gbm_surface_dimensions(first, &width, &height));
    CHECK(_wpk_gbm_surface_dimensions(second, &width, &height) && width == 800 && height == 600);
    gbm_surface_destroy(second);
    CHECK(!_wpk_gbm_surface_dimensions(second, &width, &height));
    gbm_device_destroy(device);
    CHECK(close(fd) == 0);
    int replacement = open("/dev/null", O_RDWR | O_CLOEXEC);
    CHECK(replacement >= 0);
    if (replacement != fd) {
        CHECK(dup2(replacement, fd) == fd);
        CHECK(close(replacement) == 0);
    }
    CHECK(!eglInitialize(display, NULL, NULL));
    CHECK(eglGetError() == EGL_NOT_INITIALIZED);
    CHECK(fcntl(fd, F_GETFD) >= 0);
    CHECK(close(fd) == 0);
    puts("gbm-native-window: distinct live sizes, opaque foreign handles, EGL handoff, retirement: ok");
    return 0;
}
