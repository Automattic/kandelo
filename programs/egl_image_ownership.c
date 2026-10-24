/* Guest regression for EGLImage storage through the ordinary DRM/GBM path. */
#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <drm/drm_fourcc.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdio.h>
#include <unistd.h>

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#condition); return 1; \
} } while (0)
static EGLImageKHR import(EGLDisplay display, int fd) {
    const EGLint attributes[] = {
        EGL_WIDTH, 64, EGL_HEIGHT, 64,
        EGL_LINUX_DRM_FOURCC_EXT, DRM_FORMAT_ABGR8888,
        EGL_DMA_BUF_PLANE0_FD_EXT, fd,
        EGL_DMA_BUF_PLANE0_OFFSET_EXT, 0,
        EGL_DMA_BUF_PLANE0_PITCH_EXT, 256, EGL_NONE,
    };
    return eglCreateImageKHR(display,EGL_NO_CONTEXT,EGL_LINUX_DMA_BUF_EXT,
        NULL,attributes);
}
static void stage(float value) {
    glClearColor(value,0,0,1);
    glFlush();
}
int main(void) {
    int card = open("/dev/dri/card0",O_RDWR);
    CHECK(card >= 0);
    struct gbm_device *device = gbm_create_device(card);
    CHECK(device);
    EGLDisplay display = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR,device,NULL);
    CHECK(eglInitialize(display,NULL,NULL));
    const EGLint attrs[] = { EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE };
    EGLContext context = eglCreateContext(display,EGL_NO_CONFIG_KHR,EGL_NO_CONTEXT,attrs);
    CHECK(context != EGL_NO_CONTEXT);
    CHECK(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,context));
    uint64_t modifier = DRM_FORMAT_MOD_LINEAR;
    struct gbm_bo *bo = gbm_bo_create_with_modifiers2(device,64,64,
        DRM_FORMAT_ABGR8888,&modifier,1,GBM_BO_USE_RENDERING|GBM_BO_USE_SCANOUT);
    CHECK(bo);
    int prime = gbm_bo_get_fd(bo);
    CHECK(prime >= 0);
    EGLImageKHR first = import(display,prime), second = import(display,prime);
    CHECK(first != EGL_NO_IMAGE_KHR && second != EGL_NO_IMAGE_KHR);
    GLuint textures[2], renderbuffer, framebuffer;
    glGenTextures(2,textures);
    glBindTexture(GL_TEXTURE_2D,textures[0]);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,first);
    glBindTexture(GL_TEXTURE_2D,textures[1]);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,second);
    glGenRenderbuffers(1,&renderbuffer);
    glBindRenderbuffer(GL_RENDERBUFFER,renderbuffer);
    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER,first);
    CHECK(glGetError() == GL_NO_ERROR);
    gbm_bo_destroy(bo);
    close(prime);
    CHECK(eglDestroyImageKHR(display,first));
    stage(0.125f);
    CHECK(eglDestroyImageKHR(display,second));
    stage(0.25f);
    glBindTexture(GL_TEXTURE_2D,textures[0]);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,2,2,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    stage(0.375f);
    glGenFramebuffers(1,&framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER,framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,
        GL_TEXTURE_2D,textures[1],0);
    glBindFramebuffer(GL_FRAMEBUFFER,0);
    glDeleteTextures(2,textures);
    glDeleteRenderbuffers(1,&renderbuffer);
    stage(0.5f);
    glDeleteFramebuffers(1,&framebuffer);
    stage(0.625f);
    CHECK(!eglDestroyImageKHR(display,first));
    CHECK(eglGetError() == EGL_BAD_PARAMETER);
    CHECK(eglDestroyContext(display,context));
    CHECK(eglReleaseThread());
    CHECK(eglTerminate(display));
    gbm_device_destroy(device);
    close(card);
    puts("OK image ownership");
    return 0;
}
