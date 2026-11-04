/* Exercise the optional journal wire through the real SDK/kernel/host path.
 * This deliberately uses raw records; it does not enable the C UMD fast path. */
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include "../../../libc/glue/gl_abi.h"

static uint32_t reply[12],transaction;
static void query(uint32_t op,const uint32_t *input,size_t count,void *output,size_t bytes) {
    struct gl_query_info q={.op=op,.in_buf_ptr=(uintptr_t)input,.in_buf_len=count*4,
        .out_buf_ptr=(uintptr_t)output,.out_buf_len=bytes};
    _wpk_gl_note_device_request();
    assert(ioctl(_wpk_gl_fd(),GLIO_QUERY,&q)==0);
}
static void journal(const uint32_t *input,size_t count) {
    memset(reply,0xa5,sizeof reply);query(QOP_PROGRAM_JOURNAL,input,count,reply,sizeof reply);
    assert(reply[11]==WPK_GL_QUERY_REPLY_MAGIC);
}
static void control(uint32_t action,uint32_t a,uint32_t b) {
    const uint32_t input[]={action,++transaction,a,b};
    journal(input,action==5?2:action==4?4:3);
    assert(reply[0]==0 && reply[1]==transaction && reply[2]==action);
}
static GLuint shader(GLenum type,const char *source) {
    GLuint s=glCreateShader(type);assert(s);glShaderSource(s,1,&source,NULL);glCompileShader(s);
    GLint linked=0;glGetShaderiv(s,GL_COMPILE_STATUS,&linked);assert(linked);return s;
}
static size_t emit(size_t at,uint16_t op,const uint32_t *words,size_t count) {
    uint8_t *base=_wpk_gl_cmdbuf_base();assert(base);
    const uint16_t header[]={op,(uint16_t)(count*4)};
    memcpy(base+at,header,sizeof header);memcpy(base+at+4,words,count*4);return at+4+count*4;
}
struct peer_data {EGLDisplay display;EGLConfig config;EGLContext source;GLuint program;int fd;};
static void *delete_in_peer(void *opaque) {
    struct peer_data *p=opaque;
    /* An inherited file number conveys no calling-thread current authority. */
    const uint32_t read[]={6};uint32_t untouched[12];memset(untouched,0xa5,sizeof untouched);
    struct gl_query_info q={.op=QOP_PROGRAM_JOURNAL,.in_buf_ptr=(uintptr_t)read,.in_buf_len=4,
        .out_buf_ptr=(uintptr_t)untouched,.out_buf_len=sizeof untouched};
    _wpk_gl_note_device_request();errno=0;
    assert(ioctl(p->fd,GLIO_QUERY,&q)==-1 && errno==EACCES);
    for(unsigned i=0;i<12;i++)assert(untouched[i]==0xa5a5a5a5);
    const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    EGLContext context=eglCreateContext(p->display,p->config,p->source,attrs);assert(context!=EGL_NO_CONTEXT);
    assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,context));
    glDeleteProgram(p->program);assert(glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroyContext(p->display,context)&&eglReleaseThread());return NULL;
}
int main(int argc,char **argv) {
    assert(argc==2);const int errors=!strcmp(argv[1],"errors"),preflight=!strcmp(argv[1],"preflight");
    EGLDisplay display=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(display!=EGL_NO_DISPLAY);
    if(!strcmp(argv[1],"no-renderer")) {
        assert(!eglInitialize(display,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal");return 0;
    }
    assert(eglInitialize(display,NULL,NULL));
    const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    EGLConfig config;EGLint count;assert(eglChooseConfig(display,choose,&config,1,&count)&&count==1);
    const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE},dimensions[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
    EGLContext context=eglCreateContext(display,config,EGL_NO_CONTEXT,attrs);
    EGLSurface surface=eglCreatePbufferSurface(display,config,dimensions);
    assert(context!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE&&eglMakeCurrent(display,surface,surface,context));
    GLuint vertex=shader(GL_VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
    GLuint fragment=shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}");
    GLuint program=glCreateProgram();assert(program);glAttachShader(program,vertex);glAttachShader(program,fragment);
    glBindAttribLocation(program,0,"p");glLinkProgram(program);GLint linked=0;
    glGetProgramiv(program,GL_LINK_STATUS,&linked);assert(linked);
    const GLfloat triangle[]={-1,-1,1,-1,0,1};GLuint buffer;
    glGenBuffers(1,&buffer);glBindBuffer(GL_ARRAY_BUFFER,buffer);glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL);
    glViewport(0,0,16,16);glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glFinish();assert(glGetError()==GL_NO_ERROR);
    uint32_t captured[4];const uint32_t acquire[]={1,program};
    query(QOP_PROGRAM_CAPTURE,acquire,2,captured,sizeof captured);
    assert(captured[0]==0&&captured[1]==1&&captured[2]&&captured[3]==WPK_GL_QUERY_REPLY_MAGIC);
    control(1,4,0);const uint32_t id=reply[3];assert(id&&reply[4]==4);
    if(!strcmp(argv[1],"recovery")) {
        /* Discard a successful response locally, then recover its exact receipt.
         * Actual copyout-throw containment is covered by the host unit control. */
        memset(reply,0,sizeof reply);const uint32_t read[]={6};journal(read,1);
        assert(reply[0]==0&&reply[1]==1&&reply[2]==1&&reply[3]==id&&reply[4]==4);
    }
    control(2,captured[2],0);const uint32_t token=reply[4];assert(token);
    uint32_t publication[]={3,++transaction,2,
        id,0,1,0,1,0,errors?0xfffffff0:program,errors?0:token,
        id,1,2,0,2,0,errors?0xfffffff0:0,0};
    if(preflight) {
        publication[15]=3;journal(publication,19);
        assert(reply[0]==1&&reply[1]==transaction&&reply[5]==0&&reply[7]==0);
        GLint current=-1;glGetIntegerv(GL_CURRENT_PROGRAM,&current);assert(current==0);
        assert(glGetError()==GL_INVALID_OPERATION&&glGetError()==GL_NO_ERROR);
        publication[15]=2;publication[1]=++transaction;
    }
    journal(publication,19);assert(reply[0]==0&&reply[4]==2&&reply[5]==2&&reply[7]==2&&reply[9]==0);
    if(!strcmp(argv[1],"exit-pending")) {
        puts("PASS journal wire exit-pending");fflush(stdout);_exit(0);
    }
    if(!strcmp(argv[1],"abandon")) {
        assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
        assert(eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
        puts("PASS journal wire abandon");return 0;
    }
    if(!errors) {
        struct peer_data peer={display,config,context,program,_wpk_gl_fd()};pthread_t thread;
        assert(!pthread_create(&thread,NULL,delete_in_peer,&peer)&&!pthread_join(thread,NULL));
        assert(glIsProgram(program)==GL_FALSE); /* Logical selection is already zero. */
    }
    const uint32_t first[]={id,0,1,0},second[]={id,1,2,0},draw[]={GL_TRIANGLES,0,3},observed[]={2,2};
    size_t length=emit(0,OP_USE_PROGRAM_JOURNAL,first,4);
    length=emit(length,errors?OP_ERROR_OBSERVED:OP_DRAW_ARRAYS,errors?observed:draw,errors?2:3);
    length=emit(length,OP_USE_PROGRAM_JOURNAL,second,4);
    if(errors)length=emit(length,OP_ERROR_OBSERVED,observed,2);
    const struct gl_submit_info submit={.offset=0,.length=length};
    _wpk_gl_note_device_request();assert(ioctl(_wpk_gl_fd(),GLIO_SUBMIT,&submit)==0);
    const uint32_t snapshot[]={7,id};journal(snapshot,2);
    assert(reply[0]==0&&reply[2]==7&&reply[3]==id&&reply[4]==1&&reply[5]==2&&reply[7]==2&&reply[9]==2);
    if(!errors) {
        GLubyte rgba[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
        assert(rgba[0]==51&&rgba[1]==153&&rgba[2]==204&&rgba[3]==255);
    }
    assert(glGetError()==GL_NO_ERROR);control(4,id,token);control(5,0,0);
    const uint32_t release[]={3,captured[2]};query(QOP_PROGRAM_CAPTURE,release,2,captured,sizeof captured);
    assert(captured[0]==0&&captured[1]==1&&captured[3]==WPK_GL_QUERY_REPLY_MAGIC);
    if(errors)glDeleteProgram(program);
    glDeleteShader(vertex);glDeleteShader(fragment);glDeleteBuffers(1,&buffer);assert(glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
    printf("PASS journal wire %s\n",argv[1]);return 0;
}
