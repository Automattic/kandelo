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
static void pixel_color(unsigned r,unsigned g,unsigned b){GLubyte p[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,p);assert(p[0]==r&&p[1]==g&&p[2]==b&&p[3]==255&&glGetError()==GL_NO_ERROR);}
static void pixel(void){pixel_color(51,153,204);}
static void first_effect(const char *kind,unsigned r,unsigned g,unsigned b){
 GLenum error=glGetError();GLubyte p[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,p);GLenum read_error=glGetError();
 printf("COLD_FIRST_RESULT {\"kind\":\"%s\",\"error\":%u,\"readError\":%u,\"pixel\":[%u,%u,%u,%u]}\n",kind,error,read_error,p[0],p[1],p[2],p[3]);fflush(stdout);
 assert(error==GL_NO_ERROR&&read_error==GL_NO_ERROR&&p[0]==r&&p[1]==g&&p[2]==b&&p[3]==255);
}

int main(int argc,char **argv){
 const int offscreen=argc==2&&!strcmp(argv[1],"offscreen");assert(argc==1||offscreen);const int automatic=0,raw=0;
 if(automatic)assert(!unsetenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION"));else assert(!setenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION","1",1));
 EGLDisplay display=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(display!=EGL_NO_DISPLAY);
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
 if(1){assert(_wpk_gl_enable_program_journal());glUseProgram(0);glUseProgram(program);}
 GLuint texture=0,framebuffer=0;
 if(offscreen){
  glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,16,16,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
  glGenFramebuffers(1,&framebuffer);glBindFramebuffer(GL_FRAMEBUFFER,framebuffer);glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,texture,0);
  glBindTexture(GL_TEXTURE_2D,0);assert(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE&&glGetError()==GL_NO_ERROR);
 }
 glViewport(0,0,16,16);
 // Action12 can be reached by clear before the first draw. Observe this
 // first visible effect immediately, so later fallback draws cannot hide it.
 if(offscreen){glClearColor(1,0,0,1);glClear(GL_COLOR_BUFFER_BIT);first_effect("clear",255,0,0);}
 glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);
 // Inspect the FIRST cold draw before any retry can repaint its pixels.
 // A definite optimization-admission refusal must execute this ordinary API.
 glDrawArrays(GL_TRIANGLE_STRIP,0,4);first_effect("draw",51,153,204);
 for(unsigned i=0;i<3;i++){glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_NO_ERROR);pixel();}
 // A completed capture refusal consumes its attempted token; a later
 // definition must advance that token rather than retry the failed one.
 const GLfloat changed[]={.8,.2,.6,1,.8,.2,.6,1,.8,.2,.6,1,.8,.2,.6,1};
 glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);glBufferData(GL_ARRAY_BUFFER,sizeof positions,positions,GL_DYNAMIC_DRAW);
 glBindBuffer(GL_ARRAY_BUFFER,buffers[2]);glBufferData(GL_ARRAY_BUFFER,sizeof changed,changed,GL_DYNAMIC_DRAW);assert(glGetError()==GL_NO_ERROR);
 if(offscreen){glBindTexture(GL_TEXTURE_2D,texture);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,16,16,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);glBindTexture(GL_TEXTURE_2D,0);}
 for(unsigned i=0;i<3;i++){glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_NO_ERROR);pixel_color(204,51,153);}
 if(offscreen){glBindFramebuffer(GL_FRAMEBUFFER,0);glDeleteFramebuffers(1,&framebuffer);glDeleteTextures(1,&texture);}

 glUseProgram(0);glDeleteProgram(program);glDeleteShader(v);glDeleteShader(f);glDeleteBuffers(3,buffers);assert(glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
 puts("PASS cold owned admission preserves original draw");return 0;
}
