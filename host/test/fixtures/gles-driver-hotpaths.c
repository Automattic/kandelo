#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "../../../libc/glue/gl_abi.h"
/* Internal core VAO symbols, as exercised by the native encoder controls.
 * OES VAOs are not advertised by this GLES2 surface. */
void glGenVertexArrays(GLsizei,GLuint *);
void glBindVertexArray(GLuint);
void glDeleteVertexArrays(GLsizei,const GLuint *);
static GLuint shader(GLenum type,const char *text){GLuint s=glCreateShader(type);assert(s);glShaderSource(s,1,&text,NULL);glCompileShader(s);GLint ok=0;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);assert(ok);return s;}
#define MEASURE(label,...) do { \
 __VA_ARGS__;assert(glGetError()==GL_NO_ERROR); \
 uint64_t sum=0,min=UINT64_MAX,max=0; \
 for(unsigned i=0;i<20;i++){assert(glGetError()==GL_NO_ERROR);uint64_t start=_wpk_gl_device_requests(); \
 __VA_ARGS__;assert(glGetError()==GL_NO_ERROR);uint64_t n=_wpk_gl_device_requests()-start; \
 sum+=n;if(n<min)min=n;if(n>max)max=n;} \
 printf("COUNT {\"operation\":\"%s\",\"iterations\":20,\"total\":%llu,\"min\":%llu,\"max\":%llu}\n",label,(unsigned long long)sum,(unsigned long long)min,(unsigned long long)max); \
} while(0)
int main(int argc,char **argv){
 assert(argc==2);EGLDisplay d=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(d!=EGL_NO_DISPLAY);
 if(!strcmp(argv[1],"no-renderer")){assert(!eglInitialize(d,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);puts("PASS hotpaths refuses absent renderer");return 0;}
 assert(eglInitialize(d,NULL,NULL));EGLConfig config;EGLint count;
 const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
 assert(eglChooseConfig(d,choose,&config,1,&count)&&count==1);
 const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE},size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
 EGLContext ctx=eglCreateContext(d,config,EGL_NO_CONTEXT,attrs);EGLSurface surface=eglCreatePbufferSurface(d,config,size);assert(ctx!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE&&eglMakeCurrent(d,surface,surface,ctx));
 GLuint v=shader(GL_VERTEX_SHADER,"attribute vec2 p;uniform mat4 matrix;void main(){gl_Position=matrix*vec4(p,0.,1.);}"),f=shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}");
 GLuint program=glCreateProgram();glAttachShader(program,v);glAttachShader(program,f);glBindAttribLocation(program,0,"p");glLinkProgram(program);GLint ok=0;glGetProgramiv(program,GL_LINK_STATUS,&ok);assert(ok);glUseProgram(program);
 const GLfloat matrix[]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1},triangle[]={-1,-1,1,-1,0,1};GLint location=glGetUniformLocation(program,"matrix");assert(location>=0);glUniformMatrix4fv(location,1,GL_FALSE,matrix);
 GLuint buffers[3],texture,vao;glGenBuffers(3,buffers);glBindBuffer(GL_ARRAY_BUFFER,buffers[0]);glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STATIC_DRAW);glEnableVertexAttribArray(0);glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL);
 glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);unsigned char pixel[]={255,255,255,255};glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
 glViewport(0,0,16,16);glClearColor(0,0,0,1);glFinish();assert(glGetError()==GL_NO_ERROR);
 if(!strcmp(argv[1],"admitted")){assert(_wpk_gl_enable_program_journal());glUseProgram(0);glUseProgram(program);glFinish();assert(glGetError()==GL_NO_ERROR);}
 MEASURE("program-pair",glUseProgram(0);glUseProgram(program));
 MEASURE("array-bind-same",glBindBuffer(GL_ARRAY_BUFFER,buffers[0]));
 MEASURE("array-bind-changed",glBindBuffer(GL_ARRAY_BUFFER,buffers[1]);glBindBuffer(GL_ARRAY_BUFFER,buffers[0]));
 MEASURE("texture-bind-same",glBindTexture(GL_TEXTURE_2D,texture));
 MEASURE("array-definition-small",glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_DYNAMIC_DRAW));
 static unsigned char large[131072];
 for(unsigned i=0;i<sizeof large;i++)large[i]=(unsigned char)(i%251);
 const unsigned offsets[]={0,65520,sizeof large-sizeof triangle};
 for(unsigned i=0;i<3;i++)memcpy(large+offsets[i],triangle,sizeof triangle);
 MEASURE("array-definition-large",glBufferData(GL_ARRAY_BUFFER,sizeof large,large,GL_DYNAMIC_DRAW));
 // Exercise bytes at both ends and across the 16-bit TLV payload boundary.
 for(unsigned i=0;i<3;i++){
  glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,(const void *)(uintptr_t)offsets[i]);
  glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLES,0,3);
  unsigned char sample[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,sample);
  assert(sample[0]==51&&sample[1]==153&&sample[2]==204&&sample[3]==255&&glGetError()==GL_NO_ERROR);
 }
 glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STATIC_DRAW);assert(glGetError()==GL_NO_ERROR);
 MEASURE("attribute-default",glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL));
 MEASURE("matrix4",glUniformMatrix4fv(location,1,GL_FALSE,matrix));
 MEASURE("draw-arrays",glDrawArrays(GL_TRIANGLES,0,3));
 MEASURE("clear-default",glClear(GL_COLOR_BUFFER_BIT));
 glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,buffers[2]);
 MEASURE("element-definition-default",glBufferData(GL_ELEMENT_ARRAY_BUFFER,sizeof triangle,triangle,GL_DYNAMIC_DRAW));
 glGenVertexArrays(1,&vao);glBindVertexArray(vao);glEnableVertexAttribArray(0);glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL);assert(glGetError()==GL_NO_ERROR);
 MEASURE("attribute-vao",glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL));
 glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,buffers[2]);
 MEASURE("element-definition-vao",glBufferData(GL_ELEMENT_ARRAY_BUFFER,sizeof triangle,triangle,GL_DYNAMIC_DRAW));
 glBindVertexArray(0);assert(glGetError()==GL_NO_ERROR);
 MEASURE("attribute-restored-default",glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL));
 glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLES,0,3);unsigned char result[4];glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,result);assert(result[0]==51&&result[1]==153&&result[2]==204&&result[3]==255);assert(glGetError()==GL_NO_ERROR);
 glBindVertexArray(0);glDeleteVertexArrays(1,&vao);glUseProgram(0);glDeleteProgram(program);glDeleteShader(v);glDeleteShader(f);glDeleteBuffers(3,buffers);glDeleteTextures(1,&texture);assert(glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroyContext(d,ctx)&&eglDestroySurface(d,surface)&&eglTerminate(d)&&eglReleaseThread());
 puts("PASS hotpath request attribution");return 0;
}
