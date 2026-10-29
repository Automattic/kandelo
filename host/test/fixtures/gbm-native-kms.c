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
#ifndef KANDELO_GBM_CPU_WINDOW_FLAGS
#define KANDELO_GBM_CPU_WINDOW_FLAGS 0
#endif
#ifndef KANDELO_GBM_WINDOW_FORMAT
#define KANDELO_GBM_WINDOW_FORMAT GBM_FORMAT_ABGR8888
#endif
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"line %d: %s errno=%d EGL=%x GL=%x\n",__LINE__,#x,errno,eglGetError(),glGetError()); exit(1); } } while (0)
static void stage(const char *name) { puts(name); fflush(stdout); char c; CHECK(read(0,&c,1) == 1); }
static void cpu_image_layouts(EGLDisplay display, struct gbm_device *device) {
    struct gbm_bo *bo=gbm_bo_create(device,4,4,GBM_FORMAT_ABGR8888,GBM_BO_USE_WRITE|GBM_BO_USE_LINEAR);
    CHECK(bo);
    uint32_t stride=0; void *token=NULL;
    unsigned char *bytes=gbm_bo_map(bo,0,0,4,4,GBM_BO_TRANSFER_READ_WRITE,&stride,&token);
    CHECK(bytes && token && stride >= 16);
    GLuint rb,fbo;glGenRenderbuffers(1,&rb);glGenFramebuffers(1,&fbo);
    const uint32_t formats[]={GBM_FORMAT_ABGR8888,GBM_FORMAT_ARGB8888,GBM_FORMAT_XBGR8888,GBM_FORMAT_XRGB8888};
    for (unsigned i=0;i<4;i++) {
        const int bgra=i==1||i==3,opaque=i>=2;
        for (unsigned j=0;j<64;j++) bytes[j]=0xa5;
        const unsigned char first[]={10,20,30,40},second[]={50,60,70,80};
        for (unsigned j=0;j<4;j++) {bytes[4+j]=first[j];bytes[28+j]=second[j];}
        int prime=gbm_bo_get_fd(bo);CHECK(prime>=0);
        /* Deliberately differs from allocator geometry and row stride. */
        const EGLint attrs[]={EGL_WIDTH,1,EGL_HEIGHT,2,EGL_LINUX_DRM_FOURCC_EXT,formats[i],
            EGL_DMA_BUF_PLANE0_FD_EXT,prime,EGL_DMA_BUF_PLANE0_OFFSET_EXT,4,EGL_DMA_BUF_PLANE0_PITCH_EXT,24,EGL_NONE};
        EGLImageKHR image=eglCreateImageKHR(display,EGL_NO_CONTEXT,EGL_LINUX_DMA_BUF_EXT,NULL,attrs);
        CHECK(image && close(prime)==0);
        glBindRenderbuffer(GL_RENDERBUFFER,rb);glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER,image);
        glBindFramebuffer(GL_FRAMEBUFFER,fbo);glFramebufferRenderbuffer(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,rb);
        CHECK(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);
        unsigned char pixels[8];glReadPixels(0,0,1,2,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
        CHECK(glGetError()==GL_NO_ERROR && pixels[0]==(bgra?30:10) && pixels[1]==20 && pixels[2]==(bgra?10:30) && pixels[3]==(opaque?255:40));
        CHECK(pixels[4]==(bgra?70:50) && pixels[5]==60 && pixels[6]==(bgra?50:70) && pixels[7]==(opaque?255:80));
        /* Keep the original application mapping live across the image's
         * separate mapping and verify that neither alias loses authority. */
        bytes[4]=99;glReadPixels(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
        CHECK(glGetError()==GL_NO_ERROR && pixels[bgra?2:0]==99);
        CHECK(eglDestroyImageKHR(display,image));
        glClearColor(1,0,0,0);glClear(GL_COLOR_BUFFER_BIT);glFinish();
        CHECK(glGetError()==GL_NO_ERROR && bytes[4]==(bgra?0:255) && bytes[5]==0 && bytes[6]==(bgra?255:0) && bytes[7]==(opaque?40:0));
        CHECK(bytes[28]==(bgra?0:255) && bytes[29]==0 && bytes[30]==(bgra?255:0) && bytes[31]==(opaque?80:0));
        CHECK(bytes[0]==0xa5 && bytes[8]==0xa5 && bytes[27]==0xa5 && bytes[32]==0xa5);
        glReadPixels(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
        CHECK(glGetError()==GL_NO_ERROR && pixels[0]==255 && pixels[1]==0 && pixels[2]==0 && pixels[3]==(opaque?255:0));
    }
    glBindFramebuffer(GL_FRAMEBUFFER,0);glDeleteFramebuffers(1,&fbo);glDeleteRenderbuffers(1,&rb);
    gbm_bo_unmap(bo,token);gbm_bo_destroy(bo);
}
int main(void) {
    int card = open("/dev/dri/card0",O_RDWR|O_CLOEXEC); CHECK(card >= 0 && drmSetMaster(card) == 0);
    drmModeRes *resources = drmModeGetResources(card); CHECK(resources && resources->count_crtcs && resources->count_connectors);
    uint32_t crtc = resources->crtcs[0], connector_id = resources->connectors[0];
    drmModeConnector *connector = drmModeGetConnector(card,connector_id); CHECK(connector && connector->count_modes);
    const unsigned W = connector->modes[0].hdisplay, H = connector->modes[0].vdisplay;
    int fd = open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC); CHECK(fd >= 0);
    struct gbm_device *device = gbm_create_device(fd); CHECK(device);
    struct gbm_surface *window = gbm_surface_create(device,W,H,KANDELO_GBM_WINDOW_FORMAT,
        GBM_BO_USE_RENDERING|GBM_BO_USE_SCANOUT|KANDELO_GBM_CPU_WINDOW_FLAGS); CHECK(window);
    EGLDisplay display = eglGetDisplay((EGLNativeDisplayType)device); CHECK(eglInitialize(display,NULL,NULL));
    EGLConfig config; EGLint count;
    const EGLint cfg[] = {EGL_SURFACE_TYPE,EGL_WINDOW_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_NONE};
    const EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    EGLConfig configs[4]; config = NULL;
    CHECK(eglChooseConfig(display,cfg,configs,4,&count) && count == 2);
    for (EGLint i = 0; i < count; ++i) {
        EGLint visual = 0;
        CHECK(eglGetConfigAttrib(display,configs[i],EGL_NATIVE_VISUAL_ID,&visual));
        if ((uint32_t)visual == KANDELO_GBM_WINDOW_FORMAT) config = configs[i];
    }
    CHECK(config != NULL);
    EGLContext context = eglCreateContext(display,config,EGL_NO_CONTEXT,attrs); CHECK(context);
    EGLSurface surface = eglCreateWindowSurface(display,config,(EGLNativeWindowType)window,NULL); CHECK(surface);
    EGLint config_id = 0, selected_id = 0;
    CHECK(eglGetConfigAttrib(display,config,EGL_CONFIG_ID,&selected_id));
    CHECK(eglQuerySurface(display,surface,EGL_CONFIG_ID,&config_id) && config_id == selected_id);
    CHECK(eglQueryContext(display,context,EGL_CONFIG_ID,&config_id) && config_id == selected_id);
    CHECK(eglMakeCurrent(display,surface,surface,context));
    glViewport(0,0,W,H); glClearColor(1,0,0,1); glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0,0,W/4,H/3); glClearColor(0,1,0,1); glClear(GL_COLOR_BUFFER_BIT);
    glScissor(3*W/4,2*H/3,W/4,H/3); glClearColor(0,0,1,1); glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
    CHECK(eglSwapBuffers(display,surface) && glGetError() == GL_NO_ERROR);
    struct gbm_bo *front = gbm_surface_lock_front_buffer(window); CHECK(front);
    const unsigned red_byte = KANDELO_GBM_WINDOW_FORMAT == GBM_FORMAT_ARGB8888 ? 2 : 0;
    const unsigned blue_byte = 2 - red_byte;
    if (KANDELO_GBM_CPU_WINDOW_FLAGS) {
        uint32_t map_pitch = 0; void *map_token = NULL;
        unsigned char *mapped = gbm_bo_map(front,0,0,W,H,GBM_BO_TRANSFER_READ,&map_pitch,&map_token);
        CHECK(mapped && map_token && map_pitch >= W*4);
        unsigned char *green = mapped + (H-1)*map_pitch;
        unsigned char *blue = mapped + (W-1)*4;
        unsigned char *red = mapped + (H/2)*map_pitch+(W/2)*4;
        CHECK(green[0] == 0 && green[1] == 255 && green[2] == 0 && green[3] == 255);
        CHECK(blue[red_byte] == 0 && blue[1] == 0 && blue[blue_byte] == 255 && blue[3] == 255);
        CHECK(red[red_byte] == 255 && red[1] == 0 && red[blue_byte] == 0 && red[3] == 255);
        gbm_bo_unmap(front,map_token);
    }
    int source_prime = gbm_bo_get_fd(front); CHECK(source_prime >= 0);
    const EGLint image_attrs[] = {EGL_WIDTH,W,EGL_HEIGHT,H,EGL_LINUX_DRM_FOURCC_EXT,KANDELO_GBM_WINDOW_FORMAT,
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
    if (KANDELO_GBM_CPU_WINDOW_FLAGS) {
        /* The sibling keeps storage alive after the public image dies. CPU
         * and GPU writers must observe each other without another import. */
        CHECK(eglDestroyImageKHR(display,image)); image = EGL_NO_IMAGE_KHR;
        uint32_t map_pitch = 0; void *map_token = NULL;
        unsigned char *mapped = gbm_bo_map(front,0,0,W,H,GBM_BO_TRANSFER_READ_WRITE,&map_pitch,&map_token);
        CHECK(mapped && map_token);
        unsigned char *middle = mapped + (H/2)*map_pitch+(W/2)*4;
        middle[0]=middle[1]=middle[2]=middle[3]=255;
        glReadPixels(W/2,H/2,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
        CHECK(glGetError() == GL_NO_ERROR && pixels[0] == 255 && pixels[1] == 255 && pixels[2] == 255 && pixels[3] == 255);
        glEnable(GL_SCISSOR_TEST); glScissor(W/2,H/2,1,1);
        glClearColor(1,1,0,1); glClear(GL_COLOR_BUFFER_BIT); glFinish();
        CHECK(glGetError() == GL_NO_ERROR && middle[red_byte] == 255 && middle[1] == 255 && middle[blue_byte] == 0 && middle[3] == 255);
        glClearColor(1,0,0,1); glClear(GL_COLOR_BUFFER_BIT); glFinish();
        CHECK(glGetError() == GL_NO_ERROR && middle[red_byte] == 255 && middle[1] == 0 && middle[blue_byte] == 0 && middle[3] == 255);
        glDisable(GL_SCISSOR_TEST); gbm_bo_unmap(front,map_token);
        cpu_image_layouts(display,device);
    }
    glBindFramebuffer(GL_FRAMEBUFFER,0); glDeleteFramebuffers(1,&fbo); glDeleteRenderbuffers(1,&rb);
    if (image) CHECK(eglDestroyImageKHR(display,image));
    stage("READY_UNSELECTED");
    int prime = gbm_bo_get_fd(front); CHECK(prime >= 0);
    uint32_t handle; CHECK(drmPrimeFDToHandle(card,prime,&handle) == 0 && close(prime) == 0);
    uint32_t handles[4] = {handle}, pitches[4] = {gbm_bo_get_stride(front)}, offsets[4] = {0}, framebuffer;
    CHECK(drmModeAddFB2(card,W,H,KANDELO_GBM_WINDOW_FORMAT,handles,pitches,offsets,&framebuffer,0) == 0);
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
