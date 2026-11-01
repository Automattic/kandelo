#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#ifdef TEST_EGL_RENDER
#include <gbm.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <drm/drm_fourcc.h>
#include <libdrm/xf86drm.h>
#include <libdrm/xf86drmMode.h>
#include <poll.h>
#endif

/* Linux UAPI layouts, also checked by shared::dri's layout tests. */
struct dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct mapping { uint32_t handle, pad; uint64_t offset; };
struct cursor { uint32_t flags, crtc; int32_t x, y; uint32_t width, height, handle; int32_t hot_x, hot_y; };
struct client_cap { uint64_t capability, value; };
struct planes { uint64_t ids; uint32_t count, pad; };
struct gem_close { uint32_t handle, pad; };
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s (errno %d)\n", __LINE__, #x, errno); exit(1); } } while (0)

#ifdef TEST_EGL_RENDER
struct rendered_display {
    struct gbm_device *device;
    struct gbm_surface *window;
    struct gbm_bo *front;
    EGLDisplay display;
    EGLContext context;
    EGLSurface surface;
    uint32_t crtc, framebuffer;
    GLuint renderbuffer, target;
    int render_fd;
};

static void flip_done(int fd, unsigned sequence, unsigned seconds, unsigned microseconds, void *data) {
    (void)fd; (void)sequence; (void)seconds; (void)microseconds;
    *(int *)data = 1;
}

static void wait_for_flip(int fd, uint32_t crtc, uint32_t framebuffer) {
    int done = 0;
    CHECK(drmModePageFlip(fd, crtc, framebuffer, DRM_MODE_PAGE_FLIP_EVENT, &done) == 0);
    drmEventContext events = {.version = 2, .page_flip_handler = flip_done};
    while (!done) {
        struct pollfd event = {.fd = fd, .events = POLLIN};
        CHECK(poll(&event, 1, 3000) == 1 && (event.revents & POLLIN));
        CHECK(drmHandleEvent(fd, &events) == 0);
    }
}

