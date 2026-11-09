/* Actual pinned native queue classification. The controlled allocator retains
 * one empty queue block to force exact-address reuse; native constructor,
 * list/closure/callback/free paths otherwise execute their real code. */
#include "drm_owned.c"
static void *private_test_zalloc(size_t,const char *);
static void private_test_free(void *);
#define main original_connection_control_main
#include "wayland-connection.c"
#undef main
struct private_owner {struct wpk_drm_actor_claim actor;struct wpk_wl_log_scope logs;struct wpk_wl_private_queue_token token;};
static struct private_owner private_owner;
static struct wpk_wl_log_scope other_scope;
static void *private_queue_block;
static int private_queue_in_use,private_expect_skip,private_callbacks;
static struct wl_display *private_display;
static struct wl_proxy *private_probe;
static void *private_test_zalloc(size_t bytes,const char *caller){
    if(bytes==sizeof(struct wl_event_queue)&&!strcmp(caller,"_wpk_raw_native_wl_display_create_queue")){
        if(!private_queue_block)private_queue_block=wpk_wl_native_zalloc(bytes);
        if(!private_queue_in_use){private_queue_in_use=1;memset(private_queue_block,0,bytes);return private_queue_block;}
    }
    return wpk_wl_native_zalloc(bytes);
}
static void private_test_free(void *pointer){
    if(pointer&&pointer==private_queue_block){assert(!private_owner.token.active&&private_queue_in_use);private_queue_in_use=0;return;}
    wpk_wl_native_free(pointer);
}
void _wpk_egl_request_native_drain(void){}
static const struct wl_message private_events[]={{"done","",NULL}};
static const struct wl_interface private_interface={"audited_private",1,0,NULL,1,private_events};
static void private_listener(void *data,struct wl_proxy *proxy){
    assert(data==&private_owner&&proxy==private_probe);private_callbacks++;
    if(private_expect_skip){
        assert(!wpk_wl_callbacks&&!wpk_wl_raw_retirements);
        assert(_wpk_wl_log_capture_current()==&private_owner.logs);
    }else{
        assert(wpk_wl_callbacks&&wpk_wl_raw_retirements&&wpk_wl_callbacks->delivered);
        assert(!_wpk_wl_log_capture_current());
    }
}
static void private_dispatch(struct wl_event_queue *queue,struct wpk_wl_log_scope *scope,int skip,int peer){
    private_expect_skip=skip;wl_proxy_set_queue(private_probe,queue);
    uint32_t wire[]={private_probe->object.id,8u<<16};assert(write(peer,wire,sizeof wire)==sizeof wire);
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(scope)assert(_wpk_wl_log_capture_begin(scope));
    assert(wl_display_dispatch_queue(private_display,queue)==1);
    if(scope)_wpk_wl_log_capture_end(scope);
    pthread_setcancelstate(prior,NULL);
    assert(!wpk_wl_callbacks&&!wpk_wl_raw_retirements&&private_probe->refcount==1);
}
static void *private_foreign_owner(void *queue){
    assert(_wpk_wl_log_capture_begin(&private_owner.logs));
    assert(!wpk_wl_private_queue_current(queue,private_display));
    _wpk_wl_log_capture_end(&private_owner.logs);return NULL;
}
int main(void){
    alarm(20);int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));
    private_display=wl_display_connect_to_fd(pair[0]);assert(private_display);
    struct wl_proxy *surface=wl_proxy_create((void*)private_display,&wl_surface_interface);assert(surface);
    struct wpk_wl_surface_retirement hold={0};const void *display=NULL;uint64_t identity=0;
    assert(_wpk_wl_surface_acquire_pending(surface,&display,&identity,&hold.live));
    assert(_wpk_drm_actor_prepare());_wpk_drm_owned_publication_begin();assert(_wpk_drm_actor_try_claim_locked(&private_owner.actor));_wpk_drm_owned_publication_end();
    struct wl_event_queue *queue=wl_display_create_queue(private_display);assert(queue);
    struct wl_event_queue *public_queue=wl_display_create_queue(private_display);assert(public_queue&&public_queue!=queue);
    struct wpk_wl_private_queue_token bad={0};struct wpk_drm_actor_claim unclaimed={0};
    assert(!_wpk_wl_private_queue_register(&bad,queue,hold.live,&bad,&unclaimed,&private_owner.logs)&&!bad.active);
    assert(_wpk_wl_private_queue_register(&private_owner.token,queue,hold.live,&private_owner,&private_owner.actor,&private_owner.logs));
    assert(!wpk_wl_private_queue_current(queue,private_display)); /* capture is independent */
    assert(_wpk_wl_log_capture_begin(&private_owner.logs));
    assert(wpk_wl_private_queue_current(queue,private_display)==&private_owner.token);
    assert(!wpk_wl_private_queue_current(public_queue,private_display)&&!wpk_wl_private_queue_current(queue,(void*)1));
    _wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&private_owner.actor);_wpk_drm_owned_publication_end();
    assert(!wpk_wl_private_queue_current(queue,private_display));
    _wpk_drm_owned_publication_begin();assert(_wpk_drm_actor_try_claim_locked(&private_owner.actor));
    private_owner.token.identity++;_wpk_drm_owned_publication_end();assert(!wpk_wl_private_queue_current(queue,private_display));
    _wpk_drm_owned_publication_begin();private_owner.token.identity--;private_owner.token.native_epoch++;
    void *record=private_owner.token.connection;private_owner.token.connection=(void*)1;_wpk_drm_owned_publication_end();
    assert(!wpk_wl_private_queue_current(queue,private_display)); /* old epoch before even metadata borrow */
    _wpk_drm_owned_publication_begin();private_owner.token.connection=record;private_owner.token.native_epoch--;
    private_owner.token.process_epoch++;_wpk_drm_owned_publication_end();assert(!wpk_wl_private_queue_current(queue,private_display));
    _wpk_drm_owned_publication_begin();private_owner.token.process_epoch--;_wpk_drm_owned_publication_end();
    assert(wpk_wl_private_queue_current(queue,private_display));_wpk_wl_log_capture_end(&private_owner.logs);
    pthread_t peer;assert(!pthread_create(&peer,NULL,private_foreign_owner,queue));assert(!pthread_join(peer,NULL));
    private_probe=wl_proxy_create((void*)private_display,&private_interface);assert(private_probe);
    static void (*listener[])(void)={(void(*)(void))private_listener};assert(!wl_proxy_add_listener(private_probe,listener,&private_owner));
    private_dispatch(queue,&private_owner.logs,1,pair[1]); /* cold token AND exact active log proof */
    private_dispatch(queue,&other_scope,0,pair[1]); /* wrong capture is full raw custody */
    private_dispatch(public_queue,&private_owner.logs,0,pair[1]); /* public queue under explicit capture still full */
    private_dispatch(queue,NULL,0,pair[1]); /* token alone cannot suppress raw callback lifetime */
    wl_proxy_set_queue(private_probe,NULL);
    uintptr_t old=(uintptr_t)queue;wl_event_queue_destroy(queue);
    assert(!private_owner.token.active&&!private_queue_in_use);
    queue=wl_display_create_queue(private_display);assert(queue&&(uintptr_t)queue==old);
    assert(_wpk_wl_log_capture_begin(&private_owner.logs));assert(!wpk_wl_private_queue_current(queue,private_display));_wpk_wl_log_capture_end(&private_owner.logs);
    private_dispatch(queue,&private_owner.logs,0,pair[1]); /* exact ABA cannot inherit classification */
    assert(_wpk_wl_private_queue_register(&private_owner.token,queue,hold.live,&private_owner,&private_owner.actor,&private_owner.logs));
    private_dispatch(queue,&private_owner.logs,1,pair[1]);
    _wpk_wl_private_queue_withdraw(&private_owner.token);assert(!private_owner.token.active);
    wl_proxy_destroy(private_probe);wl_event_queue_destroy(queue);wl_event_queue_destroy(public_queue);
    _wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&private_owner.actor);_wpk_drm_owned_publication_end();
    wl_proxy_destroy(surface);assert(_wpk_wl_surface_release_pending(&hold)==WPK_WL_RETIRE_COMPLETE);
    wpk_wl_native_free(private_queue_block);private_queue_block=NULL;
    wl_display_disconnect(private_display);assert(fcntl(pair[0],F_GETFD)<0&&errno==EBADF);close(pair[1]);
    assert(private_callbacks==6);puts("PASS actual native cold queue token, owner/log/epoch refusal, public capture and exact ABA");return 0;
}
