#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <drm/drm.h>
#include <errno.h>
#include <pthread.h>
#include <drm/drm_fourcc.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../libc/glue/gl_abi.h"
#include "../libc/glue/drm_owned.h"
static int pixels;
static void draw(float r,float g,float b){
    glViewport(0,0,8,8);glClearColor(r,g,b,1);glClear(GL_COLOR_BUFFER_BIT);glFinish();assert(glGetError()==GL_NO_ERROR);
    if(pixels){
        unsigned char p[4]={0};glReadPixels(4,4,1,1,GL_RGBA,GL_UNSIGNED_BYTE,p);
        assert(p[0]==(unsigned)(r*255)&&p[1]==(unsigned)(g*255)&&p[2]==(unsigned)(b*255)&&p[3]==255&&glGetError()==GL_NO_ERROR);
    }
}
static EGLImageKHR image_from_prime(EGLDisplay display,int prime){
    const EGLint attributes[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_LINUX_DRM_FOURCC_EXT,DRM_FORMAT_ARGB8888,
        EGL_DMA_BUF_PLANE0_FD_EXT,prime,EGL_DMA_BUF_PLANE0_PITCH_EXT,64,EGL_DMA_BUF_PLANE0_OFFSET_EXT,0,EGL_NONE};
    EGLImageKHR image=eglCreateImageKHR(display,EGL_NO_CONTEXT,EGL_LINUX_DMA_BUF_EXT,NULL,attributes);assert(image!=EGL_NO_IMAGE_KHR);return image;
}
/* Target ownership evidence uses actual Wasm pthread/TLS/fork, device
 * transport, and BO exports. The private driver API exposes ownership kinds
 * without adding a production test hook or trusting C reference counters. */
