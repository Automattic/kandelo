/* Kernel-owned device files are capabilities, not recyclable fd numbers.
 * This archive member is linked only by consumers of the private driver API;
 * ordinary libc calls do not pay a graphics hook or take a driver mutex. */
#include "drm_owned.h"
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sched.h>
#include <unistd.h>
#if defined(__wasm__)
#include <sys/syscall.h>
extern long __syscall_cp(long,long long,long long,long long,long long,long long,long long);
#endif

struct wpk_drm_owner {
    struct wpk_drm_mutex mutex;
    uint64_t creation_nonce, transaction, acknowledge;
    _Atomic uint32_t token;
    uint32_t release_action;
    _Atomic uint32_t references;
    _Atomic int released,capture_resolved,pending;
    int creation,creation_receipt_known,acknowledgement_pending,release_error;
    int publication_tracked,parent_recovery_claimed,retirement_queued;
    uint64_t retirement_claim_epoch;
    uint32_t pending_action,pending_token,pending_request,pending_length,pending_flags;
    uint64_t pending_transaction;
    struct wpk_drm_owner *capture, *creation_parent, *retirement_next;
    struct wpk_drm_mapping *mapping;
    struct wpk_drm_owned_packet request, recovery;
};
static _Atomic(struct wpk_drm_owner *) retired_owners;
static void unlink_retirement_published(struct wpk_drm_owner *owner);
static _Atomic uint64_t resource_nonce;
static _Atomic uint64_t resource_process_epoch;
static pthread_once_t resource_once=PTHREAD_ONCE_INIT;
/* Capture and deferred-retirement custody use this cold guard. Fork must not split a pointer
 * publication from its matching C reference-count change. Its holders perform
 * pure metadata/free work only: native I/O, receiver locks and futex unlocks
 * stay outside, so prepare cannot invert the graphics lock hierarchy. */
static pthread_mutex_t capture_publication_mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t capture_publication_once=PTHREAD_ONCE_INIT;
static int capture_publication_status=EAGAIN;
static void capture_publication_begin(void) {
    if(pthread_mutex_lock(&capture_publication_mutex))abort();
}
static void capture_publication_end(void) {
    if(pthread_mutex_unlock(&capture_publication_mutex))abort();
}
static void initialize_capture_publication(void) {
    capture_publication_status=pthread_atfork(capture_publication_begin,
        capture_publication_end,capture_publication_end);
}
static int prepare_capture_publication(void) {
    if(pthread_once(&capture_publication_once,initialize_capture_publication)||capture_publication_status){errno=ENOMEM;return 0;}
    return 1;
}
static void resource_forked(void) {
    uint64_t prior=atomic_fetch_add_explicit(&resource_process_epoch,1,memory_order_relaxed);
    if(prior==UINT64_MAX)abort();
}
static void resource_initialize(void) {
    if(pthread_atfork(NULL,NULL,resource_forked)==0)
        atomic_store_explicit(&resource_process_epoch,1,memory_order_relaxed);
}
uint64_t _wpk_owned_resource_nonce(void) {
    uint64_t value=atomic_load_explicit(&resource_nonce,memory_order_relaxed);
    do {
        if(value==UINT64_MAX){errno=EOVERFLOW;return 0;}
    }while(!atomic_compare_exchange_weak_explicit(&resource_nonce,&value,value+1,memory_order_relaxed,memory_order_relaxed));
    return value+1;
}
static uint64_t process_epoch(void) {
    pthread_once(&resource_once,resource_initialize);
    return atomic_load_explicit(&resource_process_epoch,memory_order_relaxed);
}
uint64_t _wpk_drm_process_generation(void) {return process_epoch();}
#if defined(__wasm__)
extern uint64_t __wasm_posix_native_fork_epoch(void);
#else
/* Native source controls provide explicit copied-libc state when exercising
 * D-59. This is a fixture hook, not a production missing-capability fallback. */
extern uint64_t __wasm_posix_native_fork_epoch(void) __attribute__((weak));
#endif
uint64_t _wpk_drm_native_fork_epoch(void) {
#if defined(__wasm__)
    return __wasm_posix_native_fork_epoch();
#else
    return __wasm_posix_native_fork_epoch?__wasm_posix_native_fork_epoch():0;
#endif
}
static struct wpk_wl_boundary_hold *wayland_boundary_roots;
void _wpk_wl_boundary_transfer_locked(struct wpk_wl_boundary_hold *hold) {
    if(!hold||!hold->owner)abort();
    if(hold->transferred)return;
    /* WHY: replaying cleanup could traverse a torn inherited native graph or
     * close a recycled descriptor. Preserve its actual heap owner for the
     * remaining image lifetime instead; this marker is not native completion
     * or a Worker acknowledgement. Caller and root publish under one guard. */
    hold->next=wayland_boundary_roots;
    hold->transferred=1;wayland_boundary_roots=hold;
}
static struct wpk_drm_owner *reserve_owner(void) {
    uint64_t epoch=process_epoch();
    if(!epoch){errno=ENOMEM;return NULL;}
    /* Register before any kernel effect. Void cleanup cannot discover a
     * missing fork-publication guard after custody is already unavoidable. */
    if(!prepare_capture_publication())return NULL;
    struct wpk_drm_owner *owner=calloc(1,sizeof *owner);
    if(!owner)return NULL;
    owner->references=1;owner->release_action=WPK_DRM_OWNED_RELEASE;owner->publication_tracked=1;
    return owner;
}
static void free_owner(struct wpk_drm_owner *owner) {
    free(owner);
}
static int lock_owner(struct wpk_drm_owner *owner,int *cancel_state) {
    uint64_t epoch=process_epoch();
    if(!owner||!epoch){errno=EACCES;return 0;}
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,cancel_state);
    /* A child adopts its independently pinned kernel capability through a
     * new lock generation, never an inherited pthread owner. The copied
     * pending key is reconciled read-only before another operation enters;
     * it cannot authorize replay of the parent's native mutation. */
    _wpk_drm_mutex_lock(&owner->mutex);
    return 1;
}
static void unlock_owner(struct wpk_drm_owner *owner,int cancel_state) {
    _wpk_drm_mutex_unlock(&owner->mutex);
    pthread_setcancelstate(cancel_state,NULL);
}
static void initialize_packet(struct wpk_drm_owned_packet *packet,uint32_t action,uint64_t transaction,uint32_t token) {
    memset(packet,0,sizeof *packet);
    packet->version=WPK_DRM_OWNED_VERSION;packet->action=action;
    packet->transaction=transaction;packet->token=token;packet->fd=-1;
}
static int send_packet(struct wpk_drm_owned_packet *packet) {
    packet->result=0;packet->state=0;packet->magic=0;
    if(packet->action==WPK_DRM_OWNED_POLL){
#if defined(__wasm__)
        long result=__syscall_cp(SYS_ioctl,-1,WPK_DRM_IOCTL_OWNED_RESOURCE,
            (long long)(uintptr_t)packet,0,0,0);
        if(result<0&&result>=-4095){errno=(int)-result;return -1;}return (int)result;
#else
        /* The native peer exercises the same cleanup scope around its
         * blocking transport; actual channel cancellation is a Wasm gate. */
        pthread_testcancel();int result=ioctl(-1,WPK_DRM_IOCTL_OWNED_RESOURCE,packet);
        pthread_testcancel();return result;
#endif
    }
    return ioctl(-1,WPK_DRM_IOCTL_OWNED_RESOURCE,packet);
}
static int valid_packet(const struct wpk_drm_owned_packet *packet) {
    return packet->version==WPK_DRM_OWNED_VERSION&&packet->magic==WPK_DRM_OWNED_MAGIC&&
        !packet->reserved&&packet->length<=WPK_DRM_OWNED_BODY_BYTES;
}
static int completed_packet(const struct wpk_drm_owned_packet *packet,uint32_t action,
                            uint64_t transaction,uint32_t token,int creation) {
    return valid_packet(packet)&&packet->state==WPK_DRM_OWNED_COMPLETE&&
        packet->action==action&&packet->transaction==transaction&&
        (creation?(packet->result<0||packet->token!=0):packet->token==token)&&
        packet->result>=-4095;
}
/* Recover only the exact retained transaction. A missing record proves
 * nonentry in this synchronous protocol; a failed read proves nothing.
 * Never issue the original mutation again after its first attempt. */
