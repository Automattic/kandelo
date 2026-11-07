/* Actual client listener continuations. Native built-in listeners remain
 * native code under raw log capture; only application callbacks suspend it. */
#include <ffi.h>
struct wpk_wl_callback_retirement {
    struct wpk_wl_callback_retirement *next;
    struct wpk_wl_raw_entry *entry;
    struct wpk_drm_actor_claim actor;
    struct wpk_wl_boundary_hold boundary;
    struct wpk_wl_display_retirement connection;
    struct wl_closure *closure;
    struct wl_proxy *references[WL_CLOSURE_MAX_ARGS+1];
    uint32_t reference_slots,descriptor_slots;
    unsigned argument_count;
    uint64_t native_epoch,visit,entry_nonce;
    int delivered,abandoned;
};
static struct wpk_wl_callback_retirement *wpk_wl_callbacks,*wpk_wl_callback_tail,*wpk_wl_callback_pool;
static unsigned wpk_wl_callback_pool_count;
static _Thread_local struct wl_closure *wpk_wl_private_closure;
static void wpk_wl_callback_unlink_locked(struct wpk_wl_callback_retirement *);
static int wpk_wl_callbacks_present_locked(void){return wpk_wl_callbacks!=NULL;}
static void wpk_wl_callback_cache_locked(struct wpk_wl_callback_retirement *node){
    if(node->closure||node->connection.live||node->connection.retired)abort();
    if(wpk_wl_raw_current_entry&&node->entry==wpk_wl_raw_current_entry&&node->entry_nonce==wpk_wl_raw_current_entry->custody_nonce){
        if(!wpk_wl_raw_current_entry->callback_roots)abort();--wpk_wl_raw_current_entry->callback_roots;
    }
    wpk_wl_callback_unlink_locked(node);_wpk_drm_actor_release_locked(&node->actor);
    if(wpk_wl_callback_pool_count<8){memset(node,0,sizeof *node);node->next=wpk_wl_callback_pool;wpk_wl_callback_pool=node;++wpk_wl_callback_pool_count;}
    else free(node);
}
static _Thread_local struct wpk_wl_callback_retirement *wpk_wl_current_callback,*wpk_wl_current_tail;
static struct wpk_wl_callback_retirement *wpk_wl_callback_new(struct wl_closure *closure,struct wl_display *display){
    if(!wpk_wl_raw_current_entry||!_wpk_drm_actor_prepare())wpk_wl_raw_bookkeeping_failed();
    /* One entry owner retains native display storage until its frame returns.
     * Fully retired per-event tails can then recycle immediately, so a large
     * event batch does not become an unbounded per-message ownership ledger. */
    if(!wpk_wl_raw_current_entry->diagnostic){
        wpk_wl_raw_current_entry->diagnostic=wpk_wl_raw_new(wpk_wl_raw_current_entry);
        if(!wpk_wl_raw_current_entry->diagnostic)wpk_wl_raw_bookkeeping_failed();
    }
    _wpk_drm_owned_publication_begin();
    struct wpk_wl_callback_retirement *node=wpk_wl_callback_pool;
    if(node){wpk_wl_callback_pool=node->next;--wpk_wl_callback_pool_count;memset(node,0,sizeof *node);}
    else node=calloc(1,sizeof *node);
    if(node){
        node->entry=wpk_wl_raw_current_entry;node->entry_nonce=wpk_wl_raw_current_entry->custody_nonce;
        ++wpk_wl_raw_current_entry->callback_roots;node->closure=closure;
        node->argument_count=(unsigned)closure->count;if(node->argument_count>WL_CLOSURE_MAX_ARGS)abort();
        const char *signature=closure->message->signature;
        for(unsigned i=0;i<node->argument_count;i++){
            struct argument_details argument;signature=get_next_argument(signature,&argument);
            if(argument.type==WL_ARG_OBJECT||argument.type==WL_ARG_NEW_ID){
                node->reference_slots|=1u<<i;node->references[i]=(void*)closure->args[i].o;
            }else if(argument.type==WL_ARG_FD)node->descriptor_slots|=1u<<i;
        }
        node->references[WL_CLOSURE_MAX_ARGS]=closure->proxy;
        node->native_epoch=_wpk_drm_native_fork_epoch();node->boundary.owner=node;
        struct wpk_wl_connection *record=wpk_wl_find(display);
        if(!record||record->users==UINT_MAX||!_wpk_drm_actor_try_claim_locked(&node->actor))abort();
        ++record->users;node->connection.live=record;
        if(wpk_wl_callback_tail)wpk_wl_callback_tail->next=node;else wpk_wl_callbacks=node;
        wpk_wl_callback_tail=node;
    }
    _wpk_drm_owned_publication_end();if(!node)wpk_wl_raw_bookkeeping_failed();return node;
}
static int wpk_wl_callbacks_abandon_locked(struct wpk_wl_raw_entry *entry){
    int work=0;
    for(struct wpk_wl_callback_retirement *p=wpk_wl_callbacks;p;p=p->next)
        if(p->entry==entry&&p->entry_nonce==entry->custody_nonce&&_wpk_drm_actor_claim_current_locked(&p->actor)){p->abandoned=1;work=1;}
    return work;
}
static _Noreturn void wpk_wl_callback_forbidden_return(void){
    static const char text[]="Kandelo Wayland: returning into inherited client callback frame after multithreaded fork is forbidden (D-59)\n";
    (void)write(STDERR_FILENO,text,sizeof text-1);_Exit(125);
}
void _wpk_wl_client_ffi_call(ffi_cif *cif,void (*function)(void),void *result,void **arguments){
    struct wpk_wl_callback_retirement *node=wpk_wl_current_callback;
    if(!node){ffi_call(cif,function,result,arguments);return;}
    uint64_t epoch=node->native_epoch;
    /* A previous event tail in this batch masked its native FD close/free.
     * We are now outside the display mutex with this next closure rooted:
     * preserve the caller's mask for the actual user callback. */
    if(wpk_wl_raw_current_entry&&wpk_wl_raw_current_entry->cancel_suspended){
        struct wpk_wl_raw_entry *outer=wpk_wl_raw_current_entry;outer->cancel_suspended=0;
        pthread_setcancelstate(outer->cancel_prior,NULL);
        /* Enabling deferred cancellation is not itself a required cancel
         * point. Honor a queued request before committing FD delivery. */
        if(outer->cancel_prior==PTHREAD_CANCEL_ENABLE)pthread_testcancel();
    }
    void *entry=_wpk_wl_raw_entry_suspend();
    struct wpk_wl_log_scope *capture=_wpk_wl_log_capture_suspend();wpk_wl_current_callback=NULL;wpk_wl_current_tail=NULL;
    /* WHY: FD authority transfers before user code. Normal upstream return
     * clears slots itself; ended-callback adoption clears delivered slots
     * before tail destruction and never closes a raw delivered number. */
    _wpk_drm_owned_publication_begin();node->delivered=1;_wpk_drm_owned_publication_end();
    if(epoch!=_wpk_drm_native_fork_epoch())wpk_wl_callback_forbidden_return();
    ffi_call(cif,function,result,arguments);
    if(epoch!=_wpk_drm_native_fork_epoch())wpk_wl_callback_forbidden_return();
    wpk_wl_current_callback=node;wpk_wl_current_tail=node;_wpk_wl_log_capture_resume(capture);_wpk_wl_raw_entry_resume(entry);
}
int _wpk_wl_client_dispatcher_call(wl_dispatcher_func_t function,const void *implementation,void *target,uint32_t opcode,const struct wl_message *message,union wl_argument *arguments){
    struct wpk_wl_callback_retirement *node=wpk_wl_current_callback;
    if(!node)return function(implementation,target,opcode,message,arguments);
    uint64_t epoch=node->native_epoch;
    /* A previous event tail in this batch masked its native FD close/free.
     * We are now outside the display mutex with this next closure rooted:
     * preserve the caller's mask for the actual user callback. */
    if(wpk_wl_raw_current_entry&&wpk_wl_raw_current_entry->cancel_suspended){
        struct wpk_wl_raw_entry *outer=wpk_wl_raw_current_entry;outer->cancel_suspended=0;
        pthread_setcancelstate(outer->cancel_prior,NULL);
        /* Enabling deferred cancellation is not itself a required cancel
         * point. Honor a queued request before committing FD delivery. */
        if(outer->cancel_prior==PTHREAD_CANCEL_ENABLE)pthread_testcancel();
    }
    void *entry=_wpk_wl_raw_entry_suspend();
    struct wpk_wl_log_scope *capture=_wpk_wl_log_capture_suspend();wpk_wl_current_callback=NULL;wpk_wl_current_tail=NULL;
    _wpk_drm_owned_publication_begin();node->delivered=1;_wpk_drm_owned_publication_end();
    if(epoch!=_wpk_drm_native_fork_epoch())wpk_wl_callback_forbidden_return();
    int result=function(implementation,target,opcode,message,arguments);
    if(epoch!=_wpk_drm_native_fork_epoch())wpk_wl_callback_forbidden_return();
    wpk_wl_current_callback=node;wpk_wl_current_tail=node;_wpk_wl_log_capture_resume(capture);_wpk_wl_raw_entry_resume(entry);return result;
}
static int wpk_wl_callback_builtin(struct wl_object *target){
    /* display_handle_error logs before committing native protocol_error.
     * Deferring that log under its raw native entry lets it actually finish;
     * treating this native function as user code would expose the old gap. */
    return target->implementation==(void(**)(void))&display_listener||target->implementation==(void(**)(void))&sync_listener;
}
/* These two adapter booleans are compile constants at the exact pinned
 * call sites. All other list/count calls remain original calls after inline
 * folding; no queue scan or allocation is added to ordinary frame/draw work. */