static struct rendered_display render_frames(int fd, int render_node) {
    struct rendered_display state = {.render_fd = -1};
    drmModeRes *resources = drmModeGetResources(fd);
    CHECK(resources && resources->count_crtcs > 0);
    drmModeConnector *connector = NULL;
    for (int i = 0; i < resources->count_connectors; ++i) {
        connector = drmModeGetConnector(fd, resources->connectors[i]);
        CHECK(connector);
        if (connector->connection == DRM_MODE_CONNECTED && connector->count_modes > 0) break;
        drmModeFreeConnector(connector);
        connector = NULL;
    }
    CHECK(connector);
    drmModeModeInfo mode = connector->modes[0];
    uint32_t connector_id = connector->connector_id;
    state.crtc = resources->crtcs[0];
    drmModeFreeConnector(connector);
    drmModeFreeResources(resources);
    state.render_fd = render_node ? open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC) : fd;
    CHECK(state.render_fd >= 0);
    state.device = gbm_create_device(state.render_fd);
    CHECK(state.device);
    state.display = eglGetDisplay((EGLNativeDisplayType)state.device);
    CHECK(state.display != EGL_NO_DISPLAY && eglInitialize(state.display, NULL, NULL));
    CHECK(eglBindAPI(EGL_OPENGL_ES_API));
    EGLConfig config;
    EGLint count, visual;
    const EGLint attributes[] = {EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE};
    CHECK(eglChooseConfig(state.display, attributes, &config, 1, &count) && count == 1);
    CHECK(eglGetConfigAttrib(state.display, config, EGL_NATIVE_VISUAL_ID, &visual));
    const EGLint context_attributes[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    state.context = eglCreateContext(state.display, config, EGL_NO_CONTEXT, context_attributes);
    CHECK(state.context != EGL_NO_CONTEXT);
    if (!render_node) {
        state.window = gbm_surface_create(state.device, mode.hdisplay, mode.vdisplay, visual,
            GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
        CHECK(state.window);
        state.surface = eglCreateWindowSurface(state.display, config, (EGLNativeWindowType)state.window, NULL);
        CHECK(state.surface != EGL_NO_SURFACE);
    }
    CHECK(eglMakeCurrent(state.display, state.surface, state.surface, state.context));
    if (render_node) {
        /* wlroots allocates modifier-aware scanout BOs, imports dma-buf
         * storage and renders through an image-backed FBO. It does not
         * post an EGL native window to the primary DRM file's canvas. */
        uint64_t modifier = DRM_FORMAT_MOD_LINEAR;
        state.front = gbm_bo_create_with_modifiers2(state.device, mode.hdisplay, mode.vdisplay,
            GBM_FORMAT_ABGR8888, &modifier, 1, GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
        CHECK(state.front);
        int prime = gbm_bo_get_fd(state.front);
        CHECK(prime >= 0);
        const EGLint image_attributes[] = {EGL_WIDTH, mode.hdisplay, EGL_HEIGHT, mode.vdisplay,
            EGL_LINUX_DRM_FOURCC_EXT, GBM_FORMAT_ABGR8888, EGL_DMA_BUF_PLANE0_FD_EXT, prime,
            EGL_DMA_BUF_PLANE0_OFFSET_EXT, 0, EGL_DMA_BUF_PLANE0_PITCH_EXT, gbm_bo_get_stride(state.front), EGL_NONE};
        EGLImageKHR image = eglCreateImageKHR(state.display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT,
            NULL, image_attributes);
        CHECK(image != EGL_NO_IMAGE_KHR && close(prime) == 0);
        glGenRenderbuffers(1, &state.renderbuffer);
        glBindRenderbuffer(GL_RENDERBUFFER, state.renderbuffer);
        glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, image);
        glGenFramebuffers(1, &state.target);
        glBindFramebuffer(GL_FRAMEBUFFER, state.target);
        glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, state.renderbuffer);
        CHECK(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
        CHECK(eglDestroyImageKHR(state.display, image));
    }
    glViewport(0, 0, mode.hdisplay, mode.vdisplay);
    for (int frame = 0; frame < 3; ++frame) {
        if (render_node && frame == 1) {
            /* A CPU presenter shares this physical context while the guest
             * retains its GLES context and objects. Return to that context
             * afterwards; the presenter must not corrupt its native state. */
            struct dumb cpu = {.width = mode.hdisplay, .height = mode.vdisplay, .bpp = 32};
            CHECK(ioctl(fd, 0xc02064b2, &cpu) == 0);
            struct mapping cpu_map = {.handle = cpu.handle};
            CHECK(ioctl(fd, 0xc01064b3, &cpu_map) == 0);
            uint32_t *bytes = mmap(NULL, cpu.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, cpu_map.offset);
            CHECK(bytes != MAP_FAILED);
            for (uint32_t y = 0; y < cpu.height; y++)
                for (uint32_t x = 0; x < cpu.width; x++) bytes[y * (cpu.pitch / 4) + x] = 0xff0000ff;
            uint32_t handles[4] = {cpu.handle}, pitches[4] = {cpu.pitch}, offsets[4] = {0}, fb = 0;
            CHECK(drmModeAddFB2(fd, cpu.width, cpu.height, GBM_FORMAT_XRGB8888, handles, pitches, offsets, &fb, 0) == 0);
            wait_for_flip(fd, state.crtc, fb);
            puts("render-node CPU interlude ready"); fflush(stdout);
            char command;
            CHECK(read(STDIN_FILENO, &command, 1) == 1 && command == 'c');
            CHECK(drmModeSetCrtc(fd, state.crtc, state.framebuffer, 0, 0, &connector_id, 1, &mode) == 0);
            CHECK(drmModeRmFB(fd, fb) == 0 && munmap(bytes, cpu.size) == 0);
            struct gem_close remove = {.handle = cpu.handle};
            CHECK(ioctl(fd, 0x40086409, &remove) == 0);
        }
        glClearColor(1, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        if (render_node) {
            /* KMS BO row zero is the top row, unlike a window's GL default
             * framebuffer. An asymmetric marker catches an extra Y flip. */
            glEnable(GL_SCISSOR_TEST);
            glScissor(17, 19, 1, 1);
            glClearColor(1, 1, 1, 1);
            glClear(GL_COLOR_BUFFER_BIT);
            glDisable(GL_SCISSOR_TEST);
        }
        unsigned char pixel[4] = {0};
        glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel);
        CHECK(glGetError() == GL_NO_ERROR && pixel[0] == 255 && pixel[1] == 0
            && pixel[2] == 0 && pixel[3] == 255);
        if (render_node) glFlush();
        else CHECK(eglSwapBuffers(state.display, state.surface));
        if (render_node && frame == 0) {
            puts("render-node unpresented resource ready"); fflush(stdout);
            char command;
            CHECK(read(STDIN_FILENO, &command, 1) == 1 && command == 'r');
        }
        struct gbm_bo *front = render_node ? state.front : gbm_surface_lock_front_buffer(state.window);
        CHECK(front);
        uint32_t handles[4] = {gbm_bo_get_handle(front).u32};
        uint32_t pitches[4] = {gbm_bo_get_stride(front)}, offsets[4] = {0}, fb = 0;
        if (state.render_fd != fd) {
            int prime = gbm_bo_get_fd(front);
            CHECK(prime >= 0 && drmPrimeFDToHandle(fd, prime, &handles[0]) == 0);
            CHECK(close(prime) == 0);
        }
        CHECK(drmModeAddFB2(fd, mode.hdisplay, mode.vdisplay, gbm_bo_get_format(front),
            handles, pitches, offsets, &fb, 0) == 0);
        if (state.render_fd != fd) CHECK(drmCloseBufferHandle(fd, handles[0]) == 0);
        if (frame == 0) {
            CHECK(drmModeSetCrtc(fd, state.crtc, fb, 0, 0, &connector_id, 1, &mode) == 0);
        } else {
            wait_for_flip(fd, state.crtc, fb);
            CHECK(drmModeRmFB(fd, state.framebuffer) == 0);
            if (!render_node) gbm_surface_release_buffer(state.window, state.front);
        }
        state.front = front;
        state.framebuffer = fb;
    }
    return state;
}

static void retire_display(int fd, struct rendered_display *state) {
    CHECK(drmModeSetCrtc(fd, state->crtc, 0, 0, 0, NULL, 0, NULL) == 0);
    CHECK(drmModeRmFB(fd, state->framebuffer) == 0);
    if (state->window) gbm_surface_release_buffer(state->window, state->front);
    else {
        glDeleteFramebuffers(1, &state->target);
        glDeleteRenderbuffers(1, &state->renderbuffer);
        glFlush();
        gbm_bo_destroy(state->front);
    }
    CHECK(eglMakeCurrent(state->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT));
    if (state->surface != EGL_NO_SURFACE) CHECK(eglDestroySurface(state->display, state->surface));
    CHECK(eglDestroyContext(state->display, state->context));
    CHECK(eglTerminate(state->display));
    if (state->window) gbm_surface_destroy(state->window);
    gbm_device_destroy(state->device);
    if (state->render_fd != fd) CHECK(close(state->render_fd) == 0);
}
#endif

int main(int argc, char **argv) {
    CHECK(argc == 2);
    int render_node = strcmp(argv[1], "render-node") == 0 || strcmp(argv[1], "render-node-2d") == 0;
    int render = render_node || strcmp(argv[1], "render") == 0;
    CHECK(render || strcmp(argv[1], "master") == 0 || strcmp(argv[1], "cursor") == 0);
#ifndef TEST_EGL_RENDER
    CHECK(!render);
#endif
    int fd = open("/dev/dri/card0", O_RDWR), ready[2];
    CHECK(fd >= 0 && pipe(ready) == 0);
    uint32_t magic = 0;
    CHECK(ioctl(fd, 0x80046402, &magic) == 0 && magic != 0);
    struct dumb bo = {.width = 16, .height = 16, .bpp = 32};
    CHECK(ioctl(fd, 0xc02064b2, &bo) == 0);
    struct mapping map = {.handle = bo.handle};
    CHECK(ioctl(fd, 0xc01064b3, &map) == 0);
    uint32_t *pixels = mmap(NULL, bo.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
    CHECK(pixels != MAP_FAILED);
    for (uint32_t y = 0; y < bo.height; ++y)
        for (uint32_t x = 0; x < bo.width; ++x)
            pixels[y * (bo.pitch / 4) + x] = 0xff00ff00;
    CHECK(munmap(pixels, bo.size) == 0);
    struct cursor cursor = {.flags = 3, .crtc = 1, .width = bo.width, .height = bo.height,
                            .handle = bo.handle, .x = 5, .y = 5};
    CHECK(ioctl(fd, 0xc02464bb, &cursor) == 0);
    pid_t child = fork();
    CHECK(child >= 0);
    if (child != 0) {
        CHECK(close(ready[1]) == 0);
        char byte;
        CHECK(read(ready[0], &byte, 1) == 1 && byte == 'r');
        struct planes planes = {0};
        /* The child enabled universal planes on our shared DRM file. The
         * live adapter advertises both its primary and its cursor plane. */
        CHECK(ioctl(fd, 0xc01064b5, &planes) == 0 && planes.count == 2);
        CHECK(close(ready[0]) == 0 && close(fd) == 0);
        /* The driver awaits this process's natural exit AND acknowledged
         * Worker retirement before releasing the surviving child. */
        return 0;
    }
    CHECK(close(ready[0]) == 0);
    CHECK(ioctl(fd, 0x641e, 0) == 0);
    struct client_cap cap = {.capability = 2, .value = 1};
    CHECK(ioctl(fd, 0x4010640d, &cap) == 0);
    uint32_t inherited_magic = 0;
    CHECK(ioctl(fd, 0x80046402, &inherited_magic) == 0 && inherited_magic == magic);
    printf("kms-inherited-child=%d\n", getpid());
    fflush(stdout);
    CHECK(write(ready[1], "r", 1) == 1 && close(ready[1]) == 0);
    char byte;
    CHECK(read(STDIN_FILENO, &byte, 1) == 1 && byte == 'g');
    CHECK(ioctl(fd, 0x641e, 0) == 0);
    CHECK(ioctl(fd, 0xc01064b3, &map) == 0);
    pixels = mmap(NULL, bo.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
    CHECK(pixels != MAP_FAILED && pixels[0] == 0xff00ff00);
    CHECK(munmap(pixels, bo.size) == 0);
    if (render || strcmp(argv[1], "cursor") == 0) {
        /* MOVE alone must retain the image installed by the retired opener. */
        cursor.flags = 2;
        cursor.x = 30;
        cursor.y = 40;
        CHECK(ioctl(fd, 0xc02464bb, &cursor) == 0);
    }
#ifdef TEST_EGL_RENDER
    struct rendered_display display = {0};
    if (render) display = render_frames(fd, render_node);
#endif
    printf("inherited %s after opener retirement: ready\n", argv[1]);
    fflush(stdout);
    CHECK(read(STDIN_FILENO, &byte, 1) == 1 && byte == 'q');
#ifdef TEST_EGL_RENDER
    if (render) retire_display(fd, &display);
#endif
    cursor.flags = 1;
    cursor.handle = 0;
    CHECK(ioctl(fd, 0xc02464bb, &cursor) == 0);
    struct gem_close remove = {.handle = bo.handle};
    CHECK(ioctl(fd, 0x40086409, &remove) == 0 && close(fd) == 0);
    puts("inherited KMS file: ok");
    return 0;
}
