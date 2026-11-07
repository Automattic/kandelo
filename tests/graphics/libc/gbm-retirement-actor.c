/* Actual GBM and common receiver code with independent native device peer.
 * The published capsule is the surviving cleanup actor across foreign fork. */
#include "drm-owned-double.h"
#include "drm_owned.c"
#define main transport_fixture_main
#include "drm-owned-transport.c"
#undef main
static int actor_prepare_phase(void);
static void actor_free_phase(void *);
#define calloc owned_calloc
#define free actor_free_phase
#define _wpk_drm_actor_prepare actor_prepare_phase
#include "libgbm_stub.c"
#undef calloc
#undef free
#undef _wpk_drm_actor_prepare
static void finish_actor_scope(void){
    if(actor_current_scope){
        struct wpk_drm_actor_scope *scope=actor_current_scope;
        assert(!pthread_setspecific(actor_scope_key,NULL));actor_scope_ended(scope);
    }
}
static struct wpk_gbm_window_retirement state;
static struct gbm_device *device;
static struct gbm_surface *ordinary_surface;
static int ordinary_last_buffer;
static void ordinary_release(void){
    if(ordinary_last_buffer)gbm_surface_release_buffer(ordinary_surface,ordinary_surface->bos[0]);
    else gbm_surface_destroy(ordinary_surface);
}
static void *ordinary_withdraw(void *unused){(void)unused;ordinary_release();return NULL;}
static pthread_mutex_t gate=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed=PTHREAD_COND_INITIALIZER;
static unsigned callbacks, pause_at;
static int ready,proceed,destroy_public,callback_mode,callback_child,public_bo_mode,ordinary_callback_mode;
static int admission_pause,admission_ready,admission_resume,admission_freed;
static pthread_t admission_thread;
static struct gbm_bo *admission_bo;
static void *admission_object;
static int actor_prepare_phase(void){
    if(admission_pause&&pthread_equal(pthread_self(),admission_thread)&&!admission_ready){
        pthread_mutex_lock(&gate);admission_ready=1;pthread_cond_broadcast(&changed);
        while(!admission_resume)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);
    }
    return _wpk_drm_actor_prepare();
}
static void actor_free_phase(void *pointer){if(pointer&&pointer==admission_object)admission_freed=1;owned_free(pointer);}
static void *admission_withdraw(void *unused){(void)unused;admission_thread=pthread_self();gbm_bo_destroy(admission_bo);return NULL;}
static void *ordinary_admission_withdraw(void *unused){(void)unused;admission_thread=pthread_self();ordinary_release();return NULL;}