static int recover_pending(struct wpk_drm_owner *owner) {
    struct wpk_drm_owned_packet *request=&owner->request,*reply=&owner->recovery;
    const uint32_t action=owner->pending_action,token=owner->pending_token;
    const uint64_t tx=owner->pending_transaction;
    initialize_packet(reply,WPK_DRM_OWNED_READ_LAST,tx,token);
    if(send_packet(reply)!=0)return -1;
    if(completed_packet(reply,action,tx,owner->token,owner->creation)){
        if(reply->request!=owner->pending_request||reply->length!=owner->pending_length||reply->flags!=owner->pending_flags){errno=EIO;return -1;}
        if((owner->pending_flags&(WPK_DRM_OWNED_CAPTURE_FD|WPK_DRM_OWNED_CAPTURE_BO))&&
           reply->result>=0&&reply->source_token==0){errno=EIO;return -1;}
        if(action==WPK_DRM_OWNED_MMAP_EXACT&&reply->result>=0){
            uint64_t identity;memcpy(&identity,reply->body+32,8);
            if(!identity){errno=EIO;return -1;}
        }
        *request=*reply;return 1;
    }
    if(valid_packet(reply)&&reply->action==WPK_DRM_OWNED_READ_LAST&&reply->transaction==tx&&reply->token==token&&
       reply->state==WPK_DRM_OWNED_ABSENT&&reply->result==-ENOENT){
        return 0;
    }
    errno=EIO;return -1;
}
static int captures_valid(const struct wpk_drm_owner *owner,const struct wpk_drm_owned_packet *packet) {
    if(owner->pending_action==WPK_DRM_OWNED_MMAP_EXACT&&packet->result>=0){
        uint64_t identity;memcpy(&identity,packet->body+32,8);
        if(!identity)return 0;
    }
    if(!(owner->pending_flags&(WPK_DRM_OWNED_CAPTURE_FD|WPK_DRM_OWNED_CAPTURE_BO)))return 1;
    return packet->result<0||packet->source_token!=0;
}
static void stage_request(struct wpk_drm_owner *owner) {
    struct wpk_drm_owned_packet *packet=&owner->request;
    owner->pending_action=packet->action;owner->pending_token=owner->creation?0:owner->token;
    owner->pending_transaction=packet->transaction;owner->pending_request=packet->request;
    owner->pending_length=packet->length;owner->pending_flags=packet->flags;
}
static int enter_request(struct wpk_drm_owner *owner) {
    struct wpk_drm_owned_packet *packet=&owner->request;
    const uint32_t action=packet->action,token=owner->token;
    const uint64_t tx=packet->transaction;
    stage_request(owner);
    /* Publication is last: a fork snapshot seeing pending must always have
     * a complete immutable key, even if copyout changes the packet itself. */
    owner->pending=1;
    if(send_packet(packet)==0&&completed_packet(packet,action,tx,token,owner->creation)&&
       packet->request==owner->pending_request&&packet->length==owner->pending_length&&packet->flags==owner->pending_flags&&captures_valid(owner,packet)){
        return 1;
    }
    return recover_pending(owner);
}
/* ACK has deliberately idempotent semantics: retrying it cannot execute a
 * device operation or release a resource twice. Keep the C receiver until
 * the kernel acknowledges removal of its final immutable receipt. */
static int acknowledge(struct wpk_drm_owner *owner,uint32_t token,uint64_t transaction) {
    struct wpk_drm_owned_packet *reply=&owner->recovery;
    initialize_packet(reply,WPK_DRM_OWNED_ACK,transaction,token);
    if(send_packet(reply)!=0||!completed_packet(reply,WPK_DRM_OWNED_ACK,transaction,token,0)||reply->result){errno=EIO;return 0;}
    return 1;
}
static void publish_creation_receipt(struct wpk_drm_owner *owner) {
    /* Cold acknowledgement may remove the kernel receipt before fork. Make
     * the verified token/result durable first; ACK never recreates a file. */
    capture_publication_begin();
    owner->token=owner->request.token;owner->creation_receipt_known=1;
    capture_publication_end();
}
static int finish_creation(struct wpk_drm_owner *owner) {
    if(!owner->creation_receipt_known){
        owner->pending=1;
        int recovered=recover_pending(owner);
        if(recovered<0)return -1;
        if(!recovered){
            /* The immutable cold key existed before the pointer was
             * published. ABSENT proves no effect; never replay OPEN/ACQUIRE. */
            capture_publication_begin();
            owner->released=1;owner->creation=0;owner->pending=0;
            capture_publication_end();return 0;
        }
        publish_creation_receipt(owner);
    }
    if(!acknowledge(owner,0,owner->creation_nonce)){owner->acknowledgement_pending=1;return -1;}
    capture_publication_begin();
    owner->acknowledgement_pending=0;owner->creation=0;
    if(!owner->token&&owner->request.result<0)owner->released=1;
    owner->pending=0;
    capture_publication_end();
    return owner->request.result<0?0:1;
}

