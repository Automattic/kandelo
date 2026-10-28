#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <gbm.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"line %d: %s errno=%d EGL=%x GL=%x\n",__LINE__,#x,errno,eglGetError(),glGetError()); exit(1); } } while (0)
static EGLDisplay display;
static unsigned callbacks;
static void retired(struct gbm_bo *bo, void *data) {
    CHECK(bo && data == &callbacks);
    EGLint red = -1;
    CHECK(eglGetConfigAttrib(display,(EGLConfig)1,EGL_RED_SIZE,&red) && red == 8);
    CHECK(!eglDestroySurface(display,EGL_NO_SURFACE) && eglGetError() == EGL_BAD_SURFACE);
    ++callbacks;
}
static void read_front(struct gbm_bo *bo, unsigned r, unsigned g, unsigned b) {
    int prime = gbm_bo_get_fd(bo); CHECK(prime >= 0);
    const EGLint attrs[] = {EGL_WIDTH,4,EGL_HEIGHT,3,
        EGL_LINUX_DRM_FOURCC_EXT,GBM_FORMAT_ABGR8888,
        EGL_DMA_BUF_PLANE0_FD_EXT,prime,EGL_DMA_BUF_PLANE0_OFFSET_EXT,0,
        EGL_DMA_BUF_PLANE0_PITCH_EXT,gbm_bo_get_stride(bo),EGL_NONE};
    EGLImageKHR image = eglCreateImageKHR(display,EGL_NO_CONTEXT,EGL_LINUX_DMA_BUF_EXT,NULL,attrs);
    CHECK(image && close(prime) == 0);
    GLuint renderbuffer, fbo;
    glGenRenderbuffers(1,&renderbuffer); CHECK(renderbuffer && glGetError() == GL_NO_ERROR);
    glBindRenderbuffer(GL_RENDERBUFFER,renderbuffer); CHECK(glGetError() == GL_NO_ERROR);
    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER,image); CHECK(glGetError() == GL_NO_ERROR);
    glGenFramebuffers(1,&fbo); CHECK(fbo && glGetError() == GL_NO_ERROR);
    glBindFramebuffer(GL_FRAMEBUFFER,fbo); CHECK(glGetError() == GL_NO_ERROR);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,renderbuffer); CHECK(glGetError() == GL_NO_ERROR);
    CHECK(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
    CHECK(eglDestroyImageKHR(display,image));
    unsigned char pixels[4*3*4] = {0};
    glReadPixels(0,0,4,3,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
    CHECK(glGetError() == GL_NO_ERROR);
#ifndef GBM_RING_OWNERSHIP_ONLY
    for (unsigned i = 0; i < sizeof pixels; i+=4)
        CHECK(pixels[i] == r && pixels[i+1] == g && pixels[i+2] == b && pixels[i+3] == 255);
#endif
    glBindFramebuffer(GL_FRAMEBUFFER,0);
    glDeleteFramebuffers(1,&fbo); glDeleteRenderbuffers(1,&renderbuffer);
    CHECK(glGetError() == GL_NO_ERROR);
}
int main(void) {
    int fd = open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC); CHECK(fd >= 0);
    struct gbm_device *device = gbm_create_device(fd); CHECK(device);
    struct gbm_surface *window = gbm_surface_create(device,4,3,GBM_FORMAT_ABGR8888,
        GBM_BO_USE_RENDERING|GBM_BO_USE_SCANOUT); CHECK(window);
    CHECK(gbm_surface_has_free_buffers(window) == 1);
    CHECK(!gbm_surface_lock_front_buffer(window));
    display = eglGetDisplay((EGLNativeDisplayType)device);
    CHECK(display && eglInitialize(display,NULL,NULL));
    EGLConfig config; EGLint count;
    const EGLint config_attrs[] = {EGL_SURFACE_TYPE,EGL_WINDOW_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_NONE};
    CHECK(eglChooseConfig(display,config_attrs,&config,1,&count) && count == 1);
    const EGLint context_attrs[] = {EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    EGLContext context = eglCreateContext(display,config,EGL_NO_CONTEXT,context_attrs); CHECK(context);
    EGLSurface surface = eglCreateWindowSurface(display,config,(EGLNativeWindowType)window,NULL); CHECK(surface);
    CHECK(eglMakeCurrent(display,surface,surface,context));
    gbm_device_destroy(device); CHECK(close(fd) == 0);
    struct gbm_bo *front[3];
    for (unsigned i = 0; i < 3; ++i) {
        glClearColor(i == 0,i == 1,i == 2,1); glClear(GL_COLOR_BUFFER_BIT);
        CHECK(eglSwapBuffers(display,surface));
        front[i] = gbm_surface_lock_front_buffer(window); CHECK(front[i]);
        for (unsigned j = 0; j < i; ++j) CHECK(front[j] != front[i]);
        CHECK(!gbm_surface_lock_front_buffer(window));
        gbm_bo_set_user_data(front[i],&callbacks,retired);
        for (unsigned j = 0; j <= i; ++j)
            read_front(front[j],j == 0 ? 255 : 0,j == 1 ? 255 : 0,j == 2 ? 255 : 0);
    }
    CHECK(!gbm_surface_has_free_buffers(window));
    glClearColor(1,1,0,1); glClear(GL_COLOR_BUFFER_BIT);
    CHECK(!eglSwapBuffers(display,surface) && eglGetError() == EGL_BAD_ALLOC);
    CHECK(eglGetCurrentContext() == context && glGetError() == GL_NO_ERROR);
    for (unsigned j = 0; j < 3; ++j)
        read_front(front[j],j == 0 ? 255 : 0,j == 1 ? 255 : 0,j == 2 ? 255 : 0);
    gbm_surface_release_buffer(window,front[1]);
    CHECK(gbm_surface_has_free_buffers(window) == 1);
    CHECK(eglSwapBuffers(display,surface));
    struct gbm_bo *yellow = gbm_surface_lock_front_buffer(window); CHECK(yellow);
    read_front(yellow,255,255,0);
    gbm_surface_destroy(window);
    CHECK(!callbacks);
    gbm_surface_release_buffer(window,front[0]);
    gbm_surface_release_buffer(window,front[2]);
    gbm_surface_release_buffer(window,yellow);
    CHECK(!callbacks);
    CHECK(eglDestroySurface(display,surface) && eglDestroyContext(display,context));
    CHECK(!callbacks);
    CHECK(eglReleaseThread());
    CHECK(callbacks == 3 && eglTerminate(display));
    puts("OK GBM rendered fronts survive swaps, exhaustion and retirement");
    return 0;
}
