/* Appended only after the unmodified pinned wayland-util.c, whose wl_log
 * definition is renamed in its platform TU wrapper. wl_abort and both public
 * handler setters remain upstream and use the canonical wl_log_handler. */
#undef wl_log
#include "wayland-retirement.h"
#include <limits.h>
#include <unistd.h>

struct wpk_wl_log_message {
    struct wpk_wl_log_message *next;
    wl_log_func_t handler;
    char *text;
    struct wpk_drm_actor_claim callback_claim;
    int started;
};
static _Thread_local struct wpk_wl_log_scope *wpk_wl_capture,*wpk_wl_suppressed_scope;
static _Atomic(wpk_wl_log_resolver) wpk_wl_resolver;
struct wpk_wl_deferred_log {
    struct wpk_wl_deferred_log *next;
    struct wpk_wl_log_scope logs;
    struct wpk_drm_actor_claim drain_claim;
    uint64_t visit;
};
static struct wpk_wl_deferred_log *wpk_wl_deferred_logs,*wpk_wl_deferred_tail;
#if defined(__APPLE__)
__attribute__((weak_import)) void _wpk_egl_request_native_drain(void);
#else
__attribute__((weak)) void _wpk_egl_request_native_drain(void);
#endif


static _Noreturn void wpk_wl_log_bookkeeping_failed(void) {
    /* WHY: falling back to an arbitrary handler here can end the thread while
     * upstream owns its display mutex. Exact capture OOM is a loud fatal
     * bookkeeping failure, never silent/truncated logging or false cleanup. */
    static const char message[]="Kandelo Wayland: durable teardown log capture failed\n";
    (void)write(STDERR_FILENO,message,sizeof message-1);
    abort();
}
int _wpk_wl_log_set_resolver(wpk_wl_log_resolver resolver) {
    if(!resolver){errno=EINVAL;return 0;}
    if(!_wpk_drm_actor_prepare())return 0;
    _wpk_drm_owned_publication_begin();
    wpk_wl_log_resolver old=atomic_load_explicit(&wpk_wl_resolver,memory_order_relaxed);
    int installed=!old||old==resolver;
    if(installed)atomic_store_explicit(&wpk_wl_resolver,resolver,memory_order_release);
    _wpk_drm_owned_publication_end();
    if(!installed){errno=EEXIST;return 0;}
    return 1;
}
int _wpk_wl_log_capture_begin(struct wpk_wl_log_scope *scope) {
    if(!scope||!_wpk_drm_actor_prepare())return 0;
    _wpk_drm_owned_publication_begin();
    if(scope->capturing||scope->messages||
       !_wpk_drm_actor_try_claim_locked(&scope->capture_claim)){
        _wpk_drm_owned_publication_end();return 0;
    }
    /* WHY: scope storage already belongs to the caller's durable native node.
     * Its independent claim and TLS publication preserve nested scopes and a
     * continuing fork caller without making a peer's stack its only owner. */
    if(scope->origin_claim.scope)_wpk_drm_actor_release_locked(&scope->origin_claim);
    scope->previous=wpk_wl_capture;scope->capturing=1;wpk_wl_capture=scope;
    _wpk_drm_owned_publication_end();return 1;
}
void _wpk_wl_log_capture_end_locked(struct wpk_wl_log_scope *scope) {
    if(!scope||wpk_wl_capture!=scope||!scope->capturing)abort();
    wpk_wl_capture=scope->previous;scope->previous=NULL;scope->capturing=0;
    _wpk_drm_actor_release_locked(&scope->capture_claim);
}
void _wpk_wl_log_capture_end(struct wpk_wl_log_scope *scope) {
    _wpk_drm_owned_publication_begin();_wpk_wl_log_capture_end_locked(scope);
    _wpk_drm_owned_publication_end();
}
static void wpk_wl_log_invoke(wl_log_func_t handler,const char *fmt,...) {
    va_list args;va_start(args,fmt);handler(fmt,args);va_end(args);
}
int _wpk_wl_log_deliver(struct wpk_wl_log_scope *scope) {
    if(!scope||!_wpk_drm_actor_prepare())return 0;
    for(;;){
        _wpk_drm_owned_publication_begin();
        if(_wpk_drm_actor_claim_live_locked(&scope->origin_claim)&&
           !_wpk_drm_actor_claim_current_locked(&scope->origin_claim)){
            _wpk_drm_owned_publication_end();return 0;
        }
        if(scope->messages&&!_wpk_drm_actor_claim_live_locked(&scope->origin_claim))
            if(!_wpk_drm_actor_try_claim_locked(&scope->origin_claim))abort();
        if(scope->capturing){_wpk_drm_owned_publication_end();return 0;}
        struct wpk_wl_log_scope *parent=wpk_wl_capture;
        if(parent&&parent!=scope&&scope->messages){
            /* WHY: a nested native helper may have completed while its parent
             * still owns native/facade locks. Transfer actual diagnostic
             * custody into that rooted scope, preserving emission order. */
            for(struct wpk_wl_log_message *p=scope->messages;p;p=p->next)
                if(_wpk_drm_actor_claim_live_locked(&p->callback_claim)){
                    _wpk_drm_owned_publication_end();return 0;
                }
            if(!parent->origin_claim.scope)
                if(!_wpk_drm_actor_try_claim_locked(&parent->origin_claim))abort();
            if(parent->tail)parent->tail->next=scope->messages;else parent->messages=scope->messages;
            parent->tail=scope->tail;scope->messages=scope->tail=NULL;
            _wpk_drm_actor_release_locked(&scope->origin_claim);
            _wpk_drm_owned_publication_end();return 1;
        }
        struct wpk_wl_log_message *message=scope->messages;
        if(!message){
            _wpk_drm_actor_release_locked(&scope->origin_claim);
            _wpk_drm_owned_publication_end();return 1;
        }
        if(!_wpk_drm_actor_try_claim_locked(&message->callback_claim)){
            _wpk_drm_owned_publication_end();return 0;
        }
        int invoke=!message->started;message->started=1;
        _wpk_drm_owned_publication_end();
        if(invoke){
            /* WHY: callbacks run after native progress has sealed, outside all
             * native/publication locks. Suspend outer capture too: reentrant
             * cleanup owns its own capsule and ordinary callback logging must
             * retain the normal public path. */
            struct wpk_wl_log_scope *prior=wpk_wl_capture,*suppressed=wpk_wl_suppressed_scope;
            wpk_wl_capture=NULL;wpk_wl_suppressed_scope=scope;
            wpk_wl_log_invoke(message->handler,"%s",message->text);
            wpk_wl_capture=prior;wpk_wl_suppressed_scope=suppressed;
        }
        _wpk_drm_owned_publication_begin();
        /* No cursor survives the handler. An ended handler is not replayed;
         * its independent dead claim can be consumed by the adopting actor. */
        struct wpk_wl_log_message **link=&scope->messages;
        while(*link&&*link!=message)link=&(*link)->next;
        if(!*link)abort();*link=message->next;
        if(scope->tail==message){
            scope->tail=scope->messages;
            while(scope->tail&&scope->tail->next)scope->tail=scope->tail->next;
        }
        _wpk_drm_actor_release_locked(&message->callback_claim);
        free(message->text);free(message);
        _wpk_drm_owned_publication_end();
    }
}
int _wpk_wl_log_defer(struct wpk_wl_log_scope *scope) {
    if(!scope||!_wpk_drm_actor_prepare())return 0;
    _wpk_drm_owned_publication_begin();
    if(scope->capturing){_wpk_drm_owned_publication_end();return 0;}
    if(!scope->messages){
        _wpk_drm_actor_release_locked(&scope->origin_claim);
        _wpk_drm_owned_publication_end();return 1;
    }
    for(struct wpk_wl_log_message *p=scope->messages;p;p=p->next)
        if(_wpk_drm_actor_claim_live_locked(&p->callback_claim)){
            _wpk_drm_owned_publication_end();return 0;
        }
    struct wpk_wl_deferred_log *owner=calloc(1,sizeof *owner);
    if(owner){
        /* WHY: source scopes can be embedded in native shells about to free.
         * Move identity and messages to a real independent heap owner before
         * clearing those source slots; a queued borrowed pointer is not custody. */
        owner->logs.messages=scope->messages;owner->logs.tail=scope->tail;
        owner->logs.origin_claim=scope->origin_claim;
        scope->messages=scope->tail=NULL;scope->origin_claim.scope=NULL;
        /* Separate handoffs from the same origin retain emission order too. */
        if(wpk_wl_deferred_tail)wpk_wl_deferred_tail->next=owner;else wpk_wl_deferred_logs=owner;
        wpk_wl_deferred_tail=owner;
    }
    _wpk_drm_owned_publication_end();
    if(!owner)wpk_wl_log_bookkeeping_failed();
    if(_wpk_egl_request_native_drain)_wpk_egl_request_native_drain();
    return 1;
}
int _wpk_wl_log_drain_deferred(void) {
    if(!_wpk_drm_actor_prepare())return 0;
    uint64_t visit=_wpk_owned_resource_nonce();if(!visit)return 0;
    size_t budget=0;int live_origin=0;
    _wpk_drm_owned_publication_begin();
    for(struct wpk_wl_deferred_log *p=wpk_wl_deferred_logs;p;p=p->next)budget++;
    _wpk_drm_owned_publication_end();
    while(budget--){
        struct wpk_wl_deferred_log *owner=NULL;
        _wpk_drm_owned_publication_begin();
        for(struct wpk_wl_deferred_log *p=wpk_wl_deferred_logs;p;p=p->next){
            if(p->visit==visit)continue;
            if(_wpk_drm_actor_claim_live_locked(&p->logs.origin_claim)&&
               !_wpk_drm_actor_claim_current_locked(&p->logs.origin_claim)){
                live_origin=1;continue;
            }
            if(!_wpk_drm_actor_try_claim_locked(&p->drain_claim)){live_origin=1;continue;}
            owner=p;p->visit=visit;break;
        }
        _wpk_drm_owned_publication_end();if(!owner)break;
        int complete=_wpk_wl_log_deliver(&owner->logs);
        _wpk_drm_owned_publication_begin();
        _wpk_drm_actor_release_locked(&owner->drain_claim);
        if(complete){
            struct wpk_wl_deferred_log **link=&wpk_wl_deferred_logs;
            while(*link&&*link!=owner)link=&(*link)->next;
            if(!*link)abort();*link=owner->next;
            if(wpk_wl_deferred_tail==owner){
                wpk_wl_deferred_tail=wpk_wl_deferred_logs;
                while(wpk_wl_deferred_tail&&wpk_wl_deferred_tail->next)
                    wpk_wl_deferred_tail=wpk_wl_deferred_tail->next;
            }
            free(owner);
        }
        _wpk_drm_owned_publication_end();
    }
    /* A nested handler may have completed an earlier busy node. Report the
     * current live-peer obligation, not a stale observation from selection. */
    _wpk_drm_owned_publication_begin();live_origin=0;
    for(struct wpk_wl_deferred_log *p=wpk_wl_deferred_logs;p;p=p->next)
        if(_wpk_drm_actor_claim_live_locked(&p->logs.origin_claim)&&
           !_wpk_drm_actor_claim_current_locked(&p->logs.origin_claim)){live_origin=1;break;}
    _wpk_drm_owned_publication_end();return live_origin;
}
void _wpk_wl_logv(const char *fmt,va_list args) {
    struct wpk_wl_log_scope *scope=wpk_wl_capture;
    if(!scope){
        /* WHY: only an actual log asks for owned error-path capture. Ordinary
         * successful frames do not prepare scopes, scan windows or touch TLS.
         * The internal resolver returns a caller-rooted current operation. */
        wpk_wl_log_resolver resolver=atomic_load_explicit(&wpk_wl_resolver,memory_order_acquire);
        if(resolver){
            scope=resolver();
            if(scope==wpk_wl_suppressed_scope)scope=NULL;
            if(scope&&!_wpk_wl_log_capture_begin(scope))wpk_wl_log_bookkeeping_failed();
        }
    }
    if(!scope){wl_log_handler(fmt,args);return;}
    int saved_errno=errno;
    _wpk_drm_owned_publication_begin();
    struct wpk_wl_log_message *message=calloc(1,sizeof *message);
    if(message){
        if(!scope->origin_claim.scope)
            if(!_wpk_drm_actor_try_claim_locked(&scope->origin_claim))abort();
        message->handler=wl_log_handler;
        if(scope->tail)scope->tail->next=message;else scope->messages=message;
        scope->tail=message;
    }
    _wpk_drm_owned_publication_end();
    if(!message)wpk_wl_log_bookkeeping_failed();
    va_list measure;va_copy(measure,args);errno=saved_errno;
    int length=vsnprintf(NULL,0,fmt,measure);va_end(measure);
    if(length<0 || (size_t)length==SIZE_MAX)wpk_wl_log_bookkeeping_failed();
    _wpk_drm_owned_publication_begin();
    message->text=malloc((size_t)length+1);
    _wpk_drm_owned_publication_end();
    if(!message->text)wpk_wl_log_bookkeeping_failed();
    errno=saved_errno;
    if(vsnprintf(message->text,(size_t)length+1,fmt,args)!=length)
        wpk_wl_log_bookkeeping_failed();
    errno=saved_errno;
}
void wl_log(const char *fmt,...) {
    va_list args;va_start(args,fmt);_wpk_wl_logv(fmt,args);va_end(args);
}
