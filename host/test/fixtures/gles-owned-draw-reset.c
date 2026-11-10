#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../../libc/glue/gl_abi.h"

static const GLfloat triangle[]={-1,-1,3,-1,-1,3};
struct drawing {GLuint program,vertex,fragment,buffer;GLint tint;};
static GLuint shader(GLenum type,const char *source){GLuint s=glCreateShader(type);assert(s);glShaderSource(s,1,&source,NULL);glCompileShader(s);GLint ok=0;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);assert(ok);return s;}
static struct drawing prepare(int vbo){
 struct drawing x={0};x.vertex=shader(GL_VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");x.fragment=shader(GL_FRAGMENT_SHADER,"precision mediump float;uniform vec4 tint;void main(){gl_FragColor=tint;}");
 x.program=glCreateProgram();assert(x.program);glAttachShader(x.program,x.vertex);glAttachShader(x.program,x.fragment);glBindAttribLocation(x.program,0,"p");glLinkProgram(x.program);GLint ok=0;glGetProgramiv(x.program,GL_LINK_STATUS,&ok);assert(ok);glUseProgram(x.program);assert(_wpk_gl_enable_program_journal());
 x.tint=glGetUniformLocation(x.program,"tint");assert(x.tint>=0);glViewport(0,0,16,16);glClearColor(0,0,0,1);
 if(vbo){glGenBuffers(1,&x.buffer);glBindBuffer(GL_ARRAY_BUFFER,x.buffer);glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STATIC_DRAW);}else glBindBuffer(GL_ARRAY_BUFFER,0);
 glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,vbo?NULL:triangle);glEnableVertexAttribArray(0);assert(glGetError()==GL_NO_ERROR);return x;
}
static void pixel(int odd){GLubyte p[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,p);assert(glGetError()==GL_NO_ERROR);assert(p[0]==(odd?204:51)&&p[1]==(odd?51:153)&&p[2]==(odd?153:204)&&p[3]==255);}
static uint64_t warm(struct drawing *x){
 uint64_t requests=0;
 for(unsigned i=0;i<5;i++){
  const int odd=i&1;glUniform4f(x->tint,odd?.8f:.2f,odd?.2f:.6f,odd?.6f:.8f,1);glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);
  uint64_t before=_wpk_gl_device_requests();glDrawArrays(GL_TRIANGLES,0,3);assert(glGetError()==GL_NO_ERROR);if(i)requests+=_wpk_gl_device_requests()-before;pixel(odd);
 }
 return requests;
}
static void retire(struct drawing *x){glUseProgram(0);glDeleteProgram(x->program);glDeleteShader(x->vertex);glDeleteShader(x->fragment);if(x->buffer)glDeleteBuffers(1,&x->buffer);assert(glGetError()==GL_NO_ERROR);}
int main(int argc,char **argv){
 assert(argc==2);assert(!setenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION","1",1));EGLDisplay d=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(d!=EGL_NO_DISPLAY);
 if(!strcmp(argv[1],"no-renderer")){assert(!eglInitialize(d,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);puts("PASS owned draw reset refuses absent renderer");return 0;}
 const int vbo=!strcmp(argv[1],"vbo");assert(vbo||!strcmp(argv[1],"inline"));assert(eglInitialize(d,NULL,NULL));
 const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE},attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY,EGL_LOSE_CONTEXT_ON_RESET,EGL_NONE},size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};EGLConfig config;EGLint n;assert(eglChooseConfig(d,choose,&config,1,&n)&&n==1);
 // WHY: an independent peer keeps the VBO family's no-sharing proof valid.
 // Its survival still proves that native OOM resets only the submitting
 // context, rather than hiding cleanup behind kernel-worker termination.
 EGLContext primary=eglCreateContext(d,config,EGL_NO_CONTEXT,attrs),peer=eglCreateContext(d,config,EGL_NO_CONTEXT,attrs);EGLSurface a=eglCreatePbufferSurface(d,config,size),b=eglCreatePbufferSurface(d,config,size);assert(primary!=EGL_NO_CONTEXT&&peer!=EGL_NO_CONTEXT&&a!=EGL_NO_SURFACE&&b!=EGL_NO_SURFACE);
 assert(eglMakeCurrent(d,a,a,primary));struct drawing x=prepare(vbo);uint64_t primary_warm=warm(&x);assert(primary_warm==0);
 assert(eglMakeCurrent(d,b,b,peer));struct drawing y=prepare(vbo);uint64_t peer_warm=warm(&y);assert(peer_warm==0);glViewport(0,0,-1,16);
 assert(eglMakeCurrent(d,a,a,primary));assert(glGetError()==GL_NO_ERROR);printf("RESET_WARM {\"family\":\"%s\",\"primary\":%llu,\"peer\":%llu}\n",argv[1],(unsigned long long)primary_warm,(unsigned long long)peer_warm);puts("ARM");fflush(stdout);assert(getchar()=='x'&&getchar()=='\n');
 uint64_t before=_wpk_gl_device_requests();glDrawArrays(GL_TRIANGLES,0,3);assert(glGetError()==GL_NO_ERROR&&_wpk_gl_device_requests()==before);assert(_wpk_gl_flush_checked()!=0);
 assert(glGetGraphicsResetStatusEXT()==GL_UNKNOWN_CONTEXT_RESET_EXT&&glGetGraphicsResetStatusEXT()==GL_NO_ERROR);assert(glGetError()==GL_CONTEXT_LOST_KHR&&glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(d,b,b,peer));assert(glGetGraphicsResetStatusEXT()==GL_NO_ERROR);assert(glGetError()==GL_INVALID_VALUE&&glGetError()==GL_NO_ERROR);
 glUniform4f(y.tint,.8f,.2f,.6f,1);glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);before=_wpk_gl_device_requests();glDrawArrays(GL_TRIANGLES,0,3);assert(glGetError()==GL_NO_ERROR);uint64_t after_reset=_wpk_gl_device_requests()-before;assert(after_reset==0);pixel(1);printf("RESET_PEER_COUNT %llu\n",(unsigned long long)after_reset);
 retire(&y);assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroyContext(d,primary)&&eglDestroyContext(d,peer)&&eglDestroySurface(d,a)&&eglDestroySurface(d,b)&&eglTerminate(d)&&eglReleaseThread());
 puts("RETIRED");fflush(stdout);assert(getchar()=='y'&&getchar()=='\n');puts("PASS owned draw reset preserves healthy peer");return 0;
}
