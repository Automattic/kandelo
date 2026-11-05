#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include "../../../libc/glue/gl_abi.h"
/* Internal core VAO symbols, as exercised by the native encoder controls.
 * OES VAOs are not advertised by this GLES2 surface. */
void glGenVertexArrays(GLsizei,GLuint *);
void glBindVertexArray(GLuint);
void glDeleteVertexArrays(GLsizei,const GLuint *);
static GLuint shader(GLenum type,const char *text){GLuint s=glCreateShader(type);assert(s);glShaderSource(s,1,&text,NULL);glCompileShader(s);GLint ok=0;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);assert(ok);return s;}
static void linked(GLuint program){GLint ok=0;glLinkProgram(program);glGetProgramiv(program,GL_LINK_STATUS,&ok);assert(ok);}
static const GLfloat identity2[]={1,0,0,1},identity3[]={1,0,0,0,1,0,0,0,1},identity4[]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
struct matrix_peer {EGLDisplay display;EGLConfig config;EGLContext source;GLuint program,vertex;int fail;};
static void *matrix_relink(void *opaque){
 struct matrix_peer *p=opaque;const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
 EGLContext ctx=eglCreateContext(p->display,p->config,p->source,attrs);assert(ctx!=EGL_NO_CONTEXT);
 assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,ctx));
 const char *source=p->fail?"invalid shader on purpose":"attribute vec2 p;uniform mat2 u;void main(){gl_Position=vec4(u*p,0.,1.);}";
 glShaderSource(p->vertex,1,&source,NULL);glCompileShader(p->vertex);GLint ok=0;
 glGetShaderiv(p->vertex,GL_COMPILE_STATUS,&ok);assert(ok==!p->fail);
 glLinkProgram(p->program);glGetProgramiv(p->program,GL_LINK_STATUS,&ok);assert(ok==!p->fail);
 glFinish();assert(glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
 assert(eglDestroyContext(p->display,ctx)&&eglReleaseThread());return NULL;
}
/* First call is cold; subsequent calls must retain exact host error ordering
 * without another device request when the journal proves the signature. */