static __attribute__((always_inline)) inline void wpk_wl_raw_list_remove(struct wl_list *link,int dispatch_event){
    if(dispatch_event){
        struct wl_closure *closure=wl_container_of(link,closure,link);
        if(wpk_wl_current_tail||wpk_wl_private_closure)abort();
        /* Pinned dispatch_event always removes its first queued event while
         * holding display->mutex: that element's prev is exactly the native
         * queue head. Never apply this derivation to generic list operations. */
        struct wl_event_queue *queue=wl_container_of(link->prev,queue,event_list);
        if(wpk_wl_private_queue_current(queue,closure->proxy->display))wpk_wl_private_closure=closure;
        else wpk_wl_current_tail=wpk_wl_callback_new(closure,closure->proxy->display);
    }
    wl_list_remove(link);
}
static __attribute__((always_inline)) inline int wpk_wl_raw_arg_count(const char *signature,int retire_tail){
    if(retire_tail&&wpk_wl_current_tail){
        struct wpk_wl_callback_retirement *node=wpk_wl_current_tail;
        _wpk_drm_owned_publication_begin();
        if(!node->closure||!_wpk_drm_actor_claim_current_locked(&node->actor))abort();
        /* WHY: validate_closure_objects normalizes destroyed arguments toNULL,
         * and a language dispatcher can edit its argument array. Neither
         * change transfers the original <=21 native retained references.
         * Restore aliases only for the actual upstream unref tail, after the
         * callback has observed/modified the ordinary native arguments. */
        for(unsigned i=0;i<node->argument_count;i++)
            if(node->reference_slots&(1u<<i))node->closure->args[i].o=(void*)node->references[i];
        node->closure->proxy=node->references[WL_CLOSURE_MAX_ARGS];
        _wpk_drm_owned_publication_end();
    }
    return arg_count_for_signature(signature);
}
static void wpk_wl_raw_closure_invoke(struct wl_closure *closure,uint32_t flags,struct wl_object *target,uint32_t opcode,void *data){
    if(closure==wpk_wl_private_closure||!(flags&WL_CLOSURE_INVOKE_CLIENT)||wpk_wl_callback_builtin(target)){
        wl_closure_invoke(closure,flags,target,opcode,data);return;
    }
    struct wpk_wl_callback_retirement *node=wpk_wl_current_tail,*prior=wpk_wl_current_callback;
    if(!node||node->closure!=closure)abort();wpk_wl_current_callback=node;
    wl_closure_invoke(closure,flags,target,opcode,data);wpk_wl_current_callback=prior;
}
static void wpk_wl_raw_closure_dispatch(struct wl_closure *closure,wl_dispatcher_func_t dispatcher,struct wl_object *target,uint32_t opcode){
    if(closure==wpk_wl_private_closure){wl_closure_dispatch(closure,dispatcher,target,opcode);return;}
    struct wpk_wl_callback_retirement *node=wpk_wl_current_tail,*prior=wpk_wl_current_callback;
    if(!node||node->closure!=closure)abort();wpk_wl_current_callback=node;
    wl_closure_dispatch(closure,dispatcher,target,opcode);wpk_wl_current_callback=prior;
}
static void wpk_wl_raw_closure_destroy(struct wl_closure *closure){
    struct wpk_wl_callback_retirement *node=wpk_wl_current_tail;
    if(!node){
        wl_closure_destroy(closure);if(wpk_wl_private_closure==closure)wpk_wl_private_closure=NULL;return;
    }
    _wpk_drm_owned_publication_begin();
    if(node->closure!=closure||!_wpk_drm_actor_claim_current_locked(&node->actor))abort();
    _wpk_drm_owned_publication_end();
    /* WHY: only a real undelivered FD close is a deferred cancellation
     * point here. Plain allocator free plus slot seal is not one, so FD-free
     * and already-delivered native tails need no cancellation mask or test. */
    int closes_descriptor=0;
    for(unsigned i=0;i<node->argument_count;i++)
        if((node->descriptor_slots&(1u<<i))&&closure->args[i].h>=0){closes_descriptor=1;break;}
    if(closes_descriptor&&wpk_wl_raw_current_entry&&!wpk_wl_raw_current_entry->cancel_suspended){
        pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&wpk_wl_raw_current_entry->cancel_prior);
        wpk_wl_raw_current_entry->cancel_suspended=1;
    }
    wl_closure_destroy(closure);
    _wpk_drm_owned_publication_begin();node->closure=NULL;node->reference_slots=node->descriptor_slots=0;node->argument_count=0;
    memset(node->references,0,sizeof node->references);wpk_wl_current_tail=NULL;
    if(wpk_wl_raw_current_entry&&node->entry==wpk_wl_raw_current_entry&&node->entry_nonce==wpk_wl_raw_current_entry->custody_nonce){
        struct wpk_wl_raw_retirement *owner=wpk_wl_raw_current_entry->diagnostic;
        struct wpk_wl_connection *record=node->connection.live;
        if(!owner||owner->connection.live!=record||!record||record->users<2||node->connection.retired)abort();
        /* The independent entry edge provably prevents final disconnect here.
         * Consume only this exact completed tail edge under pub; native final
         * release happens after entry unlock, or through full cold adoption. */
        --record->users;node->connection.live=NULL;wpk_wl_callback_cache_locked(node);
    }
    _wpk_drm_owned_publication_end();
}
static void wpk_wl_callback_unlink_locked(struct wpk_wl_callback_retirement *node){
    struct wpk_wl_callback_retirement **link=&wpk_wl_callbacks;
    while(*link&&*link!=node)link=&(*link)->next;
    if(!*link)abort();*link=node->next;
    if(wpk_wl_callback_tail==node){
        wpk_wl_callback_tail=wpk_wl_callbacks;
        while(wpk_wl_callback_tail&&wpk_wl_callback_tail->next)wpk_wl_callback_tail=wpk_wl_callback_tail->next;
    }
    wpk_wl_raw_work_refresh_locked();
}
static int wpk_wl_callback_boundary(struct wpk_wl_callback_retirement *node){
    if(node->native_epoch==_wpk_drm_native_fork_epoch())return 0;
    if(node->connection.live)_wpk_wl_display_transfer_boundary(node->connection.live);
    if(node->connection.retired)_wpk_wl_display_transfer_boundary(node->connection.retired);
    _wpk_drm_owned_publication_begin();_wpk_wl_boundary_transfer_locked(&node->boundary);
    wpk_wl_callback_unlink_locked(node);_wpk_drm_actor_release_locked(&node->actor);
    _wpk_drm_owned_publication_end();return 1;
}
static int wpk_wl_callback_finish(struct wpk_wl_callback_retirement *node){
    if(wpk_wl_callback_boundary(node))return 1;
    if(node->closure){
        struct wpk_wl_connection *record=node->connection.live;if(!record)abort();
        pthread_mutex_lock(&record->display->mutex);
        if(node->delivered){
            _wpk_drm_owned_publication_begin();
            const char *signature=node->closure->message->signature;
            for(int i=0;i<node->closure->count;i++){
                struct argument_details argument;signature=get_next_argument(signature,&argument);
                if(argument.type==WL_ARG_FD)node->closure->args[i].h=-1;
            }
            _wpk_drm_owned_publication_end();
        }
        /* Actual static upstream tail retires its retained proxy/object refs
         * and closure storage, while the independent connection edge keeps
         * display storage valid through unlock and any final disconnect log. */
        if(wpk_wl_current_tail)abort();wpk_wl_current_tail=node;
        destroy_queued_closure(node->closure);pthread_mutex_unlock(&record->display->mutex);
    }
    enum wpk_wl_retire_result result=_wpk_wl_display_release_pending(&node->connection);
    if(result==WPK_WL_RETIRE_PENDING){
        _wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&node->actor);_wpk_drm_owned_publication_end();return 0;
    }
    if(wpk_wl_callback_boundary(node))return 1;
    _wpk_drm_owned_publication_begin();
    wpk_wl_callback_cache_locked(node);
    _wpk_drm_owned_publication_end();return 1;
}
static int wpk_wl_callbacks_finish_entry(struct wpk_wl_raw_entry *entry){
    for(;;){
        _wpk_drm_owned_publication_begin();struct wpk_wl_callback_retirement *node=NULL;
        for(struct wpk_wl_callback_retirement *p=wpk_wl_callbacks;p;p=p->next)
            if(p->entry==entry&&p->entry_nonce==entry->custody_nonce&&_wpk_drm_actor_claim_current_locked(&p->actor)){node=p;break;}
        _wpk_drm_owned_publication_end();if(!node)return 1;
        if(node->closure)abort();if(!wpk_wl_callback_finish(node))return 0;
    }
}
static int wpk_wl_callbacks_drain(void){
    uint64_t visit=_wpk_owned_resource_nonce();if(!visit)return 0;
    size_t budget=0;_wpk_drm_owned_publication_begin();
    for(struct wpk_wl_callback_retirement *p=wpk_wl_callbacks;p;p=p->next)budget++;
    _wpk_drm_owned_publication_end();
    while(budget--){
        _wpk_drm_owned_publication_begin();struct wpk_wl_callback_retirement *node=NULL;
        for(struct wpk_wl_callback_retirement *p=wpk_wl_callbacks;p;p=p->next)
            if(p->visit!=visit&&_wpk_drm_actor_try_claim_locked(&p->actor)){p->visit=visit;node=p;break;}
        _wpk_drm_owned_publication_end();if(!node)break;
        (void)wpk_wl_callback_finish(node);
    }
    int live=0;_wpk_drm_owned_publication_begin();
    for(struct wpk_wl_callback_retirement *p=wpk_wl_callbacks;p;p=p->next)
        if(p->abandoned&&_wpk_drm_actor_claim_live_locked(&p->actor)){live=1;break;}
    _wpk_drm_owned_publication_end();return live;
}