static int create_owner(uint32_t action,int fd,uint32_t request,uint32_t flags,struct wpk_drm_owner **result) {
    if(!result){errno=EINVAL;return -1;}*result=NULL;
    struct wpk_drm_owner *owner=reserve_owner();if(!owner)return -1;
    uint64_t nonce=_wpk_owned_resource_nonce();
    if(!nonce){free_owner(owner);return -1;}
    owner->creation=1;owner->creation_nonce=nonce;
    initialize_packet(&owner->request,action,nonce,0);
    owner->request.fd=fd;owner->request.request=request;owner->request.flags=flags;
    // Fork may observe this pointer before native entry. Its exact immutable
    // key must already let the child prove ABSENT without replaying creation.
    stage_request(owner);
    *result=owner;
    int cancel_state;if(!lock_owner(owner,&cancel_state))return -1;
    int entered=enter_request(owner);
    if(entered>0){publish_creation_receipt(owner);entered=finish_creation(owner);}
    int error=owner->request.result<0?-owner->request.result:errno;
    if(entered==0&&owner->token==0){
        *result=NULL;
        _wpk_drm_mutex_unlock(&owner->mutex);free_owner(owner);
        pthread_setcancelstate(cancel_state,NULL);errno=error?error:EIO;return -1;
    }
    unlock_owner(owner,cancel_state);
    if(entered<0){errno=EIO;return -1;}
    if(entered==0){errno=error?error:EIO;return -1;}
    return 0;
}
int _wpk_drm_owned_open(uint32_t node,struct wpk_drm_owner **owner) {
    return create_owner(WPK_DRM_OWNED_OPEN,-1,node,0,owner);
}
int _wpk_drm_owned_acquire(int fd,uint32_t flags,struct wpk_drm_owner **owner) {
    return create_owner(WPK_DRM_OWNED_ACQUIRE,fd,0,flags,owner);
}
/* A known child capability owns its
 * exact kernel file/storage independently; retaining its C parent would make
 * later child retirement wait behind unrelated work on that parent receiver.
 * A sole remaining recovery hold stays attached until the child's immediate
 * cleanup can retire that last parent without losing a reachable C owner. */
/* The publication guard, not a parent receiver lock, serializes this edge.
 * Atomic counts also make concurrent receiver-side observations well-defined. */
static void drop_capture_parent_published(struct wpk_drm_owner *owner,struct wpk_drm_owner *capture) {
    if(capture->creation_parent!=owner||!owner->references)abort();
    if(owner->references>1){capture->creation_parent=NULL;--owner->references;}
}
/* The parent receiver is locked before native completion is published. */
static void finish_capture(struct wpk_drm_owner *owner,uint32_t token) {
    struct wpk_drm_owner *capture=owner->capture;
    if(!capture)return;
    capture_publication_begin();
    capture->token=token;
    if(!token)capture->released=1;
    owner->capture=NULL;
    /* A recovery caller claimed the existing hold before reading the parent
     * pointer. Keep that same explicit hold until it has locked the parent;
     * a temporary anonymous increment would itself tear across fork. */
    if(!capture->parent_recovery_claimed)drop_capture_parent_published(owner,capture);
    capture->capture_resolved=1;
    capture_publication_end();
}
/* An unresolved child has one C receiver reference: retaining token zero
 * fails until guarded completion publishes its independent capability. One
 * recovery claim therefore protects its sole parent edge, not anonymous refs. */
static struct wpk_drm_owner *claim_capture_parent(struct wpk_drm_owner *capture) {
    if(!capture->publication_tracked)return NULL;
    capture_publication_begin();
    struct wpk_drm_owner *parent=capture->creation_parent;
    if(parent){
        if(!capture->capture_resolved)capture->parent_recovery_claimed=1;
        else{
            /* A fork can copy a completed token while the old recovery caller
             * still owns its claim. That inherited edge needs no more native
             * observation and must not lock an unrelated live parent caller. */
            capture->parent_recovery_claimed=0;
            drop_capture_parent_published(parent,capture);parent=NULL;
        }
    }
    capture_publication_end();return parent;
}
static void unclaim_capture_parent_locked(struct wpk_drm_owner *parent,struct wpk_drm_owner *capture) {
    capture_publication_begin();
    capture->parent_recovery_claimed=0;
    if(capture->capture_resolved)drop_capture_parent_published(parent,capture);
    capture_publication_end();
}

static void publish_request_result(struct wpk_drm_owner *owner,int accepted) {
    if(owner->mapping){
        struct wpk_drm_mapping *mapping=owner->mapping;
        /* A later FILE request may ACK this receipt. Publish its exact mapping
         * custody under the same fork guard before making that ACK possible;
         * otherwise a vanished caller could leave an unrecoverable map. */
        capture_publication_begin();
        if(accepted){owner->transaction=owner->request.transaction;owner->acknowledge=owner->transaction;}
        if(owner->pending_action==WPK_DRM_OWNED_MMAP_EXACT){
            if(accepted&&owner->request.result>=0){
                memcpy(&mapping->address,owner->request.body,8);
                memcpy(&mapping->identity,owner->request.body+32,8);
                atomic_store_explicit(&mapping->phase,WPK_DRM_MAPPING_LIVE,memory_order_release);
            }else atomic_store_explicit(&mapping->phase,WPK_DRM_MAPPING_EMPTY,memory_order_release);
        }else if(owner->pending_action==WPK_DRM_OWNED_UNMAP_EXACT){
            atomic_store_explicit(&mapping->phase,accepted&&owner->request.result>=0
                ?WPK_DRM_MAPPING_EMPTY:WPK_DRM_MAPPING_LIVE,memory_order_release);
        }else abort();
        owner->mapping=NULL;owner->pending=0;
        capture_publication_end();return;
    }
    if(accepted){
        owner->transaction=owner->request.transaction;owner->acknowledge=owner->transaction;
        finish_capture(owner,owner->request.source_token);
        if((owner->request.action==WPK_DRM_OWNED_RELEASE||owner->request.action==WPK_DRM_OWNED_BO_RELEASE)&&owner->request.source_token==1){
            owner->released=1;owner->release_error=owner->request.result<0?-owner->request.result:0;
        }
    }else if(owner->capture)finish_capture(owner,0);
    /* Last publication is the reconciliation marker, not native return.
     * A fork during any prior write keeps the immutable pending key and
     * rereads its exact receipt, rather than reusing an already consumed tx. */
    owner->pending=0;
}

