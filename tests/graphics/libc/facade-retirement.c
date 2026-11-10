/* Actual facade/common source, independent device peer, native pthread/fork.
 * This judges exact resource custody, not arbitrary inherited malloc blocks
 * or target Wasm execution. No product test hooks are compiled in. */
#include <pthread.h>
#include <stdatomic.h>
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
static int facade_mutex_lock(pthread_mutex_t *);
#include "drm-owned-double.h"
#define pthread_mutex_lock facade_mutex_lock
#include "drm_owned.c"
#undef pthread_mutex_lock
#define main transport_fixture_main
#include "drm-owned-transport.c"
#undef main
static void facade_retire(struct wpk_drm_owner **);
static void facade_defer(struct wpk_drm_owner **);
static void facade_drain(void);
#define _wpk_drm_owned_retire facade_retire
#define _wpk_drm_owned_defer_locked facade_defer
#define _wpk_drm_owned_drain facade_drain
#define calloc owned_calloc
#define free owned_free
#ifdef WPK_FACADE_GBM
#include "libgbm_stub.c"
#else
#include "libegl_stub.c"
void _wpk_gbm_window_release_pending(struct wpk_gbm_window_retirement *p){(void)p;abort();}
#endif
#undef calloc
#undef free
#undef _wpk_drm_owned_retire
#undef _wpk_drm_owned_defer_locked
#undef _wpk_drm_owned_drain
static pthread_mutex_t gate=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed=PTHREAD_COND_INITIALIZER;
static pthread_t cleanup_thread;
static int ready,resume_cleanup,paused_in_guard,fork_waiting,forking,hook_count,hook_target=1;
static struct wpk_drm_owner *file_owner,*target_owner,*secondary_owner;
static uint32_t target_token,secondary_token;
#ifdef WPK_FACADE_GBM
static struct gbm_device *device;
static struct gbm_bo *buffer;
static struct gbm_surface *window;
#else
static struct wpk_egl_image *image;
#endif
static int facade_mutex_lock(pthread_mutex_t *mutex) {
    if(mutex==&capture_publication_mutex&&forking&&!pthread_equal(pthread_self(),cleanup_thread)){
        pthread_mutex_lock(&gate);fork_waiting=1;pthread_cond_broadcast(&changed);pthread_mutex_unlock(&gate);
    }
    return pthread_mutex_lock(mutex);
}
static void pause_cleanup(int held) {
    pthread_mutex_lock(&gate);
    if(++hook_count==hook_target){
        paused_in_guard=held;ready=1;pthread_cond_broadcast(&changed);
        while(!resume_cleanup)pthread_cond_wait(&changed,&gate);
    }
    pthread_mutex_unlock(&gate);
}
static void facade_retire(struct wpk_drm_owner **pointer) {pause_cleanup(0);_wpk_drm_owned_retire(pointer);}
static void facade_defer(struct wpk_drm_owner **pointer) {
    _wpk_drm_owned_defer_locked(pointer);
    pause_cleanup(1);
}
static void facade_drain(void) {_wpk_drm_owned_drain();}
static void snapshot_prepare(void) {pthread_mutex_lock(&peer_mutex);}
static void snapshot_end(void) {pthread_mutex_unlock(&peer_mutex);}
static void *unblock_guard(void *unused) {
    (void)unused;pthread_mutex_lock(&gate);
    while(!fork_waiting)pthread_cond_wait(&changed,&gate);
    if(paused_in_guard){resume_cleanup=1;pthread_cond_broadcast(&changed);}
    pthread_mutex_unlock(&gate);return NULL;
}
static int rooted(struct wpk_drm_owner *owner) {
    for(struct wpk_drm_owner *p=atomic_load(&retired_owners);p;p=p->retirement_next)if(p==owner)return 1;
#ifdef WPK_FACADE_GBM
    for(struct gbm_device *p=live_devices;p;p=p->live_next)if(p->owner==owner)return 1;
    for(struct gbm_bo *p=live_bos;p;p=p->handle_next){
        if(p->dev->owner==owner)return 1;
        for(unsigned i=0;i<GBM_MAX_PLANES;i++)if(p->planes[i].owner==owner)return 1;
    }
    for(struct gbm_surface *p=live_surfaces;p;p=p->live_next)if(p->dev->owner==owner)return 1;
#else
    for(struct wpk_egl_image *p=g_images;p;p=p->next){
        if(p->bo_owner==owner)return 1;
        for(unsigned i=0;i<p->plane_count;i++)if(p->planes[i].owner==owner)return 1;
    }
#endif
    return 0;
}
static void coherent_public_facades(void) {
#ifdef WPK_FACADE_GBM
    for(struct gbm_device *p=live_devices;p;p=p->live_next)assert(p->owner);
    for(struct gbm_bo *p=live_bos;p;p=p->handle_next)assert(p->dev->owner&&p->planes[0].owner);
#else
    for(struct wpk_egl_image *p=g_images;p;p=p->next)assert(p->external_only?p->planes[0].owner!=NULL:p->bo_owner!=NULL);
#endif
}
static struct wpk_drm_owner *capture_bo(void) {
    uint32_t value=5;struct wpk_drm_owner *owner=NULL;
    assert(!_wpk_drm_owned_ioctl(file_owner,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&owner)&&owner);
    return owner;
}
#ifdef WPK_FACADE_GBM
static struct gbm_bo *make_buffer(void) {
    struct gbm_bo *bo=owned_calloc(1,sizeof *bo);assert(bo);
    bo->dev=device;bo->plane_count=1;bo->planes[0].owner=capture_bo();
    bo->handle_next=live_bos;live_bos=bo;return bo;
}
#endif
static void *withdraw(void *mode) {
    cleanup_thread=pthread_self();
#ifdef WPK_FACADE_GBM
    if(!strcmp(mode,"bo"))gbm_bo_destroy(buffer);
    else if(!strcmp(mode,"device"))gbm_device_destroy(device);
    else gbm_surface_destroy(window);
#else
    (void)mode;int cancel_state;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    _wpk_drm_mutex_lock(&g_image_mutex);image_release_locked(image);_wpk_drm_mutex_unlock(&g_image_mutex);
    pthread_setcancelstate(cancel_state,NULL);
#endif
    return NULL;
}
int main(int argc,char **argv) {
    assert(argc==2);
    /* Register the independent peer's snapshot before first OPEN, matching
     * kernel snapshot-after-guest-prepare ordering rather than inverting it. */
    assert(!pthread_atfork(snapshot_prepare,snapshot_end,snapshot_end));
    assert(!_wpk_drm_owned_open(1,&file_owner));
#ifdef WPK_FACADE_GBM
    device=owned_calloc(1,sizeof *device);assert(device);device->owner=file_owner;
    device->references=1;device->fd=device->public_fd=-1;live_devices=device;
    if(!strcmp(argv[1],"device")){target_owner=file_owner;}
    else if(!strcmp(argv[1],"bo")){
        device->references++;buffer=make_buffer();target_owner=buffer->planes[0].owner;
    }else{
        assert(!strcmp(argv[1],"surface"));
        window=owned_calloc(1,sizeof *window);assert(window);window->dev=device;window->public_live=1;live_surfaces=window;
        device->references=4;
        window->bos[0]=make_buffer();window->bos[0]->surface=window;
        window->bos[1]=make_buffer();window->bos[1]->surface=window;
        target_owner=window->bos[1]->planes[0].owner;secondary_owner=file_owner;
        gbm_device_destroy(device);hook_count=0;hook_target=2;
    }
#else
    assert(!strcmp(argv[1],"image"));
    image=owned_calloc(1,sizeof *image);assert(image);image->bo_owner=capture_bo();g_images=image;
    target_owner=image->bo_owner;
#endif
    target_token=target_owner->token;if(secondary_owner)secondary_token=secondary_owner->token;
    pthread_t worker,controller;assert(!pthread_create(&worker,NULL,withdraw,argv[1]));
    pthread_mutex_lock(&gate);while(!ready)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);
    assert(!pthread_create(&controller,NULL,unblock_guard,NULL));
    forking=1;pid_t child=fork();assert(child>=0);
    if(!child){
        alarm(5);forking=0;
        coherent_public_facades();
        fputs("CONTROL child inspects exact resource custody after facade withdrawal\n",stderr);
        if(caps[target_token].live)assert(rooted(target_owner));
        if(secondary_owner&&caps[secondary_token].live)assert(rooted(secondary_owner));
        _wpk_drm_owned_drain();
#ifdef WPK_FACADE_GBM
        if(!strcmp(argv[1],"bo"))gbm_device_destroy(device);
#else
        release_owner(&file_owner);
#endif
        assert(!live_caps());_exit(0);
    }
    forking=0;int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
    pthread_mutex_lock(&gate);resume_cleanup=1;pthread_cond_broadcast(&changed);pthread_mutex_unlock(&gate);
    assert(!pthread_join(worker,NULL)&&!pthread_join(controller,NULL));
#ifdef WPK_FACADE_GBM
    if(!strcmp(argv[1],"bo"))gbm_device_destroy(device);
#else
    release_owner(&file_owner);
#endif
    assert(!allocations&&!live_caps());printf("PASS facade publication %s\n",argv[1]);return 0;
}
