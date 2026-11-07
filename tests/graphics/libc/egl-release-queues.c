/* Actual EGL outer queues + actual GBM continuation + common ActorScope.
 * The transport peer supplies independent native capability accounting. The
 * Wayland peer seals each native effect and callback claim independently.
 * Actual pinned native client/log semantics are proved by their own controls. */
#include "drm-owned-double.h"
#include "drm_owned.c"
#define main transport_fixture_main
#include "drm-owned-transport.c"
#undef main
#define calloc owned_calloc
#define free owned_free
/* These archives normally compile as separate TUs and each names its private
 * wire struct. Rename the GBM-only tag for this combined actual-source fixture. */
#define wpk_drm_check_bo_format queue_gbm_check_bo_format
#include "libgbm_stub.c"
#undef wpk_drm_check_bo_format
static void queue_publication_end(void);
#define _wpk_drm_owned_publication_end queue_publication_end
#include "libegl_stub.c"
#undef _wpk_drm_owned_publication_end
#undef calloc
#undef free

void _wpk_gl_destroy_encoder(struct wpk_gles_context *p){(void)p;abort();}
void _wpk_gl_end_name_scope(struct wpk_gl_name_scope *p){(void)p;abort();}
void _wpk_gl_flush(void){abort();}
struct wpk_gl_name_scope _wpk_gl_lock_encoder_retirement(struct wpk_gles_context *p){(void)p;abort();}
int _wpk_gl_prepare_encoder_retirement(struct wpk_gles_context *p,int i){(void)p;(void)i;abort();}
int _wpk_gl_prepare_encoder_retirement_with_peer(struct wpk_gles_context *p,struct wpk_gles_context *q){(void)p;(void)q;abort();}
void _wpk_gl_retire_encoder_programs(struct wpk_gles_context *p){(void)p;abort();}

static pthread_mutex_t queue_gate=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t queue_changed=PTHREAD_COND_INITIALIZER;
struct queue_native_peer {
    unsigned native_epoch,native_live,callback_started,effects;
    struct wpk_drm_actor_claim callback_claim;
    struct wpk_wl_boundary_hold boundary;
};
static struct queue_native_peer *wayland_tokens[4];
static unsigned queue_callbacks,queue_pause_at,queue_effects,queue_boundary_transfers,queue_native_epoch;
static int queue_pending_once,queue_error_once,queue_retired_pending;
static int queue_ready,queue_proceed,queue_kind,queue_action,queue_child,queue_nested,queue_mixed,queue_inherited;
static struct gbm_device *queue_device;
static struct gbm_bo *queue_held_bo;
static struct egl_surface_record *queue_surface;
static struct egl_generation *queue_generation;
static int queue_clear_control,queue_pause_after_clear;
/* Observe publication return from EGL and the independent native peer.
 * The peer can finish its capsule before returning to its still-claimed
 * EGL caller; a foreign fork must then collect that empty outer shell. */
