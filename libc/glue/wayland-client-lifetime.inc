/* Included only after the pinned upstream wayland-client.c. Public connection
 * entry points are renamed in that TU; all protocol/transport code stays
 * upstream. Private proxy access here retains actual native storage, rather
 * than trying to identify an arbitrary native pointer by dereferencing it. */
#undef wl_display_connect
#undef wl_display_connect_to_fd
#undef wl_display_disconnect
#include "wayland-native.h"
#include "drm_owned.h"
#include "wayland-retirement.h"
#include <limits.h>

struct wpk_wl_connection {
    struct wl_display *display;
    uint64_t identity,process_epoch,native_fork_epoch;
    unsigned boundary_reported;
    unsigned users;
    int alive;
    struct wpk_wl_connection *next,*release_next;
    struct wpk_drm_actor_claim release_claim;
    struct wpk_wl_log_scope logs;
    struct wpk_wl_boundary_hold boundary;
    uint64_t release_visit;
    int release_queued;
};
struct wpk_wl_surface {
    struct wpk_wl_connection *connection;
    struct wl_proxy *proxy;
    struct wpk_wl_display_retirement display_retirement;
    struct wpk_wl_surface_retirement self_retirement;
    struct wpk_drm_actor_claim release_claim,construction_claim;
    int constructing;
    struct wpk_wl_boundary_hold boundary;
    struct wpk_wl_surface *release_next;
    uint64_t release_visit;
    int release_queued;
};
static struct wpk_drm_mutex wpk_wl_mutex=WPK_DRM_MUTEX_INITIALIZER;
static struct wpk_wl_connection *wpk_wl_connections;
static uint64_t wpk_wl_serial;
static struct wpk_wl_connection *wpk_wl_connection_releases;
static struct wpk_wl_surface *wpk_wl_surface_releases;
static void wpk_wl_drain_releases(void);
static void wpk_wl_abandon_constructor(void *);
static struct wpk_wl_connection *wpk_wl_find(const void *native) {
    for(struct wpk_wl_connection *p=wpk_wl_connections;p;p=p->next)
        if(p->display==native)return p;
    return NULL;
}
#include "wayland-fork-boundary.inc"

static struct wl_display *wpk_wl_register(struct wl_display *display) {
    if(!display)return NULL;
    struct wpk_wl_connection *record=calloc(1,sizeof *record);
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    if(!record || wpk_wl_serial==UINT64_MAX) {
        _wpk_drm_mutex_unlock(&wpk_wl_mutex);free(record);
        _wpk_upstream_display_disconnect(display);errno=ENOMEM;return NULL;
    }
    *record=(struct wpk_wl_connection){.display=display,.identity=++wpk_wl_serial,.process_epoch=_wpk_drm_process_generation(),
        .alive=1,.native_fork_epoch=_wpk_drm_native_fork_epoch(),.next=wpk_wl_connections};
    _wpk_drm_owned_publication_begin();
    record->boundary.owner=record;
    wpk_wl_connections=record;
    _wpk_drm_owned_publication_end();
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);return display;
}
WL_EXPORT struct wl_display *wl_display_connect(const char *name) {
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(prior,NULL);return NULL;}
    wpk_wl_drain_releases();
    struct wl_display *display=wpk_wl_register(_wpk_upstream_display_connect(name));
    /* A pending deferred cancellation can fire while restoring its state.
     * Publish abandonment into the cold queue rather than losing an unreturned
     * native connection or invoking user logs from a pthread cleanup handler. */
    pthread_cleanup_push(wpk_wl_abandon_constructor,display);
    pthread_setcancelstate(prior,NULL);pthread_cleanup_pop(0);return display;
}
WL_EXPORT struct wl_display *wl_display_connect_to_fd(int fd) {
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(!_wpk_drm_actor_prepare()){
        int error=errno;close(fd);pthread_setcancelstate(prior,NULL);errno=error;return NULL;
    }
    wpk_wl_drain_releases();
    struct wl_display *display=wpk_wl_register(_wpk_upstream_display_connect_to_fd(fd));
    pthread_cleanup_push(wpk_wl_abandon_constructor,display);
    pthread_setcancelstate(prior,NULL);pthread_cleanup_pop(0);return display;
}
/* Returns actual cleanup custody after unlinking, with no lock held while
 * upstream releases queues/proxies/connection storage. */