struct borrow_peer {
    EGLDisplay display;
    EGLContext context;
    EGLImageKHR image;
    int ready, proceed;
};
static void send_byte(int fd) {
    const unsigned char byte = 0x63;
    ssize_t result;
    do result = write(fd, &byte, 1); while (result < 0 && errno == EINTR);
    assert(result == 1);
}
static void receive_byte(int fd) {
    unsigned char byte = 0;
    ssize_t result;
    do result = read(fd, &byte, 1); while (result < 0 && errno == EINTR);
    assert(result == 1 && byte == 0x63);
}
static void *hold_peer_borrow(void *pointer) {
    struct borrow_peer *peer = pointer;
    assert(eglMakeCurrent(peer->display, EGL_NO_SURFACE, EGL_NO_SURFACE, peer->context));
    struct wpk_egl_image_borrow *borrow = NULL;
    assert(_wpk_egl_image_borrow_lookup(peer->image, &borrow));
    send_byte(peer->ready);
    receive_byte(peer->proceed);
    _wpk_egl_image_borrow_release(&borrow);
    assert(!borrow && eglReleaseThread());
    return NULL;
}
static void export_pattern(struct wpk_drm_owner *observer, uint32_t handle,
                           struct gbm_device *device, uint32_t expected) {
    struct drm_prime_handle request = {.handle = handle, .flags = O_CLOEXEC | O_RDWR, .fd = -1};
    /* No BO proof: this intentionally resolves the real public GEM name on
     * the exact original file. A retained BO capability would keep it alive
     * and could conceal the very leaked image reference being tested. */
    assert(_wpk_drm_owned_ioctl(observer, DRM_IOCTL_PRIME_HANDLE_TO_FD,
        &request, sizeof request, NULL, 0, NULL) == 0 && request.fd >= 0);
    struct gbm_import_fd_data data = {.fd = request.fd, .width = 16, .height = 16,
        .stride = 64, .format = DRM_FORMAT_ARGB8888};
    struct gbm_bo *copy = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, GBM_BO_USE_WRITE);
    assert(copy && close(request.fd) == 0);
    uint32_t stride;
    void *mapping = NULL;
    const uint32_t *bytes = gbm_bo_map(copy, 0, 0, 16, 16, GBM_BO_TRANSFER_READ, &stride, &mapping);
    assert(bytes && stride >= 64 && bytes[0] == expected);
    gbm_bo_unmap(copy, mapping);
    gbm_bo_destroy(copy);
}
static void export_absent(struct wpk_drm_owner *observer, uint32_t handle) {
    struct drm_prime_handle request = {.handle = handle, .flags = O_CLOEXEC | O_RDWR, .fd = -1};
    errno = 0;
    int result = _wpk_drm_owned_ioctl(observer, DRM_IOCTL_PRIME_HANDLE_TO_FD,
        &request, sizeof request, NULL, 0, NULL);
    int error = errno;
    if (result == 0 && request.fd >= 0) assert(close(request.fd) == 0);
    assert(result == -1 && error == ENOENT);
}
static void borrow_fork_round(EGLDisplay display, struct gbm_device *device,
                             EGLConfig config, EGLContext original, int card, unsigned order) {
    const uint32_t pattern = UINT32_C(0x6312ab40) + order;
    struct gbm_bo *source = gbm_bo_create(device, 16, 16, DRM_FORMAT_ARGB8888,
        GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR);
    assert(source);
    uint32_t stride;
    void *mapping = NULL;
    uint32_t *bytes = gbm_bo_map(source, 0, 0, 16, 16, GBM_BO_TRANSFER_WRITE, &stride, &mapping);
    assert(bytes && stride >= 64);
    bytes[0] = pattern;
    gbm_bo_unmap(source, mapping);
    int prime = gbm_bo_get_fd(source);
    assert(prime >= 0);
    EGLImageKHR image = image_from_prime(display, prime);
    assert(close(prime) == 0);
    gbm_bo_destroy(source);

    struct wpk_egl_image_borrow *caller_borrow = NULL;
    struct wpk_egl_image *storage = _wpk_egl_image_borrow_lookup(image, &caller_borrow);
    assert(storage);
    _wpk_egl_image_retain(storage); /* explicit process-storage ownership */
    uint32_t handle = storage->handle;
    assert(handle);
    struct wpk_drm_owner *observer = NULL;
    int render_fd = _wpk_gl_fd();
    assert(render_fd >= 0 && _wpk_drm_owned_acquire(render_fd, 0, &observer) == 0);
    assert(close(render_fd) == 0);

    GLuint texture;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, image);
    glFinish();
    assert(glGetError() == GL_NO_ERROR); /* actual published renderer hold */
    export_pattern(observer, handle, device, pattern);

    const EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    const EGLint size[] = {EGL_WIDTH, 8, EGL_HEIGHT, 8, EGL_NONE};
    EGLContext peer_context = eglCreateContext(display, config, original, attrs);
    assert(peer_context != EGL_NO_CONTEXT);
    int peer_ready[2], peer_proceed[2], child_ready[2], child_proceed[2];
    assert(pipe(peer_ready) == 0 && pipe(peer_proceed) == 0 &&
           pipe(child_ready) == 0 && pipe(child_proceed) == 0);
    struct borrow_peer peer = {display, peer_context, image, peer_ready[1], peer_proceed[0]};
    pthread_t thread;
    assert(pthread_create(&thread, NULL, hold_peer_borrow, &peer) == 0);
    receive_byte(peer_ready[0]);
    pid_t child = fork();
    assert(child >= 0);
    if (!child) {
        alarm(30);
        assert(close(peer_ready[0]) == 0 && close(peer_ready[1]) == 0 &&
               close(peer_proceed[0]) == 0 && close(peer_proceed[1]) == 0 &&
               close(child_ready[0]) == 0 && close(child_proceed[1]) == 0);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT && eglInitialize(display, NULL, NULL));
        const EGLint choose[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
            EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_RED_SIZE, 8,
            EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
        EGLConfig fresh;
        EGLint count;
        assert(eglChooseConfig(display, choose, &fresh, 1, &count) && count == 1);
        EGLContext context = eglCreateContext(display, fresh, EGL_NO_CONTEXT, attrs);
        EGLSurface target = eglCreatePbufferSurface(display, fresh, size);
        assert(context != EGL_NO_CONTEXT && target != EGL_NO_SURFACE &&
               eglMakeCurrent(display, target, target, context));
        draw(0, 1, 0);
        assert(eglDestroyImageKHR(display, image));
        export_pattern(observer, handle, device, pattern);
        send_byte(child_ready[1]);
        receive_byte(child_proceed[0]);
        /* The parent must retire its own image cap first: cross-process GEM
         * name custody correctly keeps the name live while ANY process owns
         * it. Otherwise a leaked vanished-peer hold would be unobservable. */
        export_pattern(observer, handle, device, pattern);
        if (order == 0) _wpk_egl_image_release(storage);
        else _wpk_egl_image_borrow_release(&caller_borrow);
        export_pattern(observer, handle, device, pattern);
        if (order == 0) _wpk_egl_image_borrow_release(&caller_borrow);
        else _wpk_egl_image_release(storage);
        assert(!caller_borrow);
        export_absent(observer, handle);
        assert(_wpk_drm_owned_release(&observer) == 0 && !observer);
        assert(eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT) &&
               eglDestroySurface(display, target) && eglDestroyContext(display, context) &&
               eglTerminate(display) && eglReleaseThread());
        gbm_device_destroy(device);
        assert(close(card) == 0 && close(child_ready[1]) == 0 && close(child_proceed[0]) == 0);
        _exit(0);
    }
    assert(close(child_ready[1]) == 0 && close(child_proceed[0]) == 0);
    receive_byte(child_ready[0]);
    assert(eglGetCurrentContext() == original);
    draw(0, 0, 1); /* child's reinitialization cannot destroy the parent */
    export_pattern(observer, handle, device, pattern);
    send_byte(peer_proceed[1]);
    assert(pthread_join(thread, NULL) == 0 && eglDestroyContext(display, peer_context));
    assert(eglDestroyImageKHR(display, image));
    glDeleteTextures(1, &texture);
    glFinish();
    assert(glGetError() == GL_NO_ERROR);
    _wpk_egl_image_borrow_release(&caller_borrow);
    _wpk_egl_image_release(storage);
    export_pattern(observer, handle, device, pattern); /* child's live cap */
    assert(_wpk_drm_owned_release(&observer) == 0 && !observer);
    send_byte(child_proceed[1]);
    int status;
    assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    assert(close(peer_ready[0]) == 0 && close(peer_ready[1]) == 0 &&
           close(peer_proceed[0]) == 0 && close(peer_proceed[1]) == 0 &&
           close(child_ready[0]) == 0 && close(child_proceed[1]) == 0);
    draw(1, 0, 0);
}
int main(int argc,char **argv){
    assert(argc==2);
    int borrow_mode=!strcmp(argv[1],"borrow-protocol")||!strcmp(argv[1],"borrow-pixels");
    pixels=!strcmp(argv[1],"pixels")||!strcmp(argv[1],"borrow-pixels");
    assert(pixels||!strcmp(argv[1],"protocol")||borrow_mode);
    int card=open("/dev/dri/card0",O_RDWR|O_CLOEXEC);assert(card>=0);
    struct gbm_device *device=gbm_create_device(card);assert(device);
    EGLDisplay display=eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR,device,NULL);assert(display!=EGL_NO_DISPLAY&&eglInitialize(display,NULL,NULL));
    const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    EGLConfig config;EGLint count;assert(eglChooseConfig(display,choose,&config,1,&count)&&count==1);
    const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE},size[]={EGL_WIDTH,8,EGL_HEIGHT,8,EGL_NONE};
    EGLContext original=eglCreateContext(display,config,EGL_NO_CONTEXT,attrs);EGLSurface surface=eglCreatePbufferSurface(display,config,size);
    assert(original!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE&&eglMakeCurrent(display,surface,surface,original));
    if(borrow_mode){
        borrow_fork_round(display,device,config,original,card,0);
        borrow_fork_round(display,device,config,original,card,1);
        assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroySurface(display,surface)&&eglDestroyContext(display,original)&&eglTerminate(display)&&eglReleaseThread());
        gbm_device_destroy(device);assert(close(card)==0);
        puts("OK target image borrow fork custody");return 0;
    }
    struct gbm_bo *bo=gbm_bo_create(device,16,16,DRM_FORMAT_ARGB8888,GBM_BO_USE_WRITE|GBM_BO_USE_LINEAR);assert(bo);
    int prime=gbm_bo_get_fd(bo);assert(prime>=0);EGLImageKHR image=image_from_prime(display,prime);
    GLuint texture;glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,image);glFlush();assert(glGetError()==GL_NO_ERROR);
    draw(1,0,0);
    pid_t child=fork();assert(child>=0);
    if(!child){
        alarm(20);assert(eglGetCurrentContext()==EGL_NO_CONTEXT);
        /* Repeated initialize must create and then report a real child
         * renderer, never reuse the parent's cached initialized boolean. */
        assert(eglInitialize(display,NULL,NULL)&&eglInitialize(display,NULL,NULL));
        assert(!eglMakeCurrent(display,surface,surface,original)&&eglGetError()==EGL_BAD_CONTEXT);
        assert(!eglDestroyContext(display,original)&&eglGetError()==EGL_BAD_CONTEXT);
        struct gbm_bo *retained=gbm_bo_import(device,GBM_BO_IMPORT_EGL_IMAGE,image,GBM_BO_USE_WRITE);assert(retained);gbm_bo_destroy(retained);
        EGLConfig fresh;assert(eglChooseConfig(display,choose,&fresh,1,&count)&&count==1);
        EGLContext context=eglCreateContext(display,fresh,EGL_NO_CONTEXT,attrs);EGLSurface target=eglCreatePbufferSurface(display,fresh,size);
        assert(context!=EGL_NO_CONTEXT&&target!=EGL_NO_SURFACE&&eglMakeCurrent(display,target,target,context));
        GLuint sibling;glGenTextures(1,&sibling);glBindTexture(GL_TEXTURE_2D,sibling);glEGLImageTargetTexture2DOES(GL_TEXTURE_2D,image);glFlush();assert(glGetError()==GL_NO_ERROR);
        draw(0,1,0);glDeleteTextures(1,&sibling);glFlush();assert(glGetError()==GL_NO_ERROR&&eglDestroyImageKHR(display,image));
        assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroySurface(display,target)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
        gbm_bo_destroy(bo);gbm_device_destroy(device);assert(close(prime)==0&&close(card)==0);_exit(0);
    }
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    /* Child teardown must not publish parent destroys or consume its BO/name. */
    draw(0,0,1);glBindTexture(GL_TEXTURE_2D,texture);glDeleteTextures(1,&texture);glFlush();assert(glGetError()==GL_NO_ERROR&&eglDestroyImageKHR(display,image));
    assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroySurface(display,surface)&&eglDestroyContext(display,original)&&eglTerminate(display)&&eglReleaseThread());
    gbm_bo_destroy(bo);gbm_device_destroy(device);assert(close(prime)==0&&close(card)==0);
    puts("OK EGL child renderer and inherited storage");return 0;
}
