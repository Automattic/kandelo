/* Accepted metadata survives reset until the exact backend owner retires.
 * Wait for an independent ownership sample before process exit can reap it. */
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../../libc/glue/gl_abi.h"
static const EGLint attributes[]={EGL_CONTEXT_CLIENT_VERSION,2,
    EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY,EGL_LOSE_CONTEXT_ON_RESET,EGL_NONE};
static const EGLint dimensions[]={EGL_WIDTH,4,EGL_HEIGHT,4,EGL_NONE};
struct peer {EGLDisplay display;EGLContext context;GLuint program;
    pthread_mutex_t mutex;pthread_cond_t condition;int ready,queue,queued,retire;};
static void *peer_main(void *opaque){
    struct peer *p=opaque;
    assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,p->context));
    glUseProgram(p->program);assert(_wpk_gl_enable_program_journal());
    glUseProgram(0);glUseProgram(p->program);glFinish();assert(glGetError()==GL_NO_ERROR);
    assert(!pthread_mutex_lock(&p->mutex));p->ready=1;assert(!pthread_cond_signal(&p->condition));
    while(!p->queue)assert(!pthread_cond_wait(&p->condition,&p->mutex));
    assert(!pthread_mutex_unlock(&p->mutex));
    glUseProgram(0);
    assert(!pthread_mutex_lock(&p->mutex));p->queued=1;assert(!pthread_cond_signal(&p->condition));
    while(!p->retire)assert(!pthread_cond_wait(&p->condition,&p->mutex));
    assert(!pthread_mutex_unlock(&p->mutex));
    glClearColor(0,0,0,1); // A command after the observed share-group loss.
    assert(glGetGraphicsResetStatusEXT()==GL_UNKNOWN_CONTEXT_RESET_EXT);
    assert(glGetError()==GL_CONTEXT_LOST_KHR&&glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroyContext(p->display,p->context)&&eglReleaseThread());return NULL;
}
static void retire_peer(struct peer *p,pthread_t thread){
    assert(!pthread_mutex_lock(&p->mutex));p->retire=1;assert(!pthread_cond_signal(&p->condition));
    assert(!pthread_mutex_unlock(&p->mutex));assert(!pthread_join(thread,NULL));
    assert(!pthread_mutex_destroy(&p->mutex)&&!pthread_cond_destroy(&p->condition));
}
static GLuint shader(GLenum type,const char *source){
    GLuint s=glCreateShader(type);assert(s);glShaderSource(s,1,&source,NULL);glCompileShader(s);
    GLint ok=0;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);assert(ok);return s;
}
int main(int argc,char **argv){
    /* Raw receipt/fault controls own admission explicitly. */
    assert(!setenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION","1",1));
    assert(argc==2);const char *mode=argv[1];
    EGLDisplay d=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(d!=EGL_NO_DISPLAY);
    if(!strcmp(mode,"no-renderer")){
        assert(!eglInitialize(d,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);
        puts("PASS reset retirement refuses missing renderer");return 0;
    }
    const int shared=!strcmp(mode,"shared")||!strcmp(mode,"shared-reverse")||!strcmp(mode,"proof-retry");
    const int reverse=!strcmp(mode,"shared-reverse"),retry=!strcmp(mode,"proof-retry");
    const int logical=!strncmp(mode,"logical-",8),foreign=!strcmp(mode,"logical-foreign");
    const int healthy_peer=!strcmp(mode,"logical-peer")||!strcmp(mode,"logical-peer-query");
    const int early_query=!strcmp(mode,"logical-peer-query");
    assert(eglInitialize(d,NULL,NULL));EGLConfig config;EGLint count;
    const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    assert(eglChooseConfig(d,choose,&config,1,&count)&&count==1);
    EGLContext context=eglCreateContext(d,config,EGL_NO_CONTEXT,attributes);assert(context!=EGL_NO_CONTEXT);
    EGLSurface surface=eglCreatePbufferSurface(d,config,dimensions);assert(surface!=EGL_NO_SURFACE);
    assert(eglMakeCurrent(d,surface,surface,context));
    GLuint v=shader(GL_VERTEX_SHADER,"void main(){gl_Position=vec4(0.);}"),
        f=shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(1.);}");
    GLuint program=glCreateProgram();assert(program);glAttachShader(program,v);glAttachShader(program,f);
    glLinkProgram(program);GLint linked=0;glGetProgramiv(program,GL_LINK_STATUS,&linked);assert(linked);
    GLuint next=0;
    if(logical){
        GLuint v2=shader(GL_VERTEX_SHADER,"void main(){gl_Position=vec4(1.);}"),
            f2=shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(0.);}");
        next=glCreateProgram();assert(next);glAttachShader(next,v2);glAttachShader(next,f2);
        glLinkProgram(next);glGetProgramiv(next,GL_LINK_STATUS,&linked);assert(linked);
    }
    glUseProgram(program);assert(_wpk_gl_enable_program_journal());
    glUseProgram(next);glUseProgram(program);glFinish();assert(glGetError()==GL_NO_ERROR);
    if(logical){glDeleteShader(v);glDeleteShader(f);glDeleteProgram(program);}
    struct peer peer={.display=d,.program=program,.mutex=PTHREAD_MUTEX_INITIALIZER,.condition=PTHREAD_COND_INITIALIZER};pthread_t thread;
    if(shared){
        peer.context=eglCreateContext(d,config,context,attributes);assert(peer.context!=EGL_NO_CONTEXT);
        assert(!pthread_create(&thread,NULL,peer_main,&peer));
        assert(!pthread_mutex_lock(&peer.mutex));
        while(!peer.ready)assert(!pthread_cond_wait(&peer.condition,&peer.mutex));
        peer.queue=1;assert(!pthread_cond_signal(&peer.condition));
        while(!peer.queued)assert(!pthread_cond_wait(&peer.condition,&peer.mutex));
        assert(!pthread_mutex_unlock(&peer.mutex));
    }
    EGLContext healthy=EGL_NO_CONTEXT;EGLSurface healthy_surface=EGL_NO_SURFACE;
    if(healthy_peer){
        healthy=eglCreateContext(d,config,context,attributes);assert(healthy!=EGL_NO_CONTEXT);
        healthy_surface=eglCreatePbufferSurface(d,config,dimensions);assert(healthy_surface!=EGL_NO_SURFACE);
    }
    EGLContext idle=EGL_NO_CONTEXT;
    if(retry){idle=eglCreateContext(d,config,context,attributes);assert(idle!=EGL_NO_CONTEXT);}
    const uint64_t requests=_wpk_gl_device_requests();glUseProgram(0);if(logical)glUseProgram(next);
    assert(_wpk_gl_device_requests()==requests);
    puts("ARM");fflush(stdout);char input[8];assert(fgets(input,sizeof input,stdin));
    assert(_wpk_gl_flush_checked()!=0);
    assert(glGetGraphicsResetStatusEXT()==GL_UNKNOWN_CONTEXT_RESET_EXT);
    assert(glGetError()==GL_CONTEXT_LOST_KHR&&glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    if(foreign){
        healthy=eglCreateContext(d,config,EGL_NO_CONTEXT,attributes);assert(healthy!=EGL_NO_CONTEXT);
        healthy_surface=eglCreatePbufferSurface(d,config,dimensions);assert(healthy_surface!=EGL_NO_SURFACE);
        assert(eglMakeCurrent(d,healthy_surface,healthy_surface,healthy));assert(glGetError()==GL_NO_ERROR);
        glEnable(0xdead); // An older unrelated flag must survive foreign retirement.
    }
    if(healthy_peer&&early_query){
        assert(eglMakeCurrent(d,healthy_surface,healthy_surface,healthy));
        glEnable(0xdead);
        if(early_query){
            assert(glGetError()==GL_INVALID_ENUM&&glGetError()==GL_NO_ERROR);
            glEnable(0xdead); // A fresh repetition must survive retirement too.
        }
    }
    if(reverse)retire_peer(&peer,thread);
    assert(eglDestroyContext(d,context));
    if(retry){puts("RETRY");fflush(stdout);assert(fgets(input,sizeof input,stdin));assert(eglDestroyContext(d,idle));}
    if(shared&&!reverse)retire_peer(&peer,thread);
    assert(eglDestroySurface(d,surface));
    if(healthy_peer&&!early_query){
        assert(eglMakeCurrent(d,healthy_surface,healthy_surface,healthy));glEnable(0xdead);
    }
    if(foreign||healthy_peer){
        assert(glGetError()==GL_INVALID_ENUM&&glGetError()==GL_NO_ERROR);
        if(healthy_peer){
            assert(glIsProgram(next));GLint ok=0;glGetProgramiv(next,GL_LINK_STATUS,&ok);assert(ok);
            glUseProgram(next);
            if(early_query){
                // Carrier authority must end before this context gets its own
                // journal transaction sequence; no stale outer receipt reuse.
                assert(_wpk_gl_enable_program_journal());
                glUseProgram(0);glUseProgram(next);glFinish();assert(glGetError()==GL_NO_ERROR);
            }
        }
        glViewport(0,0,4,4);glClearColor(.2f,.4f,.6f,1);glClear(GL_COLOR_BUFFER_BIT);
        unsigned char pixel[4]={0};glReadPixels(1,1,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
        assert(pixel[0]==51&&pixel[1]==102&&pixel[2]==153&&pixel[3]==255&&glGetError()==GL_NO_ERROR);
        assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
        assert(eglDestroyContext(d,healthy)&&eglDestroySurface(d,healthy_surface));
    }
    assert(eglReleaseThread()&&eglTerminate(d));
    puts("RETIRED");fflush(stdout);assert(fgets(input,sizeof input,stdin));
    puts("PASS reset contexts retire before exit");return 0;
}
