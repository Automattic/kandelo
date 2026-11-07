/* SDK consumer: ordered defaults keep independent host validation. */
#define EGL_EGLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "gl_abi.h"
static void pixel(unsigned r,unsigned g,unsigned b) {
    unsigned char out[4]={0};glReadPixels(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,out);
    assert(glGetError()==GL_NO_ERROR);
    assert(out[0]+1>=r && out[0]<=r+1 && out[1]+1>=g && out[1]<=g+1);
    assert(out[2]+1>=b && out[2]<=b+1 && out[3]==255);
}
int main(int argc,char **argv) {
    assert(argc==2);
    EGLDisplay d=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(d!=EGL_NO_DISPLAY);
    if(!strcmp(argv[1],"no-renderer")) {
        assert(!eglInitialize(d,NULL,NULL) && eglGetError()==EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal");return 0;
    }
    const int after=!strcmp(argv[1],"after");assert(eglInitialize(d,NULL,NULL));
    const EGLint configAttrs[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    EGLConfig config;EGLint n;assert(eglChooseConfig(d,configAttrs,&config,1,&n) && n==1);
    const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    const EGLint size[]={EGL_WIDTH,4,EGL_HEIGHT,4,EGL_NONE};
    EGLContext context=eglCreateContext(d,config,EGL_NO_CONTEXT,attrs);
    EGLSurface a=eglCreatePbufferSurface(d,config,size),b=eglCreatePbufferSurface(d,config,size);
    assert(context!=EGL_NO_CONTEXT && a!=EGL_NO_SURFACE && b!=EGL_NO_SURFACE);
    assert(eglMakeCurrent(d,a,a,context));glClearColor(.2f,.6f,.8f,1);
    assert(glGetError()==GL_NO_ERROR);
    uint64_t start=_wpk_gl_device_requests();
    for(unsigned i=0;i<16;i++) {
        glBindFramebuffer(GL_FRAMEBUFFER,0);assert(glGetError()==GL_NO_ERROR);
        glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);
    }
    uint64_t requests=_wpk_gl_device_requests()-start;
    printf("DEFAULT_TARGET_REQUESTS commands=32 requests=%llu\n",(unsigned long long)requests);
    assert(requests==(after?0u:32u));
    glClear(0x80000000u);assert(glGetError()==GL_INVALID_VALUE && glGetError()==GL_NO_ERROR);
    pixel(51,153,204);
    /* Logical zero must select distinct EGL draw/read storage independently. */
    assert(eglMakeCurrent(d,b,b,context));glClearColor(.6f,.2f,.4f,1);glClear(GL_COLOR_BUFFER_BIT);
    pixel(153,51,102);
    assert(eglMakeCurrent(d,a,b,context));glBindFramebuffer(GL_FRAMEBUFFER,0);pixel(153,51,102);
    glClearColor(.4f,.8f,.2f,1);glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);
    pixel(153,51,102);
    assert(eglMakeCurrent(d,a,a,context));pixel(102,204,51);
    /* A nonzero target must still use its own completeness, even after zero
     * was locally proven. Returning to zero may rearm its independent proof;
     * treating that as an "ever default" bit would hide the incomplete FBO. */
    glBindFramebuffer(GL_FRAMEBUFFER,17);assert(glGetError()==GL_NO_ERROR);
    assert(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT);
    glClear(GL_COLOR_BUFFER_BIT);
    assert(glGetError()==GL_INVALID_FRAMEBUFFER_OPERATION && glGetError()==GL_NO_ERROR);
    glBindFramebuffer(GL_FRAMEBUFFER,0);assert(glGetError()==GL_NO_ERROR);
    start=_wpk_gl_device_requests();glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);
    assert(_wpk_gl_device_requests()==start+(after?0u:1u));
    pixel(102,204,51);
    assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,context));assert(glGetError()==GL_NO_ERROR);
    glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_INVALID_FRAMEBUFFER_OPERATION && glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(d,a,a,context));glClear(GL_COLOR_BUFFER_BIT);pixel(102,204,51);
    glDeleteFramebuffers(1,(const GLuint[]){17});
    assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroyContext(d,context) && eglDestroySurface(d,a) && eglDestroySurface(d,b));
    assert(eglTerminate(d) && eglReleaseThread());
    puts("PASS default target errors, split draw/read and zero rearm");return 0;
}
