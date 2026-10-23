/* Focused library tests. The device double records storage ownership and
 * encoded commands; real guest and browser tests remain separate gates. */
#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include "gl_abi.h"

/* Optional window backends are absent in this device-only harness. */
uint32_t _wpk_wlegl_bo_handle(void *window) { (void)window; return 0; }
void _wpk_wlegl_present(void *window) { (void)window; }
int _wpk_gbm_surface_dimensions(const void *window, uint32_t *w, uint32_t *h) {
    (void)window; (void)w; (void)h; return 0;
}

static unsigned closes, imports;
static uint32_t bound_texture, redefined_texture;
static unsigned char command_storage[2][WPK_GL_CMDBUF_LEN];
static unsigned char *commands;
static unsigned mappings;
int graphics_open(const char *path, int flags, ...) {
    (void)flags;
    assert(!strcmp(path, WPK_GL_DEVICE));
    return 10;
}
int graphics_close(int fd) { assert(fd == 10); return 0; }
int graphics_fstat(int fd, struct stat *st) {
    assert(fd == 100);
    memset(st, 0, sizeof *st);
    st->st_size = 64 * 64 * 4;
    return 0;
}
void *graphics_mmap(void *a, size_t len, int prot, int flags, int fd, off_t offset) {
    (void)a; (void)prot; (void)flags; (void)offset;
    if (fd == 10) {
        assert(len == WPK_GL_CMDBUF_LEN);
        commands = command_storage[mappings++ % 2];
        return commands;
    }
    assert(fd == 100);
    errno = EINVAL; // GPU storage is not CPU mappable.
    return MAP_FAILED;
}
int graphics_munmap(void *a, size_t len) {
    assert(a == commands && len == WPK_GL_CMDBUF_LEN);
    return 0;
}
int graphics_ioctl(int fd, unsigned long request, ...) {
    assert(fd == 10);
    va_list args; va_start(args, request);
    void *arg = va_arg(args, void *); va_end(args);
    if (request == 0xc00c642eu) {
        uint32_t *words = arg;
        assert(words[2] == 100);
        words[0] = 77; // Repeated PRIME imports share one GEM handle.
        imports++;
    } else if (request == 0x40086409u) {
        assert(*(uint32_t *)arg == 77);
        closes++;
    } else if (request == 0xc01064e1u) {
        uint32_t *words = arg;
        assert(words[0] == 77);
        words[3] = 0x60000000u;
    } else if (request == GLIO_SUBMIT) {
        struct gl_submit_info *submit = arg;
        size_t at = submit->offset, end = at + submit->length;
        while (at < end) {
            uint16_t op, len;
            memcpy(&op, commands + at, 2);
            memcpy(&len, commands + at + 2, 2);
            assert(at + 4 + len <= end);
            uint32_t words[2] = {0};
            memcpy(words, commands + at + 4, len < 8 ? len : 8);
            if (op == OP_BIND_TEXTURE) bound_texture = words[1];
            if (op == OP_TEX_IMAGE_2D) redefined_texture = bound_texture;
            at += 4 + len;
        }
    } else if (request == GLIO_QUERY) {
        struct gl_query_info *q = arg;
        /* This harness never needs renderer results. */
        (void)q;
    }
    return 0;
}

static EGLImageKHR image(EGLDisplay dpy) {
    const EGLint attrs[] = {
        EGL_WIDTH, 64, EGL_HEIGHT, 64,
        EGL_LINUX_DRM_FOURCC_EXT, 0x34324241,
        EGL_DMA_BUF_PLANE0_FD_EXT, 100,
        EGL_DMA_BUF_PLANE0_OFFSET_EXT, 0,
        EGL_DMA_BUF_PLANE0_PITCH_EXT, 256, EGL_NONE,
    };
    EGLImageKHR img = eglCreateImageKHR(dpy, EGL_NO_CONTEXT,
        EGL_LINUX_DMA_BUF_EXT, NULL, attrs);
    assert(img != EGL_NO_IMAGE_KHR);
    return img;
}
int main(int argc, char **argv) {
    assert(argc == 2);
    EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    assert(eglInitialize(dpy, NULL, NULL));
    const EGLint attrs[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    EGLContext ctx = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
    assert(ctx != EGL_NO_CONTEXT);
    assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
    EGLImageKHR first = image(dpy), second = image(dpy);
    assert(imports == 2);
    GLuint tex, rb;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, first);
    glGenRenderbuffers(1, &rb);
    glBindRenderbuffer(GL_RENDERBUFFER, rb);
    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, second);
    assert(eglDestroyImageKHR(dpy, first));
    assert(eglDestroyImageKHR(dpy, second));
    if (!strcmp(argv[1], "lifetime")) {
        assert(closes == 0); // The texture and renderbuffer retain storage.
        glDeleteTextures(1, &tex);
        assert(closes == 0); // The other image's sibling remains live.
        glDeleteRenderbuffers(1, &rb);
        assert(closes == 1); // Final reference retires exactly one handle.
    } else if (!strcmp(argv[1], "redefine")) {
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0,
            GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glFlush();
        assert(redefined_texture == tex); // Never respecify the shared BO.
        assert(closes == 0);
        glDeleteRenderbuffers(1, &rb);
        assert(closes == 1);
        glDeleteTextures(1, &tex);
    } else if (!strcmp(argv[1], "framebuffer")) {
        GLuint fb;
        glGenFramebuffers(1, &fb);
        glBindFramebuffer(GL_FRAMEBUFFER, fb);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
            GL_TEXTURE_2D, tex, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glDeleteTextures(1, &tex);
        glDeleteRenderbuffers(1, &rb);
        assert(closes == 0); // An unbound FBO still retains the image storage.
        glDeleteFramebuffers(1, &fb);
        assert(closes == 1);
    } else if (!strcmp(argv[1], "context")) {
        assert(eglDestroyContext(dpy, ctx));
        assert(closes == 1);
        assert(eglTerminate(dpy));
        puts("PASS context");
        return 0;
    } else if (!strcmp(argv[1], "cycle")) {
        // Leave siblings live; teardown must retire them and reset the encoder.
    } else {
        assert(!strcmp(argv[1], "invalid"));
        assert(!eglDestroyImageKHR(dpy, first));
        assert(eglGetError() == EGL_BAD_PARAMETER);
        assert(!eglDestroyImageKHR(dpy, (EGLImageKHR)(uintptr_t)0x1234));
        assert(eglGetError() == EGL_BAD_PARAMETER);
    }
    assert(eglDestroyContext(dpy, ctx));
    assert(eglTerminate(dpy));
    assert(closes == 1);
    if (!strcmp(argv[1], "cycle")) {
        assert(eglInitialize(dpy, NULL, NULL));
        ctx = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(ctx != EGL_NO_CONTEXT);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglDestroyContext(dpy, ctx));
        assert(eglTerminate(dpy));
    }
    printf("PASS %s\n", argv[1]);
}
