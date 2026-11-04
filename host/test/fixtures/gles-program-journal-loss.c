#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include "../../../libc/glue/gl_abi.h"

struct peer {
    EGLDisplay display; EGLContext context; EGLSurface surface;
    GLuint program,buffer; int ready,go,select_again,retired_primary;
    pthread_mutex_t mutex; pthread_cond_t condition;
};
static void layout(GLuint buffer) {
    glBindBuffer(GL_ARRAY_BUFFER,buffer);
    glEnableVertexAttribArray(0);glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL);
    glViewport(0,0,16,16);
}
static void *render_peer(void *opaque) {
    struct peer *p=opaque;
    assert(eglMakeCurrent(p->display,p->surface,p->surface,p->context));
    layout(p->buffer);assert(_wpk_gl_enable_program_journal());
    glUseProgram(p->program);glFinish();assert(glGetError()==GL_NO_ERROR);
    glUseProgram(0);glUseProgram(p->program);
    glViewport(0,0,-1,16); /* This peer's older flag must survive the reset. */
    assert(!pthread_mutex_lock(&p->mutex));p->ready=1;
    assert(!pthread_cond_signal(&p->condition));
    while(!p->go)assert(!pthread_cond_wait(&p->condition,&p->mutex));
    assert(!pthread_mutex_unlock(&p->mutex));
    assert(glGetGraphicsResetStatusEXT()==GL_NO_ERROR);
    assert(glGetError()==GL_INVALID_VALUE&&glGetError()==GL_NO_ERROR);
    assert(glIsProgram(p->program)==GL_TRUE);
    /* A same-name selection still owns the delete-pending public name. */
    if(p->select_again){glUseProgram(p->program);assert(glGetError()==GL_NO_ERROR);}
    glViewport(0,0,16,16);glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);
    glDrawArrays(GL_TRIANGLES,0,3);
    unsigned char pixel[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
    assert(pixel[0]==51&&pixel[1]==153&&pixel[2]==204&&pixel[3]==255);
    assert(glGetError()==GL_NO_ERROR);
    glUseProgram(0);glFinish();assert(glGetError()==GL_NO_ERROR);
    assert(glIsProgram(p->program)==(p->retired_primary?GL_FALSE:GL_TRUE));
    if(p->select_again){
        /* The private generation pin must not revive the now-dead name. */
        glUseProgram(p->program);assert(glGetError()==GL_INVALID_VALUE&&glGetError()==GL_NO_ERROR);
    }
    glDeleteBuffers(1,&p->buffer);
    assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroyContext(p->display,p->context)&&eglReleaseThread());
    return NULL;
}
static GLuint shader(GLenum type,const char *source) {
    GLuint s=glCreateShader(type);assert(s);glShaderSource(s,1,&source,NULL);glCompileShader(s);
    GLint compiled=0;glGetShaderiv(s,GL_COMPILE_STATUS,&compiled);assert(compiled);return s;
}
int main(int argc,char **argv) {
    assert(argc==2);EGLDisplay d=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(d!=EGL_NO_DISPLAY);
    if(!strcmp(argv[1],"no-renderer")) {
        assert(!eglInitialize(d,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal");return 0;
    }
    assert(eglInitialize(d,NULL,NULL));EGLConfig config;EGLint n;
    const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    assert(eglChooseConfig(d,choose,&config,1,&n)&&n==1);
    const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY,
        EGL_LOSE_CONTEXT_ON_RESET,EGL_NONE};
    const EGLint size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
    EGLContext primary=eglCreateContext(d,config,EGL_NO_CONTEXT,attrs);
    EGLContext context=eglCreateContext(d,config,primary,attrs);
    EGLSurface a=eglCreatePbufferSurface(d,config,size),b=eglCreatePbufferSurface(d,config,size);
    assert(primary!=EGL_NO_CONTEXT&&context!=EGL_NO_CONTEXT&&a!=EGL_NO_SURFACE&&b!=EGL_NO_SURFACE);
    assert(eglMakeCurrent(d,a,a,primary));
    GLuint v=shader(GL_VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
    GLuint f=shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}");
    GLuint program=glCreateProgram();assert(program);
    glAttachShader(program,v);glAttachShader(program,f);glBindAttribLocation(program,0,"p");glLinkProgram(program);
    GLint linked=0;glGetProgramiv(program,GL_LINK_STATUS,&linked);assert(linked);
    GLuint buffer;const GLfloat triangle[]={-1,-1,1,-1,0,1};
    glGenBuffers(1,&buffer);glBindBuffer(GL_ARRAY_BUFFER,buffer);glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STATIC_DRAW);
    layout(buffer);assert(_wpk_gl_enable_program_journal());
    glUseProgram(program);glFinish();assert(glGetError()==GL_NO_ERROR);
    struct peer p={.display=d,.context=context,.surface=b,.program=program,.buffer=buffer,
        .select_again=!strcmp(argv[1],"peer-select"),.retired_primary=strcmp(argv[1],"submit")!=0,.mutex=PTHREAD_MUTEX_INITIALIZER,.condition=PTHREAD_COND_INITIALIZER};
    pthread_t thread;assert(!pthread_create(&thread,NULL,render_peer,&p));
    assert(!pthread_mutex_lock(&p.mutex));
    while(!p.ready)assert(!pthread_cond_wait(&p.condition,&p.mutex));
    assert(!pthread_mutex_unlock(&p.mutex));
    glDeleteShader(v);glDeleteShader(f);glDeleteProgram(program);
    puts("ARM");fflush(stdout);assert(getchar()=='x'&&getchar()=='\n');
    const uint64_t requests=_wpk_gl_device_requests();
    glUseProgram(0);glUseProgram(program);assert(_wpk_gl_device_requests()==requests);
    assert(_wpk_gl_flush_checked()!=0);
    assert(glGetGraphicsResetStatusEXT()==GL_UNKNOWN_CONTEXT_RESET_EXT);
    assert(glGetGraphicsResetStatusEXT()==GL_NO_ERROR);
    assert(glGetError()==GL_CONTEXT_LOST_KHR&&glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    const int early=strcmp(argv[1],"submit")!=0;
    if(early)assert(eglDestroyContext(d,primary));
    assert(!pthread_mutex_lock(&p.mutex));p.go=1;assert(!pthread_cond_signal(&p.condition));
    assert(!pthread_mutex_unlock(&p.mutex));assert(!pthread_join(thread,NULL));
    if(!early)assert(eglDestroyContext(d,primary));
    assert(eglDestroySurface(d,a)&&eglDestroySurface(d,b)&&eglTerminate(d)&&eglReleaseThread());
    assert(!pthread_mutex_destroy(&p.mutex)&&!pthread_cond_destroy(&p.condition));
    /* Let the independent observer inspect native ownership before process
     * exit could close any forgotten descriptor or context on our behalf. */
    puts("RETIRED");fflush(stdout);assert(getchar()=='y'&&getchar()=='\n');
    printf("PASS journal reset preserves pending peer %s\n",argv[1]);return 0;
}