static int resolve_owner(struct wpk_drm_owner *owner) {
    if(owner->creation)return finish_creation(owner)==1;
    /* Native completion can precede publication of the captured C token.
     * A copied child receiver recovers that exact snapshot, not a prior
     * transaction whose body happens to occupy the same packet storage. */
    if(owner->capture&&!owner->capture->capture_resolved&&!owner->pending)owner->pending=1;
    if(owner->pending){
        int recovered=recover_pending(owner);
        if(recovered<0)return 0;
        publish_request_result(owner,recovered);
        // No old caller buffer is retained. Existing API receipt/state
        // reconciliation remains responsible for an unknown operation.
    }
    return owner->token&&!owner->released;
}
static int begin_request(struct wpk_drm_owner *owner,uint32_t action) {
    if(!resolve_owner(owner)){errno=EIO;return 0;}
    if(owner->transaction==UINT64_MAX){errno=EOVERFLOW;return 0;}
    initialize_packet(&owner->request,action,owner->transaction+1,owner->token);
    owner->request.acknowledge=owner->acknowledge;
    return 1;
}
static int complete_request(struct wpk_drm_owner *owner,int entered) {
    if(entered<0){errno=EIO;return -1;}
    publish_request_result(owner,entered!=0);
    if(!entered){errno=EIO;return -1;}
    if(owner->request.result<0){errno=-owner->request.result;return -1;}
    return owner->request.result;
}
int _wpk_drm_owned_ioctl_bo(struct wpk_drm_owner *owner,uint32_t request,void *body,uint32_t length,
                         struct wpk_drm_owner *source,uint32_t flags,struct wpk_drm_owner **capture_result,
                         const struct wpk_drm_bo_binding *bindings,uint32_t count) {
    uint32_t proof_bytes=count?4+count*8:0;
    if(count>WPK_DRM_OWNED_MAX_BO_BINDINGS||(!bindings&&count)||
       length>WPK_DRM_OWNED_BODY_BYTES-proof_bytes||(!body&&length)||
       (flags&WPK_DRM_OWNED_BO_BINDINGS)||
       (flags&(WPK_DRM_OWNED_CAPTURE_FD|WPK_DRM_OWNED_CAPTURE_BO))==(WPK_DRM_OWNED_CAPTURE_FD|WPK_DRM_OWNED_CAPTURE_BO)||
       (!!(flags&(WPK_DRM_OWNED_CAPTURE_FD|WPK_DRM_OWNED_CAPTURE_BO))!=!!capture_result)){
        errno=EINVAL;return -1;
    }
    if(capture_result)*capture_result=NULL;
    for(uint32_t i=0;i<count;i++){
        struct wpk_drm_owner *bo=bindings[i].owner;
        if(length<4||bindings[i].byte_offset>length-4||
           !bo||!bo->token||bo->released||
           bo->release_action!=WPK_DRM_OWNED_BO_RELEASE){
            errno=EINVAL;return -1;
        }
        for(uint32_t j=0;j<i;j++)if(bindings[i].byte_offset==bindings[j].byte_offset){errno=EINVAL;return -1;}
    }
    if(source&&(!source->token||source->released)){errno=EACCES;return -1;}
    struct wpk_drm_owner *capture=capture_result?reserve_owner():NULL;
    if(capture_result&&!capture)return -1;
    int cancel_state;if(!lock_owner(owner,&cancel_state)){if(capture)free_owner(capture);return -1;}
    if(!begin_request(owner,WPK_DRM_OWNED_IOCTL)|| (capture&&owner->references==UINT32_MAX)){
        if(capture&&owner->references==UINT32_MAX)errno=EOVERFLOW;
        unlock_owner(owner,cancel_state);if(capture)free_owner(capture);return -1;
    }
    owner->request.request=request;owner->request.length=length+proof_bytes;
    owner->request.flags=flags|(count?WPK_DRM_OWNED_BO_BINDINGS:0);
    owner->request.source_token=source?source->token:0;
    if(length)memcpy(owner->request.body,body,length);
    if(count){
        memcpy(owner->request.body+length,&count,4);
        for(uint32_t i=0;i<count;i++){
            memcpy(owner->request.body+length+4+i*8,&bindings[i].byte_offset,4);
            uint32_t token=bindings[i].owner->token;
            memcpy(owner->request.body+length+8+i*8,&token,4);
        }
    }
    stage_request(owner);
    if(capture){
        /* The returned child may outlive its parent's caller after an
         * unknown response. A strong C hold prevents read-only recovery
         * from following a freed parent while another thread retires it. */
        capture_publication_begin();
        owner->publication_tracked=capture->publication_tracked=1;
        ++owner->references;capture->creation_parent=owner;
        capture->release_action=flags&WPK_DRM_OWNED_CAPTURE_BO?WPK_DRM_OWNED_BO_RELEASE:WPK_DRM_OWNED_RELEASE;
        owner->capture=capture;*capture_result=capture;
        capture_publication_end();
    }
    int entered=enter_request(owner),rc=complete_request(owner,entered);
    if(entered>0&&length)memcpy(body,owner->request.body,length);
    if(entered>=0&&capture&&!capture->token){
        if(owner->capture)finish_capture(owner,0);
        capture_publication_begin();
        if(capture->creation_parent)abort();
        *capture_result=NULL;free_owner(capture);
        capture_publication_end();
    }
    unlock_owner(owner,cancel_state);return rc;
}
int _wpk_drm_owned_ioctl(struct wpk_drm_owner *owner,uint32_t request,void *body,uint32_t length,
                         struct wpk_drm_owner *source,uint32_t flags,struct wpk_drm_owner **capture) {
    return _wpk_drm_owned_ioctl_bo(owner,request,body,length,source,flags,capture,NULL,0);
}
int _wpk_drm_owned_map_bo(struct wpk_drm_owner *owner,struct wpk_drm_owner *bo,
                       uint64_t address,uint64_t length,int64_t offset,
                       uint32_t prot,uint32_t flags,uint64_t *mapped) {
    if(!mapped||(bo&&(!bo->token||bo->released||
       bo->release_action!=WPK_DRM_OWNED_BO_RELEASE))){errno=EINVAL;return -1;}
    int cancel_state;if(!lock_owner(owner,&cancel_state))return -1;
    if(!begin_request(owner,WPK_DRM_OWNED_MMAP)){unlock_owner(owner,cancel_state);return -1;}
    owner->request.length=32;owner->request.source_token=bo?bo->token:0;
    memcpy(owner->request.body,&address,8);memcpy(owner->request.body+8,&length,8);
    memcpy(owner->request.body+16,&offset,8);memcpy(owner->request.body+24,&prot,4);memcpy(owner->request.body+28,&flags,4);
    int entered=enter_request(owner),rc=complete_request(owner,entered);
    if(rc>=0)memcpy(mapped,owner->request.body,8);
    unlock_owner(owner,cancel_state);return rc;
}
int _wpk_drm_owned_map(struct wpk_drm_owner *owner,uint64_t address,uint64_t length,int64_t offset,
                       uint32_t prot,uint32_t flags,uint64_t *mapped) {
    return _wpk_drm_owned_map_bo(owner,NULL,address,length,offset,prot,flags,mapped);
}
static int mapping_arguments_match(const struct wpk_drm_mapping *mapping,
    struct wpk_drm_owner *file,struct wpk_drm_owner *bo,uint64_t address,
    uint64_t length,int64_t offset,uint32_t prot,uint32_t flags) {
    return mapping->file==file&&mapping->bo==bo&&mapping->requested_address==address&&
        mapping->length==length&&mapping->offset==offset&&mapping->prot==prot&&mapping->flags==flags;
}
int _wpk_drm_owned_map_exact(struct wpk_drm_mapping *mapping,
    struct wpk_drm_owner *file,struct wpk_drm_owner *bo,uint64_t address,
    uint64_t length,int64_t offset,uint32_t prot,uint32_t flags) {
    if(!mapping||!length||(bo&&(!bo->token||bo->released||
       bo->release_action!=WPK_DRM_OWNED_BO_RELEASE))){errno=EINVAL;return -1;}
    int cancel_state;if(!lock_owner(file,&cancel_state))return -1;
    int was_pending=_wpk_drm_mapping_phase(mapping)==WPK_DRM_MAPPING_MAP_PENDING;
    if(!resolve_owner(file)){unlock_owner(file,cancel_state);errno=EIO;return -1;}
    if(_wpk_drm_mapping_phase(mapping)!=WPK_DRM_MAPPING_EMPTY){
        int match=_wpk_drm_mapping_phase(mapping)==WPK_DRM_MAPPING_LIVE&&
            mapping_arguments_match(mapping,file,bo,address,length,offset,prot,flags);
        unlock_owner(file,cancel_state);if(!match)errno=EBUSY;return match?0:-1;
    }
    /* Recovery proving ABSENT/failed construction must not replay a vanished
     * caller's mutation. A fresh caller may explicitly retry after observing
     * EMPTY, but this invocation reports the original failure. */
    if(was_pending){unlock_owner(file,cancel_state);errno=EIO;return -1;}
    if(!begin_request(file,WPK_DRM_OWNED_MMAP_EXACT)){unlock_owner(file,cancel_state);return -1;}
    file->request.length=40;file->request.source_token=bo?bo->token:0;
    memcpy(file->request.body,&address,8);memcpy(file->request.body+8,&length,8);
    memcpy(file->request.body+16,&offset,8);memcpy(file->request.body+24,&prot,4);memcpy(file->request.body+28,&flags,4);
    capture_publication_begin();
    mapping->file=file;mapping->bo=bo;mapping->requested_address=address;
    mapping->length=length;mapping->offset=offset;mapping->prot=prot;mapping->flags=flags;
    mapping->address=0;mapping->identity=0;atomic_store_explicit(&mapping->phase,WPK_DRM_MAPPING_MAP_PENDING,memory_order_release);
    file->mapping=mapping;stage_request(file);file->pending=1;
    capture_publication_end();
    int entered=enter_request(file),rc=complete_request(file,entered);
    unlock_owner(file,cancel_state);return rc;
}
int _wpk_drm_owned_unmap_exact(struct wpk_drm_mapping *mapping) {
    if(!mapping){errno=EINVAL;return -1;}
    if(_wpk_drm_mapping_phase(mapping)==WPK_DRM_MAPPING_EMPTY)return 0;
    struct wpk_drm_owner *file=mapping->file;
    int cancel_state;if(!lock_owner(file,&cancel_state))return -1;
    if(!resolve_owner(file)){unlock_owner(file,cancel_state);errno=EIO;return -1;}
    if(_wpk_drm_mapping_phase(mapping)==WPK_DRM_MAPPING_EMPTY){unlock_owner(file,cancel_state);return 0;}
    if(_wpk_drm_mapping_phase(mapping)!=WPK_DRM_MAPPING_LIVE||!mapping->identity){unlock_owner(file,cancel_state);errno=EIO;return -1;}
    if(!begin_request(file,WPK_DRM_OWNED_UNMAP_EXACT)){unlock_owner(file,cancel_state);return -1;}
    file->request.length=8;file->request.source_token=mapping->bo?mapping->bo->token:0;
    memcpy(file->request.body,&mapping->identity,8);
    capture_publication_begin();
    atomic_store_explicit(&mapping->phase,WPK_DRM_MAPPING_UNMAP_PENDING,memory_order_release);file->mapping=mapping;
    stage_request(file);file->pending=1;
    capture_publication_end();
    int entered=enter_request(file),rc=complete_request(file,entered);
    unlock_owner(file,cancel_state);return rc;
}
int _wpk_drm_owned_bo_info(struct wpk_drm_owner *owner,struct wpk_drm_bo_info *info) {
    if(!info||!owner||owner->release_action!=WPK_DRM_OWNED_BO_RELEASE){errno=EINVAL;return -1;}
    int cancel_state;if(!lock_owner(owner,&cancel_state))return -1;
    if(!begin_request(owner,WPK_DRM_OWNED_BO_INFO)){unlock_owner(owner,cancel_state);return -1;}
    owner->request.length=32;
    int entered=enter_request(owner),rc=complete_request(owner,entered);
    if(rc>=0)memcpy(info,owner->request.body,32);
    unlock_owner(owner,cancel_state);return rc;
}
static void cancel_poll_locked(struct wpk_drm_owner *owner) {
    if(!owner->pending||owner->pending_action!=WPK_DRM_OWNED_POLL)return;
    int recovered=recover_pending(owner);
    if(recovered<0){
        struct wpk_drm_owned_packet *reply=&owner->recovery;
        initialize_packet(reply,WPK_DRM_OWNED_CANCEL_POLL,owner->pending_transaction,owner->token);
        int sent=send_packet(reply);
        if(sent==0&&completed_packet(reply,WPK_DRM_OWNED_POLL,owner->pending_transaction,owner->token,0)&&
           reply->length==16&&reply->request==0&&reply->flags==0){
            owner->request=*reply;recovered=1;
        }else recovered=recover_pending(owner);
    }
    if(recovered>=0)publish_request_result(owner,recovered);
}