static void queue_publication_end(void){
    _wpk_drm_owned_publication_end();
    if(queue_pause_after_clear&&g_generation_releases==queue_generation&&queue_generation&&
       !queue_generation->wayland_retirement.live&&!queue_generation->wayland_retirement.retired){
        queue_pause_after_clear=0;
        pthread_mutex_lock(&queue_gate);queue_ready=1;pthread_cond_broadcast(&queue_changed);
        while(!queue_proceed)pthread_cond_wait(&queue_changed,&queue_gate);
        pthread_mutex_unlock(&queue_gate);
    }
}
static void cold_drain(void){
#ifdef WPK_EGL_QUEUE_BEFORE
    lock_context();unlock_context();
#else
    atomic_store_explicit(&g_release_work,1,memory_order_relaxed);
    lock_context();unlock_context();
#endif
}
static void assert_queue_root(void){
    if(queue_kind==2){
        struct egl_generation *p=g_generation_releases;
        while(p&&p!=queue_generation)p=p->next;
        assert(p&&!p->wayland_hold&&(p->wayland_retirement.live==wayland_tokens[0]||p->wayland_retirement.retired==wayland_tokens[0]));
    }else{
        struct egl_surface_record *p=g_surface_releases;
        while(p&&p!=queue_surface)p=p->next;
        assert(p);
        if(queue_kind==1)assert(!p->wayland_lease&&(p->wayland_retirement.live==wayland_tokens[0]||p->wayland_retirement.retired==wayland_tokens[0]));
        else {
#ifdef WPK_EGL_QUEUE_BEFORE
            assert(p->gbm_lease);
#else
            assert(p->gbm_retirement.live||p->gbm_retirement.retired);
#endif
        }
    }
}
static void enqueue_wayland(int kind,unsigned token){
    lock_context();_wpk_drm_owned_publication_begin();
    assert(!wayland_tokens[token]);
    wayland_tokens[token]=owned_calloc(1,sizeof *wayland_tokens[token]);assert(wayland_tokens[token]);
    wayland_tokens[token]->native_live=1;wayland_tokens[token]->native_epoch=queue_native_epoch+!!(token==3||queue_inherited);
    wayland_tokens[token]->boundary.owner=wayland_tokens[token];
    if(kind==2){
        struct egl_generation *p=owned_calloc(1,sizeof *p);assert(p);
        p->wayland_hold=wayland_tokens[token];p->fork_retired=token==3||queue_inherited;
        free_generation_locked(p);if(!token)queue_generation=p;
    }else{
        struct egl_surface_record *p=owned_calloc(1,sizeof *p);assert(p);
        p->wayland_lease=wayland_tokens[token];p->inherited=token==3||queue_inherited;
        free_surface_record_locked(p);if(!token)queue_surface=p;
    }
    _wpk_drm_owned_publication_end();
    if(!token&&queue_action==5)deny_allocation=1;
#ifndef WPK_EGL_QUEUE_BEFORE
    if(!token&&queue_action==7)atomic_store_explicit(&g_release_work,0,memory_order_relaxed);
#endif
    unlock_context();
    if(!token&&queue_action==5){
        assert(!queue_callbacks);assert_queue_root();deny_allocation=0;cold_drain();
    }
}
static void queue_callback(int outer){
    unsigned ordinal=++queue_callbacks;
    if(outer)assert_queue_root();
    if(ordinal==1&&(queue_action==1||queue_action==4)){
        /* A nested cold drain must not consume its own outer live claim. */
        cold_drain();assert_queue_root();
        queue_nested=1;enqueue_wayland(queue_kind==2?2:1,1);
        assert(queue_callbacks==2);assert_queue_root();
    }
    if(ordinal==2&&queue_action==4){
#ifndef WPK_EGL_QUEUE_BEFORE
        if(queue_kind==2){
            assert(g_generation_releases!=queue_generation);
            assert(g_generation_releases->release_claim.scope==queue_generation->release_claim.scope);
        }else{
            assert(g_surface_releases!=queue_surface);
            assert(g_surface_releases->release_claim.scope==queue_surface->release_claim.scope);
        }
#endif
        pid_t child=fork();assert(child>=0);
        if(!child){queue_child=1;queue_action=0;cold_drain();assert_queue_root();}
        else {int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));}
    }
    if(ordinal==1&&queue_action==2){
        pid_t child=fork();assert(child>=0);
        if(!child){queue_child=1;queue_action=0;cold_drain();assert_queue_root();}
        else {int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));}
    }
    if(ordinal==1&&queue_action==3)pthread_exit(NULL);
    if(ordinal==queue_pause_at){
        pthread_mutex_lock(&queue_gate);queue_ready=1;pthread_cond_broadcast(&queue_changed);
        while(!queue_proceed)pthread_cond_wait(&queue_changed,&queue_gate);
        pthread_mutex_unlock(&queue_gate);
    }
}
static void queue_bo_destructor(struct gbm_bo *bo,void *data){
    assert(data==queue_device&&gbm_bo_get_device(bo)==queue_device);
    assert(bo->planes[0].owner&&caps[bo->planes[0].owner->token].live);
    queue_callback(1);
}
/* This protocol peer is intentionally independent of EGL's queue algorithm:
 * the native effect and callback-start bit seal BEFORE user code. The caller
 * must keep the exact live/retired capsule and its outer claim across it. */
