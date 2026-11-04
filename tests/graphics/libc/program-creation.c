/* Exercise checked creation through ordinary SDK, ioctl, kernel and renderer. */
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include "gl_abi.h"
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>

struct wire {struct gl_query_info info;uint32_t input[3],reply[3];};
static int creation(int fd,uint32_t kind,uint32_t type,uint32_t name,
                    unsigned input_bytes,unsigned output_bytes,uint32_t expected_status) {
    struct wire *w=calloc(1,sizeof *w);assert(w);
    w->input[0]=kind;w->input[1]=type;w->input[2]=name;
    for(unsigned i=0;i<3;i++)w->reply[i]=0xa5a5a5a5;
    w->info=(struct gl_query_info){.op=QOP_CREATE_SHADER_PROGRAM,
        .in_buf_ptr=(uintptr_t)w->input,.in_buf_len=input_bytes,
        .out_buf_ptr=(uintptr_t)w->reply,.out_buf_len=output_bytes};
    _wpk_gl_note_device_request();errno=0;
    int rc=ioctl(fd,GLIO_QUERY,&w->info),saved=errno;
    if(rc==0) {
        assert(w->reply[0]==expected_status);
        assert(w->reply[1]==(expected_status?0:name));
        assert(w->reply[2]==WPK_GL_QUERY_REPLY_MAGIC);
    } else for(unsigned i=0;i<3;i++)assert(w->reply[i]==0xa5a5a5a5);
    free(w);errno=saved;return rc;
}
static int mutation(int fd,uint32_t op,uint32_t name,uint32_t shader,
                    unsigned input_bytes,unsigned output_bytes,uint32_t expected_status) {
    /* Raw ioctl callers must submit the ordinary driver's prior command prefix. */
    assert(_wpk_gl_flush_checked()==0);
    struct wire *w=calloc(1,sizeof *w);assert(w);
    w->input[0]=op;w->input[1]=name;w->input[2]=shader;
    for(unsigned i=0;i<3;i++)w->reply[i]=0xa5a5a5a5;
    w->info=(struct gl_query_info){.op=QOP_PROGRAM_MUTATION,
        .in_buf_ptr=(uintptr_t)w->input,.in_buf_len=input_bytes,
        .out_buf_ptr=(uintptr_t)w->reply,.out_buf_len=output_bytes};
    _wpk_gl_note_device_request();errno=0;
    int rc=ioctl(fd,GLIO_QUERY,&w->info),saved=errno;
    if(rc==0) {
        assert(w->reply[0]==expected_status&&w->reply[1]==(expected_status?0:1));
        assert(w->reply[2]==WPK_GL_QUERY_REPLY_MAGIC);
    } else for(unsigned i=0;i<3;i++)assert(w->reply[i]==0xa5a5a5a5);
    free(w);errno=saved;return rc;
}
static void shader(GLuint name,const char *source) {
    glShaderSource(name,1,&source,NULL);glCompileShader(name);
    GLint compiled=0;glGetShaderiv(name,GL_COMPILE_STATUS,&compiled);assert(compiled);
}
int main(int argc,char **argv) {
    assert(argc==2);
    EGLDisplay d=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(d!=EGL_NO_DISPLAY);
    if(!strcmp(argv[1],"no-renderer")) {
        assert(!eglInitialize(d,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal");return 0;
    }
    assert(eglInitialize(d,NULL,NULL));
    EGLConfig config;EGLint count;
    const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    assert(eglChooseConfig(d,choose,&config,1,&count)&&count==1);
    const EGLint ctxattrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    const EGLint size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
    EGLContext ctx=eglCreateContext(d,config,EGL_NO_CONTEXT,ctxattrs);
    EGLSurface surface=eglCreatePbufferSurface(d,config,size);
    assert(ctx!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE&&eglMakeCurrent(d,surface,surface,ctx));
    int fd=_wpk_gl_fd();assert(fd>=0);
    assert(creation(fd,5,0,200,8,12,0)==-1&&errno==EINVAL);
    assert(creation(fd,5,0,200,12,8,0)==-1&&errno==EINVAL);
    assert(creation(fd,3,0,200,12,12,0)==-1&&errno==EINVAL);
    assert(glGetError()==GL_NO_ERROR);
    /* An accepted allocation must not consume an older guest error flag. */
    glEnable(0xffff);glFinish();
    assert(creation(fd,4,GL_VERTEX_SHADER,100,12,12,0)==0);
    assert(glGetError()==GL_INVALID_ENUM&&glGetError()==GL_NO_ERROR);
    assert(creation(fd,4,GL_FRAGMENT_SHADER,101,12,12,0)==0);
    assert(creation(fd,5,0,200,12,12,0)==0);
    assert(glIsShader(100)&&glIsShader(101)&&glIsProgram(200));
    assert(creation(fd,4,0xffff,200,12,12,1)==0);
    assert(glGetError()==GL_INVALID_ENUM&&glGetError()==GL_NO_ERROR);
    assert(creation(fd,5,0,100,12,12,1)==0);
    assert(glGetError()==GL_INVALID_OPERATION&&glGetError()==GL_NO_ERROR&&glIsShader(100));
    assert(creation(fd,5,0,200,12,12,1)==0);
    assert(glGetError()==GL_INVALID_OPERATION&&glGetError()==GL_NO_ERROR&&glIsProgram(200));
    assert(creation(fd,5,0,0,12,12,1)==0);
    assert(glGetError()==GL_INVALID_OPERATION&&glGetError()==GL_NO_ERROR);
    shader(100,"attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
    shader(101,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}");
    glAttachShader(200,100);glAttachShader(200,101);glBindAttribLocation(200,0,"p");glLinkProgram(200);
    GLint linked=0;glGetProgramiv(200,GL_LINK_STATUS,&linked);assert(linked);glUseProgram(200);
    const GLfloat vertices[]={-1,-1,1,-1,0,1};GLuint buffer;
    glGenBuffers(1,&buffer);glBindBuffer(GL_ARRAY_BUFFER,buffer);glBufferData(GL_ARRAY_BUFFER,sizeof vertices,vertices,GL_STATIC_DRAW);
    glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL);glEnableVertexAttribArray(0);glViewport(0,0,16,16);
    glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLES,0,3);
    GLubyte rgba[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
    assert(rgba[0]==51&&rgba[1]==153&&rgba[2]==204&&rgba[3]==255&&glGetError()==GL_NO_ERROR);
    assert(mutation(fd,OP_CLEAR,0,0,8,12,0)==-1&&errno==EINVAL);
    assert(mutation(fd,OP_USE_PROGRAM,200,0,12,12,0)==-1&&errno==EINVAL);
    assert(mutation(fd,OP_ATTACH_SHADER,200,100,8,12,0)==-1&&errno==EINVAL);
    assert(mutation(fd,OP_USE_PROGRAM,0,0,8,8,0)==-1&&errno==EINVAL);
    assert(glGetError()==GL_NO_ERROR);
    glEnable(0xffff);glFinish();
    assert(mutation(fd,OP_USE_PROGRAM,100,0,8,12,1)==0);
    assert(glGetError()==GL_INVALID_ENUM&&glGetError()==GL_INVALID_OPERATION&&glGetError()==GL_NO_ERROR);
    /* A duplicate flag must not turn the next rejected operation into ACK. */
    assert(mutation(fd,OP_USE_PROGRAM,100,0,8,12,1)==0);
    assert(mutation(fd,OP_USE_PROGRAM,100,0,8,12,1)==0);
    assert(glGetError()==GL_INVALID_OPERATION&&glGetError()==GL_NO_ERROR);
    GLint current=0;glGetIntegerv(GL_CURRENT_PROGRAM,&current);assert(current==200);
    /* Failed link is command completion, not successful executable creation. */
    const char *bad="this shader does not compile";
    glShaderSource(101,1,&bad,NULL);glCompileShader(101);glFinish();
    GLint compiled=1;glGetShaderiv(101,GL_COMPILE_STATUS,&compiled);assert(!compiled);
    assert(mutation(fd,OP_LINK_PROGRAM,200,0,8,12,0)==0);
    glGetProgramiv(200,GL_LINK_STATUS,&linked);assert(!linked);
    assert(mutation(fd,OP_USE_PROGRAM,200,0,8,12,1)==0);
    assert(glGetError()==GL_INVALID_OPERATION&&glGetError()==GL_NO_ERROR);
    glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLES,0,3);memset(rgba,0,sizeof rgba);
    glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
    assert(rgba[0]==51&&rgba[1]==153&&rgba[2]==204&&rgba[3]==255&&glGetError()==GL_NO_ERROR);
    shader(101,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}");
    assert(mutation(fd,OP_LINK_PROGRAM,200,0,8,12,0)==0);
    glGetProgramiv(200,GL_LINK_STATUS,&linked);assert(linked);
    assert(mutation(fd,OP_USE_PROGRAM,0,0,8,12,0)==0);
    glGetIntegerv(GL_CURRENT_PROGRAM,&current);assert(current==0);
    assert(mutation(fd,OP_DETACH_SHADER,200,100,12,12,0)==0);
    assert(mutation(fd,OP_ATTACH_SHADER,200,100,12,12,0)==0);
    assert(mutation(fd,OP_ATTACH_SHADER,200,100,12,12,1)==0);
    assert(glGetError()==GL_INVALID_OPERATION&&glGetError()==GL_NO_ERROR);
    assert(mutation(fd,OP_USE_PROGRAM,200,0,8,12,0)==0);
    assert(mutation(fd,OP_DELETE_SHADER,100,0,8,12,0)==0);
    assert(glIsShader(100));glGetShaderiv(100,GL_DELETE_STATUS,&current);assert(current);
    assert(mutation(fd,OP_DELETE_PROGRAM,200,0,8,12,0)==0);
    assert(glIsProgram(200));glGetProgramiv(200,GL_DELETE_STATUS,&current);assert(current);
    assert(mutation(fd,OP_USE_PROGRAM,0,0,8,12,0)==0);
    assert(!glIsProgram(200)&&!glIsShader(100)&&glGetError()==GL_NO_ERROR);
    assert(mutation(fd,OP_DELETE_PROGRAM,0,0,8,12,0)==0);
    assert(mutation(fd,OP_DELETE_SHADER,0,0,8,12,0)==0);
    glDeleteShader(101);glDeleteBuffers(1,&buffer);
    assert(glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(creation(fd,5,0,201,12,12,0)==-1&&errno==EACCES);
    assert(mutation(fd,OP_USE_PROGRAM,0,0,8,12,0)==-1&&errno==EACCES);
    assert(eglMakeCurrent(d,surface,surface,ctx));
    assert(!glIsProgram(201)&&glGetError()==GL_NO_ERROR);
    assert(creation(fd,5,0,201,12,12,0)==0&&glIsProgram(201));glDeleteProgram(201);
    assert(glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroySurface(d,surface)&&eglDestroyContext(d,ctx)&&eglTerminate(d)&&eglReleaseThread());
    puts("PASS checked shader/program creation and mutation, error ownership, authority and pixels");return 0;
}
