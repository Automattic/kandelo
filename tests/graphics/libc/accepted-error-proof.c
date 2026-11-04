/* Ordinary SDK probe: accepted synchronous mutations preserve an exact error
 * proof. Bind requests still execute synchronously; this is not async B2. */
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "gl_abi.h"
int main(int argc,char **argv) {
    assert(argc == 2);
    EGLDisplay display=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(display != EGL_NO_DISPLAY);
    if (!strcmp(argv[1],"no-renderer")) {
        assert(!eglInitialize(display,NULL,NULL) && eglGetError()==EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal");return 0;
    }
    const int local=!strcmp(argv[1],"after");
    assert(eglInitialize(display,NULL,NULL));
    const EGLint configs[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_NONE};
    EGLConfig config;EGLint count;assert(eglChooseConfig(display,configs,&config,1,&count) && count==1);
    const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    const EGLint size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
    EGLContext context=eglCreateContext(display,config,EGL_NO_CONTEXT,attrs);
    EGLSurface surface=eglCreatePbufferSurface(display,config,size);
    assert(context!=EGL_NO_CONTEXT && surface!=EGL_NO_SURFACE && eglMakeCurrent(display,surface,surface,context));
    GLuint buffers[2],textures[2];glGenBuffers(2,buffers);glGenTextures(2,textures);
    for(unsigned i=0;i<2;i++){glBindBuffer(GL_ARRAY_BUFFER,buffers[i]);glBindTexture(GL_TEXTURE_2D,textures[i]);}
    assert(glGetError()==GL_NO_ERROR);
    uint64_t start=_wpk_gl_device_requests();
    for(unsigned i=0;i<16;i++){
        glBindBuffer(GL_ARRAY_BUFFER,buffers[i%2]);assert(glGetError()==GL_NO_ERROR);
        glBindTexture(GL_TEXTURE_2D,textures[i%2]);assert(glGetError()==GL_NO_ERROR);
    }
    const uint64_t requests=_wpk_gl_device_requests()-start;
    printf("ACCEPTED_REQUESTS mutations=32 requests=%llu\n",(unsigned long long)requests);
    assert(requests==(local?32:64));
    start=_wpk_gl_device_requests();
    glEnable(0xdead);
    glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);
    assert(glGetError()==GL_INVALID_ENUM && glGetError()==GL_NO_ERROR);
    glEnable(0xdead);assert(glGetError()==GL_INVALID_ENUM && glGetError()==GL_NO_ERROR);
    glBindTexture(GL_TEXTURE_2D,textures[0]);assert(glGetError()==GL_NO_ERROR);
    if(local)assert(_wpk_gl_device_requests()-start==2);
    glFinish();assert(glGetError()==GL_NO_ERROR);
    /* Unknown commands and separate client trailers still require a drain. */
    start=_wpk_gl_device_requests();
    glClear(0x80000000u);glBindBuffer(GL_ARRAY_BUFFER,buffers[1]);
    assert(glGetError()==GL_INVALID_VALUE && glGetError()==GL_NO_ERROR);
    assert(_wpk_gl_device_requests()-start==2);
    start=_wpk_gl_device_requests();
    glBindBuffer(0xdead,0);glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);
    assert(glGetError()==GL_INVALID_ENUM && glGetError()==GL_NO_ERROR);
    assert(_wpk_gl_device_requests()-start==3);
    /* A normal state query provides no mutation-acceptance receipt. */
    start=_wpk_gl_device_requests();GLint bound=0;glGetIntegerv(GL_ARRAY_BUFFER_BINDING,&bound);
    assert((GLuint)bound==buffers[0] && glGetError()==GL_NO_ERROR);
    assert(_wpk_gl_device_requests()-start==2);
    glDeleteBuffers(2,buffers);glDeleteTextures(2,textures);assert(glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroySurface(display,surface) && eglDestroyContext(display,context));
    assert(eglTerminate(display) && eglReleaseThread());
    puts("PASS accepted mutation error proof and conservative fallbacks");return 0;
}
