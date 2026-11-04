/* A current program survives deletion by a newly shared context on another thread. */
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <assert.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static GLuint shader(GLenum type, const char *source) {
    GLuint result=glCreateShader(type); assert(result);
    glShaderSource(result,1,&source,NULL); glCompileShader(result);
    GLint status=0; glGetShaderiv(result,GL_COMPILE_STATUS,&status); assert(status);
    return result;
}
static void pixel(unsigned red,unsigned green,unsigned blue) {
    glViewport(0,0,16,16); glClearColor(0,0,0,1); glClear(GL_COLOR_BUFFER_BIT);
    glDrawArrays(GL_TRIANGLES,0,3);
    GLubyte rgba[4]={0}; glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
    assert(rgba[0]+1>=red && rgba[0]<=red+1 && rgba[1]+1>=green && rgba[1]<=green+1);
    assert(rgba[2]+1>=blue && rgba[2]<=blue+1 && rgba[3]==255);
    assert(glGetError()==GL_NO_ERROR);
}
struct peer_delete { EGLDisplay display; EGLConfig config; EGLContext source; GLuint program; };
static void *delete_in_peer(void *opaque) {
    struct peer_delete *data=opaque;
    const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    EGLContext peer=eglCreateContext(data->display,data->config,data->source,attrs);
    assert(peer!=EGL_NO_CONTEXT);
    assert(eglMakeCurrent(data->display,EGL_NO_SURFACE,EGL_NO_SURFACE,peer));
    glDeleteProgram(data->program);assert(glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(data->display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroyContext(data->display,peer)&&eglReleaseThread());
    return NULL;
}
int main(int argc,char **argv) {
    assert(argc==2);
    EGLDisplay display=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(display!=EGL_NO_DISPLAY);
    if(!strcmp(argv[1],"no-renderer")) {
        assert(!eglInitialize(display,NULL,NULL) && eglGetError()==EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal");return 0;
    }
    assert(eglInitialize(display,NULL,NULL));
    const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    EGLConfig config;EGLint count;assert(eglChooseConfig(display,choose,&config,1,&count)&&count==1);
    const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    const EGLint dimensions[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
    EGLContext context=eglCreateContext(display,config,EGL_NO_CONTEXT,attrs);
    EGLSurface surface=eglCreatePbufferSurface(display,config,dimensions);
    assert(context!=EGL_NO_CONTEXT && surface!=EGL_NO_SURFACE && eglMakeCurrent(display,surface,surface,context));
    const GLfloat triangle[]={-1,-1,1,-1,0,1};GLuint buffer;
    glGenBuffers(1,&buffer);glBindBuffer(GL_ARRAY_BUFFER,buffer);
    glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STATIC_DRAW);
    GLuint vertex=shader(GL_VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
    GLuint fragments[]={
        shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}"),
        shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(.8,.3,.2,1.);}")};
    GLuint programs[]={glCreateProgram(),glCreateProgram()};
    for(unsigned i=0;i<2;i++) {
        assert(programs[i]);glAttachShader(programs[i],vertex);glAttachShader(programs[i],fragments[i]);
        glBindAttribLocation(programs[i],0,"p");glLinkProgram(programs[i]);
        GLint linked=0;glGetProgramiv(programs[i],GL_LINK_STATUS,&linked);assert(linked);
    }
    glEnableVertexAttribArray(0);glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL);
    assert(glGetError()==GL_NO_ERROR);
    /* The API selection precedes peer creation/deletion, even when the GPU
     * command remains queued. Its program stays current and usable here. */
    glUseProgram(programs[0]);assert(glGetError()==GL_NO_ERROR);
    struct peer_delete data={display,config,context,programs[0]};pthread_t thread;
    assert(pthread_create(&thread,NULL,delete_in_peer,&data)==0);
    assert(pthread_join(thread,NULL)==0);
    assert(glGetError()==GL_NO_ERROR);pixel(51,153,204);
    glUseProgram(0);glDeleteProgram(programs[1]);
    glDeleteShader(vertex);glDeleteShader(fragments[0]);glDeleteShader(fragments[1]);glDeleteBuffers(1,&buffer);
    assert(glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroySurface(display,surface)&&eglDestroyContext(display,context));
    assert(eglTerminate(display)&&eglReleaseThread());
    puts("PASS selected program survives a newly shared peer deletion");return 0;
}
