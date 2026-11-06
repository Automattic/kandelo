#define EGL_EGLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include "../../../libc/glue/gl_abi.h"
static GLuint shader(GLenum type,const char *source){GLuint s=glCreateShader(type);assert(s);glShaderSource(s,1,&source,NULL);glCompileShader(s);GLint ok=0;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);assert(ok);return s;}
static GLuint program(const char *fragment){GLuint v=shader(GL_VERTEX_SHADER,"attribute vec2 p;attribute vec2 uv;attribute vec4 color;varying vec2 t;varying vec4 c;void main(){gl_Position=vec4(p,0.,1.);t=uv*.00001+vec2(.5);c=color;}"),f=shader(GL_FRAGMENT_SHADER,fragment),p=glCreateProgram();glAttachShader(p,v);glAttachShader(p,f);glBindAttribLocation(p,0,"p");glBindAttribLocation(p,1,"uv");glBindAttribLocation(p,2,"color");glLinkProgram(p);GLint ok=0;glGetProgramiv(p,GL_LINK_STATUS,&ok);assert(ok);glDeleteShader(v);glDeleteShader(f);return p;}
static void pixel(unsigned x,unsigned y,unsigned alternate){GLubyte value[4]={0};glReadPixels(x,y,1,1,GL_RGBA,GL_UNSIGNED_BYTE,value);assert(glGetError()==GL_NO_ERROR);assert(value[0]==(alternate?204:51)&&value[1]==(alternate?51:153)&&value[2]==(alternate?153:204)&&value[3]==255);}
static void tint(GLint location,unsigned alternate){glUniform4f(location,alternate?.8f:.2f,alternate?.2f:.6f,alternate?.6f:.8f,1);assert(glGetError()==GL_NO_ERROR);}
int main(int argc,char **argv){
 assert(argc==2);int automatic=!strcmp(argv[1],"automatic");if(automatic)assert(!unsetenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION"));else assert(!setenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION","1",1));
 EGLDisplay d=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(d!=EGL_NO_DISPLAY);
 if(!strcmp(argv[1],"no-renderer")){assert(!eglInitialize(d,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);puts("PASS owned framebuffers refuse absent renderer");return 0;}
 assert(eglInitialize(d,NULL,NULL));const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
 EGLConfig config;EGLint count;assert(eglChooseConfig(d,choose,&config,1,&count)&&count==1);const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT,EGL_TRUE,EGL_NONE},size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
 EGLContext context=eglCreateContext(d,config,EGL_NO_CONTEXT,attrs);EGLSurface surface=eglCreatePbufferSurface(d,config,size);assert(context!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE&&eglMakeCurrent(d,surface,surface,context));
 const GLfloat positions[]={-1,-1,1,-1,-1,1,1,1},uv[8]={0},colors[]={1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1};GLuint buffers[3];glGenBuffers(3,buffers);
 for(unsigned i=0;i<3;i++){glBindBuffer(GL_ARRAY_BUFFER,buffers[i]);glBufferData(GL_ARRAY_BUFFER,i==2?sizeof colors:sizeof positions,i==0?positions:i==1?uv:colors,GL_STATIC_DRAW);glVertexAttribPointer(i,i==2?4:2,GL_FLOAT,GL_FALSE,0,NULL);glEnableVertexAttribArray(i);}
 GLuint programs[2]={program("precision mediump float;uniform sampler2D a;uniform sampler2D b;uniform vec4 tint;varying vec2 t;varying vec4 c;void main(){gl_FragColor=tint*c*texture2D(b,t)*texture2D(a,t).aaaa;}"),program("precision mediump float;uniform sampler2D image;varying vec2 t;varying vec4 c;void main(){gl_FragColor=texture2D(image,t);}")};
 GLuint textures[3];glGenTextures(3,textures);GLubyte alpha[16],white[64];memset(alpha,255,sizeof alpha);memset(white,255,sizeof white);
 for(unsigned i=0;i<3;i++){glBindTexture(GL_TEXTURE_2D,textures[i]);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);glTexImage2D(GL_TEXTURE_2D,0,i?GL_RGBA:GL_ALPHA,i==2?16:4,i==2?16:4,0,i?GL_RGBA:GL_ALPHA,GL_UNSIGNED_BYTE,i==2?NULL:i?white:alpha);}
 GLuint fbo;glGenFramebuffers(1,&fbo);glBindFramebuffer(GL_FRAMEBUFFER,fbo);glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,textures[2],0);assert(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);
 if(!strcmp(argv[1],"admitted"))assert(_wpk_gl_enable_program_journal());
 glUseProgram(programs[0]);glUniform1i(glGetUniformLocation(programs[0],"a"),0);glUniform1i(glGetUniformLocation(programs[0],"b"),1);GLint tint_location=glGetUniformLocation(programs[0],"tint");assert(tint_location>=0);
 glUseProgram(programs[1]);glUniform1i(glGetUniformLocation(programs[1],"image"),0);glViewport(0,0,16,16);glClearColor(0,0,0,1);assert(glGetError()==GL_NO_ERROR);
 uint64_t offscreen=0,screen=0,clear_requests=0;
 for(unsigned i=0;i<5;i++){
  glBindFramebuffer(GL_FRAMEBUFFER,fbo);glUseProgram(programs[0]);glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,textures[0]);glActiveTexture(GL_TEXTURE1);glBindTexture(GL_TEXTURE_2D,textures[1]);assert(glGetError()==GL_NO_ERROR);uint64_t clear_start=_wpk_gl_device_requests();glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);if(i)clear_requests+=_wpk_gl_device_requests()-clear_start;tint(tint_location,i&1);
  uint64_t start=_wpk_gl_device_requests();glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_NO_ERROR);if(i)offscreen+=_wpk_gl_device_requests()-start;pixel(4,4,i&1);
  // Each frame has different pixels, and the next pass samples that result.
  // Repeating old pixels or dropping a warmed draw cannot satisfy this check.
  glBindFramebuffer(GL_FRAMEBUFFER,0);glUseProgram(programs[1]);glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,textures[2]);glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);
  start=_wpk_gl_device_requests();glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_NO_ERROR);if(i)screen+=_wpk_gl_device_requests()-start;pixel(4,4,i&1);
 }
 printf("FBO_COUNTS {\"offscreenWarm\":%llu,\"defaultWarm\":%llu,\"clearWarm\":%llu}\n",(unsigned long long)offscreen,(unsigned long long)screen,(unsigned long long)clear_requests);fflush(stdout);
 // Redefining the destination must select new storage, not an older cached
 // target. The original private generation remains owned until retirement.
 glBindTexture(GL_TEXTURE_2D,textures[2]);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,8,8,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);glBindFramebuffer(GL_FRAMEBUFFER,fbo);glUseProgram(programs[0]);glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,textures[0]);glActiveTexture(GL_TEXTURE1);glBindTexture(GL_TEXTURE_2D,textures[1]);tint(tint_location,1);glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_NO_ERROR);pixel(1,1,1);
 EGLContext peer=eglCreateContext(d,config,context,attrs);assert(peer!=EGL_NO_CONTEXT&&eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,peer));glBindTexture(GL_TEXTURE_2D,textures[2]);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,2,2,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);glFinish();assert(glGetError()==GL_NO_ERROR);assert(eglMakeCurrent(d,surface,surface,context));glUseProgram(programs[0]);tint(tint_location,0);glDrawArrays(GL_TRIANGLE_STRIP,0,4);assert(glGetError()==GL_NO_ERROR);pixel(1,1,0);assert(eglDestroyContext(d,peer));
 // A successful drain says nothing about bindings changed through raw I/O.
 GLuint incomplete;glGenFramebuffers(1,&incomplete);glBindFramebuffer(GL_FRAMEBUFFER,incomplete);glBindFramebuffer(GL_FRAMEBUFFER,0);glFlush();assert(glGetError()==GL_NO_ERROR);
 uint8_t *raw=_wpk_gl_cmdbuf_base();const uint16_t header[2]={OP_BIND_FRAMEBUFFER,8};const uint32_t words[2]={GL_FRAMEBUFFER,incomplete};memcpy(raw,header,4);memcpy(raw+4,words,8);struct gl_submit_info submit={.length=12};_wpk_gl_note_device_request();assert(ioctl(_wpk_gl_fd(),GLIO_SUBMIT,&submit)==0);assert(glGetError()==GL_NO_ERROR);glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_INVALID_FRAMEBUFFER_OPERATION&&glGetError()==GL_NO_ERROR);puts("PASS raw target proof revoked");
 glBindFramebuffer(GL_FRAMEBUFFER,0);glDeleteFramebuffers(1,&incomplete);glDeleteFramebuffers(1,&fbo);glUseProgram(0);glDeleteProgram(programs[0]);glDeleteProgram(programs[1]);glDeleteTextures(3,textures);glDeleteBuffers(3,buffers);assert(glGetError()==GL_NO_ERROR);assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroySurface(d,surface)&&eglDestroyContext(d,context)&&eglTerminate(d)&&eglReleaseThread());puts("PASS owned framebuffer C driver");return 0;
}