static void release_pending(void);
static void snapshot_prepare(void){pthread_mutex_lock(&peer_mutex);}
static void snapshot_end(void){pthread_mutex_unlock(&peer_mutex);}
static void destructor(struct gbm_bo *bo,void *data) {
    assert(data==device&&gbm_bo_get_device(bo)==device);
    /* User callbacks still observe live BO/file custody and may reenter.
     * A pre-withdraw-all shortcut would invalidate this ordinary contract. */
    assert(device->owner&&caps[device->owner->token].live);
    assert(bo->planes[0].owner&&caps[bo->planes[0].owner->token].live);
    callbacks++;
    if(callbacks==1&&callback_mode==3){
        struct gbm_bo *nested=live_bos;while(nested&&nested==bo)nested=nested->handle_next;
        assert(nested);callback_mode=0;gbm_bo_destroy(nested);
        assert(callbacks==2&&live_bos==bo&&retired_bos==bo);
    }
    if(callbacks==1&&callback_mode==2)pthread_exit(NULL);
    if(callbacks==1&&callback_mode==1){
        pid_t child=fork();assert(child>=0);
        if(!child){
            callback_child=1;callback_mode=0;
            if(public_bo_mode)drain_retired_bos();
            else if(ordinary_callback_mode)gbm_surface_destroy(ordinary_surface);
            else release_pending();
            /* The fork caller's callback stack still owns this BO. A child
             * reentry must leave it and its source FILE alive until return. */
            assert(bo->dev==device&&bo->planes[0].owner&&caps[bo->planes[0].owner->token].live);
            assert(public_bo_mode?retired_bos!=NULL:ordinary_callback_mode?retired_surfaces!=NULL:state.retired!=NULL);
        }else{
            int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
        }
    }
    if(callbacks==pause_at) {
        pthread_mutex_lock(&gate);ready=1;pthread_cond_broadcast(&changed);
        while(!proceed)pthread_cond_wait(&changed,&gate);
        pthread_mutex_unlock(&gate);
    }
}
static struct wpk_drm_owner *capture_bo(struct wpk_drm_owner *owner) {
    uint32_t value=5;struct wpk_drm_owner *bo=NULL;
    assert(!_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo));
    assert(bo);return bo;
}
static void release_pending(void) {
#ifdef WPK_GBM_RETIREMENT_BEFORE
    if(destroy_public)gbm_surface_destroy(state.live);else _wpk_gbm_window_release(state.live);
    state.live=NULL;
#else
    if(destroy_public)_wpk_gbm_surface_destroy_pending(&state);
    else _wpk_gbm_window_release_pending(&state);
#endif
}
static void *withdraw(void *unused){(void)unused;release_pending();return NULL;}
static void *public_withdraw(void *unused){(void)unused;gbm_bo_destroy(live_bos);return NULL;}
#ifndef WPK_GBM_RETIREMENT_MAIN
#define WPK_GBM_RETIREMENT_MAIN main
#endif
int WPK_GBM_RETIREMENT_MAIN(int argc,char **argv) {
    assert(argc==2);assert(!pthread_atfork(snapshot_prepare,snapshot_end,snapshot_end));
    struct wpk_drm_owner *owner=NULL;assert(!_wpk_drm_owned_open(1,&owner));
    device=owned_calloc(1,sizeof *device);assert(device);
    device->owner=owner;device->references=4;device->fd=device->public_fd=-1;live_devices=device;
    struct gbm_surface *surface=owned_calloc(1,sizeof *surface);assert(surface);
    destroy_public=!strncmp(argv[1],"surface-",8);
    surface->dev=device;surface->window_owned=!destroy_public;
    surface->public_live=destroy_public||!strcmp(argv[1],"public");
    live_surfaces=surface;
    for(unsigned i=0;i<2;i++) {
        struct gbm_bo *bo=owned_calloc(1,sizeof *bo);assert(bo);
        bo->dev=device;bo->surface=surface;bo->plane_count=1;bo->planes[0].owner=capture_bo(owner);
        bo->user_data=device;bo->user_data_destroy=destructor;
        bo->handle_next=live_bos;live_bos=bo;surface->bos[i]=bo;
    }
    if(strcmp(argv[1],"device"))gbm_device_destroy(device);
    state.live=surface;
    if(!strcmp(argv[1],"public-admission")){
        _wpk_drm_owned_publication_begin();
        for(unsigned i=0;i<2;i++)surface->bos[i]->surface=NULL;
        assert(!release_device_published(device));live_surfaces=NULL;state.live=NULL;
        _wpk_drm_owned_publication_end();owned_free(surface);
        admission_bo=live_bos;admission_object=admission_bo;admission_pause=1;
        pthread_t worker;assert(!pthread_create(&worker,NULL,admission_withdraw,NULL));
        pthread_mutex_lock(&gate);while(!admission_ready)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);
        drain_retired_bos();
        if(admission_freed){fprintf(stderr,"FAIL queued BO freed before its caller could claim it\n");_exit(42);}
        pthread_mutex_lock(&gate);admission_resume=1;pthread_cond_broadcast(&changed);pthread_mutex_unlock(&gate);
        assert(!pthread_join(worker,NULL));admission_pause=0;assert(admission_freed);admission_bo=NULL;admission_object=NULL;
        while(live_bos)gbm_bo_destroy(live_bos);
        finish_actor_scope();assert(callbacks==2&&!live_caps()&&!allocations);
        puts("PASS public BO publication and caller claim are inseparable");return 0;
    }
    if(!strcmp(argv[1],"public-preparation-failure")){
        _wpk_drm_owned_publication_begin();
        for(unsigned i=0;i<2;i++)surface->bos[i]->surface=NULL;
        assert(!release_device_published(device));live_surfaces=NULL;state.live=NULL;
        _wpk_drm_owned_publication_end();owned_free(surface);
        deny_allocation=1;gbm_bo_destroy(live_bos);
        assert(retired_bos&&callbacks==0);deny_allocation=0;drain_retired_bos();
        while(live_bos)gbm_bo_destroy(live_bos);
        finish_actor_scope();assert(callbacks==2&&!live_caps()&&!allocations);
        puts("PASS BO preparation failure retains exact queue custody");return 0;
    }
    if(!strcmp(argv[1],"surface-preparation-failure")){
        ordinary_surface=surface;surface->window_owned=0;surface->public_live=1;state.live=NULL;
        deny_allocation=1;gbm_surface_destroy(surface);
        assert(retired_surfaces==surface&&!live_surfaces&&callbacks==0);
        deny_allocation=0;gbm_surface_destroy(surface);finish_actor_scope();
        assert(callbacks==2&&!live_caps()&&!allocations);
        puts("PASS surface preparation failure retains the whole ring");return 0;
    }
    if(!strcmp(argv[1],"surface-admission")){
        ordinary_surface=surface;surface->window_owned=0;surface->public_live=1;state.live=NULL;
        admission_object=surface;admission_pause=1;
        pthread_t worker;assert(!pthread_create(&worker,NULL,ordinary_admission_withdraw,NULL));
        pthread_mutex_lock(&gate);while(!admission_ready)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);
        drain_retired_surfaces();
        assert(!admission_freed&&!retired_surfaces);
        pid_t child=fork();assert(child>=0);
        if(!child){
            alarm(5);admission_pause=0;gbm_surface_destroy(ordinary_surface);
            drain_retired_surfaces();drain_retired_bos();_wpk_drm_owned_drain();finish_actor_scope();
            if(live_caps()||allocations){fprintf(stderr,"FAIL surface withdrawal escaped queue publication\n");_exit(43);}
            _exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status));
        if(WEXITSTATUS(status))_exit(WEXITSTATUS(status));
        pthread_mutex_lock(&gate);admission_resume=1;pthread_cond_broadcast(&changed);pthread_mutex_unlock(&gate);
        assert(!pthread_join(worker,NULL));admission_pause=0;assert(admission_freed);admission_object=NULL;
        finish_actor_scope();assert(callbacks==2&&!live_caps()&&!allocations);
        puts("PASS public surface withdrawal and caller claim are inseparable");return 0;
    }
    if(!strncmp(argv[1],"ordinary-",9)&&!strstr(argv[1],"callback-")){
        ordinary_surface=surface;state.live=NULL;surface->window_owned=0;surface->public_live=1;
        ordinary_last_buffer=strstr(argv[1],"last")!=NULL;
        if(ordinary_last_buffer){surface->in_use[0]=1;gbm_surface_destroy(surface);}
        pause_at=strstr(argv[1],"first")?1:2;
        pthread_t worker;assert(!pthread_create(&worker,NULL,ordinary_withdraw,NULL));
        pthread_mutex_lock(&gate);while(!ready)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);
        pid_t child=fork();assert(child>=0);
        if(!child){
            alarm(5);pause_at=0;proceed=1;
            /* Re-enter only normal cold public paths: no private capsule or
             * lost worker stack is available to the surviving caller. */
            gbm_surface_destroy(ordinary_surface);drain_retired_bos();_wpk_drm_owned_drain();
            finish_actor_scope();
            if(live_bos||live_caps()||allocations){
                fprintf(stderr,"FAIL ordinary public surface lost its ring/finalizer actor\n");_exit(41);
            }
            assert(!live_surfaces);_exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child);
        pthread_mutex_lock(&gate);proceed=1;pthread_cond_broadcast(&changed);pthread_mutex_unlock(&gate);
        assert(!pthread_join(worker,NULL));finish_actor_scope();
        assert(callbacks==2&&!live_surfaces&&!live_bos&&!live_caps()&&!allocations);
        if(!WIFEXITED(status))return 42;return WEXITSTATUS(status);
    }
    if(strstr(argv[1],"callback-")){
        callback_mode=strstr(argv[1],"exit")?2:strstr(argv[1],"nested")?3:1;
        public_bo_mode=!strncmp(argv[1],"public-",7);
        ordinary_callback_mode=!strncmp(argv[1],"ordinary-",9);
        if(ordinary_callback_mode){
            ordinary_surface=surface;surface->window_owned=0;surface->public_live=1;state.live=NULL;
            ordinary_last_buffer=strstr(argv[1],"last")!=NULL;
            if(ordinary_last_buffer){surface->in_use[0]=1;gbm_surface_destroy(surface);}
        }
        if(public_bo_mode){
            /* Fixture setup transfers the already-created BOs to ordinary
             * public destruction; the production list publishes each actor. */
            _wpk_drm_owned_publication_begin();
            for(unsigned i=0;i<2;i++)surface->bos[i]->surface=NULL;
            assert(!release_device_published(device));
            live_surfaces=NULL;state.live=NULL;
            _wpk_drm_owned_publication_end();owned_free(surface);
        }
        if(callback_mode==2){
            pthread_t worker;
            if(public_bo_mode){
                assert(!pthread_create(&worker,NULL,public_withdraw,NULL));
            }else if(ordinary_callback_mode)assert(!pthread_create(&worker,NULL,ordinary_withdraw,NULL));
            else assert(!pthread_create(&worker,NULL,withdraw,NULL));
            assert(!pthread_join(worker,NULL));callback_mode=0;
        }
        if(public_bo_mode){drain_retired_bos();while(live_bos)gbm_bo_destroy(live_bos);}
        else if(ordinary_callback_mode){
            if(strstr(argv[1],"exit"))gbm_surface_destroy(ordinary_surface);
            else ordinary_release();
        }else release_pending();
        finish_actor_scope();
        assert(callbacks==2&&!live_surfaces&&!live_bos&&!live_devices&&!retired_bos&&!retired_surfaces&&!live_caps()&&!allocations);
        puts("PASS actual GBM callback fork/reentry or ended-thread adoption");
        if(callback_child)_exit(0);return 0;
    }
    if(!strcmp(argv[1],"plain")||!strcmp(argv[1],"public")||!strcmp(argv[1],"device")) {
        int public_live=surface->public_live;
        release_pending();assert(!state.live&&!state.retired);
        if(public_live){assert(live_surfaces==surface&&!surface->window_owned);gbm_surface_destroy(surface);}
        if(!strcmp(argv[1],"device")) {
            assert(live_devices==device&&caps[device->owner->token].live);
            struct gbm_device *receiver=device;
#ifdef WPK_GBM_RETIREMENT_BEFORE
            gbm_device_destroy(receiver);receiver=NULL;
#else
            _wpk_gbm_device_destroy_pending(&receiver);
#endif
            assert(!receiver&&!live_devices);
        }
        finish_actor_scope();assert(callbacks==2&&!live_surfaces&&!live_bos&&!live_caps()&&!allocations);
        puts("PASS GBM retirement actor ordinary/public lifetime");return 0;
    }
    pause_at=strstr(argv[1],"first")?1:2;
    pthread_t worker;assert(!pthread_create(&worker,NULL,withdraw,NULL));
    pthread_mutex_lock(&gate);while(!ready)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);
    pid_t child=fork();assert(child>=0);
    if(!child) {
        alarm(5);pause_at=0;proceed=1;release_pending();
        assert(!state.live&&!state.retired&&!live_surfaces&&!live_bos);
        finish_actor_scope();assert(callbacks==2&&!live_caps()&&!allocations);_exit(0);
    }
    int status;assert(waitpid(child,&status,0)==child);
    pthread_mutex_lock(&gate);proceed=1;pthread_cond_broadcast(&changed);pthread_mutex_unlock(&gate);
    assert(!pthread_join(worker,NULL));
    assert(WIFEXITED(status)&&!WEXITSTATUS(status));
    finish_actor_scope();assert(callbacks==2&&!live_surfaces&&!live_bos&&!live_caps()&&!allocations);
    printf("PASS GBM rooted retirement actor foreign fork %s callback\n",argv[1]);return 0;
}
