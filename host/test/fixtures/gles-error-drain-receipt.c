/* Real error flags enter through ordinary GL command submission, without a
 * client-side mirror. Only the reply transport is fault-injected by the host
 * fixture. Recovered flags, repetition and rendering use the normal SDK. */
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include "../../../libc/glue/gl_abi.h"
static void host_flags(void) {
    glFlush();
    const uint32_t wire[]={OP_ENABLE|(4u<<16),0xdead,
        OP_VIEWPORT|(16u<<16),0,0,UINT32_MAX,1};
    memcpy(_wpk_gl_cmdbuf_base(),wire,sizeof wire);
    struct gl_submit_info submit={.length=sizeof wire};
    _wpk_gl_note_device_request();
    assert(!ioctl(_wpk_gl_fd(),GLIO_SUBMIT,&submit));
}
int main(int argc,char **argv) {
    /* Raw receipt/fault controls own admission explicitly. */
    assert(!setenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION","1",1));
    assert(argc==2);EGLDisplay d=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(d!=EGL_NO_DISPLAY);
    if(!strcmp(argv[1],"no-renderer")){
        assert(!eglInitialize(d,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);
        puts("PASS no renderer refuses error-drain guest");return 0;
    }
    assert(eglInitialize(d,NULL,NULL));
    const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    EGLConfig config;EGLint count;assert(eglChooseConfig(d,choose,&config,1,&count)&&count==1);
    const EGLint attributes[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE},size[]={EGL_WIDTH,4,EGL_HEIGHT,4,EGL_NONE};
    EGLContext c=eglCreateContext(d,config,EGL_NO_CONTEXT,attributes);assert(c!=EGL_NO_CONTEXT);
    EGLSurface s=eglCreatePbufferSurface(d,config,size);assert(s!=EGL_NO_SURFACE&&eglMakeCurrent(d,s,s,c));
    assert(glGetError()==GL_NO_ERROR);host_flags();
    puts("ARM");fflush(stdout);char input[8];assert(fgets(input,sizeof input,stdin));
    const int failure=strcmp(argv[1],"none");
    if(failure)assert(glGetError()==GL_INVALID_OPERATION);
    if(!strcmp(argv[1],"read-lost"))assert(glGetError()==GL_INVALID_OPERATION);
    /* VALUE still coalesces before observation. ENUM after its observation
     * must be reported anew, even across the failed transport boundary. */
    glViewport(0,0,-1,1);
    assert(glGetError()==GL_INVALID_ENUM);
    glEnable(0xdead);glViewport(0,0,-1,1);
    assert(glGetError()==GL_INVALID_VALUE);
    assert(glGetError()==GL_INVALID_ENUM&&glGetError()==GL_NO_ERROR);
    glViewport(0,0,4,4);glClearColor(.2f,.4f,.6f,1);glClear(GL_COLOR_BUFFER_BIT);
    unsigned char pixel[4]={0};glReadPixels(1,1,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
    assert(pixel[0]==51&&pixel[1]==102&&pixel[2]==153&&pixel[3]==255);
    assert(glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroySurface(d,s)&&eglDestroyContext(d,c)&&eglReleaseThread()&&eglTerminate(d));
    puts("PASS error drain preserves flags without replay");return 0;
}
