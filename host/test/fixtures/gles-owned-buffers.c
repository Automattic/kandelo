#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../../libc/glue/gl_abi.h"
static GLuint shader(GLenum kind,const char *text){GLuint s=glCreateShader(kind);assert(s);glShaderSource(s,1,&text,NULL);glCompileShader(s);GLint ok=0;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);assert(ok);return s;}
static void pixel(void){GLubyte p[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,p);assert(p[0]==51&&p[1]==153&&p[2]==204&&p[3]==255&&glGetError()==GL_NO_ERROR);}
static uint64_t warm(void){glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_NO_ERROR);uint64_t start=_wpk_gl_device_requests();for(unsigned i=0;i<4;i++){glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_NO_ERROR);}return _wpk_gl_device_requests()-start;}
int main(int argc,char **argv){
 assert(argc==2);const int automatic=!strcmp(argv[1],"automatic"),raw=!strcmp(argv[1],"raw");
 if(automatic)assert(!unsetenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION"));else assert(!setenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION","1",1));
 EGLDisplay display=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(display!=EGL_NO_DISPLAY);
 if(!strcmp(argv[1],"no-renderer")){assert(!eglInitialize(display,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);puts("PASS owned buffers refuse absent renderer");return 0;}
 assert(eglInitialize(display,NULL,NULL));const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
 EGLConfig config;EGLint count;assert(eglChooseConfig(display,choose,&config,1,&count)&&count==1);
 const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT,EGL_TRUE,EGL_NONE},size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
 EGLContext context=eglCreateContext(display,config,EGL_NO_CONTEXT,attrs);EGLSurface surface=eglCreatePbufferSurface(display,config,size);assert(context!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE&&eglMakeCurrent(display,surface,surface,context));
 if(raw)_wpk_gl_note_device_request();
 // All three definitions predate journal admission. The first owned draw
 // must capture real existing stores rather than assuming fresh uploads.
 const GLfloat positions[]={-1,-1,1,-1,-1,1,1,1},uv[8]={0},colors[]={.2,.6,.8,1,.2,.6,.8,1,.2,.6,.8,1,.2,.6,.8,1};
 GLuint buffers[3];glGenBuffers(3,buffers);
 for(unsigned i=0;i<3;i++){glBindBuffer(GL_ARRAY_BUFFER,buffers[i]);glBufferData(GL_ARRAY_BUFFER,i==2?sizeof colors:sizeof positions,i==0?positions:i==1?uv:colors,GL_STATIC_DRAW);glVertexAttribPointer(i,i==2?4:2,GL_FLOAT,GL_FALSE,0,NULL);glEnableVertexAttribArray(i);}
 GLuint v=shader(GL_VERTEX_SHADER,"attribute vec2 p;attribute vec2 uv;attribute vec4 color;varying vec4 c;void main(){gl_Position=vec4(p,0.,1.);c=color+vec4(uv*.00001,0.,0.);}"),f=shader(GL_FRAGMENT_SHADER,"precision mediump float;varying vec4 c;void main(){gl_FragColor=c;}");
 GLuint program=glCreateProgram();glAttachShader(program,v);glAttachShader(program,f);glBindAttribLocation(program,0,"p");glBindAttribLocation(program,1,"uv");glBindAttribLocation(program,2,"color");glLinkProgram(program);GLint linked=0;glGetProgramiv(program,GL_LINK_STATUS,&linked);assert(linked);glUseProgram(program);
 if(raw||!strcmp(argv[1],"admitted")){assert(_wpk_gl_enable_program_journal());glUseProgram(0);glUseProgram(program);}
 glViewport(0,0,16,16);glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);
 uint64_t static_warm=warm();pixel();
 uint64_t dynamic_warm=0;
 for(unsigned i=0;i<4;i++){
  glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);glBufferData(GL_ARRAY_BUFFER,sizeof positions,positions,GL_DYNAMIC_DRAW);
  glBindBuffer(GL_ARRAY_BUFFER,buffers[1]);glBufferData(GL_ARRAY_BUFFER,sizeof uv,uv,GL_DYNAMIC_DRAW);assert(glGetError()==GL_NO_ERROR);
  uint64_t start=_wpk_gl_device_requests();glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_NO_ERROR);dynamic_warm+=_wpk_gl_device_requests()-start;
 }
 pixel();
 glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);glBufferSubData(GL_ARRAY_BUFFER,0,sizeof positions,positions);assert(glGetError()==GL_NO_ERROR);uint64_t after_subdata=warm();pixel();
 assert(eglSwapBuffers(display,surface));assert(glGetError()==GL_NO_ERROR);uint64_t after_swap=warm();pixel();
 GLuint fbo;glGenFramebuffers(1,&fbo);glBindFramebuffer(GL_FRAMEBUFFER,fbo);glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_INVALID_FRAMEBUFFER_OPERATION&&glGetError()==GL_NO_ERROR);
 glBindFramebuffer(GL_FRAMEBUFFER,0);glDeleteFramebuffers(1,&fbo);assert(glGetError()==GL_NO_ERROR);uint64_t restored=warm();pixel();
 // A future peer revokes NEW local storage proofs permanently. Already
 // queued draws still own their copies; returning to one member is no proof
 // that the storage has never been shared.
 EGLContext peer=eglCreateContext(display,config,context,attrs);assert(peer!=EGL_NO_CONTEXT);assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,peer));
 glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);glBufferData(GL_ARRAY_BUFFER,2,NULL,GL_STATIC_DRAW);glFinish();assert(glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(display,surface,surface,context));assert(warm()==4);assert(eglDestroyContext(display,peer));
 glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);glBufferData(GL_ARRAY_BUFFER,sizeof positions,positions,GL_STATIC_DRAW);assert(glGetError()==GL_NO_ERROR);assert(warm()==4);pixel();
 printf("OWNED_COUNTS {\"staticWarm\":%llu,\"dynamicWarm\":%llu,\"afterSubDataWarm\":%llu,\"afterSwapWarm\":%llu,\"restoredWarm\":%llu}\n",(unsigned long long)static_warm,(unsigned long long)dynamic_warm,(unsigned long long)after_subdata,(unsigned long long)after_swap,(unsigned long long)restored);
 glUseProgram(0);glDeleteProgram(program);glDeleteShader(v);glDeleteShader(f);glDeleteBuffers(3,buffers);assert(glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
 puts("PASS owned buffer C driver");return 0;
}