static void poll_canceled(void *pointer) {
    struct wpk_drm_owner *owner=pointer;
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,NULL);
    /* Cancel only this read-only wait. A generic retry/cancel operation
     * could execute or discard an unrelated mutating driver request. */
    cancel_poll_locked(owner);
    _wpk_drm_mutex_unlock(&owner->mutex);
}
int _wpk_drm_owned_poll(struct wpk_drm_owner *owner,uint32_t events,int32_t timeout_ms,uint32_t *revents) {
    if(!revents){errno=EINVAL;return -1;}
    int cancel_state;if(!lock_owner(owner,&cancel_state))return -1;
    if(!begin_request(owner,WPK_DRM_OWNED_POLL)){unlock_owner(owner,cancel_state);return -1;}
    owner->request.length=16;
    memcpy(owner->request.body,&events,4);memcpy(owner->request.body+8,&timeout_ms,4);
    int rc;
    pthread_cleanup_push(poll_canceled,owner);
    pthread_setcancelstate(cancel_state,NULL);
    int entered=enter_request(owner);
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,NULL);
    rc=complete_request(owner,entered);
    if(rc>=0)memcpy(revents,owner->request.body+4,4);
    pthread_cleanup_pop(0);
    unlock_owner(owner,cancel_state);return rc;
}
int _wpk_drm_owned_fd(struct wpk_drm_owner *owner,int previous,uint32_t flags) {
    int cancel_state;if(!lock_owner(owner,&cancel_state))return -1;
    if(!begin_request(owner,WPK_DRM_OWNED_DUP_FD)){unlock_owner(owner,cancel_state);return -1;}
    owner->request.fd=previous;owner->request.flags=flags|WPK_DRM_OWNED_REUSE_EXACT;
    int entered=enter_request(owner),rc=complete_request(owner,entered);
    unlock_owner(owner,cancel_state);return rc;
}
/* Resolve before taking the fork guard. The caller may then publish the new
 * C edge and its facade root without native I/O or another lock acquisition;
 * splitting retain from publication would strand a copied reference at fork. */