static struct wpk_wl_connection *wpk_wl_collect(struct wpk_wl_connection *record) {
    if(record->alive || record->users)return NULL;
    struct wpk_wl_connection **p=&wpk_wl_connections;
    while(*p && *p!=record)p=&(*p)->next;
    if(*p)*p=record->next;
    return record;
}
static void wpk_wl_queue_connection_locked(struct wpk_wl_connection *record) {
    if(record->release_queued)abort();
    record->release_queued=1;record->release_next=wpk_wl_connection_releases;
    wpk_wl_connection_releases=record;
}
static void wpk_wl_abandon_constructor(void *opaque) {
    if(!opaque)return;
    int ignored;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&ignored);
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    struct wpk_wl_connection *record=wpk_wl_find(opaque);
    if(record&&record->alive){
        _wpk_drm_owned_publication_begin();record->alive=0;
        struct wpk_wl_connection *retired=wpk_wl_collect(record);
        if(retired)wpk_wl_queue_connection_locked(retired);
        _wpk_drm_owned_publication_end();
    }
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
}
static void wpk_wl_unlink_connection_locked(struct wpk_wl_connection *record) {
    if(!record->release_queued)return;
    struct wpk_wl_connection **link=&wpk_wl_connection_releases;
    while(*link&&*link!=record)link=&(*link)->release_next;
    if(!*link)abort();*link=record->release_next;record->release_queued=0;
}
static enum wpk_wl_retire_result wpk_wl_finish_connection(
    struct wpk_wl_connection *record,struct wpk_wl_display_retirement *receiver) {
    if(record->display&&_wpk_wl_display_boundary_required(record)){
        if(!_wpk_wl_display_transfer_boundary(record))abort();
        _wpk_drm_owned_publication_begin();
        wpk_wl_unlink_connection_locked(record);
        if(receiver){if(receiver->retired!=record)abort();receiver->retired=NULL;}
        _wpk_drm_actor_release_locked(&record->release_claim);
        _wpk_drm_owned_publication_end();return WPK_WL_RETIRE_BOUNDARY_TRANSFERRED;
    }
    if(record->display){
        if(!_wpk_wl_log_capture_begin(&record->logs))goto pending;
        /* WHY: upstream owns protocol/FD/queue semantics. Only its ordinary
         * logging callbacks are deferred, so cancellation-disabled native
         * teardown can finish/unlock before an arbitrary handler ends us. */
        _wpk_upstream_display_disconnect(record->display);
        _wpk_drm_owned_publication_begin();record->display=NULL;
        _wpk_wl_log_capture_end_locked(&record->logs);_wpk_drm_owned_publication_end();
    }
    if(!_wpk_wl_log_deliver(&record->logs))goto pending;
    _wpk_drm_owned_publication_begin();
    if(receiver){if(receiver->retired!=record)abort();receiver->retired=NULL;}
    wpk_wl_unlink_connection_locked(record);
    _wpk_drm_actor_release_locked(&record->release_claim);free(record);
    _wpk_drm_owned_publication_end();return WPK_WL_RETIRE_COMPLETE;
pending:
    _wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&record->release_claim);
    _wpk_drm_owned_publication_end();return WPK_WL_RETIRE_PENDING;
}
WL_EXPORT void wl_display_disconnect(struct wl_display *display) {
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    int prepared=_wpk_drm_actor_prepare(),report=0,transferred=0,shutdown_needed=0;
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    struct wpk_wl_connection *record=wpk_wl_find(display);
    if(record&&record->alive){
        transferred=wpk_wl_transfer_connection_boundary_locked(record,&report);
        if(!transferred){
            _wpk_drm_owned_publication_begin();record->alive=0;
            /* WHY: shutdown changes the shared socket OFD. A single-thread
             * child can retire its stable local native graph, but must not
             * shut down the parent transport while its copied holds drain. */
            shutdown_needed=record->users!=0&&record->process_epoch==_wpk_drm_process_generation();
            struct wpk_wl_connection *retired=wpk_wl_collect(record);
            if(retired)wpk_wl_queue_connection_locked(retired);
            _wpk_drm_owned_publication_end();
            if(shutdown_needed)shutdown(display->fd,SHUT_RDWR);
        }
    }
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(transferred)wpk_wl_boundary_diagnose(report);
    else if(prepared)wpk_wl_drain_releases();
    pthread_setcancelstate(prior,NULL);
}
int _wpk_wl_display_metadata(const void *native,uint64_t *identity) {
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    struct wpk_wl_connection *record=wpk_wl_find(native);
    int inherited=record&&record->process_epoch!=_wpk_drm_process_generation();
    int boundary=inherited&&wpk_wl_boundary_required_locked(record);
    int report=boundary&&wpk_wl_boundary_mark_locked(record);
    int found=record&&record->alive&&!inherited;
    if(found)*identity=record->identity;
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(boundary)wpk_wl_boundary_diagnose(report);else if(inherited)errno=ECHILD;
    return found;
}
void *_wpk_wl_display_acquire(const void *native,uint64_t identity) {
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    struct wpk_wl_connection *record=wpk_wl_find(native);
    int inherited=record&&record->process_epoch!=_wpk_drm_process_generation();
    int boundary=inherited&&wpk_wl_boundary_required_locked(record);
    int report=boundary&&wpk_wl_boundary_mark_locked(record);
    if(!record||!record->alive||inherited||record->identity!=identity||record->users==UINT_MAX)record=NULL;
    else{
        _wpk_drm_owned_publication_begin();record->users++;
        _wpk_drm_owned_publication_end();
    }
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(boundary)wpk_wl_boundary_diagnose(report);else if(inherited)errno=ECHILD;
    return record;
}
int _wpk_wl_display_alive(void *lease) {
    struct wpk_wl_connection *record=lease;
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    int inherited=record&&record->process_epoch!=_wpk_drm_process_generation();
    int boundary=inherited&&wpk_wl_boundary_required_locked(record);
    int report=boundary&&wpk_wl_boundary_mark_locked(record);
    int alive=record&&record->alive&&!inherited;
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(boundary)wpk_wl_boundary_diagnose(report);else if(inherited)errno=ECHILD;
    return alive;
}
enum wpk_wl_retire_result _wpk_wl_display_release_pending(struct wpk_wl_display_retirement *state) {
    if(!state)return WPK_WL_RETIRE_ERROR;
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_PENDING;}
    struct wpk_wl_connection *record=state->live?state->live:state->retired;
    if(!record){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_COMPLETE;}
    if(record->display&&_wpk_wl_display_boundary_required(record)){
        if(!_wpk_wl_display_transfer_boundary(record))abort();
        _wpk_drm_owned_publication_begin();
        state->live=state->retired=NULL;
        _wpk_drm_owned_publication_end();pthread_setcancelstate(prior,NULL);
        return WPK_WL_RETIRE_BOUNDARY_TRANSFERRED;
    }
    _wpk_drm_mutex_lock(&wpk_wl_mutex);_wpk_drm_owned_publication_begin();
    if(state->live){
        if(state->retired||!record->users)abort();
        --record->users;state->live=NULL;
        if(wpk_wl_collect(record))state->retired=record;
    }
    record=state->retired;
    int entered=record&&_wpk_drm_actor_try_claim_locked(&record->release_claim);
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&wpk_wl_mutex);
    enum wpk_wl_retire_result result=!record?WPK_WL_RETIRE_COMPLETE:
        entered?wpk_wl_finish_connection(record,state):WPK_WL_RETIRE_PENDING;
    pthread_setcancelstate(prior,NULL);return result;
}
void _wpk_wl_display_release(void *lease) {
    struct wpk_wl_connection *record=lease;if(!record)return;
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    int prepared=_wpk_drm_actor_prepare(),report=0;
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    int transferred=wpk_wl_transfer_connection_boundary_locked(record,&report);
    if(!transferred){
        _wpk_drm_owned_publication_begin();
        if(!record->users)abort();--record->users;
        struct wpk_wl_connection *retired=wpk_wl_collect(record);
        if(retired)wpk_wl_queue_connection_locked(retired);
        _wpk_drm_owned_publication_end();
    }
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(transferred)wpk_wl_boundary_diagnose(report);
    else if(prepared)wpk_wl_drain_releases();
    pthread_setcancelstate(prior,NULL);
}
struct wpk_wl_lookup {const void *native;struct wl_proxy *found;};
static enum wl_iterator_result wpk_wl_find_surface(void *element,void *data,uint32_t flags) {
    struct wpk_wl_lookup *lookup=data;
    if(!(flags & WL_MAP_ENTRY_ZOMBIE) && element==lookup->native) {
        struct wl_proxy *proxy=element;
        if(proxy->object.interface==&wl_surface_interface && !(proxy->flags & WL_PROXY_FLAG_DESTROYED))lookup->found=proxy;
    }
    return WL_ITERATOR_CONTINUE;
}
int _wpk_wl_surface_acquire_pending(const void *native,const void **display,uint64_t *identity,void **receiver) {
    if(!native||!receiver||*receiver){errno=EINVAL;return 0;}
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(prior,NULL);return 0;}
    _wpk_drm_owned_publication_begin();
    struct wpk_wl_surface *hold=calloc(1,sizeof *hold);
    if(hold){
        hold->boundary.owner=hold;hold->constructing=1;
        if(!_wpk_drm_actor_try_claim_locked(&hold->construction_claim))abort();
        *receiver=hold;
    }
    _wpk_drm_owned_publication_end();
    if(!hold){pthread_setcancelstate(prior,NULL);return 0;}
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    for(struct wpk_wl_connection *p=wpk_wl_connections;p;p=p->next)
        if(p->alive&&p->process_epoch==_wpk_drm_process_generation()&&p->users<UINT_MAX){
            struct wpk_wl_lookup lookup={.native=native};
            pthread_mutex_lock(&p->display->mutex);
            wl_map_for_each(&p->display->objects,wpk_wl_find_surface,&lookup);
            if(lookup.found&&lookup.found->refcount<INT_MAX){
                /* WHY: the initialized hold and matching native/users edges
                 * publish into its already-rooted caller slot together. A
                 * detached return value cannot own this constructor effect. */
                _wpk_drm_owned_publication_begin();
                lookup.found->refcount++;p->users++;
                hold->connection=p;hold->proxy=lookup.found;
                *display=p->display;*identity=p->identity;
                hold->constructing=0;_wpk_drm_actor_release_locked(&hold->construction_claim);
                _wpk_drm_owned_publication_end();
            }
            pthread_mutex_unlock(&p->display->mutex);
            if(hold->proxy)break;
        }
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    int acquired=hold->proxy!=NULL;
    if(!acquired){
        _wpk_drm_owned_publication_begin();
        if(*receiver!=hold)abort();*receiver=NULL;
        hold->constructing=0;_wpk_drm_actor_release_locked(&hold->construction_claim);free(hold);
        _wpk_drm_owned_publication_end();errno=EINVAL;
    }
    pthread_setcancelstate(prior,NULL);return acquired;
}
void *_wpk_wl_surface_acquire(const void *native,const void **display,uint64_t *identity) {
    void *hold=NULL;
    return _wpk_wl_surface_acquire_pending(native,display,identity,&hold)?hold:NULL;
}
static int wpk_wl_surface_lock(struct wpk_wl_surface *hold) {
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    struct wpk_wl_connection *record=hold->connection;
    if(!record||!hold->proxy){_wpk_drm_mutex_unlock(&wpk_wl_mutex);return 0;}
    if(record->process_epoch!=_wpk_drm_process_generation()){
        int boundary=wpk_wl_boundary_required_locked(record);
        int report=boundary&&wpk_wl_boundary_mark_locked(record);
        _wpk_drm_mutex_unlock(&wpk_wl_mutex);
        if(boundary)wpk_wl_boundary_diagnose(report);else errno=ECHILD;
        return 0;
    }
    struct wl_display *display=record->display;
    pthread_mutex_lock(&display->mutex);
    int alive=record->alive&&!(hold->proxy->flags&WL_PROXY_FLAG_DESTROYED)&&!display->last_error;
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(!alive)pthread_mutex_unlock(&display->mutex);
    return alive;
}
int _wpk_wl_surface_alive(void *lease) {
    struct wpk_wl_surface *hold=lease;
    if(!wpk_wl_surface_lock(hold))return 0;
    pthread_mutex_unlock(&hold->connection->display->mutex);return 1;
}
/* Use upstream's exact closure/connection machinery while its display lock
 * serializes wl_surface destruction. No check-then-marshal race or wrapper
 * pretending to own the original proxy. */
