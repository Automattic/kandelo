/* Ordinary SDK/kernel probe: display identity and native DRM-file lifetime.
 * The Node driver supplies a GL call recorder, not a pixel renderer. */
#define EGL_EGLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <drm/drm.h>
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#define CHECK(value) do { if (!(value)) { \
    fprintf(stderr, "FAIL line %d: %s (errno %d, EGL 0x%x)\n", \
        __LINE__, #value, errno, eglGetError()); return 1; \
} } while (0)
static int busy(int fd) {
    errno = 0;
    return ioctl(fd, DRM_IOCTL_SET_MASTER, 0) == -1 && errno == EBUSY;
}
int main(void) {
    int card = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    CHECK(card >= 0);
    int alias = dup(card), independent = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    CHECK(alias >= 0 && independent >= 0);
    struct gbm_device *a = gbm_create_device(card), *b = gbm_create_device(alias);
    struct gbm_device *c = gbm_create_device(independent);
    CHECK(a && b && c);
    EGLDisplay da = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, a, NULL);
    EGLDisplay db = eglGetPlatformDisplayEXT(EGL_PLATFORM_GBM_KHR, b, NULL);
    EGLDisplay dc = eglGetDisplay((EGLNativeDisplayType)c);
    EGLDisplay defaults = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    CHECK(da != EGL_NO_DISPLAY && db != EGL_NO_DISPLAY && dc != EGL_NO_DISPLAY);
    CHECK(da != db && db != dc && da != dc && defaults != da && defaults != db && defaults != dc);
    CHECK(eglGetDisplay((EGLNativeDisplayType)a) == da);
    CHECK(eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, a, NULL) == da);
    CHECK(eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, NULL, NULL) == defaults);
    CHECK(eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, (void *)(uintptr_t)1, NULL) == EGL_NO_DISPLAY);
    CHECK(eglGetError() == EGL_BAD_PARAMETER);
    void *guard = mmap(NULL, 65536, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(guard != MAP_FAILED);
    CHECK(eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, guard, NULL) == EGL_NO_DISPLAY);
    CHECK(eglGetError() == EGL_BAD_PARAMETER && munmap(guard, 65536) == 0);
    CHECK(eglInitialize(da, NULL, NULL) && eglInitialize(db, NULL, NULL));
    CHECK(eglInitialize(dc, NULL, NULL) && eglInitialize(defaults, NULL, NULL));
    CHECK(eglInitialize(da, NULL, NULL));
    const EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    EGLContext ca = eglCreateContext(da, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, attrs);
    EGLContext cb = eglCreateContext(db, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, attrs);
    CHECK(ca != EGL_NO_CONTEXT && cb != EGL_NO_CONTEXT && ca != cb);
    CHECK(eglMakeCurrent(da, EGL_NO_SURFACE, EGL_NO_SURFACE, ca));
    CHECK(eglGetCurrentDisplay() == da && eglGetCurrentContext() == ca);
    CHECK(!eglMakeCurrent(db, EGL_NO_SURFACE, EGL_NO_SURFACE, ca));
    CHECK(eglGetError() == EGL_BAD_CONTEXT);
    CHECK(eglGetCurrentDisplay() == da && eglGetCurrentContext() == ca);
    CHECK(close(card) == 0 && close(alias) == 0);
    gbm_device_destroy(a); gbm_device_destroy(b);
    CHECK(busy(independent));
    CHECK(eglTerminate(da));
    CHECK(eglGetCurrentDisplay() == da && eglGetCurrentContext() == ca);
    CHECK(eglTerminate(db) && busy(independent));
    /* The terminated display still owns its native file while ca is current. */
    CHECK(eglReleaseThread());
    CHECK(eglGetCurrentDisplay() == EGL_NO_DISPLAY);
    CHECK(ioctl(independent, DRM_IOCTL_SET_MASTER, 0) == 0);
    EGLint configs = -1;
    CHECK(eglGetConfigs(dc, NULL, 0, &configs) && configs == 1);
    CHECK(eglTerminate(defaults));
    CHECK(eglGetConfigs(dc, NULL, 0, &configs) && configs == 1);
    struct gbm_device *replacement = gbm_create_device(independent);
    CHECK(replacement);
    EGLDisplay dn = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, replacement, NULL);
    CHECK(dn != EGL_NO_DISPLAY && dn != da && dn != db && dn != dc && dn != defaults);
    CHECK(eglInitialize(dn, NULL, NULL));
    CHECK(!eglInitialize(da, NULL, NULL) && eglGetError() == EGL_NOT_INITIALIZED);
    gbm_device_destroy(c); gbm_device_destroy(replacement);
    CHECK(close(independent) == 0);
    int observer = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    CHECK(observer >= 0 && busy(observer));
    CHECK(eglTerminate(dc) && busy(observer));
    CHECK(eglTerminate(dn));
    CHECK(ioctl(observer, DRM_IOCTL_SET_MASTER, 0) == 0 && close(observer) == 0);
    CHECK(eglTerminate(da) && eglTerminate(db));
    puts("OK native EGL display identity and retained DRM files");
    return 0;
}
