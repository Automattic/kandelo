/*
 * Exercises the dma-buf import path of the EGL/GBM/GLES stubs
 * (libc/glue/libegl_stub.c, libgbm_stub.c, libglesv2_stub.c):
 *  - the GBM platform and dma-buf extensions are advertised,
 *  - dma-buf format and modifier queries,
 *  - a surfaceless context binds and releases,
 *  - modifier-aware bo allocation accepts only LINEAR,
 *  - eglCreateImageKHR rejects malformed CPU-tier and GPU-tier planes,
 *  - EGLImage textures, renderbuffers, GL_EXT_unpack_subimage uploads
 *    and 3x3 matrix uniforms reach the host (asserted by the host test).
 */
#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <drm/drm_fourcc.h>
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

struct plane {
    EGLint fd, width, height, fourcc, pitch, offset;
};

static EGLImageKHR import_plane(EGLDisplay dpy, struct plane p,
                                const EGLint *extra)
{
    EGLint attribs[32] = {
        EGL_WIDTH, p.width,
        EGL_HEIGHT, p.height,
        EGL_LINUX_DRM_FOURCC_EXT, p.fourcc,
        EGL_DMA_BUF_PLANE0_FD_EXT, p.fd,
        EGL_DMA_BUF_PLANE0_OFFSET_EXT, p.offset,
        EGL_DMA_BUF_PLANE0_PITCH_EXT, p.pitch,
    };
    size_t n = 12;
    for (; extra && extra[0] != EGL_NONE; extra += 2) {
        attribs[n++] = extra[0];
        attribs[n++] = extra[1];
    }
    attribs[n] = EGL_NONE;
    return eglCreateImageKHR(dpy, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT,
                             NULL, attribs);
}

static int import_fails(EGLDisplay dpy, const char *what, struct plane p,
                        const EGLint *extra, EGLint want)
{
    EGLImageKHR image = import_plane(dpy, p, extra);
    EGLint got = eglGetError();
    if (image == EGL_NO_IMAGE_KHR && got == want) return 0;
    fprintf(stderr, "FAIL: %s: image=%p error=0x%x, want 0x%x\n",
            what, image, got, want);
    return 1;
}

static int unpack_reads(GLenum pname, GLint want)
{
    GLint got = -1;
    glGetIntegerv(pname, &got);
    if (got == want) return 0;
    fprintf(stderr, "FAIL: glGetIntegerv(0x%x) = %d, want %d\n",
            pname, got, want);
    return 1;
}