static int wpk_wl_request(struct wl_proxy *proxy,uint32_t opcode,union wl_argument *args) {
    const struct wl_message *message=&proxy->object.interface->methods[opcode];
    struct wl_closure *closure=wl_closure_marshal(&proxy->object,opcode,args,message);
    if(!closure) {display_fatal_error(proxy->display,errno);return 0;}
    int ok=wl_closure_send(closure,proxy->display->connection)==0;
    if(!ok)display_fatal_error(proxy->display,errno);
    wl_closure_destroy(closure);return ok;
}
int _wpk_wl_surface_present(void *lease,void *buffer,int width,int height) {
    struct wpk_wl_surface *hold=lease;
    if(!wpk_wl_surface_lock(hold))return 0;
    union wl_argument attach[]={{.o=buffer},{.i=0},{.i=0}};
    union wl_argument damage[]={{.i=0},{.i=0},{.i=width},{.i=height}};
    int ok=wpk_wl_request(hold->proxy,WL_SURFACE_ATTACH,attach)
        && wpk_wl_request(hold->proxy,WL_SURFACE_DAMAGE,damage)
        && wpk_wl_request(hold->proxy,WL_SURFACE_COMMIT,NULL);
    pthread_mutex_unlock(&hold->connection->display->mutex);return ok;
}
static enum wpk_wl_retire_result wpk_wl_surface_release_pending_impl(struct wpk_wl_surface_retirement *state,int preclaimed) {
    if(!state)return WPK_WL_RETIRE_ERROR;
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_PENDING;}
    struct wpk_wl_surface *hold=state->live?state->live:state->retired;
    if(!hold){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_COMPLETE;}
    _wpk_drm_owned_publication_begin();
    if(hold->constructing){
        if(_wpk_drm_actor_claim_live_locked(&hold->construction_claim)){
            if(preclaimed)_wpk_drm_actor_release_locked(&hold->release_claim);
            _wpk_drm_owned_publication_end();pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_PENDING;
        }
        hold->constructing=0;_wpk_drm_actor_release_locked(&hold->construction_claim);
    }
    int entered=preclaimed||_wpk_drm_actor_try_claim_locked(&hold->release_claim);
    _wpk_drm_owned_publication_end();
    if(!entered){pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_PENDING;}
    if(hold->proxy&&_wpk_wl_surface_boundary_required(hold)){
        if(!_wpk_wl_surface_transfer_boundary(hold))abort();
        _wpk_drm_owned_publication_begin();
        if(hold->release_queued){
            struct wpk_wl_surface **link=&wpk_wl_surface_releases;
            while(*link&&*link!=hold)link=&(*link)->release_next;
            if(!*link)abort();*link=hold->release_next;hold->release_queued=0;
        }
        state->live=state->retired=NULL;
        _wpk_drm_actor_release_locked(&hold->release_claim);
        _wpk_drm_owned_publication_end();
        pthread_setcancelstate(prior,NULL);return WPK_WL_RETIRE_BOUNDARY_TRANSFERRED;
    }
    if(hold->proxy){
        _wpk_drm_mutex_lock(&wpk_wl_mutex);
        struct wpk_wl_connection *record=hold->connection;
        int inherited=record->process_epoch!=_wpk_drm_process_generation();
        if(!inherited)pthread_mutex_lock(&record->display->mutex);
        _wpk_drm_owned_publication_begin();
        /* WHY: unref is callback-free for this valid retained proxy. Consume
         * that exact slot with the decrement, then keep its FILE/display edge
         * in a persistent nested capsule through last-disconnect/log callbacks. */
        wl_proxy_unref(hold->proxy);hold->proxy=NULL;
        hold->display_retirement.live=record;hold->connection=NULL;
        state->live=NULL;state->retired=hold;
        _wpk_drm_owned_publication_end();
        if(!inherited)pthread_mutex_unlock(&record->display->mutex);
        _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    }
    enum wpk_wl_retire_result result=_wpk_wl_display_release_pending(&hold->display_retirement);
    if(result==WPK_WL_RETIRE_COMPLETE||result==WPK_WL_RETIRE_BOUNDARY_TRANSFERRED){
        _wpk_drm_owned_publication_begin();
        if(hold->release_queued){
            struct wpk_wl_surface **link=&wpk_wl_surface_releases;
            while(*link&&*link!=hold)link=&(*link)->release_next;
            if(!*link)abort();*link=hold->release_next;
        }
        state->live=state->retired=NULL;_wpk_drm_actor_release_locked(&hold->release_claim);free(hold);
        _wpk_drm_owned_publication_end();
    }else{
        _wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&hold->release_claim);
        _wpk_drm_owned_publication_end();
    }
    pthread_setcancelstate(prior,NULL);return result;
}
enum wpk_wl_retire_result _wpk_wl_surface_release_pending(struct wpk_wl_surface_retirement *state) {
    return wpk_wl_surface_release_pending_impl(state,0);
}
void _wpk_wl_surface_release(void *lease) {
    struct wpk_wl_surface *hold=lease;if(!hold)return;
    int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    int prepared=_wpk_drm_actor_prepare();
    _wpk_drm_owned_publication_begin();
    if(hold->release_queued)abort();hold->release_queued=1;
    hold->self_retirement.live=hold;hold->release_next=wpk_wl_surface_releases;
    wpk_wl_surface_releases=hold;
    _wpk_drm_owned_publication_end();
    if(prepared)wpk_wl_drain_releases();pthread_setcancelstate(prior,NULL);
}
static void wpk_wl_drain_releases(void) {
    if(!_wpk_drm_actor_prepare())return;
    uint64_t visit=_wpk_owned_resource_nonce();if(!visit)return;
    size_t surfaces=0,connections=0;
    _wpk_drm_owned_publication_begin();
    for(struct wpk_wl_surface *p=wpk_wl_surface_releases;p;p=p->release_next)surfaces++;
    for(struct wpk_wl_connection *p=wpk_wl_connection_releases;p;p=p->release_next)connections++;
    _wpk_drm_owned_publication_end();
    while(surfaces--){
        struct wpk_wl_surface *hold=NULL;
        _wpk_drm_owned_publication_begin();
        for(struct wpk_wl_surface *p=wpk_wl_surface_releases;p;p=p->release_next){
            if(p->release_visit==visit||!_wpk_drm_actor_try_claim_locked(&p->release_claim))continue;
            hold=p;p->release_visit=visit;break;
        }
        _wpk_drm_owned_publication_end();if(!hold)break;
        (void)wpk_wl_surface_release_pending_impl(&hold->self_retirement,1);
    }
    while(connections--){
        struct wpk_wl_connection *record=NULL;
        _wpk_drm_owned_publication_begin();
        for(struct wpk_wl_connection *p=wpk_wl_connection_releases;p;p=p->release_next){
            if(p->release_visit==visit||!_wpk_drm_actor_try_claim_locked(&p->release_claim))continue;
            record=p;p->release_visit=visit;break;
        }
        _wpk_drm_owned_publication_end();if(!record)break;
        (void)wpk_wl_finish_connection(record,NULL);
    }
}
void _wpk_wl_display_release_inherited(void *lease) {
    struct wpk_wl_connection *record=lease;if(!record)return;
    if(record->process_epoch==_wpk_drm_process_generation())abort();
    _wpk_wl_display_release(record);
}
void _wpk_wl_surface_release_inherited(void *lease) {
    struct wpk_wl_surface *hold=lease;if(!hold)return;
    if(hold->proxy&&hold->connection->process_epoch==_wpk_drm_process_generation())abort();
    _wpk_wl_surface_release(hold);
}

void _wpk_wl_proxy_discard_inherited(void *lease,void *native) {
    struct wpk_wl_surface *hold=lease;struct wl_proxy *proxy=native;
    if(!proxy)return;
    if(hold&&_wpk_wl_surface_transfer_boundary(hold))return;
    if(!hold||hold->connection->process_epoch==_wpk_drm_process_generation()||
       proxy->display!=hold->connection->display)abort();
    /* Upstream's local destruction marks queued events discarded and keeps
     * protocol ID tombstones. No request is marshaled and no inherited display
     * mutex is acquired; the shim owns this entire private proxy/queue graph. */
    if(!(proxy->flags & WL_PROXY_FLAG_DESTROYED))proxy_destroy(proxy);
}
void _wpk_wl_queue_discard_inherited(void *lease,void *native) {
    struct wpk_wl_surface *hold=lease;struct wl_event_queue *queue=native;
    if(!queue)return;
    if(hold&&_wpk_wl_surface_transfer_boundary(hold))return;
    if(!hold||hold->connection->process_epoch==_wpk_drm_process_generation()||
       queue->display!=hold->connection->display)abort();
    wl_event_queue_release(queue);free(queue->name);free(queue);
}