int _wpk_drm_owned_retain_begin(struct wpk_drm_owner *owner, int *cancel_state) {
    if (!cancel_state) { errno = EINVAL; return -1; }
    if (!lock_owner(owner, cancel_state)) return -1;
    if (owner->references == UINT32_MAX || !resolve_owner(owner)) {
        errno = owner->references == UINT32_MAX ? EOVERFLOW : EIO;
        unlock_owner(owner, *cancel_state); return -1;
    }
    capture_publication_begin();
    ++owner->references;
    return 0;
}
void _wpk_drm_owned_retain_end(struct wpk_drm_owner *owner, int cancel_state) {
    capture_publication_end();
    unlock_owner(owner, cancel_state);
}
int _wpk_drm_owned_retain(struct wpk_drm_owner *owner) {
    int cancel_state;if(!lock_owner(owner,&cancel_state))return -1;
    if(owner->references==UINT32_MAX||!resolve_owner(owner)){
        errno=owner->references==UINT32_MAX?EOVERFLOW:EIO;unlock_owner(owner,cancel_state);return -1;
    }
    if(owner->publication_tracked)capture_publication_begin();
    ++owner->references;
    if(owner->publication_tracked)capture_publication_end();
    unlock_owner(owner,cancel_state);return 0;
}
static int release_owned_receiver(struct wpk_drm_owner **pointer,int retirement_claim);
int _wpk_drm_owned_release(struct wpk_drm_owner **pointer) {return release_owned_receiver(pointer,0);}
static int release_owned_receiver(struct wpk_drm_owner **pointer,int retirement_claim) {
    if(!pointer||!*pointer)return 0;
    struct wpk_drm_owner *owner=*pointer;
    // A child capability can be unknown while its parent's exact receipt is
    // unresolved. Reconcile the parent before touching this cold receiver.
    int recovery_cancel;
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&recovery_cancel);
    struct wpk_drm_owner *parent=claim_capture_parent(owner);
    if(parent){
        int parent_cancel;
        if(!lock_owner(parent,&parent_cancel)){pthread_setcancelstate(recovery_cancel,NULL);return -1;}
        int resolved=resolve_owner(parent);
        unclaim_capture_parent_locked(parent,owner);
        unlock_owner(parent,parent_cancel);
        if(!resolved||!owner->capture_resolved){errno=EIO;pthread_setcancelstate(recovery_cancel,NULL);return -1;}
    }
    pthread_setcancelstate(recovery_cancel,NULL);
    int cancel_state;if(!lock_owner(owner,&cancel_state))return -1;
    /* Known child completion may drop a tracked reference under the cold
     * guard without taking this receiver lock. Recheck inside that same guard
     * before deciding whether this is the last reference to retire natively. */
    if(owner->publication_tracked)capture_publication_begin();
    if(owner->references>1){
        /* A normal caller releases its own edge. Only the claimant may
         * remove the queue's separate edge while other owners remain. */
        if(retirement_claim)unlink_retirement_published(owner);
        --owner->references;*pointer=NULL;
        if(owner->publication_tracked)capture_publication_end();
        unlock_owner(owner,cancel_state);return 0;
    }
    if(owner->publication_tracked)capture_publication_end();
    if(owner->creation){
        int initialized=finish_creation(owner);
        if(initialized<0){unlock_owner(owner,cancel_state);return -1;}
        if(!initialized&&!owner->token)owner->released=1;
    }
    if(owner->capture&&!owner->capture->capture_resolved&&!owner->pending)owner->pending=1;
    if(owner->pending&&!owner->creation&&owner->pending_action==WPK_DRM_OWNED_POLL)cancel_poll_locked(owner);
    if(owner->pending&&!owner->creation){
        int recovered=recover_pending(owner);
        if(recovered<0){unlock_owner(owner,cancel_state);return -1;}
        publish_request_result(owner,recovered);
    }
    if(!owner->released){
        if(!begin_request(owner,owner->release_action)){unlock_owner(owner,cancel_state);return -1;}
        int entered=enter_request(owner),rc=complete_request(owner,entered);
        if(entered<=0||owner->request.source_token!=1){
            if(rc>=0)errno=EIO;
            unlock_owner(owner,cancel_state);return -1;
        }
        // Completion and resource consumption are separate facts. An error
        // after consumption still owns no reference to drop a second time.
        owner->released=1;owner->release_error=rc<0?errno:0;
    }
    if(owner->token&&!acknowledge(owner,owner->token,owner->transaction)){
        owner->acknowledgement_pending=1;unlock_owner(owner,cancel_state);return -1;
    }
    // Publish no receiver before cancellation is restored; cancellation must
    // not leave a freed owner behind its caller's still-live pointer.
    int release_error=owner->release_error;
    /* A recovery-only last parent remains reachable through this child until
     * its exact cleanup finishes. Clearing/freeing the child first would leave
     * a fork snapshot with an orphan parent pin on a vanished thread's stack. */
    if(owner->creation_parent&&_wpk_drm_owned_release(&owner->creation_parent)!=0){
        int error=errno;
        if(owner->creation_parent){unlock_owner(owner,cancel_state);errno=error;return -1;}
        if(!release_error)release_error=error;
    }
    int tracked=owner->publication_tracked;
    _wpk_drm_mutex_unlock(&owner->mutex);
    if(tracked)capture_publication_begin();
    if(retirement_claim)unlink_retirement_published(owner);
    else if(owner->retirement_queued)abort();
    *pointer=NULL;free_owner(owner);
    if(tracked)capture_publication_end();
    pthread_setcancelstate(cancel_state,NULL);
    if(release_error){errno=release_error;return -1;}return 0;
}

/* All list/claim/pointer publications below require the cold guard. No
 * receiver lock, device operation, or driver futex wake occurs inside it. */
