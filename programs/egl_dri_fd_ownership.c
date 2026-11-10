/* Public DRM/EGL ownership regression. The only private accessor observes
 * the driver's existing render-fd export; no lease protocol is assumed. */
#define EGL_EGLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <drm/drm.h>
#include <drm/drm_fourcc.h>
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>
extern int _wpk_gl_fd(void);
extern unsigned wpkEglImportDmabufHandle(EGLDisplay,int,uint32_t);
extern unsigned wpkEglBindBoTexture(EGLDisplay,unsigned,unsigned);
extern void wpkEglCloseBoHandle(EGLDisplay,unsigned);
#define CHECK(x) do {if(!(x)){fprintf(stderr,"FAIL line %d: %s errno=%d EGL=0x%x\n",__LINE__,#x,errno,eglGetError());return 1;}}while(0)
static int export_exists(int fd,uint32_t handle) {
    struct drm_prime_handle request={.handle=handle,.flags=O_CLOEXEC|O_RDWR,.fd=-1};
    if(ioctl(fd,DRM_IOCTL_PRIME_HANDLE_TO_FD,&request)!=0)return 0;
    return request.fd>=0&&close(request.fd)==0;
}
int main(void) {
    int card=open("/dev/dri/card0",O_RDWR|O_CLOEXEC);CHECK(card>=0);
    struct gbm_device *device=gbm_create_device(card);CHECK(device);
    EGLDisplay display=eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR,device,NULL);
    CHECK(display!=EGL_NO_DISPLAY&&eglInitialize(display,NULL,NULL));
    EGLint attributes[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    EGLContext context=eglCreateContext(display,EGL_NO_CONFIG_KHR,EGL_NO_CONTEXT,attributes);
    CHECK(context!=EGL_NO_CONTEXT&&eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,context));
    struct gbm_bo *bo=gbm_bo_create(device,64,64,DRM_FORMAT_ABGR8888,GBM_BO_USE_WRITE|GBM_BO_USE_LINEAR);
    CHECK(bo);int prime=gbm_bo_get_fd(bo);CHECK(prime>=0);
    unsigned original=wpkEglImportDmabufHandle(display,prime,DRM_FORMAT_ABGR8888);CHECK(original);
    unsigned texture=wpkEglBindBoTexture(display,original,GL_TEXTURE_2D);CHECK(texture);
    glBindTexture(GL_TEXTURE_2D,texture);glFlush();CHECK(glGetError()==GL_NO_ERROR);
    int observed=_wpk_gl_fd();CHECK(observed>=0&&close(observed)==0);
    int fresh=open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC);CHECK(fresh>=0);
    /* dup2 makes the numeric-name collision causal even when other library
     * descriptors have been closed. It cannot change the old OFD's owner. */
    if(fresh!=observed){CHECK(dup2(fresh,observed)==observed);CHECK(close(fresh)==0);}
    struct drm_prime_handle replacement={.fd=prime};
    CHECK(ioctl(observed,DRM_IOCTL_PRIME_FD_TO_HANDLE,&replacement)==0);
    CHECK(replacement.handle==original&&export_exists(observed,replacement.handle));
    wpkEglCloseBoHandle(display,original);
    CHECK(export_exists(observed,replacement.handle));
    /* Old-context work stays on its original session even though the fd
     * number now names a different render file and GEM namespace. */
    glClearColor(.25f,.5f,.75f,1.f);glFlush();CHECK(glGetError()==GL_NO_ERROR);
    glDeleteTextures(1,&texture);glFlush();CHECK(glGetError()==GL_NO_ERROR);
    CHECK(eglDestroyContext(display,context)&&eglReleaseThread()&&eglTerminate(display));
    CHECK(fcntl(observed,F_GETFD)>=0&&export_exists(observed,replacement.handle));
    struct drm_gem_close close_bo={.handle=replacement.handle};
    CHECK(ioctl(observed,DRM_IOCTL_GEM_CLOSE,&close_bo)==0&&close(observed)==0);
    CHECK(close(prime)==0);gbm_bo_destroy(bo);gbm_device_destroy(device);CHECK(close(card)==0);
    puts("OK exact DRI file ownership");return 0;
}
