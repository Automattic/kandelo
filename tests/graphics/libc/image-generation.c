/* Exact common receiver and actual EGL retirement helpers. The independent
 * device peer judges custody; ASan judges stale generation reads. This is
 * native source-level evidence, not target Rust/SDK/browser acceptance. */
#include <pthread.h>
static int generation_mutex_lock(pthread_mutex_t *);
#include "drm-owned-double.h"
#define pthread_mutex_lock generation_mutex_lock
#include "drm_owned.c"
#undef pthread_mutex_lock
#define main owned_transport_fixture_main
#include "drm-owned-transport.c"
#undef main
#include <sys/mman.h>
static void *generation_page, *tracked_image;
static size_t generation_page_size;
static unsigned image_frees;
static void generation_free(void *p) {
    if (p == generation_page) {
        /* A protected retired allocation makes stale reads deterministic;
         * the same page can later model allocator address reuse. */
        assert(!mprotect(p,generation_page_size,PROT_NONE));return;
    }
    if(p && p==tracked_image)image_frees++;
    owned_free(p);
}
#define calloc owned_calloc
#define free generation_free
static void publication_end(struct wpk_drm_owner *, int);
#define _wpk_drm_owned_retain_end publication_end
#include "libegl_stub.c"
#undef calloc
#undef free
#undef _wpk_drm_owned_retain_end
void _wpk_gbm_window_release(void *p){(void)p;abort();}
void _wpk_gbm_window_release_pending(struct wpk_gbm_window_retirement *p){(void)p;abort();}
void _wpk_wl_display_release(void *p){(void)p;abort();}
void _wpk_wl_display_release_inherited(void *p){(void)p;abort();}
void _wpk_wlegl_release(void *p){(void)p;abort();}
void _wpk_wlegl_release_inherited(void *p){(void)p;abort();}
void _wpk_gl_destroy_encoder(struct wpk_gles_context *p){(void)p;abort();}
void _wpk_gl_end_name_scope(struct wpk_gl_name_scope *p){(void)p;abort();}
void _wpk_gl_flush(void){abort();}
struct wpk_gl_name_scope _wpk_gl_lock_encoder_retirement(struct wpk_gles_context *p){(void)p;abort();}
int _wpk_gl_prepare_encoder_retirement(struct wpk_gles_context *p,int i){(void)p;(void)i;abort();}
int _wpk_gl_prepare_encoder_retirement_with_peer(struct wpk_gles_context *p,struct wpk_gles_context *q){(void)p;(void)q;abort();}
void _wpk_gl_retire_encoder_programs(struct wpk_gles_context *p){(void)p;abort();}

