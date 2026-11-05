/* Exercise journal transport and explicitly admitted C selection through the
 * real SDK/kernel/host path. Raw-wire modes keep independent protocol checks. */
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
#include <sys/wait.h>
#include <unistd.h>
#include "../../../libc/glue/gl_abi.h"

static uint32_t reply[12],transaction;
static int query_at(int fd,uint32_t op,const uint32_t *input,size_t count,void *output,size_t bytes) {
    struct gl_query_info q={.op=op,.in_buf_ptr=(uintptr_t)input,.in_buf_len=count*4,
        .out_buf_ptr=(uintptr_t)output,.out_buf_len=bytes};
    _wpk_gl_note_device_request();
    return ioctl(fd,GLIO_QUERY,&q);
}
static void query(uint32_t op,const uint32_t *input,size_t count,void *output,size_t bytes) {
    assert(query_at(_wpk_gl_fd(),op,input,count,output,bytes)==0);
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
static void submit(size_t length) {
    assert(length<=WPK_GL_CMDBUF_LEN);
    const struct gl_submit_info request={.offset=0,.length=length};
    _wpk_gl_note_device_request();assert(ioctl(_wpk_gl_fd(),GLIO_SUBMIT,&request)==0);
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
struct lifecycle_data {
    EGLDisplay display;EGLContext retiring;int fd;
    uint32_t publication[19],request[4],result[12];
    struct gl_submit_query_info packet;
};
static void untouched(const uint32_t *words) {
    for(unsigned i=0;i<12;i++)assert(words[i]==0xa5a5a5a5);
}
static void *publish_before_retirement(void *opaque) {
    struct lifecycle_data *p=opaque;p->request[0]=6;memset(p->result,0xa5,sizeof p->result);
    errno=0;assert(query_at(p->fd,QOP_PROGRAM_JOURNAL,p->request,1,p->result,sizeof p->result)==-1&&errno==EACCES);
    untouched(p->result);
    const uint32_t forbidden[][4]={{1,1,4},{2,1,1},{4,1,1,1},{5,1}};
    for(unsigned i=0;i<4;i++) {
        memcpy(p->request,forbidden[i],sizeof p->request);errno=0;
        assert(query_at(p->fd,QOP_PROGRAM_JOURNAL_BARRIER,p->request,i==2?4:i==3?2:3,p->result,sizeof p->result)==-1&&errno==EINVAL);
        untouched(p->result);
    }
    // A metadata capability cannot smuggle a foreign command prefix.
    p->request[0]=6;p->packet.submit.length=4;
    p->packet.query=(struct gl_query_info){.op=QOP_PROGRAM_JOURNAL_BARRIER,
        .in_buf_ptr=(uintptr_t)p->request,.in_buf_len=4,.out_buf_ptr=(uintptr_t)p->result,.out_buf_len=sizeof p->result};
    _wpk_gl_note_device_request();assert(ioctl(p->fd,GLIO_SUBMIT_QUERY,&p->packet)==0);
    assert(p->packet.result.completed_phase==WPK_GL_SUBMIT_QUERY_PHASE_SUBMIT&&p->packet.result.submit_rc==-EACCES&&
        p->packet.result.query_rc==0&&p->packet.result.result_magic==WPK_GL_SUBMIT_QUERY_REPLY_MAGIC);
    untouched(p->result);
    assert(query_at(p->fd,QOP_PROGRAM_JOURNAL_BARRIER,p->publication,19,p->result,sizeof p->result)==0);
    assert(p->result[0]==0&&p->result[1]==1&&p->result[2]==3&&p->result[3]==0&&p->result[4]==2&&p->result[5]==2);
    memset(p->result,0,sizeof p->result);
    assert(query_at(p->fd,QOP_PROGRAM_JOURNAL_BARRIER,p->request,1,p->result,sizeof p->result)==0);
    assert(p->result[0]==0&&p->result[1]==1&&p->result[2]==3&&p->result[4]==2&&p->result[11]==WPK_GL_QUERY_REPLY_MAGIC);
    assert(eglDestroyContext(p->display,p->retiring)&&eglReleaseThread());return NULL;
}
struct driver_peer {EGLDisplay display;EGLConfig config;EGLContext source,retiring;GLuint program,fragment;int fail;};
static void *driver_retire_peer(void *opaque) {
    struct driver_peer *p=opaque;
    assert(eglDestroyContext(p->display,p->retiring)&&eglReleaseThread());return NULL;
}
static void *driver_relink_peer(void *opaque) {
    struct driver_peer *p=opaque;
    const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    EGLContext context=eglCreateContext(p->display,p->config,p->source,attrs);assert(context!=EGL_NO_CONTEXT);
    assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,context));
    const char *source=p->fail?"intentional invalid shader":"precision mediump float;void main(){gl_FragColor=vec4(.8,.2,.4,1.);}";
    glShaderSource(p->fragment,1,&source,NULL);glCompileShader(p->fragment);
    GLint ok=0;glGetShaderiv(p->fragment,GL_COMPILE_STATUS,&ok);assert(ok==!p->fail);
    glLinkProgram(p->program);glGetProgramiv(p->program,GL_LINK_STATUS,&ok);assert(ok==!p->fail);
    glFinish();assert(glGetError()==GL_NO_ERROR);
    assert(eglMakeCurrent(p->display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroyContext(p->display,context)&&eglReleaseThread());return NULL;
}
static void check_color(unsigned red,unsigned green,unsigned blue) {
    GLubyte rgba[4]={0};glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
    assert(rgba[0]==red&&rgba[1]==green&&rgba[2]==blue&&rgba[3]==255);
}
struct driver_fork_guard {
    struct wpk_gles_context *encoder;
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    int held,release;
};
static void *driver_hold_dispatch(void *opaque) {
    struct driver_fork_guard *p=opaque;
    struct wpk_gl_name_scope guard=_wpk_gl_begin_encoder_retirement(p->encoder);assert(guard.group);
    assert(!pthread_mutex_lock(&p->mutex));p->held=1;assert(!pthread_cond_signal(&p->condition));
    while(!p->release)assert(!pthread_cond_wait(&p->condition,&p->mutex));
    assert(!pthread_mutex_unlock(&p->mutex));_wpk_gl_end_name_scope(&guard);return NULL;
}
static void check_driver_fork(EGLDisplay display,EGLConfig config,EGLContext context,GLuint program) {
    struct driver_fork_guard p={.encoder=_wpk_gl_current_encoder(),
        .mutex=PTHREAD_MUTEX_INITIALIZER,.condition=PTHREAD_COND_INITIALIZER};
    pthread_t thread;assert(!pthread_create(&thread,NULL,driver_hold_dispatch,&p));
    assert(!pthread_mutex_lock(&p.mutex));
    while(!p.held)assert(!pthread_cond_wait(&p.condition,&p.mutex));
    assert(!pthread_mutex_unlock(&p.mutex));
    pid_t child=fork();assert(child>=0);
    if(!child) {
        const uint64_t requests=_wpk_gl_device_requests();
        const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
        assert(eglCreateContext(display,config,context,attrs)==EGL_NO_CONTEXT);
        assert(eglGetError()==EGL_BAD_CONTEXT);
        glUseProgram(program);assert(_wpk_gl_device_requests()==requests);
        assert(glGetError()==GL_INVALID_OPERATION);_exit(0);
    }
    int status=0;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    assert(!pthread_mutex_lock(&p.mutex));p.release=1;assert(!pthread_cond_signal(&p.condition));
    assert(!pthread_mutex_unlock(&p.mutex));assert(!pthread_join(thread,NULL));
    assert(!pthread_mutex_destroy(&p.mutex)&&!pthread_cond_destroy(&p.condition));
}
int main(int argc,char **argv) {
    assert(argc==2);const int errors=!strcmp(argv[1],"errors"),preflight=!strcmp(argv[1],"preflight");
    const int uniform=!strcmp(argv[1],"uniform-interleave");
    const int lifecycle=!strcmp(argv[1],"lifecycle-unbound")||!strcmp(argv[1],"lifecycle-current-peer");
    const int current_peer=!strcmp(argv[1],"lifecycle-current-peer");
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
    GLuint fragment=shader(GL_FRAGMENT_SHADER,uniform?
        "precision mediump float;uniform vec4 color;void main(){gl_FragColor=color;}":
        "precision mediump float;void main(){gl_FragColor=vec4(.2,.6,.8,1.);}");
    GLuint program=glCreateProgram();assert(program);glAttachShader(program,vertex);glAttachShader(program,fragment);
    glBindAttribLocation(program,0,"p");glLinkProgram(program);GLint linked=0;
    if(strcmp(argv[1],"driver-link-observe")){glGetProgramiv(program,GL_LINK_STATUS,&linked);assert(linked);}
    if(!strcmp(argv[1],"driver-dispatch")) {
        struct wpk_gles_context *encoder=_wpk_gl_current_encoder();
        struct wpk_gl_name_scope outer=_wpk_gl_begin_name_scope(encoder);
        assert(outer.group);
        struct wpk_gl_name_scope inner=_wpk_gl_begin_encoder_retirement(encoder);
        assert(inner.group==outer.group);
        glUseProgram(program);glFinish();assert(glGetError()==GL_NO_ERROR);
        _wpk_gl_end_name_scope(&inner);assert(!inner.group);
        _wpk_gl_end_name_scope(&inner);
        glUseProgram(0);assert(glGetError()==GL_NO_ERROR);
        _wpk_gl_end_name_scope(&outer);assert(!outer.group);
    }
    GLint color=-1;
    if(uniform) {
        color=glGetUniformLocation(program,"color");assert(color>=0);glUseProgram(program);
        glUniform4f(color,.8,.3,.2,1.);
    }
    const GLfloat triangle[]={-1,-1,1,-1,0,1};GLuint buffer;
    glGenBuffers(1,&buffer);glBindBuffer(GL_ARRAY_BUFFER,buffer);glBufferData(GL_ARRAY_BUFFER,sizeof triangle,triangle,GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL);
    glViewport(0,0,16,16);glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glFinish();assert(glGetError()==GL_NO_ERROR);
    if(!strcmp(argv[1],"cold-failed-link")) {
        // Do not query LINK_STATUS: the journal's cold capture must observe
        // failure itself, without keeping an eager pin on every ordinary link.
        glDetachShader(program,vertex);glLinkProgram(program);assert(glGetError()==GL_NO_ERROR);
        assert(_wpk_gl_enable_program_journal());
        glUseProgram(program);assert(glGetError()==GL_INVALID_OPERATION);
        assert(glGetError()==GL_NO_ERROR);
        glUseProgram(0);glFinish();assert(glGetError()==GL_NO_ERROR);
        glAttachShader(program,vertex);glLinkProgram(program);assert(glGetError()==GL_NO_ERROR);
        assert(_wpk_gl_enable_program_journal());
        glUseProgram(program);assert(glGetError()==GL_NO_ERROR);
        glDrawArrays(GL_TRIANGLES,0,3);check_color(51,153,204);
        glUseProgram(0);glDeleteProgram(program);glDeleteShader(vertex);glDeleteShader(fragment);
        glDeleteBuffers(1,&buffer);assert(glGetError()==GL_NO_ERROR);
        assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
        assert(eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
        printf("PASS journal wire %s\n",argv[1]);return 0;
    }
    if(!strncmp(argv[1],"capture-",8)) {
        const int releasing=!strncmp(argv[1],"capture-release-",16);
        const unsigned failure=(unsigned)strtoul(strrchr(argv[1],'-')+1,NULL,10);
        assert(failure>=1&&failure<=7);
        glUseProgram(0);assert(glGetError()==GL_NO_ERROR);
        assert(_wpk_gl_enable_program_journal());
        glUseProgram(program);
        assert(glGetError()==(!releasing&&failure==2?GL_NO_ERROR:GL_INVALID_OPERATION));
        assert(glGetError()==GL_NO_ERROR);
        glUseProgram(program);
        assert(glGetError()==(releasing?GL_INVALID_OPERATION:GL_NO_ERROR));
        assert(glGetError()==GL_NO_ERROR);
        // A lost/corrupt private capture stays with its exact context. Retire
        // it while a healthy shared peer still owns and renders the program.
        EGLContext peer=eglCreateContext(display,config,context,attrs);assert(peer!=EGL_NO_CONTEXT);
        assert(eglMakeCurrent(display,surface,surface,peer));
        assert(eglDestroyContext(display,context));
        glUseProgram(program);assert(glGetError()==GL_NO_ERROR);
        glBindBuffer(GL_ARRAY_BUFFER,buffer);glEnableVertexAttribArray(0);
        glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,NULL);glViewport(0,0,16,16);
        glDrawArrays(GL_TRIANGLES,0,3);check_color(51,153,204);
        glUseProgram(0);glDeleteProgram(program);glDeleteShader(vertex);glDeleteShader(fragment);
        glDeleteBuffers(1,&buffer);assert(glGetError()==GL_NO_ERROR);
        assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
        assert(eglDestroySurface(display,surface)&&eglDestroyContext(display,peer)&&eglTerminate(display)&&eglReleaseThread());
        printf("PASS journal wire %s\n",argv[1]);return 0;
    }
    if(!strcmp(argv[1],"legacy-selection")) {
        // Never admit a journal: ordinary applications must not pay for its
        // private generation cache. Record device entries, not inferred FPS.
        glUseProgram(program);glUseProgram(0);assert(glGetError()==GL_NO_ERROR);
        const unsigned rounds=20;
        uint64_t before=_wpk_gl_device_requests();
        for(unsigned i=0;i<rounds;i++) {
            glUseProgram(program);assert(glGetError()==GL_NO_ERROR);
            glUseProgram(0);assert(glGetError()==GL_NO_ERROR);
        }
        const uint64_t selections=_wpk_gl_device_requests()-before;
        before=_wpk_gl_device_requests();
        for(unsigned i=0;i<rounds;i++) {
            glLinkProgram(program);assert(glGetError()==GL_NO_ERROR);
        }
        const uint64_t links=_wpk_gl_device_requests()-before;
        printf("SELECTION_COUNTERS {\"pairs\":%u,\"selectionDeviceRequests\":%llu,\"links\":%u,\"linkDeviceRequests\":%llu}\n",
            rounds,(unsigned long long)selections,rounds,(unsigned long long)links);
        glUseProgram(program);glDrawArrays(GL_TRIANGLES,0,3);check_color(51,153,204);
        glUseProgram(0);glDeleteProgram(program);glDeleteShader(vertex);glDeleteShader(fragment);
        glDeleteBuffers(1,&buffer);assert(glGetError()==GL_NO_ERROR);
        assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
        assert(eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
        printf("PASS journal wire %s\n",argv[1]);return 0;
    }
    if(!strncmp(argv[1],"driver-",7)&&strcmp(argv[1],"driver-dispatch")) {
        const int sharing=!strcmp(argv[1],"driver-sharing"),retirement=!strcmp(argv[1],"driver-retirement");
        GLuint cached[35]={0};
        if(!strcmp(argv[1],"driver-cache"))for(unsigned i=0;i<35;i++) {
            cached[i]=glCreateProgram();assert(cached[i]);
            glAttachShader(cached[i],vertex);glAttachShader(cached[i],fragment);
            glBindAttribLocation(cached[i],0,"p");glLinkProgram(cached[i]);
            GLint linked=0;glGetProgramiv(cached[i],GL_LINK_STATUS,&linked);assert(linked);
        }
        EGLContext retiring=EGL_NO_CONTEXT;
        if(retirement) {
            retiring=eglCreateContext(display,config,context,attrs);assert(retiring!=EGL_NO_CONTEXT);
            assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,retiring));
            glUseProgram(program);assert(glGetError()==GL_NO_ERROR);
            assert(eglMakeCurrent(display,surface,surface,context));
            glDeleteProgram(program);assert(glGetError()==GL_NO_ERROR);
        }
        assert(_wpk_gl_enable_program_journal());
        if(!strcmp(argv[1],"driver-indeterminate")||!strcmp(argv[1],"driver-error-recovery")||!strcmp(argv[1],"driver-error-suffix")) {
            EGLContext peer=eglCreateContext(display,config,context,attrs);assert(peer!=EGL_NO_CONTEXT);
            assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,peer));
            assert(_wpk_gl_enable_program_journal());
            assert(eglMakeCurrent(display,surface,surface,context));
            glUseProgram(program);
            const int error_recovery=!strcmp(argv[1],"driver-error-recovery");
            const int error_suffix=!strcmp(argv[1],"driver-error-suffix");
            if(error_recovery||error_suffix)glUseProgram(vertex);
            if(error_recovery)glEnable(0xffff);
            assert(glGetError()==GL_INVALID_OPERATION);
            if(error_suffix)glUseProgram(vertex);
            if(error_recovery)assert(glGetError()==GL_INVALID_ENUM);
            if(error_suffix)assert(glGetError()==GL_INVALID_OPERATION);
            assert(glGetError()==GL_NO_ERROR);
            glDrawArrays(GL_TRIANGLES,0,3);check_color(51,153,204);
            glUseProgram(0);glDeleteProgram(program);glDeleteShader(vertex);glDeleteShader(fragment);
            glDeleteBuffers(1,&buffer);assert(glGetError()==GL_NO_ERROR);
            assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
            assert(eglDestroyContext(display,peer)&&eglDestroySurface(display,surface)&&
                eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
            printf("PASS journal wire %s\n",argv[1]);return 0;
        }
        if(!strcmp(argv[1],"driver-cold-refusal")) {
            glUseProgram(program);assert(glGetError()==GL_NO_ERROR);
            glDrawArrays(GL_TRIANGLES,0,3);check_color(51,153,204);
            glUseProgram(0);glDeleteProgram(program);glDeleteShader(vertex);glDeleteShader(fragment);
            glDeleteBuffers(1,&buffer);assert(glGetError()==GL_NO_ERROR);
            assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
            assert(eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
            printf("PASS journal wire %s\n",argv[1]);return 0;
        }
        glUseProgram(program);glUseProgram(0);assert(glGetError()==GL_NO_ERROR);
        // Both native generation and all intent/error storage are now cold-
        // reserved. Warm Use/GetError must not enter the device at all.
        const uint64_t requests=_wpk_gl_device_requests();
        const unsigned rounds=!strcmp(argv[1],"driver-wrap")?300:20;
        for(unsigned i=0;i<rounds;i++) {
            glUseProgram(program);assert(glGetError()==GL_NO_ERROR);
            glUseProgram(0);assert(glGetError()==GL_NO_ERROR);
        }
        const uint64_t warm_requests=_wpk_gl_device_requests()-requests;
        if(rounds==20)assert(!warm_requests);
        else assert(warm_requests>0&&warm_requests<20);
        printf("DRIVER_COUNTERS {\"pairs\":%u,\"warmDeviceRequests\":%llu}\n",rounds,(unsigned long long)warm_requests);
        if(cached[0]) {
            for(unsigned pass=0;pass<2;pass++)for(unsigned i=0;i<35;i++) {
                glUseProgram(cached[i]);assert(glGetError()==GL_NO_ERROR);
            }
        }
        glUseProgram(program);assert(glGetError()==GL_NO_ERROR);
        if(sharing) {
            struct peer_data p={display,config,context,program,_wpk_gl_fd()};pthread_t thread;
            assert(!pthread_create(&thread,NULL,delete_in_peer,&p)&&!pthread_join(thread,NULL));
            assert(glIsProgram(program)==GL_TRUE);
        }
        if(retirement) {
            // Flush the previous probes, then accept a still-unsubmitted
            // selection before an unbound thread retires the old name owner.
            glUseProgram(0);glFinish();assert(glGetError()==GL_NO_ERROR);
            glUseProgram(program);
            struct driver_peer p={display,config,context,retiring,program,fragment};pthread_t thread;
            assert(!pthread_create(&thread,NULL,driver_retire_peer,&p)&&!pthread_join(thread,NULL));
            assert(glIsProgram(program)==GL_TRUE);
        }
        if(!strcmp(argv[1],"driver-errors")) {
            glUseProgram(0xfffffff0);assert(glGetError()==GL_INVALID_VALUE);
            glUseProgram(0xfffffff0);assert(glGetError()==GL_INVALID_VALUE);
            glUseProgram(vertex);assert(glGetError()==GL_INVALID_OPERATION);
            assert(glGetError()==GL_NO_ERROR);
        }
        if(!strcmp(argv[1],"driver-relink")||!strcmp(argv[1],"driver-failed-link")) {
            struct driver_peer p={display,config,context,EGL_NO_CONTEXT,program,fragment,!strcmp(argv[1],"driver-failed-link")};pthread_t thread;
            assert(!pthread_create(&thread,NULL,driver_relink_peer,&p)&&!pthread_join(thread,NULL));
        }
        if(!strcmp(argv[1],"driver-fork"))check_driver_fork(display,config,context,program);
        glDrawArrays(GL_TRIANGLES,0,3);check_color(51,153,204);
        if(!strcmp(argv[1],"driver-relink")) {
            glUseProgram(program);glDrawArrays(GL_TRIANGLES,0,3);check_color(204,51,102);
        }
        if(!strcmp(argv[1],"driver-failed-link")) {
            glUseProgram(program);assert(glGetError()==GL_INVALID_OPERATION&&glGetError()==GL_NO_ERROR);
            glDrawArrays(GL_TRIANGLES,0,3);check_color(51,153,204);
        }
        glUseProgram(0);
        if(cached[0])for(unsigned i=0;i<35;i++) {
            glDeleteProgram(cached[i]);assert(glIsProgram(cached[i])==GL_FALSE);
        }
        if(!sharing&&!retirement)glDeleteProgram(program);
        glDeleteShader(vertex);glDeleteShader(fragment);glDeleteBuffers(1,&buffer);
        assert(glGetError()==GL_NO_ERROR);
        assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
        assert(eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
        printf("PASS journal wire %s\n",argv[1]);return 0;
    }
    EGLContext retiring=EGL_NO_CONTEXT;int retirement_fd=-1;
    if(lifecycle) {
        retiring=eglCreateContext(display,config,context,attrs);assert(retiring!=EGL_NO_CONTEXT);
        assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,retiring));
        glUseProgram(program);glFinish();assert(glGetError()==GL_NO_ERROR);
        retirement_fd=dup(_wpk_gl_fd());assert(retirement_fd>=0);
        assert(eglMakeCurrent(display,surface,surface,context));
        glDeleteProgram(program);assert(glGetError()==GL_NO_ERROR&&glIsProgram(program)==GL_TRUE);
    }
    uint32_t captured[4];const uint32_t acquire[]={1,program};
    query(QOP_PROGRAM_CAPTURE,acquire,2,captured,sizeof captured);
    assert(captured[0]==0&&captured[1]==1&&captured[2]&&captured[3]==WPK_GL_QUERY_REPLY_MAGIC);
    if(uniform) {
        const uint32_t begin[]={1,OP_UNIFORM4FV,(uint32_t)color,1,0};
        uint32_t chunk[8]={1,OP_UNIFORM4FV,0,1};const GLfloat rgba[]={.2,.6,.8,1.};
        memcpy(chunk+4,rgba,sizeof rgba);
        size_t length=emit(0,OP_UNIFORM_UPLOAD_BEGIN,begin,5);
        length=emit(length,OP_UNIFORM_UPLOAD_CHUNK,chunk,8);submit(length);
    }
    control(1,4,0);const uint32_t id=reply[3];assert(id&&reply[4]==4);
    if(!strcmp(argv[1],"recovery")) {
        /* Discard a successful response locally, then recover its exact receipt.
         * Actual copyout-throw containment is covered by the host unit control. */
        memset(reply,0,sizeof reply);const uint32_t read[]={6};journal(read,1);
        assert(reply[0]==0&&reply[1]==1&&reply[2]==1&&reply[3]==id&&reply[4]==4);
    }
    control(2,captured[2],0);const uint32_t token=reply[4];assert(token);
    if(uniform) {
        const uint32_t read[]={6},snapshot[]={7,id};journal(read,1);journal(snapshot,2);
        const uint32_t commit[]={1};submit(emit(0,OP_UNIFORM_UPLOAD_COMMIT,commit,1));
    }
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
    if(lifecycle) {
        struct lifecycle_data *p=calloc(1,sizeof *p);assert(p);
        p->display=display;p->retiring=retiring;p->fd=retirement_fd;
        memcpy(p->publication,publication,sizeof publication);p->publication[1]=1;
        transaction--; // The retiring context, not this one, owns the receipt.
        if(current_peer)assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,retiring));
        pthread_t thread;assert(!pthread_create(&thread,NULL,publish_before_retirement,p)&&!pthread_join(thread,NULL));
        if(current_peer)assert(eglMakeCurrent(display,surface,surface,context));
        p->request[0]=6;memset(p->result,0xa5,sizeof p->result);errno=0;
        // EGL also terminates the object session; dup keeps the fd valid,
        // but an uninitialized session is EINVAL, not live-context EACCES.
        assert(query_at(retirement_fd,QOP_PROGRAM_JOURNAL_BARRIER,p->request,1,p->result,sizeof p->result)==-1&&errno==EINVAL);
        untouched(p->result);assert(close(retirement_fd)==0);free(p);
        const uint32_t status[]={7,id};journal(status,2);
        assert(reply[0]==0&&reply[4]==1&&reply[5]==2&&reply[7]==2&&reply[9]==0);
    }else {
        journal(publication,19);assert(reply[0]==0&&reply[4]==2&&reply[5]==2&&reply[7]==2&&reply[9]==0);
    }
    if(!strcmp(argv[1],"exit-pending")) {
        puts("PASS journal wire exit-pending");fflush(stdout);_exit(0);
    }
    if(!strcmp(argv[1],"abandon")) {
        assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
        assert(eglDestroySurface(display,surface)&&eglDestroyContext(display,context)&&eglTerminate(display)&&eglReleaseThread());
        puts("PASS journal wire abandon");return 0;
    }
    if(!errors&&!lifecycle) {
        struct peer_data peer={display,config,context,program,_wpk_gl_fd()};pthread_t thread;
        assert(!pthread_create(&thread,NULL,delete_in_peer,&peer)&&!pthread_join(thread,NULL));
        assert(glIsProgram(program)==GL_FALSE); /* Logical selection is already zero. */
    }
    if(lifecycle)assert(glIsProgram(program)==GL_FALSE);
    const uint32_t first[]={id,0,1,0},second[]={id,1,2,0},draw[]={GL_TRIANGLES,0,3},observed[]={2,2};
    size_t length=emit(0,OP_USE_PROGRAM_JOURNAL,first,4);
    length=emit(length,errors?OP_ERROR_OBSERVED:OP_DRAW_ARRAYS,errors?observed:draw,errors?2:3);
    length=emit(length,OP_USE_PROGRAM_JOURNAL,second,4);
    if(errors)length=emit(length,OP_ERROR_OBSERVED,observed,2);
    submit(length);
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
