/* Actual GBM + common actors. Compare the old caller's before/after clearing
 * choices with a jointly published front-hold release, including user exit. */
#define WPK_GBM_RETIREMENT_MAIN surface_retirement_fixture_main
#include "gbm-retirement-actor.c"
#undef WPK_GBM_RETIREMENT_MAIN
static struct wpk_gbm_front_hold hold;
static int front_mode;
static void setup_front(void){
    struct wpk_drm_owner *owner=NULL;assert(!_wpk_drm_owned_open(1,&owner));
    device=owned_calloc(1,sizeof *device);assert(device);
    device->owner=owner;device->references=4;device->fd=device->public_fd=-1;live_devices=device;
    ordinary_surface=owned_calloc(1,sizeof *ordinary_surface);assert(ordinary_surface);
    ordinary_surface->dev=device;ordinary_surface->public_live=1;live_surfaces=ordinary_surface;
    for(unsigned i=0;i<2;i++){
        struct gbm_bo *bo=owned_calloc(1,sizeof *bo);assert(bo);
        bo->dev=device;bo->surface=ordinary_surface;bo->plane_count=1;bo->planes[0].owner=capture_bo(owner);
        bo->user_data=device;bo->user_data_destroy=destructor;
        bo->handle_next=live_bos;live_bos=bo;ordinary_surface->bos[i]=bo;
    }
    ordinary_surface->in_use[0]=1;
    hold=(struct wpk_gbm_front_hold){ordinary_surface,ordinary_surface->bos[0]};
    gbm_device_destroy(device);
    if(front_mode)gbm_surface_destroy(ordinary_surface);
}
static void release_front(void){
#ifdef WPK_FRONT_HOLD_BEFORE
    if(!hold.bo)return;
    struct gbm_surface *surface=hold.surface;struct gbm_bo *bo=hold.bo;
    if(front_mode==2){
        _wpk_drm_owned_publication_begin();hold=(struct wpk_gbm_front_hold){0};_wpk_drm_owned_publication_end();
        actor_prepare_phase(); /* deterministic stop after early caller clear */
    }
    gbm_surface_release_buffer(surface,bo);
    _wpk_drm_owned_publication_begin();hold=(struct wpk_gbm_front_hold){0};_wpk_drm_owned_publication_end();
#else
    assert(!_wpk_gbm_surface_release_buffer_pending(&hold));
#endif
}
static void *release_front_thread(void *unused){(void)unused;admission_thread=pthread_self();release_front();return NULL;}
int main(int argc,char **argv){
    assert(argc==2);front_mode=!strcmp(argv[1],"exit")?1:!strcmp(argv[1],"fork")?2:0;
    setup_front();
    if(!strcmp(argv[1],"metadata")){
        assert(!actor_current_scope&&actor_scope_status==EAGAIN);
        deny_allocation=1;release_front();deny_allocation=0;
        assert(!hold.bo&&!hold.surface&&!ordinary_surface->in_use[0]&&!callbacks);
        assert(!actor_current_scope&&actor_scope_status==EAGAIN);
        gbm_surface_destroy(ordinary_surface);
    }else if(!strcmp(argv[1],"invalid")){
        struct gbm_bo *actual=hold.bo;hold.bo=ordinary_surface->bos[1];
        errno=0;assert(_wpk_gbm_surface_release_buffer_pending(&hold)==-1&&errno==EINVAL);
        assert(hold.surface==ordinary_surface&&hold.bo==ordinary_surface->bos[1]&&ordinary_surface->in_use[0]);
        hold.bo=actual;release_front();gbm_surface_destroy(ordinary_surface);
    }else if(front_mode==1){
        callback_mode=2;pthread_t worker;assert(!pthread_create(&worker,NULL,release_front_thread,NULL));
        assert(!pthread_join(worker,NULL));callback_mode=0;
        if(hold.bo||hold.surface){fprintf(stderr,"FAIL front hold survived a completed release effect after thread exit\n");return 44;}
        assert(!_wpk_gbm_surface_release_buffer_pending(&hold));
        gbm_surface_destroy(NULL);
    }else{
        assert(front_mode==2);admission_pause=1;pthread_t worker;
        assert(!pthread_create(&worker,NULL,release_front_thread,NULL));
        pthread_mutex_lock(&gate);while(!admission_ready)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);
        pid_t child=fork();assert(child>=0);
        if(!child){
            alarm(5);admission_pause=0;release_front();gbm_surface_destroy(NULL);finish_actor_scope();
            if(hold.bo||hold.surface||live_caps()||allocations){fprintf(stderr,"FAIL front release intent disappeared before the actual effect\n");_exit(45);}
            _exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status));
        pthread_mutex_lock(&gate);admission_resume=1;pthread_cond_broadcast(&changed);pthread_mutex_unlock(&gate);
        assert(!pthread_join(worker,NULL));admission_pause=0;
        if(WEXITSTATUS(status))return WEXITSTATUS(status);
    }
    finish_actor_scope();assert(!hold.bo&&!hold.surface&&callbacks==2&&!live_surfaces&&!retired_surfaces&&!live_bos&&!live_caps()&&!allocations);
    puts("PASS front hold consumption and exact surface custody publish together");return 0;
}