static pthread_mutex_t publication_gate=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t publication_changed=PTHREAD_COND_INITIALIZER;
static pthread_t publisher;
static int publication_control,publication_ready,publication_resume,publication_fork_wait;
static int generation_mutex_lock(pthread_mutex_t *mutex) {
    if (mutex==&capture_publication_mutex && publication_control &&
        !pthread_equal(pthread_self(),publisher)) {
        pthread_mutex_lock(&publication_gate);publication_fork_wait=1;
        pthread_cond_broadcast(&publication_changed);pthread_mutex_unlock(&publication_gate);
    }
    return pthread_mutex_lock(mutex);
}
static void publication_end(struct wpk_drm_owner *owner,int cancel_state) {
    if(publication_control) {
        pthread_mutex_lock(&publication_gate);publication_ready=1;
        pthread_cond_broadcast(&publication_changed);
        while(!publication_resume)pthread_cond_wait(&publication_changed,&publication_gate);
        pthread_mutex_unlock(&publication_gate);
    }
    _wpk_drm_owned_retain_end(owner,cancel_state);
}
static void finish_actor_scope(void){
    if(actor_current_scope){struct wpk_drm_actor_scope *scope=actor_current_scope;
        assert(!pthread_setspecific(actor_scope_key,NULL));actor_scope_ended(scope);}
}
#ifdef WPK_IMAGE_GENERATION_OWNED
static int fixture_publish_image(struct wpk_egl_image *image,struct egl_generation *generation){
    if(!reserve_image(image,generation)){int error=errno;image_release_locked(image);errno=error;return 0;}
    return publish_image(image,generation);
}
struct publication_args {struct wpk_egl_image *image;struct egl_generation *generation;};
static void *publish_peer(void *data) {
    struct publication_args *args=data;publisher=pthread_self();
    assert(fixture_publish_image(args->image,args->generation));return NULL;
}
static void *resume_peer(void *unused) {
    (void)unused;pthread_mutex_lock(&publication_gate);
    while(!publication_fork_wait)pthread_cond_wait(&publication_changed,&publication_gate);
    publication_resume=1;pthread_cond_broadcast(&publication_changed);
    pthread_mutex_unlock(&publication_gate);return NULL;
}
#endif
static unsigned flush_calls;
int _wpk_gl_flush_checked(void) { flush_calls++; return -1; }
struct wpk_gl_name_scope _wpk_gl_begin_name_scope(struct wpk_gles_context *p) { (void)p; abort(); }
static struct wpk_drm_owner *make_bo(struct wpk_drm_owner *owner) {
    uint32_t value=5;struct wpk_drm_owner *bo=NULL;
    assert(!_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo));
    assert(bo);return bo;
}
int main(int argc,char **argv) {
    assert(argc==2);struct wpk_drm_owner *source=NULL;
    assert(_wpk_drm_owned_retain_begin(NULL,NULL)==-1&&errno==EINVAL);
    assert(!_wpk_drm_owned_open(1,&source));
    struct egl_display_record display={0};
    generation_page_size=(size_t)sysconf(_SC_PAGESIZE);
    generation_page=mmap(NULL,generation_page_size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);
    assert(generation_page!=MAP_FAILED);
    struct egl_generation *old=generation_page;
    old->storage_owner=source;old->display=&display;old->initialized=1;
    old->next=g_generations;g_generations=old;display.active=old;
    struct wpk_egl_image *held=owned_calloc(1,sizeof *held);assert(held);
    tracked_image=held;held->generation=old;held->public_handle=123;held->fourcc=0x34325241;
    held->bo_owner=make_bo(source);
#ifdef WPK_IMAGE_GENERATION_OWNED
    if(!strcmp(argv[1],"saturation")) {
        tracked_image=held;source->references=UINT32_MAX;
        assert(!fixture_publish_image(held,old)&&errno==EOVERFLOW);
        assert(!g_images&&image_frees==1&&caps[1].live);
        source->references=1;lock_context();old->initialized=0;old->terminate_pending=1;
        display.active=NULL;retire_pending_resources_locked(old);unlock_context();
        finish_actor_scope();assert(!g_generations&&!live_caps()&&!allocations);
        assert(!munmap(generation_page,generation_page_size));
        puts("PASS private image publication saturation unwinds exact BO custody");return 0;
    }
    if(!strcmp(argv[1],"publication")) {
        publication_control=1;
        struct publication_args args={held,old};pthread_t worker,controller;
        assert(!pthread_create(&worker,NULL,publish_peer,&args));
        pthread_mutex_lock(&publication_gate);
        while(!publication_ready)pthread_cond_wait(&publication_changed,&publication_gate);
        pthread_mutex_unlock(&publication_gate);
        assert(!pthread_create(&controller,NULL,resume_peer,NULL));
        pid_t child=fork();assert(child>=0);
        if(!child) {
            alarm(5);publication_control=0;
            assert(g_images==held&&held->source_owner==source&&source->references==2);
            if(held->public_live){assert(!held->constructing);}
            else{
                /* A fork between reserve and final seal inherits a private
                 * foreign constructor, never an admitted public image. */
                assert(held->constructing);lock_images();_wpk_drm_mutex_unlock(&g_image_mutex);
                assert(!g_images&&image_frees==1&&source->references==1);
            }
            _exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
        assert(!pthread_join(worker,NULL)&&!pthread_join(controller,NULL));publication_control=0;
    }else assert(fixture_publish_image(held,old));
#else
    held->public_live=1;held->next=g_images;g_images=held;
#endif
    held->storage_references=1;tracked_image=held;
    /* This is the final normal-generation path after eglTerminate has
     * revoked public images, without a live renderer/window to delay it. */
    lock_context();old->initialized=0;old->terminate_pending=1;display.active=NULL;
    invalidate_generation_images(old); retire_pending_resources_locked(old); unlock_context();
    assert(!g_generations&&g_images==held&&!held->public_live);
    if(!strcmp(argv[1],"lookup")) {
        struct wpk_gbm_image result={0};
        assert(_wpk_egl_image_export_gbm((void *)123,NULL,0,&result)==-1&&errno==EINVAL);
    }else if(!strcmp(argv[1],"generation")) {
        /* No freed pointer may be interpreted as a later generation even if
         * an allocator returns the same address for its replacement. */
        assert(held->generation==NULL);
    }else if(!strcmp(argv[1],"reuse")) {
        assert(!mprotect(generation_page,generation_page_size,PROT_READ|PROT_WRITE));
        memset(old,0,sizeof *old);old->display=&display;old->initialized=1;
        struct egl_session replacement_session={.owner=source};
        struct egl_context_record replacement_context={.session=&replacement_session};
        struct egl_thread_binding replacement_binding={.process_epoch=_wpk_drm_process_generation(),
            .generation=old,.object=&replacement_context};
        g_destructor_binding=&replacement_binding;
        assert(_wpk_egl_image_texture(held)==0);
        assert(!flush_calls); /* old image must not enter the new renderer */
        g_destructor_binding=NULL;
    }else if(!strcmp(argv[1],"publication")) {
        /* The child checked the exact reference + list edge after prepare
         * waited for the actual publish helper's guarded transaction. */
    }else if(!strcmp(argv[1],"source")) {
#ifdef WPK_IMAGE_GENERATION_OWNED
        assert(held->source_owner==source);
#endif
        assert(caps[1].live);
        uint32_t value=9;assert(!_wpk_drm_owned_ioctl(source,0x1234,&value,4,NULL,0,NULL));
    }else abort();
    _wpk_egl_image_release(held);
    finish_actor_scope();assert(!g_images&&image_frees==1&&!live_caps()&&!allocations);
    assert(!munmap(generation_page,generation_page_size));
    printf("PASS private image generation %s\n",argv[1]);return 0;
}