static enum wpk_wl_retire_result queue_native_release(void **live,void **retired){
    _wpk_drm_owned_publication_begin();
    struct queue_native_peer *p=*live?*live:*retired;
    if(!p){_wpk_drm_owned_publication_end();return WPK_WL_RETIRE_COMPLETE;}
    int outer=p==wayland_tokens[0];
    if(outer){
        if(queue_kind==2)assert(_wpk_drm_actor_claim_current_locked(&queue_generation->release_claim));
        else assert(_wpk_drm_actor_claim_current_locked(&queue_surface->release_claim));
    }
    if(queue_error_once){queue_error_once=0;_wpk_drm_owned_publication_end();return WPK_WL_RETIRE_ERROR;}
    if(queue_pending_once&&!queue_retired_pending){queue_pending_once=0;_wpk_drm_owned_publication_end();return WPK_WL_RETIRE_PENDING;}
    if(p->native_live&&(p->native_epoch!=queue_native_epoch)){
        _wpk_wl_boundary_transfer_locked(&p->boundary);*live=*retired=NULL;++queue_boundary_transfers;
        _wpk_drm_owned_publication_end();return WPK_WL_RETIRE_BOUNDARY_TRANSFERRED;
    }
    if(*live){assert(!*retired);*retired=*live;*live=NULL;}
    if(queue_pending_once){queue_pending_once=0;_wpk_drm_owned_publication_end();return WPK_WL_RETIRE_PENDING;}
    if(!_wpk_drm_actor_try_claim_locked(&p->callback_claim)){
        _wpk_drm_owned_publication_end();return WPK_WL_RETIRE_PENDING;
    }
    int deliver=!p->callback_started;
    if(deliver){assert(p->native_live);p->native_live=0;p->effects++;queue_effects++;p->callback_started=1;}
    _wpk_drm_owned_publication_end();
    if(deliver){
        /* Reenter the ACTUAL context mutex. Calling this under the EGL lock
         * deadlocks the deadline rather than passing a facade-lock double. */
        lock_context();unlock_context();queue_callback(outer);
    }
    _wpk_drm_owned_publication_begin();
    assert(*retired==p&&!p->native_live&&p->effects==1);
    _wpk_drm_actor_release_locked(&p->callback_claim);*retired=NULL;
    for(unsigned i=0;i<4;i++)if(wayland_tokens[i]==p)wayland_tokens[i]=NULL;
    owned_free(p);queue_publication_end();return WPK_WL_RETIRE_COMPLETE;
}
enum wpk_wl_retire_result _wpk_wlegl_release_pending(struct wpk_wlegl_retirement *p){return queue_native_release(&p->live,&p->retired);}
enum wpk_wl_retire_result _wpk_wl_display_release_pending(struct wpk_wl_display_retirement *p){return queue_native_release(&p->live,&p->retired);}
/* Opaque native release is never an admissible fallback. */
void _wpk_wlegl_release(void *p){(void)p;abort();}
void _wpk_wlegl_release_inherited(void *p){(void)p;abort();}
void _wpk_wl_display_release(void *p){(void)p;abort();}
void _wpk_wl_display_release_inherited(void *p){(void)p;abort();}
static void finish_queue_scope(void){
    if(actor_current_scope){
        struct wpk_drm_actor_scope *p=actor_current_scope;
        assert(!pthread_setspecific(actor_scope_key,NULL));actor_scope_ended(p);
    }
}
static void enqueue_gbm(void){
    struct wpk_drm_owner *owner=NULL;assert(!_wpk_drm_owned_open(1,&owner));
    queue_device=owned_calloc(1,sizeof *queue_device);assert(queue_device);
    queue_device->owner=owner;queue_device->references=4;queue_device->fd=queue_device->public_fd=-1;live_devices=queue_device;
    struct gbm_surface *s=owned_calloc(1,sizeof *s);assert(s);
    s->dev=queue_device;s->window_owned=1;live_surfaces=s;
    for(unsigned i=0;i<2;i++){
        struct gbm_bo *bo=owned_calloc(1,sizeof *bo);assert(bo);
        uint32_t value=5;assert(!_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo->planes[0].owner));
        bo->dev=queue_device;bo->surface=s;bo->plane_count=1;
        bo->user_data=queue_device;bo->user_data_destroy=queue_bo_destructor;
        bo->handle_next=live_bos;live_bos=bo;s->bos[i]=bo;
    }
    gbm_device_destroy(queue_device);
    if(queue_action==6){
        assert(_wpk_drm_actor_prepare());queue_held_bo=s->bos[0];
        _wpk_drm_owned_publication_begin();
        assert(_wpk_drm_actor_try_claim_locked(&queue_held_bo->destruction_claim));
        _wpk_drm_owned_publication_end();
    }
    lock_context();_wpk_drm_owned_publication_begin();
    queue_surface=owned_calloc(1,sizeof *queue_surface);assert(queue_surface);
    queue_surface->gbm_lease=s;free_surface_record_locked(queue_surface);
    if(queue_mixed){
        struct egl_surface_record *extra=owned_calloc(1,sizeof *extra);assert(extra);
        wayland_tokens[1]=owned_calloc(1,sizeof *wayland_tokens[1]);assert(wayland_tokens[1]);
        wayland_tokens[1]->native_live=1;wayland_tokens[1]->native_epoch=queue_native_epoch;wayland_tokens[1]->boundary.owner=wayland_tokens[1];
        extra->wayland_lease=wayland_tokens[1];free_surface_record_locked(extra);
        /* Keep the GBM callback first, with independently rooted work behind
         * it in both queues when that callback ends the whole worker. */
        g_surface_releases=queue_surface;queue_surface->next=extra;extra->next=NULL;
        struct egl_generation *g=owned_calloc(1,sizeof *g);assert(g);
        wayland_tokens[2]=owned_calloc(1,sizeof *wayland_tokens[2]);assert(wayland_tokens[2]);
        wayland_tokens[2]->native_live=1;wayland_tokens[2]->native_epoch=queue_native_epoch;wayland_tokens[2]->boundary.owner=wayland_tokens[2];
        g->wayland_hold=wayland_tokens[2];free_generation_locked(g);
    }
    _wpk_drm_owned_publication_end();unlock_context();
    if(queue_action==6){
#ifndef WPK_EGL_QUEUE_BEFORE
        assert(g_surface_releases==queue_surface&&queue_surface->gbm_retirement.retired==s);
        assert(!queue_surface->release_claim.scope&&!atomic_load_explicit(&g_release_work,memory_order_relaxed));
#endif
        assert(queue_callbacks==1&&s->bos[0]==queue_held_bo&&queue_held_bo->planes[0].owner);
        lock_context();unlock_context();assert(queue_callbacks==1);
        _wpk_drm_owned_publication_begin();
        _wpk_drm_actor_release_locked(&queue_held_bo->destruction_claim);
        _wpk_drm_owned_publication_end();cold_drain();
    }
}
static void *queue_withdraw(void *unused){
    (void)unused;
    if(queue_kind)enqueue_wayland(queue_kind,0);else enqueue_gbm();
    return NULL;
}
static void assert_boundary_transfer(void){
    assert(!g_surface_releases&&!g_generation_releases&&queue_boundary_transfers==1);
    struct queue_native_peer *peer=wayland_tokens[0];
    assert(peer&&peer->native_live&&!peer->effects&&peer->boundary.transferred);
    assert(wayland_boundary_roots==&peer->boundary&&peer->boundary.owner==peer);
    assert(!atomic_load_explicit(&g_release_work,memory_order_relaxed));
    unsigned calls=queue_callbacks;cold_drain();assert(calls==queue_callbacks);
    finish_queue_scope();assert(allocations==1&&!actor_scopes);
}
int main(int argc,char **argv){
    assert(argc==2);alarm(12);
    queue_kind=strstr(argv[1],"generation")?2:strstr(argv[1],"wayland")?1:0;
    queue_mixed=strstr(argv[1],"mixed")!=NULL;
    queue_clear_control=queue_pause_after_clear=strstr(argv[1],"after-clear")!=NULL;
    queue_action=strstr(argv[1],"idle-fork")?7:strstr(argv[1],"prepare-fail")?5:strstr(argv[1],"pending")?6:strstr(argv[1],"nested-self")?4:strstr(argv[1],"nested")?1:strstr(argv[1],"self")?2:strstr(argv[1],"exit")?3:0;
    queue_inherited=strstr(argv[1],"inherited")!=NULL;
    queue_pending_once=queue_kind&&strstr(argv[1],"pending")!=NULL;
    queue_retired_pending=strstr(argv[1],"retired-pending")!=NULL;
    queue_error_once=strstr(argv[1],"error")!=NULL;
    if(queue_kind&&queue_action==6)queue_action=0;
    if(queue_inherited){
        enqueue_wayland(queue_kind,0);assert(!queue_callbacks);assert_boundary_transfer();
        puts("PASS explicit D59 transfer: native owner remains rooted independently of retired EGL parent");return 0;
    }else if(queue_action==7){
        queue_withdraw(NULL);assert(!queue_callbacks);assert_queue_root();
        pid_t child=fork();assert(child>=0);
        if(!child){
            /* Explicit copied-libc D59 epoch double, independent of the real
             * PID/ActorScope fork semantics. Native-client controls own the
             * actual libc detector and single-thread inherited local cleanup. */
            queue_native_epoch++;cold_drain();assert(!queue_callbacks);assert_boundary_transfer();_exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
        queue_action=0;cold_drain();
    }else if(strstr(argv[1],"foreign")){
        queue_pause_at=queue_clear_control?0:strstr(argv[1],"second")?2:1;
        pthread_t worker;assert(!pthread_create(&worker,NULL,queue_withdraw,NULL));
        pthread_mutex_lock(&queue_gate);while(!queue_ready)pthread_cond_wait(&queue_changed,&queue_gate);pthread_mutex_unlock(&queue_gate);
        pid_t child=fork();assert(child>=0);
        if(!child){
            queue_pause_at=0;queue_proceed=1;cold_drain();
            finish_queue_scope();assert(queue_callbacks==(queue_kind?1u:2u)&&!live_caps()&&!allocations&&!g_surface_releases&&!g_generation_releases);_exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child);
        pthread_mutex_lock(&queue_gate);queue_proceed=1;pthread_cond_broadcast(&queue_changed);pthread_mutex_unlock(&queue_gate);
        assert(!pthread_join(worker,NULL));assert(WIFEXITED(status)&&!WEXITSTATUS(status));
    }else if(queue_action==3){
        pthread_t worker;assert(!pthread_create(&worker,NULL,queue_withdraw,NULL));assert(!pthread_join(worker,NULL));queue_action=0;
        cold_drain();
    }else {
        int deferred=queue_pending_once||queue_error_once;
        queue_withdraw(NULL);
        if(deferred){
            assert(!queue_callbacks&&!queue_effects);assert_queue_root();
            assert(!atomic_load_explicit(&g_release_work,memory_order_relaxed));
            lock_context();unlock_context();assert(!queue_callbacks);cold_drain();
        }
    }
    finish_queue_scope();
    assert(!g_surface_releases&&!g_generation_releases&&!live_surfaces&&!live_bos&&!live_devices&&!retired_bos&&!live_caps()&&!allocations&&!actor_scopes);
    assert(queue_callbacks==(queue_kind?1u:2u)+(queue_nested?1u:0u)+(queue_mixed?2u:0u));
    if(queue_kind)assert(queue_effects==queue_callbacks&&!queue_boundary_transfers);
    printf("PASS actual EGL release queues %s\n",argv[1]);
    if(queue_child)_exit(0);return 0;
}
