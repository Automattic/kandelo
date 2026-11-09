/* Appended to the exact client TU after native lifetime types. Cold raw
 * constructors and actual ordinary logs retain ownership across handler exit.
 * User-listener tails are the separate callback adapter stage. */
struct wpk_wl_raw_retirement {
    struct wpk_wl_raw_retirement *next;
    struct wpk_wl_raw_entry *entry;
    struct wpk_drm_actor_claim actor;
    struct wpk_wl_boundary_hold boundary;
    struct wpk_wl_log_scope logs;
    struct wpk_wl_display_retirement connection;
    struct wpk_wl_proxy_retirement proxy;
    struct wpk_wl_connection *public_connection;
    struct wpk_wl_display_retirement public_retirement;
    uint64_t native_epoch,visit,entry_nonce;
    int native_returned,abandoned;
};
static struct wpk_wl_raw_retirement *wpk_wl_raw_retirements,*wpk_wl_raw_tail,*wpk_wl_raw_pool;
static unsigned wpk_wl_raw_pool_count;
static _Atomic int wpk_wl_raw_has_work;
static void wpk_wl_raw_work_refresh_locked(void){
    atomic_store_explicit(&wpk_wl_raw_has_work,wpk_wl_raw_retirements!=NULL||wpk_wl_callbacks_present_locked(),memory_order_release);
}
static _Noreturn void wpk_wl_raw_bookkeeping_failed(void){
    static const char message[]="Kandelo Wayland: durable raw native custody failed\n";
    (void)write(STDERR_FILENO,message,sizeof message-1);abort();
}
static struct wpk_wl_raw_retirement *wpk_wl_raw_new(struct wpk_wl_raw_entry *entry){
    if(!_wpk_drm_actor_prepare())return NULL;
    if(!entry->custody_nonce){entry->custody_nonce=_wpk_owned_resource_nonce();if(!entry->custody_nonce)return NULL;}
    _wpk_drm_owned_publication_begin();
    struct wpk_wl_raw_retirement *node=wpk_wl_raw_pool;
    if(node){wpk_wl_raw_pool=node->next;--wpk_wl_raw_pool_count;memset(node,0,sizeof *node);}
    else node=calloc(1,sizeof *node);
    if(node){
        node->entry=entry;node->entry_nonce=entry->custody_nonce;node->native_epoch=_wpk_drm_native_fork_epoch();node->boundary.owner=node;
        if(!_wpk_drm_actor_try_claim_locked(&node->actor))abort();
        /* Native callers may hold display->mutex here. Pure publication avoids
         * inverting the native display and platform record mutex order. All
         * users checks/increments are serialized by this same guard. */
        struct wpk_wl_connection *record=entry->display?wpk_wl_find(entry->display):NULL;
        if(record){
            if(record->users==UINT_MAX)abort();++record->users;node->connection.live=record;
        }
        if(wpk_wl_raw_tail)wpk_wl_raw_tail->next=node;else wpk_wl_raw_retirements=node;
        wpk_wl_raw_tail=node;atomic_store_explicit(&wpk_wl_raw_has_work,1,memory_order_release);
    }
    _wpk_drm_owned_publication_end();return node;
}
static void wpk_wl_raw_entry_begin(struct wpk_wl_raw_entry *entry,void *display){
    *entry=(struct wpk_wl_raw_entry){.previous=wpk_wl_raw_current_entry,.display=display};
    wpk_wl_raw_current_entry=entry;
}
void *_wpk_wl_raw_entry_suspend(void){
    struct wpk_wl_raw_entry *entry=wpk_wl_raw_current_entry;wpk_wl_raw_current_entry=NULL;return entry;
}
void _wpk_wl_raw_entry_resume(void *entry){
    if(wpk_wl_raw_current_entry)abort();wpk_wl_raw_current_entry=entry;
}
struct wpk_wl_log_scope *_wpk_wl_raw_log_scope(void){
    struct wpk_wl_raw_entry *entry=wpk_wl_raw_current_entry;if(!entry)return NULL;
    if(!entry->diagnostic)entry->diagnostic=wpk_wl_raw_new(entry);
    if(!entry->diagnostic)wpk_wl_raw_bookkeeping_failed();
    return &entry->diagnostic->logs;
}
static void wpk_wl_raw_unlink_locked(struct wpk_wl_raw_retirement *node){
    struct wpk_wl_raw_retirement **link=&wpk_wl_raw_retirements;
    while(*link&&*link!=node)link=&(*link)->next;
    if(!*link)abort();*link=node->next;
    if(wpk_wl_raw_tail==node){
        wpk_wl_raw_tail=wpk_wl_raw_retirements;
        while(wpk_wl_raw_tail&&wpk_wl_raw_tail->next)wpk_wl_raw_tail=wpk_wl_raw_tail->next;
    }
    wpk_wl_raw_work_refresh_locked();
}
static void wpk_wl_raw_entry_abandon(void *opaque){
    struct wpk_wl_raw_entry *entry=opaque;
    _wpk_drm_owned_publication_begin();int work=0;
    for(struct wpk_wl_raw_retirement *p=wpk_wl_raw_retirements;p;p=p->next)
        if(p->entry==entry&&p->entry_nonce==entry->custody_nonce&&_wpk_drm_actor_claim_current_locked(&p->actor)){p->abandoned=1;work=1;}
    work|=wpk_wl_callbacks_abandon_locked(entry);
    _wpk_drm_owned_publication_end();
    /* pthread cleanup does metadata/ready publication only. Actual native
     * cleanup waits for the real ActorScope to end, never a synthetic death. */
    if(work&&_wpk_egl_request_native_drain)_wpk_egl_request_native_drain();
}
static int wpk_wl_raw_boundary(struct wpk_wl_raw_retirement *node){
    if(node->native_epoch==_wpk_drm_native_fork_epoch())return 0;
    if(node->connection.live)_wpk_wl_display_transfer_boundary(node->connection.live);
    if(node->connection.retired)_wpk_wl_display_transfer_boundary(node->connection.retired);
    if(node->public_connection)_wpk_wl_display_transfer_boundary(node->public_connection);
    if(node->public_retirement.retired)_wpk_wl_display_transfer_boundary(node->public_retirement.retired);
    _wpk_drm_owned_publication_begin();
    _wpk_wl_boundary_transfer_locked(&node->boundary);wpk_wl_raw_unlink_locked(node);
    _wpk_drm_actor_release_locked(&node->actor);_wpk_drm_owned_publication_end();errno=ECHILD;return 1;
}
static int wpk_wl_raw_finish(struct wpk_wl_raw_retirement *node,int returning){
    if(wpk_wl_raw_boundary(node))return 2;
    _wpk_drm_owned_publication_begin();
    int ended_capture=_wpk_wl_log_capture_abandon_locked(&node->logs);
    _wpk_drm_owned_publication_end();if(!ended_capture)goto pending;
    if(!_wpk_wl_log_deliver(&node->logs))goto pending;
    /* Every callback can fork and return into this continuation. Reclassify
     * before each next native leaf, never cache pre-callback provenance. */
    if(wpk_wl_raw_boundary(node))return 2;
    int invalid_proxy=0;
    if(returning&&node->proxy.live&&node->connection.live){
        _wpk_drm_owned_publication_begin();invalid_proxy=!((struct wpk_wl_connection*)node->connection.live)->alive;
        _wpk_drm_owned_publication_end();
    }
    if(!returning||invalid_proxy){
        if(node->proxy.live||node->proxy.logs.messages){
            if(_wpk_wl_proxy_destroy_local_pending(&node->proxy)!=WPK_WL_RETIRE_COMPLETE)goto pending;
        }
        if(wpk_wl_raw_boundary(node))return 2;
        if(node->public_connection){
            _wpk_drm_mutex_lock(&wpk_wl_mutex);_wpk_drm_owned_publication_begin();
            struct wpk_wl_connection *record=node->public_connection;
            node->public_connection=NULL;
            int shutdown_needed=record->alive&&record->users&&record->process_epoch==_wpk_drm_process_generation();
            record->alive=0;
            /* Consume the exact public-record authority together with real
             * withdrawal. Never replay a void disconnect by an address which
             * a callback could recycle into a different connection. */
            if(wpk_wl_collect(record))node->public_retirement.retired=record;
            _wpk_drm_owned_publication_end();
            if(shutdown_needed)shutdown(record->display->fd,SHUT_RDWR);
            _wpk_drm_mutex_unlock(&wpk_wl_mutex);
        }
        if(_wpk_wl_display_release_pending(&node->public_retirement)==WPK_WL_RETIRE_PENDING)goto pending;
        if(wpk_wl_raw_boundary(node))return 2;
    }
    if(_wpk_wl_display_release_pending(&node->connection)==WPK_WL_RETIRE_PENDING)goto pending;
    if(wpk_wl_raw_boundary(node))return 2;
    _wpk_drm_owned_publication_begin();
    if(returning){node->proxy.live=NULL;node->public_connection=NULL;}
    if(node->proxy.live||node->proxy.logs.messages||node->connection.live||node->connection.retired||node->public_retirement.retired)abort();
    wpk_wl_raw_unlink_locked(node);_wpk_drm_actor_release_locked(&node->actor);
    if(wpk_wl_raw_pool_count<8){memset(node,0,sizeof *node);node->next=wpk_wl_raw_pool;wpk_wl_raw_pool=node;++wpk_wl_raw_pool_count;}
    else free(node);
    _wpk_drm_owned_publication_end();if(invalid_proxy)errno=EPIPE;return invalid_proxy?3:1;
pending:
    if(!returning){_wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&node->actor);_wpk_drm_owned_publication_end();}
    return 0;
}
static int wpk_wl_raw_entry_end(struct wpk_wl_raw_entry *entry,void *result,enum wpk_wl_raw_result kind){
    /* Actual incoming closure destruction can close undelivered native FDs.
     * Restore cancellation only now, after native mutex unlock and while
     * its independently rooted continuation still owns every sealed result. */
    if(entry->cancel_suspended){
        entry->cancel_suspended=0;pthread_setcancelstate(entry->cancel_prior,NULL);
        if(entry->cancel_prior==PTHREAD_CANCEL_ENABLE)pthread_testcancel();
    }
    if(entry->callback_roots&&!wpk_wl_callbacks_finish_entry(entry)){
        wpk_wl_raw_entry_abandon(entry);
        if(wpk_wl_raw_current_entry!=entry)abort();wpk_wl_raw_current_entry=entry->previous;return 0;
    }
    struct wpk_wl_raw_retirement *node=entry->diagnostic;
    if(node){
        _wpk_drm_owned_publication_begin();
        node->native_returned=1;
        if(kind==WPK_RAW_PROXY)node->proxy.live=result;
        if(kind==WPK_RAW_DISPLAY&&result){node->public_connection=wpk_wl_find(result);if(!node->public_connection)abort();}
        if(node->logs.capturing)_wpk_wl_log_capture_end_locked(&node->logs);
        _wpk_drm_owned_publication_end();
        int complete=wpk_wl_raw_finish(node,1);
        if(!complete){
            /* Only another continuing same-thread callback can defer this
             * token; no native result is returned without a rooted owner. */
            _wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&node->actor);_wpk_drm_owned_publication_end();
        }
        entry->diagnostic=NULL;
        if(wpk_wl_raw_current_entry!=entry)abort();wpk_wl_raw_current_entry=entry->previous;
        return complete==1;
    }
    if(wpk_wl_raw_current_entry!=entry)abort();wpk_wl_raw_current_entry=entry->previous;return 1;
}
static int wpk_wl_raw_drain(void){
    if(!atomic_load_explicit(&wpk_wl_raw_has_work,memory_order_acquire))return 0;
    if(!_wpk_drm_actor_prepare())return 0;
    int cancel;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel);
    uint64_t visit=_wpk_owned_resource_nonce();if(!visit){pthread_setcancelstate(cancel,NULL);return 0;}
    int callback_live=wpk_wl_callbacks_drain();
    size_t budget=0;_wpk_drm_owned_publication_begin();
    for(struct wpk_wl_raw_retirement *p=wpk_wl_raw_retirements;p;p=p->next)budget++;
    _wpk_drm_owned_publication_end();
    while(budget--){
        struct wpk_wl_raw_retirement *node=NULL;
        _wpk_drm_owned_publication_begin();
        for(struct wpk_wl_raw_retirement *p=wpk_wl_raw_retirements;p;p=p->next){
            if(p->visit==visit||!_wpk_drm_actor_try_claim_locked(&p->actor))continue;
            p->visit=visit;node=p;break;
        }
        _wpk_drm_owned_publication_end();if(!node)break;
        (void)wpk_wl_raw_finish(node,0);
    }
    int live=callback_live;_wpk_drm_owned_publication_begin();
    for(struct wpk_wl_raw_retirement *p=wpk_wl_raw_retirements;p;p=p->next)
        if(p->abandoned&&(_wpk_drm_actor_claim_live_locked(&p->actor)||
                (_wpk_drm_actor_claim_live_locked(&p->logs.origin_claim)&&!_wpk_drm_actor_claim_current_locked(&p->logs.origin_claim)))){live=1;break;}
    _wpk_drm_owned_publication_end();pthread_setcancelstate(cancel,NULL);return live;
}
int _wpk_wl_raw_drain_deferred(void){return wpk_wl_raw_drain();}