int main(void)
{
    const char *client = eglQueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS);
    if (!client || !strstr(client, "EGL_KHR_platform_gbm")) {
        fprintf(stderr, "FAIL: client extensions lack EGL_KHR_platform_gbm: %s\n",
                client ? client : "(null)");
        return 1;
    }

    int card = open("/dev/dri/card0", O_RDWR);
    if (card < 0) {
        fprintf(stderr, "FAIL: open /dev/dri/card0: %d\n", errno);
        return 1;
    }
    struct gbm_device *dev = gbm_create_device(card);
    if (!dev) {
        fprintf(stderr, "FAIL: gbm_create_device\n");
        return 1;
    }

    EGLDisplay dpy = eglGetPlatformDisplayEXT(EGL_PLATFORM_GBM_KHR, dev, NULL);
    EGLint major = 0, minor = 0;
    if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, &major, &minor)) {
        fprintf(stderr, "FAIL: GBM platform display: 0x%x\n", eglGetError());
        return 1;
    }
    const char *extensions = eglQueryString(dpy, EGL_EXTENSIONS);
    if (!extensions
        || !strstr(extensions, "EGL_EXT_image_dma_buf_import_modifiers")) {
        fprintf(stderr, "FAIL: display extensions lack dma-buf modifiers: %s\n",
                extensions ? extensions : "(null)");
        return 1;
    }

    EGLint count = 0;
    if (!eglQueryDmaBufFormatsEXT(dpy, 0, NULL, &count) || count < 2) {
        fprintf(stderr, "FAIL: dma-buf format count %d\n", count);
        return 1;
    }
    EGLint formats[16];
    for (int i = 0; i < 16; i++) formats[i] = -1;
    EGLint returned = 0;
    if (count > 16
        || !eglQueryDmaBufFormatsEXT(dpy, count - 1, formats, &returned)
        || returned != count - 1 || formats[count - 1] != -1) {
        fprintf(stderr, "FAIL: max %d formats returned %d, slot %d = %d\n",
                count - 1, returned, count - 1, formats[count - 1]);
        return 1;
    }
    EGLuint64KHR modifiers[4] = { DRM_FORMAT_MOD_INVALID };
    EGLBoolean external[4] = { EGL_TRUE };
    EGLint modifier_count = 0;
    if (!eglQueryDmaBufModifiersEXT(dpy, DRM_FORMAT_XRGB8888, 4, modifiers,
                                    external, &modifier_count)
        || modifier_count != 1 || modifiers[0] != DRM_FORMAT_MOD_LINEAR
        || external[0] != EGL_FALSE) {
        fprintf(stderr, "FAIL: XRGB8888 modifiers: count %d first 0x%llx\n",
                modifier_count, (unsigned long long) modifiers[0]);
        return 1;
    }

    const EGLint context_attribs[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    EGLContext ctx = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT,
                                      context_attribs);
    if (ctx == EGL_NO_CONTEXT
        || !eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) {
        fprintf(stderr, "FAIL: surfaceless eglMakeCurrent: 0x%x\n", eglGetError());
        return 1;
    }
    if (eglGetCurrentContext() != ctx
        || eglGetCurrentSurface(EGL_DRAW) != EGL_NO_SURFACE) {
        fprintf(stderr, "FAIL: surfaceless bind reports the wrong current state\n");
        return 1;
    }
    EGLint client_type = 0;
    if (!eglQueryContext(dpy, ctx, EGL_CONTEXT_CLIENT_TYPE, &client_type)
        || client_type != EGL_OPENGL_ES_API) {
        fprintf(stderr, "FAIL: EGL_CONTEXT_CLIENT_TYPE = 0x%x\n", client_type);
        return 1;
    }

    const uint64_t tiled = I915_FORMAT_MOD_X_TILED;
    errno = 0;
    struct gbm_bo *rejected = gbm_bo_create_with_modifiers2(
        dev, 64, 64, GBM_FORMAT_XRGB8888, &tiled, 1,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
    if (rejected != NULL || errno != EINVAL) {
        fprintf(stderr, "FAIL: tiled-only modifier list: bo=%p errno=%d\n",
                (void *) rejected, errno);
        return 1;
    }
    const uint64_t linear = DRM_FORMAT_MOD_LINEAR;
    struct gbm_bo *gpu_bo = gbm_bo_create_with_modifiers2(
        dev, 64, 64, GBM_FORMAT_XRGB8888, &linear, 1,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
    if (!gpu_bo || gbm_bo_get_modifier(gpu_bo) != DRM_FORMAT_MOD_LINEAR) {
        fprintf(stderr, "FAIL: LINEAR modifier bo: %d\n", errno);
        return 1;
    }
    uint32_t gpu_stride = 0;
    void *gpu_map = NULL;
    errno = 0;
    if (gbm_bo_map(gpu_bo, 0, 0, 64, 64, GBM_BO_TRANSFER_READ,
                   &gpu_stride, &gpu_map) != NULL || errno != EINVAL) {
        fprintf(stderr, "FAIL: SCANOUT|RENDERING modifier bo is not GPU-tier\n");
        return 1;
    }
    if (gbm_bo_get_fd_for_plane(gpu_bo, 1) != -1) {
        fprintf(stderr, "FAIL: plane 1 fd of a single-plane bo\n");
        return 1;
    }

    struct gbm_bo *cpu_bo = gbm_bo_create(dev, 3, 2, GBM_FORMAT_XRGB8888,
                                          GBM_BO_USE_LINEAR);
    uint32_t cpu_stride = 0;
    void *cpu_map = NULL;
    uint8_t *pixels = cpu_bo ? gbm_bo_map(cpu_bo, 0, 0, 3, 2,
                                          GBM_BO_TRANSFER_WRITE,
                                          &cpu_stride, &cpu_map)
                             : NULL;
    if (!pixels) {
        fprintf(stderr, "FAIL: CPU-tier bo: %d\n", errno);
        return 1;
    }
    for (uint32_t y = 0; y < 2; y++) {
        for (uint32_t x = 0; x < 3; x++) {
            for (uint32_t c = 0; c < 4; c++)
                pixels[y * cpu_stride + x * 4 + c] = (uint8_t) (y * 16 + x * 4 + c + 1);
        }
    }
    gbm_bo_unmap(cpu_bo, cpu_map);
    int cpu_fd = gbm_bo_get_fd(cpu_bo);
    struct stat cpu_st;
    if (cpu_fd < 0 || fstat(cpu_fd, &cpu_st) != 0) {
        fprintf(stderr, "FAIL: CPU-tier prime fd: %d\n", errno);
        return 1;
    }

    const struct plane cpu = {
        cpu_fd, 3, 2, DRM_FORMAT_XRGB8888, (EGLint) cpu_stride, 0,
    };
    struct plane bad = cpu;
    bad.fourcc = DRM_FORMAT_RGB565;
    if (import_fails(dpy, "unsupported fourcc", bad, NULL, EGL_BAD_MATCH))
        return 1;
    const EGLint tiled_modifier[] = {
        EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT, (EGLint) (tiled & 0xffffffffu),
        EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT, (EGLint) (tiled >> 32),
        EGL_NONE,
    };
    if (import_fails(dpy, "tiled modifier", cpu, tiled_modifier, EGL_BAD_MATCH))
        return 1;
    const EGLint second_plane[] = { EGL_DMA_BUF_PLANE1_FD_EXT, cpu_fd, EGL_NONE };
    if (import_fails(dpy, "second plane", cpu, second_plane, EGL_BAD_ATTRIBUTE))
        return 1;
    bad = cpu;
    bad.pitch = 3 * 4 - 4;
    if (import_fails(dpy, "pitch below width", bad, NULL, EGL_BAD_ACCESS))
        return 1;
    bad = cpu;
    bad.offset = (EGLint) cpu_st.st_size;
    if (import_fails(dpy, "plane past the buffer", bad, NULL, EGL_BAD_ACCESS))
        return 1;
    const EGLint half_modifier[] = {
        EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT, 0, EGL_NONE,
    };
    if (import_fails(dpy, "half modifier", cpu, half_modifier, EGL_BAD_PARAMETER))
        return 1;
    const EGLint linear_modifier[] = {
        EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT, 0,
        EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT, 0,
        EGL_NONE,
    };
    EGLImageKHR cpu_image = import_plane(dpy, cpu, linear_modifier);
    if (cpu_image == EGL_NO_IMAGE_KHR) {
        fprintf(stderr, "FAIL: CPU-tier image: 0x%x\n", eglGetError());
        return 1;
    }

    int gpu_fd = gbm_bo_get_fd(gpu_bo);
    struct plane gpu = {
        gpu_fd, 64, 32, DRM_FORMAT_XRGB8888,
        (EGLint) gbm_bo_get_stride(gpu_bo), 4096,
    };
    if (gpu_fd < 0
        || import_fails(dpy, "GPU-tier plane offset", gpu, NULL, EGL_BAD_ACCESS))
        return 1;
    gpu.height = 64;
    gpu.offset = 0;
    EGLImageKHR gpu_image = import_plane(dpy, gpu, NULL);
    if (gpu_image == EGL_NO_IMAGE_KHR) {
        fprintf(stderr, "FAIL: GPU-tier image: 0x%x\n", eglGetError());
        return 1;
    }

    GLuint image_texture = 0;
    glGenTextures(1, &image_texture);
    glBindTexture(GL_TEXTURE_2D, image_texture);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, cpu_image);

    glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT, 4);
    glPixelStorei(GL_UNPACK_SKIP_ROWS_EXT, 1);
    glPixelStorei(GL_UNPACK_SKIP_PIXELS_EXT, 1);
    if (unpack_reads(GL_UNPACK_ROW_LENGTH_EXT, 4)
        || unpack_reads(GL_UNPACK_SKIP_ROWS_EXT, 1)
        || unpack_reads(GL_UNPACK_SKIP_PIXELS_EXT, 1))
        return 1;
    uint8_t upload[3][4][4];
    for (int r = 0; r < 3; r++) {
        for (int x = 0; x < 4; x++) {
            for (int c = 0; c < 4; c++)
                upload[r][x][c] = (uint8_t) (0x40 + r * 16 + x * 4 + c);
        }
    }
    GLuint upload_texture = 0;
    glGenTextures(1, &upload_texture);
    glBindTexture(GL_TEXTURE_2D, upload_texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_BGRA_EXT, 2, 2, 0,
                 GL_BGRA_EXT, GL_UNSIGNED_BYTE, upload);
    glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT, 0);
    glPixelStorei(GL_UNPACK_SKIP_ROWS_EXT, 0);
    glPixelStorei(GL_UNPACK_SKIP_PIXELS_EXT, 0);
    if (unpack_reads(GL_UNPACK_ROW_LENGTH_EXT, 0)
        || unpack_reads(GL_UNPACK_SKIP_ROWS_EXT, 0)
        || unpack_reads(GL_UNPACK_SKIP_PIXELS_EXT, 0))
        return 1;

    GLuint renderbuffers[2] = { 0, 0 };
    glGenRenderbuffers(2, renderbuffers);
    glBindRenderbuffer(GL_RENDERBUFFER, renderbuffers[0]);
    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, cpu_image);
    GLenum error = glGetError();
    if (error != GL_INVALID_OPERATION) {
        fprintf(stderr, "FAIL: CPU-tier renderbuffer storage: 0x%x\n", error);
        return 1;
    }
    glBindRenderbuffer(GL_RENDERBUFFER, renderbuffers[1]);
    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, gpu_image);
    error = glGetError();
    if (error != GL_NO_ERROR) {
        fprintf(stderr, "FAIL: GPU-tier renderbuffer storage: 0x%x\n", error);
        return 1;
    }
    GLuint framebuffer = 0;
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                              GL_RENDERBUFFER, renderbuffers[1]);

    GLuint program = glCreateProgram();
    GLint location = glGetUniformLocation(program, "foo");
    if (location < 0) {
        fprintf(stderr, "FAIL: uniform location %d\n", location);
        return 1;
    }
    const GLfloat matrix[9] = { 1, 2, 3, 4, 5, 6, 7, 8, 9 };
    glUniformMatrix3fv(location, 1, GL_FALSE, matrix);
    glFlush();

    if (!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT)
        || eglGetCurrentContext() != EGL_NO_CONTEXT) {
        fprintf(stderr, "FAIL: releasing the context: 0x%x\n", eglGetError());
        return 1;
    }

    eglDestroyImageKHR(dpy, gpu_image);
    eglDestroyImageKHR(dpy, cpu_image);
    close(gpu_fd);
    close(cpu_fd);
    gbm_bo_destroy(cpu_bo);
    gbm_bo_destroy(gpu_bo);
    eglDestroyContext(dpy, ctx);
    eglTerminate(dpy);
    gbm_device_destroy(dev);
    close(card);
    printf("OK\n");
    return 0;
}
