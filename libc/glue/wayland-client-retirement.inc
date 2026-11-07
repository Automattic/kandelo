/* Appended after pinned upstream client internals by the native lifetime bridge.
 * The caller proves ordinary or safe single-thread inherited provenance and
 * owns a rooted exclusive capsule before every effect. */
#include "wayland-retirement.h"
enum wpk_wl_retire_result _wpk_wl_proxy_destroy_pending(struct wpk_wl_proxy_retirement *state,uint32_t opcode) {
    if(!state)return WPK_WL_RETIRE_ERROR;
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(state->live){
        if(!_wpk_wl_log_capture_begin(&state->logs)){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_PENDING;}
        struct wl_proxy *proxy=state->live;
        wl_proxy_marshal_array_flags(proxy,opcode,NULL,wl_proxy_get_version(proxy),WL_MARSHAL_FLAG_DESTROY,NULL);
        _wpk_drm_owned_publication_begin();state->live=NULL;_wpk_wl_log_capture_end_locked(&state->logs);
        _wpk_drm_owned_publication_end();
    }
    enum wpk_wl_retire_result result=_wpk_wl_log_deliver(&state->logs)?WPK_WL_RETIRE_COMPLETE:WPK_WL_RETIRE_PENDING;
    pthread_setcancelstate(prior,NULL);return result;
}
/* Registry has no protocol destructor. Preserve ordinary upstream local
 * destruction, including its native display locking, before sealing the slot. */
enum wpk_wl_retire_result _wpk_wl_proxy_destroy_local_pending(struct wpk_wl_proxy_retirement *state) {
    if(!state)return WPK_WL_RETIRE_ERROR;
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(state->live){
        if(!_wpk_wl_log_capture_begin(&state->logs)){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_PENDING;}
        wl_proxy_destroy(state->live);
        _wpk_drm_owned_publication_begin();state->live=NULL;
        _wpk_wl_log_capture_end_locked(&state->logs);_wpk_drm_owned_publication_end();
    }
    enum wpk_wl_retire_result result=_wpk_wl_log_deliver(&state->logs)?WPK_WL_RETIRE_COMPLETE:WPK_WL_RETIRE_PENDING;
    pthread_setcancelstate(prior,NULL);return result;
}
/* Caller proves safe inherited ownership after the cold D59 query. These
 * preserve local discard semantics and never marshal into the parent's stream
 * or acquire a copied native mutex. Only shim-owned FD-free proxies reach the
 * pure local-proxy transaction; arbitrary queue/closure teardown stays outside. */
enum wpk_wl_retire_result _wpk_wl_proxy_discard_pending(struct wpk_wl_proxy_retirement *state) {
    if(!state)return WPK_WL_RETIRE_ERROR;
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_PENDING;}
    _wpk_drm_owned_publication_begin();
    struct wl_proxy *proxy=state->live;
    if(proxy&&!(proxy->flags&WL_PROXY_FLAG_DESTROYED))proxy_destroy(proxy);
    state->live=NULL;_wpk_drm_owned_publication_end();
    enum wpk_wl_retire_result result=_wpk_wl_log_deliver(&state->logs)?WPK_WL_RETIRE_COMPLETE:WPK_WL_RETIRE_PENDING;
    pthread_setcancelstate(prior,NULL);return result;
}
enum wpk_wl_retire_result _wpk_wl_queue_discard_pending(struct wpk_wl_queue_retirement *state) {
    if(!state)return WPK_WL_RETIRE_ERROR;
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(state->live){
        if(!_wpk_wl_log_capture_begin(&state->logs)){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_PENDING;}
        struct wl_event_queue *queue=state->live;
        wl_event_queue_release(queue);
        _wpk_drm_owned_publication_begin();
        free(queue->name);free(queue);state->live=NULL;
        _wpk_wl_log_capture_end_locked(&state->logs);_wpk_drm_owned_publication_end();
    }
    enum wpk_wl_retire_result result=_wpk_wl_log_deliver(&state->logs)?WPK_WL_RETIRE_COMPLETE:WPK_WL_RETIRE_PENDING;
    pthread_setcancelstate(prior,NULL);return result;
}
enum wpk_wl_retire_result _wpk_wl_queue_destroy_pending(struct wpk_wl_queue_retirement *state) {
    if(!state)return WPK_WL_RETIRE_ERROR;
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(state->live){
        if(!_wpk_wl_log_capture_begin(&state->logs)){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_PENDING;}
        wl_event_queue_destroy(state->live);
        _wpk_drm_owned_publication_begin();state->live=NULL;_wpk_wl_log_capture_end_locked(&state->logs);
        _wpk_drm_owned_publication_end();
    }
    enum wpk_wl_retire_result result=_wpk_wl_log_deliver(&state->logs)?WPK_WL_RETIRE_COMPLETE:WPK_WL_RETIRE_PENDING;
    pthread_setcancelstate(prior,NULL);return result;
}
