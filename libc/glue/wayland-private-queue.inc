/* Client-TU metadata only; source-audited hidden wlegl queues register cold.
 * This registry is not a pointer/epoch allowlist for arbitrary public queues. */
static struct wpk_wl_private_queue_token *wpk_wl_private_queues[32];
static unsigned wpk_wl_private_bucket(const void *queue){uintptr_t value=(uintptr_t)queue;return (unsigned)((value>>4)^(value>>11))&31;}
void _wpk_wl_private_queue_withdraw_locked(struct wpk_wl_private_queue_token *token){
    if(!token||!token->active)return;
    struct wpk_wl_private_queue_token **link=&wpk_wl_private_queues[wpk_wl_private_bucket(token->queue)];
    while(*link&&*link!=token)link=&(*link)->next;
    if(!*link)abort();*link=token->next;
    memset(token,0,sizeof *token);
}
void _wpk_wl_private_queue_withdraw(struct wpk_wl_private_queue_token *token){
    _wpk_drm_owned_publication_begin();_wpk_wl_private_queue_withdraw_locked(token);_wpk_drm_owned_publication_end();
}
static void wpk_wl_private_queue_forget(void *queue){
    _wpk_drm_owned_publication_begin();
    unsigned bucket=wpk_wl_private_bucket(queue);
    for(;;){
        struct wpk_wl_private_queue_token *chosen=NULL;
        for(struct wpk_wl_private_queue_token *p=wpk_wl_private_queues[bucket];p;p=p->next)
            if(p->queue==queue){chosen=p;break;}
        if(!chosen)break;_wpk_wl_private_queue_withdraw_locked(chosen);
    }
    _wpk_drm_owned_publication_end();
}
int _wpk_wl_private_queue_register(struct wpk_wl_private_queue_token *token,void *native_queue,void *surface_hold,void *owner,struct wpk_drm_actor_claim *claim,struct wpk_wl_log_scope *logs){
    if(!token||!native_queue||!surface_hold||!owner||!claim||!logs){errno=EINVAL;return 0;}
    uint64_t process=_wpk_drm_process_generation(),epoch=_wpk_drm_native_fork_epoch();
    if(!wpk_wl_native_pointer_admitted(native_queue))return 0;
    struct wpk_wl_surface *hold=surface_hold;
    _wpk_drm_mutex_lock(&wpk_wl_mutex);_wpk_drm_owned_publication_begin();
    struct wpk_wl_connection *record=hold->connection;
    int accepted=!token->active&&!hold->constructing&&hold->proxy&&record&&record->alive&&
        record->process_epoch==process&&record->native_fork_epoch==epoch&&
        _wpk_drm_actor_claim_current_locked(claim);
    /* Only after proving the retained record's ordinary provenance inspect
     * this caller-owned newly created queue, never an inherited native graph. */
    if(accepted)accepted=((struct wl_event_queue*)native_queue)->display==record->display;
    unsigned bucket=wpk_wl_private_bucket(native_queue);
    for(struct wpk_wl_private_queue_token *p=wpk_wl_private_queues[bucket];accepted&&p;p=p->next)
        if(p->queue==native_queue)accepted=0;
    if(accepted){
        *token=(struct wpk_wl_private_queue_token){.next=wpk_wl_private_queues[bucket],.queue=native_queue,
            .display=record->display,.connection=record,.owner=owner,.owner_claim=claim,.owner_logs=logs,
            .identity=record->identity,.process_epoch=process,.native_epoch=epoch,.active=1};
        wpk_wl_private_queues[bucket]=token;
    }
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(!accepted)errno=EINVAL;return accepted;
}
static struct wpk_wl_private_queue_token *wpk_wl_private_queue_current(void *queue,void *display){
    uint64_t process=_wpk_drm_process_generation(),epoch=_wpk_drm_native_fork_epoch();
    struct wpk_wl_log_scope *capture=_wpk_wl_log_capture_current();
    _wpk_drm_owned_publication_begin();struct wpk_wl_private_queue_token *found=NULL;
    for(struct wpk_wl_private_queue_token *p=wpk_wl_private_queues[wpk_wl_private_bucket(queue)];p;p=p->next){
        /* WHY: two independent contracts must BOTH hold. Cold exact-queue
         * registration proves audited platform listeners cannot call user
         * code; the exact active owner log scope separately defers custom
         * logging until its real resource slots seal. Generic log capture or
         * an epoch match alone can never exempt an application's queue. */
        if(!p->active||p->queue!=queue||p->display!=display||p->process_epoch!=process||p->native_epoch!=epoch||
                !_wpk_drm_actor_claim_current_locked(p->owner_claim)||p->owner_logs!=capture||
                !capture||!capture->capturing||!_wpk_drm_actor_claim_current_locked(&capture->capture_claim))continue;
        struct wpk_wl_connection *record=p->connection;
        if(record->identity==p->identity&&record->display==display&&record->native_fork_epoch==epoch){found=p;break;}
    }
    _wpk_drm_owned_publication_end();return found;
}