#define MATRIX_CHECK(error,...) do { \
 __VA_ARGS__;assert(glGetError()==(error));assert(glGetError()==GL_NO_ERROR); \
 uint64_t before=_wpk_gl_device_requests(); \
 for(unsigned check=0;check<4;check++){__VA_ARGS__;assert(glGetError()==(error));assert(glGetError()==GL_NO_ERROR);} \
 if(admitted)assert(_wpk_gl_device_requests()==before);matrix_checks++; \
} while(0)
static void matrix_proofs(EGLDisplay d,EGLConfig config,EGLContext context,GLuint restore,int admitted,int automatic){
 unsigned matrix_checks=0;
 GLuint v=shader(GL_VERTEX_SHADER,"attribute vec2 p;uniform mat2 a;uniform mat3 b[3];uniform mat4 c;void main(){vec3 q=b[0]*b[1]*b[2]*vec3(a*p,1.);gl_Position=c*vec4(q.xy,0.,1.);}"),
  f=shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}"),program=glCreateProgram();
 glAttachShader(program,v);glAttachShader(program,f);glBindAttribLocation(program,0,"p");linked(program);glUseProgram(program);
 GLint a=glGetUniformLocation(program,"a"),b=glGetUniformLocation(program,"b[0]"),c=glGetUniformLocation(program,"c");assert(a>=0&&b>=0&&c>=0);
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal()); // Explicit installed-root generation zero.
 assert(glGetError()==GL_NO_ERROR);
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix2fv(a,1,GL_FALSE,identity2));
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix3fv(b,1,GL_FALSE,identity3));
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix4fv(c,1,GL_FALSE,identity4));
 MATRIX_CHECK(GL_INVALID_OPERATION,glUniformMatrix4fv(a,0,GL_FALSE,NULL));
 MATRIX_CHECK(GL_INVALID_OPERATION,glUniformMatrix3fv(c,1,GL_FALSE,identity3));
 GLfloat pairs[32];for(unsigned i=0;i<8;i++)memcpy(pairs+4*i,identity2,sizeof identity2);
 MATRIX_CHECK(GL_INVALID_OPERATION,glUniformMatrix2fv(a,2,GL_FALSE,pairs));
 GLfloat triples[36];for(unsigned i=0;i<4;i++)memcpy(triples+9*i,identity3,sizeof identity3);
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix3fv(b+1,3,GL_FALSE,triples)); // Excess array tail is ignored.
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix3fv(b,0,GL_FALSE,NULL));
 MATRIX_CHECK(GL_INVALID_OPERATION,glUniformMatrix4fv(1000000,0,GL_FALSE,NULL));
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix4fv(-1,1,GL_FALSE,(const GLfloat *)(uintptr_t)1));
 glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLES,0,3);unsigned char pixel[4];glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
 assert(pixel[0]==51&&pixel[1]==153&&pixel[2]==204&&pixel[3]==255&&glGetError()==GL_NO_ERROR);
 // Peer failed/successful relinks replace public metadata, not our installed
 // executable. A rejected reselect must preserve its exact-generation proof.
 GLuint generation=glCreateProgram(),gv=shader(GL_VERTEX_SHADER,"attribute vec2 p;uniform mat4 u;void main(){gl_Position=u*vec4(p,0.,1.);}");
 glAttachShader(generation,gv);glAttachShader(generation,f);glBindAttribLocation(generation,0,"p");linked(generation);glUseProgram(generation);
 GLint u=glGetUniformLocation(generation,"u");assert(u==0);
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal());assert(glGetError()==GL_NO_ERROR);
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix4fv(u,1,GL_FALSE,identity4));
 struct matrix_peer peer={d,config,context,generation,gv,1};pthread_t thread;
 assert(!pthread_create(&thread,NULL,matrix_relink,&peer)&&!pthread_join(thread,NULL));
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix4fv(u,1,GL_FALSE,identity4));
 glUseProgram(generation);assert(glGetError()==GL_INVALID_OPERATION);assert(glGetError()==GL_NO_ERROR);
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix4fv(u,1,GL_FALSE,identity4));
 peer.fail=0;assert(!pthread_create(&thread,NULL,matrix_relink,&peer)&&!pthread_join(thread,NULL));
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix4fv(u,1,GL_FALSE,identity4));
 glUseProgram(generation);assert(glGetError()==GL_NO_ERROR);
 MATRIX_CHECK(GL_INVALID_OPERATION,glUniformMatrix4fv(u,1,GL_FALSE,identity4));
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix2fv(u,1,GL_FALSE,identity2));
 glDeleteProgram(generation);assert(glGetError()==GL_NO_ERROR);
 MATRIX_CHECK(GL_NO_ERROR,glUniformMatrix2fv(u,1,GL_FALSE,identity2));
 glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLES,0,3);glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
 assert(pixel[0]==51&&pixel[1]==153&&pixel[2]==204&&pixel[3]==255&&glGetError()==GL_NO_ERROR);
 glUseProgram(0);assert(glGetError()==GL_NO_ERROR);
 MATRIX_CHECK(GL_INVALID_OPERATION,glUniformMatrix4fv(-1,1,GL_FALSE,(const GLfloat *)(uintptr_t)1));
 MATRIX_CHECK(GL_INVALID_OPERATION,glUniformMatrix4fv(u,0,GL_FALSE,NULL));
 glDeleteShader(gv);glDeleteProgram(program);glDeleteShader(v);glDeleteShader(f);glUseProgram(restore);assert(glGetError()==GL_NO_ERROR);
 printf("MATRIX_PROOFS %u\n",matrix_checks);
}
/* The original setter remains in the stream: local acceptance must agree
 * with the independent host oracle, including ignored array tails and the
 * installed executable surviving a peer's relink. Count cold/warm requests
 * separately; these are not input-to-display measurements. */
