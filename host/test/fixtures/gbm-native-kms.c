#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <gbm.h>
#include <libdrm/xf86drm.h>
#include <libdrm/xf86drmMode.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"line %d: %s errno=%d EGL=%x GL=%x\n",__LINE__,#x,errno,eglGetError(),glGetError()); exit(1); } } while (0)
static void stage(const char *name) { puts(name); fflush(stdout); char c; CHECK(read(0,&c,1) == 1); }
int main(void) {
    int card = open("/dev/dri/card0",O_RDWR|O_CLOEXEC); CHECK(card >= 0 && drmSetMaster(card) == 0);
    drmModeRes *resources = drmModeGetResources(card); CHECK(resources && resources->count_crtcs && resources->count_connectors);
    uint32_t crtc = resources->crtcs[0], connector_id = resources->connectors[0];
    drmModeConnector *connector = drmModeGetConnector(card,connector_id); CHECK(connector && connector->count_modes);
    const unsigned W = connector->modes[0].hdisplay, H = connector->modes[0].vdisplay;
    int fd = open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC); CHECK(fd >= 0);
    struct gbm_device *device = gbm_create_device(fd); CHECK(device);
    struct gbm_surface *window = gbm_surface_create(device,W,H,GBM_FORMAT_ABGR8888,
        GBM_BO_USE_RENDERING|GBM_BO_USE_SCANOUT); CHECK(window);
    EGLDisplay display = eglGetDisplay((EGLNativeDisplayType)device); CHECK(eglInitialize(display,NULL,NULL));
    EGLConfig config; EGLint count;
    const EGLint cfg[] = {EGL_SURFACE_TYPE,EGL_WINDOW_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_NONE};
    const EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    CHECK(eglChooseConfig(display,cfg,&config,1,&count) && count == 1);
    EGLContext context = eglCreateContext(display,config,EGL_NO_CONTEXT,attrs); CHECK(context);
    EGLSurface surface = eglCreateWindowSurface(display,config,(EGLNativeWindowType)window,NULL); CHECK(surface);
    CHECK(eglMakeCurrent(display,surface,surface,context));
    glViewport(0,0,W,H); glClearColor(1,0,0,1); glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0,0,W/4,H/3); glClearColor(0,1,0,1); glClear(GL_COLOR_BUFFER_BIT);
    glScissor(3*W/4,2*H/3,W/4,H/3); glClearColor(0,0,1,1); glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
    CHECK(eglSwapBuffers(display,surface) && glGetError() == GL_NO_ERROR);
    struct gbm_bo *front = gbm_surface_lock_front_buffer(window); CHECK(front);
    int source_prime = gbm_bo_get_fd(front); CHECK(source_prime >= 0);
    const EGLint image_attrs[] = {EGL_WIDTH,W,EGL_HEIGHT,H,EGL_LINUX_DRM_FOURCC_EXT,GBM_FORMAT_ABGR8888,
        EGL_DMA_BUF_PLANE0_FD_EXT,source_prime,EGL_DMA_BUF_PLANE0_OFFSET_EXT,0,
        EGL_DMA_BUF_PLANE0_PITCH_EXT,gbm_bo_get_stride(front),EGL_NONE};
    EGLImageKHR image = eglCreateImageKHR(display,EGL_NO_CONTEXT,EGL_LINUX_DMA_BUF_EXT,NULL,image_attrs);
    CHECK(image && close(source_prime) == 0);
    GLuint rb,fbo; glGenRenderbuffers(1,&rb); glBindRenderbuffer(GL_RENDERBUFFER,rb);
    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER,image);
    glGenFramebuffers(1,&fbo); glBindFramebuffer(GL_FRAMEBUFFER,fbo);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,rb);
    CHECK(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
    /* Raw linear BO row zero is the top row, independently of window GL coordinates. */
    unsigned char pixels[4]; glReadPixels(0,H-1,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
    CHECK(glGetError() == GL_NO_ERROR && pixels[0] == 0 && pixels[1] == 255 && pixels[2] == 0);
    glReadPixels(W-1,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
    CHECK(glGetError() == GL_NO_ERROR && pixels[0] == 0 && pixels[1] == 0 && pixels[2] == 255 && pixels[3] == 255);
    glBindFramebuffer(GL_FRAMEBUFFER,0); glDeleteFramebuffers(1,&fbo); glDeleteRenderbuffers(1,&rb);
    CHECK(eglDestroyImageKHR(display,image));
    stage("READY_UNSELECTED");
    int prime = gbm_bo_get_fd(front); CHECK(prime >= 0);
    uint32_t handle; CHECK(drmPrimeFDToHandle(card,prime,&handle) == 0 && close(prime) == 0);
    uint32_t handles[4] = {handle}, pitches[4] = {gbm_bo_get_stride(front)}, offsets[4] = {0}, framebuffer;
    CHECK(drmModeAddFB2(card,W,H,GBM_FORMAT_ABGR8888,handles,pitches,offsets,&framebuffer,0) == 0);
    CHECK(drmCloseBufferHandle(card,handle) == 0);
    CHECK(drmModeSetCrtc(card,crtc,framebuffer,0,0,&connector_id,1,&connector->modes[0]) == 0);
    stage("READY_SELECTED");
    CHECK(drmModeSetCrtc(card,crtc,0,0,0,NULL,0,NULL) == 0);
    CHECK(drmModeRmFB(card,framebuffer) == 0);
    drmModeFreeConnector(connector); drmModeFreeResources(resources);
    gbm_surface_release_buffer(window,front);
    CHECK(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    CHECK(eglDestroySurface(display,surface) && eglDestroyContext(display,context) && eglTerminate(display));
    gbm_surface_destroy(window); gbm_device_destroy(device);
    CHECK(close(fd) == 0 && drmDropMaster(card) == 0 && close(card) == 0);
    puts("OK native window reaches KMS only after selection");
    return 0;
}
