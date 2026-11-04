/* Normal SDK consumer. The source override in the before arm uses the same
 * renderer and protocol; the after arm links the rebuilt SDK archive. */
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "gl_abi.h"

static const GLfloat triangle[] = {-1,-1, 1,-1, 0,1};
static GLuint shader(GLenum type, const char *source) {
    GLuint result = glCreateShader(type); assert(result);
    glShaderSource(result,1,&source,NULL); glCompileShader(result);
    GLint compiled = 0; glGetShaderiv(result,GL_COMPILE_STATUS,&compiled);
    if (!compiled) {
        char log[1024]; glGetShaderInfoLog(result,sizeof log,NULL,log);
        fprintf(stderr,"shader compile failed: %s\n",log);
    }
    assert(compiled); return result;
}
static void pixel(void) {
    glViewport(0,0,16,16); glClearColor(0,0,0,1); glClear(GL_COLOR_BUFFER_BIT);
    glDrawArrays(GL_TRIANGLES,0,3);
    unsigned char rgba[4] = {0}; glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
    assert(rgba[0] >= 50 && rgba[0] <= 52 && rgba[1] >= 152 && rgba[1] <= 154);
    assert(rgba[2] >= 203 && rgba[2] <= 205 && rgba[3] == 255);
    assert(glGetError() == GL_NO_ERROR);
}
int main(int argc, char **argv) {
    assert(argc == 2);
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY); assert(display != EGL_NO_DISPLAY);
    if (!strcmp(argv[1],"no-renderer")) {
        assert(!eglInitialize(display,NULL,NULL) && eglGetError() == EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal"); return 0;
    }
    const int local = !strcmp(argv[1],"after");
    assert(eglInitialize(display,NULL,NULL));
    const EGLint configs[] = {EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    EGLConfig config; EGLint count; assert(eglChooseConfig(display,configs,&config,1,&count) && count == 1);
    const EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    const EGLint size[] = {EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
    EGLContext context = eglCreateContext(display,config,EGL_NO_CONTEXT,attrs);
    EGLSurface surface = eglCreatePbufferSurface(display,config,size);
    assert(context != EGL_NO_CONTEXT && surface != EGL_NO_SURFACE);
    assert(eglMakeCurrent(display,surface,surface,context));
    GLuint buffers[2]; glGenBuffers(2,buffers); glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);
    assert(glGetError() == GL_NO_ERROR);
    const GLenum usages[] = {GL_STATIC_DRAW,GL_STREAM_DRAW,GL_DYNAMIC_DRAW};
    uint64_t start = _wpk_gl_device_requests();
    for (unsigned i=0;i<12;i++) {
        glBufferData(GL_ARRAY_BUFFER,64,NULL,usages[i%3]); assert(glGetError() == GL_NO_ERROR);
        glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,usages[i%3]); assert(glGetError() == GL_NO_ERROR);
        glBufferData(GL_ARRAY_BUFFER,0,triangle,usages[i%3]); assert(glGetError() == GL_NO_ERROR);
    }
    glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_DYNAMIC_DRAW); assert(glGetError() == GL_NO_ERROR);
    uint64_t requests = _wpk_gl_device_requests()-start;
    printf("ARRAY_STORAGE_REQUESTS definitions=37 requests=%llu\n",(unsigned long long)requests);
    assert(requests == (local ? 0 : 37));
    GLint value = -1; glGetBufferParameteriv(GL_ARRAY_BUFFER,GL_BUFFER_SIZE,&value); assert(value == sizeof triangle);
    glGetBufferParameteriv(GL_ARRAY_BUFFER,GL_BUFFER_USAGE,&value); assert(value == GL_DYNAMIC_DRAW);
    GLuint vertex = shader(GL_VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
    GLuint fragment = shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}");
    GLuint program = glCreateProgram(); assert(program);
    glAttachShader(program,vertex); glAttachShader(program,fragment); glBindAttribLocation(program,0,"p");
    glLinkProgram(program); glGetProgramiv(program,GL_LINK_STATUS,&value); assert(value);
    glUseProgram(program); glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL); glEnableVertexAttribArray(0);
    pixel();

    start = _wpk_gl_device_requests();
    glEnable(0xdead); glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STATIC_DRAW);
    assert(glGetError() == GL_INVALID_ENUM && glGetError() == GL_NO_ERROR);
    assert(_wpk_gl_device_requests()-start == (local ? 0 : 1));
    glFinish(); assert(glGetError() == GL_NO_ERROR);
    start = _wpk_gl_device_requests();
    glClear(0x80000000u); glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STATIC_DRAW);
    assert(glGetError() == GL_INVALID_VALUE && glGetError() == GL_NO_ERROR);
    assert(_wpk_gl_device_requests()-start == 1);

    /* A sharing peer can delete and reuse the name without changing this
     * bound identity. Empty it first so the later draw proves new bytes reached
     * the retained object, rather than accidentally drawing its old payload. */
    glBufferData(GL_ARRAY_BUFFER,0,NULL,GL_STATIC_DRAW); assert(glGetError() == GL_NO_ERROR);
    EGLContext peer = eglCreateContext(display,config,context,attrs); assert(peer != EGL_NO_CONTEXT);
    assert(eglMakeCurrent(display,surface,surface,peer));
    glDeleteBuffers(1,buffers); assert(glGetError() == GL_NO_ERROR);
    glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);
    glBufferData(GL_ARRAY_BUFFER,4,NULL,GL_STATIC_DRAW); assert(glGetError() == GL_NO_ERROR);
    assert(eglMakeCurrent(display,surface,surface,context)); assert(glGetError() == GL_NO_ERROR);
    start = _wpk_gl_device_requests();
    glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STREAM_DRAW); assert(glGetError() == GL_NO_ERROR);
    requests = _wpk_gl_device_requests()-start;
    printf("ARRAY_SHARED_REQUESTS definitions=1 requests=%llu\n",(unsigned long long)requests);
    assert(requests == (local ? 0 : 1)); pixel();
    assert(eglDestroyContext(display,peer));

    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,buffers[1]); assert(glGetError() == GL_NO_ERROR);
    start = _wpk_gl_device_requests();
    glBufferData(GL_ELEMENT_ARRAY_BUFFER,64,NULL,GL_STATIC_DRAW); assert(glGetError() == GL_NO_ERROR);
    assert(_wpk_gl_device_requests()-start == 1);
    /* A checked cross-class bind supplies its accepted array view first. */
    glBindBuffer(GL_ARRAY_BUFFER,buffers[1]); assert(glGetError() == GL_NO_ERROR);
    start = _wpk_gl_device_requests();
    glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STREAM_DRAW); assert(glGetError() == GL_NO_ERROR);
    assert(_wpk_gl_device_requests()-start == (local ? 0 : 1));
    start = _wpk_gl_device_requests(); glGetIntegerv(GL_ARRAY_BUFFER_BINDING,&value); assert((GLuint)value == buffers[1]);
    glBufferData(GL_ARRAY_BUFFER,4,NULL,GL_DYNAMIC_DRAW); assert(glGetError() == GL_NO_ERROR);
    assert(_wpk_gl_device_requests()-start == 2);
    glBindBuffer(GL_ARRAY_BUFFER,0); glDeleteBuffers(2,buffers);
    glUseProgram(0); glDeleteProgram(program); glDeleteShader(vertex); glDeleteShader(fragment);
    assert(glGetError() == GL_NO_ERROR);
    assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroySurface(display,surface) && eglDestroyContext(display,context));
    assert(eglTerminate(display) && eglReleaseThread());
    puts("PASS array storage, payload, shared identity and conservative fallbacks"); return 0;
}