static void unlink_retirement_published(struct wpk_drm_owner *owner) {
    if(!owner->retirement_queued)abort();
    struct wpk_drm_owner *prior=NULL;
    struct wpk_drm_owner *entry=atomic_load_explicit(&retired_owners,memory_order_relaxed);
    while(entry&&entry!=owner){prior=entry;entry=entry->retirement_next;}
    if(!entry)abort();
    if(prior)prior->retirement_next=entry->retirement_next;
    else atomic_store_explicit(&retired_owners,entry->retirement_next,memory_order_release);
    entry->retirement_next=NULL;entry->retirement_queued=0;entry->retirement_claim_epoch=0;
}
void _wpk_drm_owned_publication_begin(void){capture_publication_begin();}
void _wpk_drm_owned_publication_end(void){capture_publication_end();}
void _wpk_drm_owned_defer_locked(struct wpk_drm_owner **pointer) {
    if(!pointer||!*pointer)return;
    struct wpk_drm_owner *owner=*pointer;
    if(!owner->publication_tracked)abort();
    if(owner->retirement_queued){
        /* The existing queue edge retains custody; surrender only this
         * additional caller edge without publishing a duplicate node. */
        if(owner->references<=1)abort();--owner->references;
    }else{
        owner->retirement_next=atomic_load_explicit(&retired_owners,memory_order_relaxed);
        owner->retirement_queued=1;owner->retirement_claim_epoch=0;
        atomic_store_explicit(&retired_owners,owner,memory_order_release);
    }
    *pointer=NULL;
}
static void unclaim_retirement(struct wpk_drm_owner *owner,uint64_t epoch) {
    capture_publication_begin();
    if(!owner->retirement_queued||owner->retirement_claim_epoch!=epoch)abort();
    owner->retirement_claim_epoch=0;
    capture_publication_end();
}
static void diagnose_retirement(int error,int retained) {
    fprintf(stderr,"Kandelo graphics: exact device cleanup failed (errno=%d); %s\n",error,
        retained?"unresolved custody retained":"resource consumption was acknowledged");
}

static void drain_retirements(int diagnose) {
    if(!atomic_load_explicit(&retired_owners,memory_order_acquire))return;
    uint64_t epoch=process_epoch();size_t budget=0;
    capture_publication_begin();
    for(struct wpk_drm_owner *entry=atomic_load_explicit(&retired_owners,memory_order_relaxed);
        entry;entry=entry->retirement_next)budget++;
    capture_publication_end();
    /* Keep every receiver globally reachable during native cleanup. A fork
     * of another thread loses its local stack, but inherits this queue and
     * can adopt an old-epoch claim by reconciling the exact copied receipt. */
    while(budget--){
        capture_publication_begin();
        struct wpk_drm_owner *head=atomic_load_explicit(&retired_owners,memory_order_relaxed);
        struct wpk_drm_owner *prior=NULL,*owner=head;
        while(owner&&owner->retirement_claim_epoch==epoch){prior=owner;owner=owner->retirement_next;}
        if(owner){
            owner->retirement_claim_epoch=epoch;
            /* Round-robin claims and a finite entry budget prevent an
             * unresolved receipt from spinning forever in this cold call. */
            if(owner->retirement_next){
                if(prior)prior->retirement_next=owner->retirement_next;else head=owner->retirement_next;
                struct wpk_drm_owner *tail=head;while(tail->retirement_next)tail=tail->retirement_next;
                tail->retirement_next=owner;owner->retirement_next=NULL;
                atomic_store_explicit(&retired_owners,head,memory_order_release);
            }
        }
        capture_publication_end();
        if(!owner)break;
        if(release_owned_receiver(&owner,1)!=0){
            int error=errno;
            if(owner)unclaim_retirement(owner,epoch);
            if(diagnose)diagnose_retirement(error,owner!=NULL);
        }
    }
}
void _wpk_drm_owned_drain(void) {
    int prior_errno=errno,cancel_state;
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    drain_retirements(1);
    errno=prior_errno;pthread_setcancelstate(cancel_state,NULL);
}
void _wpk_drm_owned_retire(struct wpk_drm_owner **pointer) {
    if(!pointer||!*pointer)return;
    int prior_errno=errno,cancel_state;
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    uint64_t epoch=process_epoch();
    capture_publication_begin();
    struct wpk_drm_owner *owner=*pointer;
    _wpk_drm_owned_defer_locked(pointer);
    /* Publish custody before even the first native cleanup attempt. The
     * first call can block too; a vanished thread's stack is never a root. */
    if(owner->retirement_claim_epoch!=epoch)owner->retirement_claim_epoch=epoch;
    else owner=NULL;
    capture_publication_end();
    if(owner&&release_owned_receiver(&owner,1)!=0){
        int error=errno;
        if(owner)unclaim_retirement(owner,epoch);
        diagnose_retirement(error,owner!=NULL);
    }
    /* Preserve the existing first attempt plus one bounded retry pass. Only
     * cold lifetime paths inspect this queue, never draw/query entry points. */
    drain_retirements(0);
    errno=prior_errno;pthread_setcancelstate(cancel_state,NULL);
}

/* A fork copies memory, not the parent's surviving threads. Tagging the
 * whole lock word lets a child atomically acquire a new unlocked generation
 * even if a vanished thread held the old one. Resetting pthread internals or
 * taking all driver locks from atfork would break portability or invert the
 * existing context/group lock order. No native lock representation crosses
 * this private metadata boundary. */
static uint64_t metadata_epoch(void) {
    uint64_t epoch=process_epoch();
    /* The kernel's monotonic signed task-ID space is exhausted long before
     * this process-local fork generation could use the reserved lock bits. */
    if(!epoch||epoch>(UINT64_MAX>>2))abort();return epoch<<2;
}
static void metadata_wait(struct wpk_drm_mutex *mutex,uint64_t expected) {
#if defined(__wasm__)
    /* Public syscall() consumes long-width varargs on both guest widths;
     * raw int constants would misalign wasm64's following operands. Futex
     * compares the low 32-bit word of this little-endian atomic lock. */
    long rc=syscall(SYS_futex,(long)(uintptr_t)&mutex->state,(long)0,(long)(uint32_t)expected,(long)0,(long)0,(long)0);
    if(rc<0&&errno!=EINTR&&errno!=EAGAIN)abort();
#else
    /* Native source controls do not implement Kandelo's futex syscall.
     * Product Node and browser guests both take the parking path above. */
    (void)mutex;(void)expected;sched_yield();
#endif
}
static void metadata_wake(struct wpk_drm_mutex *mutex) {
#if defined(__wasm__)
    if(syscall(SYS_futex,(long)(uintptr_t)&mutex->state,(long)1,(long)INT_MAX,(long)0,(long)0,(long)0)<0)abort();
#else
    (void)mutex;
#endif
}
void _wpk_drm_mutex_lock(struct wpk_drm_mutex *mutex) {
    uint64_t epoch=metadata_epoch();
    uint64_t state=atomic_load_explicit(&mutex->state,memory_order_relaxed);
    for(;;){
        if((state&~UINT64_C(3))!=epoch||!(state&3)){
            if(atomic_compare_exchange_weak_explicit(&mutex->state,&state,epoch|1,
                    memory_order_acquire,memory_order_relaxed))return;
            continue;
        }
        if((state&3)==3)abort();
        if((state&3)==1&&!atomic_compare_exchange_weak_explicit(&mutex->state,&state,epoch|2,
                memory_order_relaxed,memory_order_relaxed))continue;
        /* Unlock before wait is safe: the kernel compares the same low
         * word and returns EAGAIN instead of losing that wakeup. A signal
         * or spurious wake always rechecks authority and lock state. */
        metadata_wait(mutex,epoch|2);
        state=atomic_load_explicit(&mutex->state,memory_order_relaxed);
    }
}
void _wpk_drm_mutex_unlock(struct wpk_drm_mutex *mutex) {
    uint64_t epoch=metadata_epoch();
    uint64_t prior=atomic_exchange_explicit(&mutex->state,epoch,memory_order_release);
    if((prior&~UINT64_C(3))!=epoch||!(prior&3))abort();
    if((prior&3)==2)metadata_wake(mutex);
}