#define UNIFORM_CHECK(label,error,...) do { \
 uint64_t cold_before=_wpk_gl_device_requests(); \
 __VA_ARGS__;assert(glGetError()==(error));assert(glGetError()==GL_NO_ERROR); \
 uint64_t before=_wpk_gl_device_requests(),cold=before-cold_before; \
 for(unsigned check=0;check<4;check++){__VA_ARGS__;assert(glGetError()==(error));assert(glGetError()==GL_NO_ERROR);} \
 uint64_t requests=_wpk_gl_device_requests()-before; \
 printf("UNIFORM_COUNT {\"operation\":\"%s\",\"cold\":%llu,\"requests\":%llu}\n",label,(unsigned long long)cold,(unsigned long long)requests); \
 uniform_checks++; \
} while(0)
static void uniform_proofs(EGLDisplay d,EGLConfig config,EGLContext context,GLuint restore,int admitted,int automatic){
 unsigned uniform_checks=0;
 GLuint v=shader(GL_VERTEX_SHADER,
  "attribute vec2 p;uniform float f[3];uniform vec2 f2;uniform vec3 f3;uniform vec4 f4;"
  "uniform int i[3];uniform ivec2 i2;uniform ivec3 i3;uniform ivec4 i4;"
  "uniform bool b;uniform bvec2 b2;uniform bvec3 b3;uniform bvec4 b4;"
  "void main(){float q=f[0]+f[1]+f[2]+dot(f2,vec2(1.))+dot(f3,vec3(1.))+dot(f4,vec4(1.))"
  "+float(i[0]+i[1]+i[2])+dot(vec2(i2),vec2(1.))+dot(vec3(i3),vec3(1.))+dot(vec4(i4),vec4(1.))"
  "+float(b)+float(any(b2))+float(any(b3))+float(any(b4));gl_Position=vec4(p,q*.001,1.);}"),
 fshader=shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}"),program=glCreateProgram();
 glAttachShader(program,v);glAttachShader(program,fshader);glBindAttribLocation(program,0,"p");linked(program);glUseProgram(program);
 const char *names[]={"f[0]","f2","f3","f4","i[0]","i2","i3","i4","b","b2","b3","b4"};GLint loc[12];
 for(unsigned n=0;n<12;n++){loc[n]=glGetUniformLocation(program,names[n]);assert(loc[n]>=0);}
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal());assert(glGetError()==GL_NO_ERROR);
 const GLfloat fv[]={.25f,.5f,.75f,1.f};const GLint iv[]={1,2,3,4};
 UNIFORM_CHECK("float-scalar",GL_NO_ERROR,glUniform1f(loc[0],.25f));
 UNIFORM_CHECK("float2-scalar",GL_NO_ERROR,glUniform2f(loc[1],.25f,.5f));
 UNIFORM_CHECK("float3-scalar",GL_NO_ERROR,glUniform3f(loc[2],.25f,.5f,.75f));
 UNIFORM_CHECK("float4-scalar",GL_NO_ERROR,glUniform4f(loc[3],.25f,.5f,.75f,1.f));
 UNIFORM_CHECK("float-array",GL_NO_ERROR,glUniform1fv(loc[0],3,fv));
 UNIFORM_CHECK("float2-vector",GL_NO_ERROR,glUniform2fv(loc[1],1,fv));
 UNIFORM_CHECK("float3-vector",GL_NO_ERROR,glUniform3fv(loc[2],1,fv));
 UNIFORM_CHECK("float4-vector",GL_NO_ERROR,glUniform4fv(loc[3],1,fv));
 UNIFORM_CHECK("int-scalar",GL_NO_ERROR,glUniform1i(loc[4],1));
 UNIFORM_CHECK("int2-scalar",GL_NO_ERROR,glUniform2i(loc[5],1,2));
 UNIFORM_CHECK("int3-scalar",GL_NO_ERROR,glUniform3i(loc[6],1,2,3));
 UNIFORM_CHECK("int4-scalar",GL_NO_ERROR,glUniform4i(loc[7],1,2,3,4));
 UNIFORM_CHECK("int-array",GL_NO_ERROR,glUniform1iv(loc[4],3,iv));
 UNIFORM_CHECK("int2-vector",GL_NO_ERROR,glUniform2iv(loc[5],1,iv));
 UNIFORM_CHECK("int3-vector",GL_NO_ERROR,glUniform3iv(loc[6],1,iv));
 UNIFORM_CHECK("int4-vector",GL_NO_ERROR,glUniform4iv(loc[7],1,iv));
 UNIFORM_CHECK("bool-float",GL_NO_ERROR,glUniform1f(loc[8],.25f));
 UNIFORM_CHECK("bool2-float",GL_NO_ERROR,glUniform2fv(loc[9],1,fv));
 UNIFORM_CHECK("bool3-int",GL_NO_ERROR,glUniform3iv(loc[10],1,iv));
 UNIFORM_CHECK("bool4-int",GL_NO_ERROR,glUniform4i(loc[11],1,0,3,0));
 UNIFORM_CHECK("wrong-scalar-type",GL_INVALID_OPERATION,glUniform1i(loc[0],1));
 UNIFORM_CHECK("wrong-vector-zero-count",GL_INVALID_OPERATION,glUniform2iv(loc[1],0,NULL));
 UNIFORM_CHECK("nonarray-zero-count",GL_NO_ERROR,glUniform2fv(loc[1],0,NULL));
 UNIFORM_CHECK("nonarray-excess",GL_INVALID_OPERATION,glUniform2fv(loc[1],2,fv));
 UNIFORM_CHECK("float-array-tail",GL_NO_ERROR,glUniform1fv(loc[0]+2,4,fv));
 UNIFORM_CHECK("int-array-tail",GL_NO_ERROR,glUniform1iv(loc[4]+2,4,iv));
 UNIFORM_CHECK("missing-zero-count",GL_INVALID_OPERATION,glUniform4iv(1000000,0,NULL));
 UNIFORM_CHECK("ignored-pointer",GL_NO_ERROR,glUniform4iv(-1,1,(const GLint *)(uintptr_t)1));
 GLfloat floats[4]={0};GLint ints[4]={0};glGetUniformfv(program,loc[3],floats);assert(!memcmp(floats,fv,sizeof fv));
 glGetUniformiv(program,loc[7],ints);assert(!memcmp(ints,iv,sizeof iv));
 glGetUniformiv(program,loc[11],ints);assert(ints[0]==1&&ints[1]==0&&ints[2]==1&&ints[3]==0);
 glGetUniformfv(program,loc[0]+2,floats);assert(floats[0]==.25f);
 glGetUniformiv(program,loc[4]+2,ints);assert(ints[0]==1&&glGetError()==GL_NO_ERROR);
 glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLES,0,3);unsigned char pixel[4];glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
 assert(pixel[0]==51&&pixel[1]==153&&pixel[2]==204&&pixel[3]==255&&glGetError()==GL_NO_ERROR);
 GLuint sv=shader(GL_VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"),
 sf=shader(GL_FRAGMENT_SHADER,"precision mediump float;uniform sampler2D t[3];void main(){gl_FragColor=(texture2D(t[0],vec2(.5))+texture2D(t[1],vec2(.5))+texture2D(t[2],vec2(.5)))/3.;}"),sp=glCreateProgram();
 glAttachShader(sp,sv);glAttachShader(sp,sf);glBindAttribLocation(sp,0,"p");linked(sp);glUseProgram(sp);GLint t=glGetUniformLocation(sp,"t[0]");assert(t>=0);
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal());assert(glGetError()==GL_NO_ERROR);
 UNIFORM_CHECK("sampler-scalar-minimum",GL_NO_ERROR,glUniform1i(t,7));
 const GLint units[]={0,0,0,1000000};
 UNIFORM_CHECK("sampler-array-tail",GL_NO_ERROR,glUniform1iv(t,4,units));
 UNIFORM_CHECK("sampler-wrong-type",GL_INVALID_OPERATION,glUniform1f(t,0));
 // Eight is outside the guaranteed ES2 minimum until the existing explicit
 // active-texture path has learned the actual renderer limit. Keep the
 // unknown-limit path honest rather than guessing or querying per setter.
 uint64_t before=_wpk_gl_device_requests();glUniform1i(t,8);assert(glGetError()==GL_NO_ERROR);
 if(admitted)assert(_wpk_gl_device_requests()>before);
 glActiveTexture(GL_TEXTURE0);GLint limit=0;glGetIntegerv(GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS,&limit);assert(limit>8&&glGetError()==GL_NO_ERROR);
 UNIFORM_CHECK("sampler-known-high-unit",GL_NO_ERROR,glUniform1i(t,8));
 UNIFORM_CHECK("sampler-known-negative",GL_INVALID_VALUE,glUniform1i(t,-1));
 UNIFORM_CHECK("sampler-known-limit",GL_INVALID_VALUE,glUniform1i(t,limit));
 const GLint rejected[]={0,limit,0};
 UNIFORM_CHECK("sampler-array-invalid",GL_INVALID_VALUE,glUniform1iv(t,3,rejected));
 glGetUniformiv(sp,t,ints);assert(ints[0]==8&&glGetError()==GL_NO_ERROR); // Rejection changed no prefix.
 glUniform1iv(t,3,units);glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_TRIANGLES,0,3);glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
 assert(pixel[0]==255&&pixel[1]==255&&pixel[2]==255&&pixel[3]==255&&glGetError()==GL_NO_ERROR);
 GLuint generation=glCreateProgram(),gv=shader(GL_VERTEX_SHADER,"attribute vec2 p;uniform float u;void main(){gl_Position=vec4(p,u,1.);}");
 glAttachShader(generation,gv);glAttachShader(generation,fshader);glBindAttribLocation(generation,0,"p");linked(generation);glUseProgram(generation);GLint u=glGetUniformLocation(generation,"u");assert(u==0);
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal());assert(glGetError()==GL_NO_ERROR);
 UNIFORM_CHECK("float-old-generation",GL_NO_ERROR,glUniform1f(u,.25f));
 struct matrix_peer peer={d,config,context,generation,gv,0};pthread_t thread;assert(!pthread_create(&thread,NULL,matrix_relink,&peer)&&!pthread_join(thread,NULL));
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal());assert(glGetError()==GL_NO_ERROR);
 UNIFORM_CHECK("float-peer-relink",GL_NO_ERROR,glUniform1f(u,.25f));
 glUseProgram(generation);assert(glGetError()==GL_NO_ERROR);
 UNIFORM_CHECK("float-new-generation-mismatch",GL_INVALID_OPERATION,glUniform1f(u,.25f));
 glUseProgram(0);assert(glGetError()==GL_NO_ERROR);
 UNIFORM_CHECK("float-no-program",GL_INVALID_OPERATION,glUniform1f(u,.25f));
 UNIFORM_CHECK("ignored-no-program",GL_INVALID_OPERATION,glUniform1i(-1,7));
 glDeleteProgram(generation);glDeleteShader(gv);glDeleteProgram(sp);glDeleteShader(sv);glDeleteShader(sf);glDeleteProgram(program);glDeleteShader(v);glDeleteShader(fshader);glUseProgram(restore);
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal());assert(glGetError()==GL_NO_ERROR);
 printf("UNIFORM_PROOFS %u\n",uniform_checks);fflush(stdout);
}
struct inline_peer {EGLDisplay display;EGLConfig config;EGLContext source;GLuint program,fragment;const char *text;};
static void *inline_relink(void *opaque){
 struct inline_peer *p=opaque;const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
 EGLContext ctx=eglCreateContext(p->display,p->config,p->source,attrs);assert(ctx!=EGL_NO_CONTEXT);
 assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,ctx));
 glShaderSource(p->fragment,1,&p->text,NULL);glCompileShader(p->fragment);GLint ok=0;glGetShaderiv(p->fragment,GL_COMPILE_STATUS,&ok);assert(ok);
 linked(p->program);glFinish();assert(glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroyContext(p->display,ctx)&&eglReleaseThread());return NULL;
}
#define INLINE_CHECK(label,error,...) do { \
 uint64_t cold_before=_wpk_gl_device_requests(); \
 __VA_ARGS__;assert(glGetError()==(error)&&glGetError()==GL_NO_ERROR); \
 uint64_t before=_wpk_gl_device_requests(),cold=before-cold_before; \
 for(unsigned check=0;check<4;check++){__VA_ARGS__;assert(glGetError()==(error)&&glGetError()==GL_NO_ERROR);} \
 printf("INLINE_COUNT {\"operation\":\"%s\",\"cold\":%llu,\"requests\":%llu}\n",label,(unsigned long long)cold,(unsigned long long)(_wpk_gl_device_requests()-before));inline_checks++; \
} while(0)
static void inline_pixel(const unsigned char expected[4]){
 unsigned char pixel[4];glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
 assert(!memcmp(pixel,expected,4)&&glGetError()==GL_NO_ERROR);
}
static void inline_proofs(EGLDisplay d,EGLConfig config,EGLContext parent,EGLSurface parent_surface,int admitted,int automatic){
 unsigned inline_checks=0;const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE},size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
 EGLContext ctx=eglCreateContext(d,config,parent,attrs);EGLSurface surface=eglCreatePbufferSurface(d,config,size);
 assert(ctx!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE&&eglMakeCurrent(d,surface,surface,ctx));
 GLuint v=shader(GL_VERTEX_SHADER,"attribute vec2 p;attribute vec4 c;varying vec4 color;void main(){gl_Position=vec4(p,0.,1.);color=c;}"),
 f=shader(GL_FRAGMENT_SHADER,"precision mediump float;varying vec4 color;void main(){gl_FragColor=vec4(.2,.6,.8,1.)+color*.001;}"),program=glCreateProgram();
 glAttachShader(program,v);glAttachShader(program,f);glBindAttribLocation(program,0,"p");glBindAttribLocation(program,1,"c");linked(program);glUseProgram(program);
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal());
 const GLfloat triangle[]={-1,-1,1,-1,0,1};glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,triangle);glEnableVertexAttribArray(0);
 glViewport(0,0,16,16);glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);assert(glGetError()==GL_NO_ERROR);
 const unsigned char blue[]={51,153,204,255},white[]={255,255,255,255};
 INLINE_CHECK("no-sampler",GL_NO_ERROR,glDrawArrays(GL_TRIANGLES,0,3));inline_pixel(blue);
 // Mixed client/VBO arrays keep the conservative path even if this particular
 // buffer is large enough. Shared mutable storage is not a local draw proof.
 GLuint buffer;glGenBuffers(1,&buffer);glBindBuffer(GL_ARRAY_BUFFER,buffer);const GLfloat colors[12]={0};
 glBufferData(GL_ARRAY_BUFFER,sizeof colors,colors,GL_STATIC_DRAW);glVertexAttribPointer(1,4,GL_FLOAT,GL_FALSE,0,NULL);glEnableVertexAttribArray(1);assert(glGetError()==GL_NO_ERROR);
 INLINE_CHECK("mixed-buffer",GL_NO_ERROR,glDrawArrays(GL_TRIANGLES,0,3));inline_pixel(blue);
 glDisableVertexAttribArray(1);glBindBuffer(GL_ARRAY_BUFFER,0);glDeleteBuffers(1,&buffer);assert(glGetError()==GL_NO_ERROR);
 GLuint sf=shader(GL_FRAGMENT_SHADER,"precision mediump float;uniform sampler2D t;void main(){gl_FragColor=texture2D(t,vec2(.5));}"),sp=glCreateProgram();
 glAttachShader(sp,v);glAttachShader(sp,sf);glBindAttribLocation(sp,0,"p");linked(sp);glUseProgram(sp);
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal());
 GLuint texture;glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,white);assert(glGetError()==GL_NO_ERROR);
 INLINE_CHECK("one-sampler",GL_NO_ERROR,glDrawArrays(GL_TRIANGLES,0,3));inline_pixel(white);
 struct inline_peer peer={d,config,ctx,sp,sf,"precision mediump float;uniform sampler2D t,s;void main(){gl_FragColor=(texture2D(t,vec2(.5))+texture2D(s,vec2(.5)))/2.;}"};pthread_t thread;
 assert(!pthread_create(&thread,NULL,inline_relink,&peer)&&!pthread_join(thread,NULL));
 if(admitted&&!automatic)assert(_wpk_gl_enable_program_journal());assert(glGetError()==GL_NO_ERROR);
 INLINE_CHECK("old-link",GL_NO_ERROR,glDrawArrays(GL_TRIANGLES,0,3));inline_pixel(white);
 glUseProgram(sp);assert(glGetError()==GL_NO_ERROR);
 INLINE_CHECK("new-link-multi-sampler",GL_NO_ERROR,glDrawArrays(GL_TRIANGLES,0,3));inline_pixel(white);
 glUseProgram(program);assert(glGetError()==GL_NO_ERROR);
 GLuint fbo;glGenFramebuffers(1,&fbo);glBindFramebuffer(GL_FRAMEBUFFER,fbo);assert(glGetError()==GL_NO_ERROR);
 INLINE_CHECK("incomplete-framebuffer",GL_INVALID_FRAMEBUFFER_OPERATION,glDrawArrays(GL_TRIANGLES,0,3));
 glBindFramebuffer(GL_FRAMEBUFFER,0);glDeleteFramebuffers(1,&fbo);assert(glGetError()==GL_NO_ERROR);
 INLINE_CHECK("restored-framebuffer",GL_NO_ERROR,glDrawArrays(GL_TRIANGLES,0,3));inline_pixel(blue);
 glUseProgram(0);glDeleteProgram(program);glDeleteProgram(sp);glDeleteShader(v);glDeleteShader(f);glDeleteShader(sf);glDeleteTextures(1,&texture);assert(glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(d,parent_surface,parent_surface,parent)&&eglDestroyContext(d,ctx)&&eglDestroySurface(d,surface));
 printf("INLINE_PROOFS %u\n",inline_checks);fflush(stdout);
}
/* Read-only rejection cannot revoke independently owned program names.
 * Both standalone requests and accepted-prefix/query-rejection receipts keep
 * exact errors and untouched outputs. Checked mode remains the control. */
