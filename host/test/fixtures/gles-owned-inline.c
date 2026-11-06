#define EGL_EGLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../../libc/glue/gl_abi.h"
static GLuint shader(GLenum type,const char *source){GLuint value=glCreateShader(type);assert(value);glShaderSource(value,1,&source,NULL);glCompileShader(value);GLint ok=0;glGetShaderiv(value,GL_COMPILE_STATUS,&ok);assert(ok);return value;}
static uint64_t cohort(const char *name,GLint location,GLint first,GLsizei count){
 uint64_t requests=0;
 for(unsigned i=0;i<5;i++){
  const int odd=i&1;glUniform4f(location,odd?.8f:.2f,odd?.2f:.6f,odd?.6f:.8f,1);
  glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);
  uint64_t before=_wpk_gl_device_requests();glDrawArrays(GL_TRIANGLES,first,count);GLenum error=glGetError();
  if(i)requests+=_wpk_gl_device_requests()-before;
  GLubyte pixel[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);GLenum read_error=glGetError();
  // Observe every changed frame before a later draw can repaint it. A zero
  // request counter alone cannot prove that the transport executed anything.
  assert(error==GL_NO_ERROR&&read_error==GL_NO_ERROR&&pixel[0]==(odd?204:51)&&pixel[1]==(odd?51:153)&&pixel[2]==(odd?153:204)&&pixel[3]==255);
 }
 printf("INLINE_OWNED_COUNT {\"operation\":\"%s\",\"requests\":%llu}\n",name,(unsigned long long)requests);return requests;
}
int main(int argc,char **argv){
 assert(argc==2);const int automatic=!strcmp(argv[1],"automatic"),refusal=!strcmp(argv[1],"refuse-cold");
 if(automatic)assert(!unsetenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION"));else assert(!setenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION","1",1));
 EGLDisplay display=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(display!=EGL_NO_DISPLAY);
 if(!strcmp(argv[1],"no-renderer")){assert(!eglInitialize(display,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);puts("PASS owned inline refuses absent renderer");return 0;}
 assert(eglInitialize(display,NULL,NULL));const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
 EGLConfig config;EGLint number;assert(eglChooseConfig(display,choose,&config,1,&number)&&number==1);
 const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE},size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
 EGLContext context=eglCreateContext(display,config,EGL_NO_CONTEXT,attrs);EGLSurface surface=eglCreatePbufferSurface(display,config,size);
 assert(context!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE&&eglMakeCurrent(display,surface,surface,context));
 GLuint vertex=shader(GL_VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"),fragment=shader(GL_FRAGMENT_SHADER,"precision mediump float;uniform vec4 tint;void main(){gl_FragColor=tint;}");
 GLuint program=glCreateProgram();glAttachShader(program,vertex);glAttachShader(program,fragment);glBindAttribLocation(program,0,"p");glLinkProgram(program);GLint linked=0;glGetProgramiv(program,GL_LINK_STATUS,&linked);assert(linked);glUseProgram(program);
 if(!strcmp(argv[1],"admitted")||refusal){assert(_wpk_gl_enable_program_journal());glUseProgram(0);glUseProgram(program);}
 GLint tint=glGetUniformLocation(program,"tint");assert(tint>=0);glViewport(0,0,16,16);glBindBuffer(GL_ARRAY_BUFFER,0);glEnableVertexAttribArray(0);
 const GLfloat points[]={0,0,0,0,0,0,-1,-1,3,-1,-1,3};
 glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,points);cohort("float-first3",tint,3,3);
 const GLfixed fixed[]={0,0,0,0,0,0,-65536,-65536,196608,-65536,-65536,196608};
 glVertexAttribPointer(0,2,GL_FIXED,GL_FALSE,0,fixed);cohort("fixed-first3",tint,3,3);
 // This original inline body is65534bytes (16+20+32749*2). Its authority
 // must use compact050c rather than losing the preexisting selected form.
 const GLsizei count=32749;GLbyte *large=malloc((size_t)count*2);assert(large);
 const GLbyte quad[]={-127,-127,127,-127,-127,127,-127,127,127,-127,127,127};
 for(GLsizei i=0;i<count*2;i++)large[i]=quad[i%12];
 glVertexAttribPointer(0,2,GL_BYTE,GL_TRUE,0,large);cohort("compact-max-body",tint,0,count);free(large);
 glDisableVertexAttribArray(0);glUseProgram(0);glDeleteProgram(program);glDeleteShader(vertex);glDeleteShader(fragment);assert(glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
 puts("PASS owned inline C driver");return 0;
}