/* Heap scopes outlive their thread whenever a published cleanup claim still
 * names them. TLS addresses and process epochs cannot distinguish a vanished
 * peer from the fork caller whose callback stack continues in the child. */
struct wpk_drm_actor_scope {
    struct wpk_drm_actor_scope *next;
    size_t references;
    int alive;
};
static struct wpk_drm_actor_scope *actor_scopes;
static _Thread_local struct wpk_drm_actor_scope *actor_current_scope;
static pthread_key_t actor_scope_key;
static pthread_once_t actor_scope_once=PTHREAD_ONCE_INIT;
static int actor_scope_status=EAGAIN;
static void actor_drop_locked(struct wpk_drm_actor_scope *scope) {
    if(!scope->references)abort();
    if(--scope->references)return;
    if(scope->alive)abort();
    struct wpk_drm_actor_scope **link=&actor_scopes;
    while(*link&&*link!=scope)link=&(*link)->next;
    if(!*link)abort();
    *link=scope->next;free(scope);
}
static void actor_scope_ended(void *opaque) {
    struct wpk_drm_actor_scope *scope=opaque;
    capture_publication_begin();
    /* The key argument is authoritative during thread teardown. A native
     * libc may already have torn down compiler TLS before invoking keys. */
    if(!scope->alive)abort();
    actor_current_scope=NULL;scope->alive=0;
    /* Claims retain their own refs. pthread_exit/cancellation cannot make
     * their identity dangle or leave an abandoned callback permanently busy. */
    actor_drop_locked(scope);
    capture_publication_end();
}
static void actor_child_fork(void) {
    /* Registration follows the publication handler, so its child unlock has
     * already run. The child has no peer threads: this is metadata only and
     * deliberately performs no free, I/O, key mutation or receiver locking. */
    /* Read an already-installed key, not first-use compiler TLS. There is
     * no prepare snapshot to allocate storage or race another fork caller. */
    struct wpk_drm_actor_scope *caller=pthread_getspecific(actor_scope_key);
    for(struct wpk_drm_actor_scope *scope=actor_scopes;scope;scope=scope->next){
        if(scope->alive&&scope!=caller){
            if(!scope->references)abort();
            scope->alive=0;--scope->references; /* vanished TLS reference */
        }
    }
}
static void actor_scope_initialize(void) {
    actor_scope_status=pthread_key_create(&actor_scope_key,actor_scope_ended);
    if(actor_scope_status)return;
    actor_scope_status=pthread_atfork(NULL,NULL,actor_child_fork);
    if(actor_scope_status)pthread_key_delete(actor_scope_key);
}
static int actor_prepare_failed(int error) {
    /* No cleanup claim is consumed on failure. Returning apparent success
     * would hide a permanently unreachable receiver behind a void destructor. */
    fprintf(stderr,"Kandelo graphics: durable cleanup actor preparation failed (%d); cleanup not entered\n",error);
    errno=error;return 0;
}
static void actor_sweep_locked(void) {
    struct wpk_drm_actor_scope **link=&actor_scopes;
    while(*link){
        struct wpk_drm_actor_scope *scope=*link;
        if(!scope->references){
            if(scope->alive)abort();
            *link=scope->next;free(scope);
        }else link=&scope->next;
    }
}
int _wpk_drm_actor_prepare(void) {
    int cancel_state,error=0;
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    if(actor_current_scope){
        capture_publication_begin();actor_sweep_locked();capture_publication_end();
        pthread_setcancelstate(cancel_state,NULL);return 1;
    }
    if(!process_epoch()||!prepare_capture_publication())error=errno?errno:ENOMEM;
    else if(pthread_once(&actor_scope_once,actor_scope_initialize))error=EAGAIN;
    else if(actor_scope_status)error=actor_scope_status;
    if(!error){
        capture_publication_begin();
        /* Child handlers leave zero-ref vanished scopes for ordinary code.
         * Reclaiming here keeps atfork free of allocator/native cleanup work. */
        actor_sweep_locked();
        struct wpk_drm_actor_scope *scope=calloc(1,sizeof *scope);
        if(!scope)error=ENOMEM;
        else {
            /* Key installation and list publication form one pure metadata
             * step. A fork cannot see a surviving caller's new scope before
             * the key used by its child handler identifies that same scope. */
            error=pthread_setspecific(actor_scope_key,scope);
            if(error)free(scope);
            else {
                scope->alive=1;scope->references=1;scope->next=actor_scopes;
                actor_scopes=scope;actor_current_scope=scope;
            }
        }
        capture_publication_end();
    }
    pthread_setcancelstate(cancel_state,NULL);
    return error?actor_prepare_failed(error):1;
}
int _wpk_drm_actor_claim_live_locked(const struct wpk_drm_actor_claim *claim) {
    return claim&&claim->scope&&claim->scope->alive;
}
int _wpk_drm_actor_claim_current_locked(const struct wpk_drm_actor_claim *claim) {
    /* Metadata only: callers already hold publication and retain the claim.
     * Preparing an actor here could allocate or recurse under that guard. */
    return claim&&claim->scope&&claim->scope==actor_current_scope&&
        claim->scope->alive;
}
int _wpk_drm_actor_try_claim_locked(struct wpk_drm_actor_claim *claim) {
    if(!claim||!actor_current_scope||!actor_current_scope->alive)abort();
    if(_wpk_drm_actor_claim_live_locked(claim))return 0;
    struct wpk_drm_actor_scope *prior=claim->scope;
    if(actor_current_scope->references==SIZE_MAX)abort();
    ++actor_current_scope->references;claim->scope=actor_current_scope;
    if(prior)actor_drop_locked(prior);
    return 1;
}
void _wpk_drm_actor_release_locked(struct wpk_drm_actor_claim *claim) {
    if(!claim||!claim->scope)return;
    struct wpk_drm_actor_scope *scope=claim->scope;
    claim->scope=NULL;actor_drop_locked(scope);
}