static void readonly_query_proofs(GLuint program,int admitted){
 unsigned checks=0;
 for(unsigned prefix=0;prefix<2;prefix++)for(unsigned kind=0;kind<3;kind++)for(unsigned version=0;version<2;version++){
  glUseProgram(program);glFinish();assert(glGetError()==GL_NO_ERROR);
  if(prefix)glClearColor(.2f,.6f,.8f,1.f);
  GLenum pname=0x821bu+version; /* GLES3 MAJOR_VERSION / MINOR_VERSION. */
  if(kind==0){GLint value=77;glGetIntegerv(pname,&value);assert(value==77);}
  else if(kind==1){GLfloat value=7.25f;glGetFloatv(pname,&value);assert(value==7.25f);}
  else {GLboolean value=77;glGetBooleanv(pname,&value);assert(value==77);}
  assert(glGetError()==GL_INVALID_ENUM&&glGetError()==GL_NO_ERROR);
  uint64_t before=_wpk_gl_device_requests();
  for(unsigned i=0;i<20;i++){glUseProgram(0);glUseProgram(program);assert(glGetError()==GL_NO_ERROR);}
  assert(_wpk_gl_device_requests()-before==(admitted?0:40));checks++;
 }
 glFinish();assert(glGetError()==GL_NO_ERROR);
 printf("READONLY_QUERY_PROOFS %u\n",checks);
}
#define MEASURE(label,...) do { \
 uint64_t setup_before=_wpk_gl_device_requests(); \
 __VA_ARGS__;assert(glGetError()==GL_NO_ERROR); \
 printf("SETUP {\"operation\":\"%s\",\"deviceRequests\":%llu}\n",label,(unsigned long long)(_wpk_gl_device_requests()-setup_before)); \
 uint64_t sum=0,min=UINT64_MAX,max=0; \
 for(unsigned i=0;i<20;i++){assert(glGetError()==GL_NO_ERROR);uint64_t start=_wpk_gl_device_requests(); \
 __VA_ARGS__;assert(glGetError()==GL_NO_ERROR);uint64_t n=_wpk_gl_device_requests()-start; \
 sum+=n;if(n<min)min=n;if(n>max)max=n;} \
 printf("COUNT {\"operation\":\"%s\",\"iterations\":20,\"total\":%llu,\"min\":%llu,\"max\":%llu}\n",label,(unsigned long long)sum,(unsigned long long)min,(unsigned long long)max); \
} while(0)
int main(int argc,char **argv){
 assert(argc==2);const int automatic=!strcmp(argv[1],"automatic");
 if(automatic)assert(!unsetenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION"));
 else assert(!setenv("KANDELO_GL_CHECKED_PROGRAM_SELECTION","1",1));
 EGLDisplay d=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(d!=EGL_NO_DISPLAY);
 if(!strcmp(argv[1],"no-renderer")){assert(!eglInitialize(d,NULL,NULL)&&eglGetError()==EGL_NOT_INITIALIZED);puts("PASS hotpaths refuses absent renderer");return 0;}
 assert(eglInitialize(d,NULL,NULL));EGLConfig config;EGLint count;
 const EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
 assert(eglChooseConfig(d,choose,&config,1,&count)&&count==1);
 const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE},size[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
 EGLContext ctx=eglCreateContext(d,config,EGL_NO_CONTEXT,attrs);EGLSurface surface=eglCreatePbufferSurface(d,config,size);assert(ctx!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE&&eglMakeCurrent(d,surface,surface,ctx));
 GLuint v=shader(GL_VERTEX_SHADER,"attribute vec2 p;uniform mat4 matrix;void main(){gl_Position=matrix*vec4(p,0.,1.);}"),f=shader(GL_FRAGMENT_SHADER,"precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}");
 GLuint program=glCreateProgram();glAttachShader(program,v);glAttachShader(program,f);glBindAttribLocation(program,0,"p");glLinkProgram(program);GLint ok=0;glGetProgramiv(program,GL_LINK_STATUS,&ok);assert(ok);glUseProgram(program);
 const GLfloat matrix[]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1},triangle[]={-1,-1,1,-1,0,1};GLint location=glGetUniformLocation(program,"matrix");assert(location>=0);
 uint64_t initial_matrix=_wpk_gl_device_requests();glUniformMatrix4fv(location,1,GL_FALSE,matrix);assert(glGetError()==GL_NO_ERROR);
 printf("INITIAL_MATRIX %llu\n",(unsigned long long)(_wpk_gl_device_requests()-initial_matrix));
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
 matrix_proofs(d,config,ctx,program,automatic||!strcmp(argv[1],"admitted"),automatic);
 uniform_proofs(d,config,ctx,program,automatic||!strcmp(argv[1],"admitted"),automatic);
 readonly_query_proofs(program,automatic||!strcmp(argv[1],"admitted"));
 inline_proofs(d,config,ctx,surface,automatic||!strcmp(argv[1],"admitted"),automatic);
 glBindVertexArray(0);glDeleteVertexArrays(1,&vao);glUseProgram(0);glDeleteProgram(program);glDeleteShader(v);glDeleteShader(f);glDeleteBuffers(3,buffers);glDeleteTextures(1,&texture);assert(glGetError()==GL_NO_ERROR);
 assert(eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT)&&eglDestroyContext(d,ctx)&&eglDestroySurface(d,surface)&&eglTerminate(d)&&eglReleaseThread());
 puts("PASS hotpath request attribution");return 0;
}
