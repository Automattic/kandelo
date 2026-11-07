/* Source-level peer of the private endpoint, not an implementation of a guest
 * syscall. Actual Rust and normal SDK fixtures separately judge the kernel.
 * Fixed-capacity custody is reserved before effects so allocation failures in
 * the tested C receiver cannot make an accepted resource disappear. */
#include "owned-resource-peer.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <string.h>
#include <sys/mman.h>
#define PEER_MAX 1024
struct peer_bo {struct graphics_peer_file *file;uint32_t handle,refs;uint64_t storage;struct wpk_drm_bo_info info;};
struct peer_cap {struct graphics_peer_file *file;struct peer_bo *bo;int live,receipt,borrowed;uint64_t tx;struct wpk_drm_owned_packet reply;};
struct peer_cold {int live;uint64_t nonce;struct wpk_drm_owned_packet reply;};
static struct peer_cap caps[PEER_MAX];
static struct peer_bo bos[PEER_MAX];
static struct peer_cold cold[PEER_MAX];
static uint32_t last_cap;
static unsigned effects;
static pthread_mutex_t peer_lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t peer_idle=PTHREAD_COND_INITIALIZER;
static pthread_once_t fork_once=PTHREAD_ONCE_INIT;
static const struct graphics_peer_ops *active_ops;
static unsigned in_flight;
static void peer_fork_prepare(void){pthread_mutex_lock(&peer_lock);while(in_flight)pthread_cond_wait(&peer_idle,&peer_lock);}
static void peer_fork_parent(void){pthread_mutex_unlock(&peer_lock);}
static void peer_fork_child(void){
    /* Fork copies receipt metadata, never a parent's execution. The entry
     * barrier excludes partially applied native effects from this snapshot. */
    if(active_ops->fork_child)active_ops->fork_child();
    if(active_ops->bo_retain)for(unsigned i=0;i<PEER_MAX;i++)if(bos[i].refs)active_ops->bo_retain(bos[i].file,bos[i].handle,bos[i].storage);
    pthread_mutex_unlock(&peer_lock);peer_idle=(pthread_cond_t)PTHREAD_COND_INITIALIZER;
}
static void peer_register_fork(void){assert(!pthread_atfork(peer_fork_prepare,peer_fork_parent,peer_fork_child));}

unsigned graphics_peer_lose_action,graphics_peer_lose_reads;
static void complete(struct wpk_drm_owned_packet *p){p->state=WPK_DRM_OWNED_COMPLETE;p->magic=WPK_DRM_OWNED_MAGIC;p->reserved=0;}
static uint32_t mint(const struct graphics_peer_ops *ops,struct graphics_peer_file *file,struct peer_bo *bo){
    assert(last_cap+1<PEER_MAX);uint32_t token=++last_cap;
    caps[token]=(struct peer_cap){.file=file,.bo=bo,.live=1,.borrowed=-1};ops->retain(file);if(bo)bo->refs++;return token;
}
static struct peer_bo *capture_bo(const struct graphics_peer_ops *ops,struct graphics_peer_file *file,uint32_t handle){
    uint64_t storage=0;struct wpk_drm_bo_info info;
    assert(!ops->bo_info(file,handle,&storage,&info)&&storage);
    /* A GEM name can disappear and be reused while an accepted BO remains
     * alive. Coalescing on the scalar name would silently retarget custody. */
    for(unsigned i=0;i<PEER_MAX;i++)if(bos[i].refs&&bos[i].file==file&&bos[i].handle==handle&&bos[i].storage==storage)return &bos[i];
    for(unsigned i=0;i<PEER_MAX;i++)if(!bos[i].refs){
        bos[i]=(struct peer_bo){.file=file,.handle=handle,.storage=storage,.info=info};
        if(ops->bo_retain)ops->bo_retain(file,handle,storage);return &bos[i];
    }
    assert(!"native peer BO capacity exhausted before effect");return NULL;
}
static struct peer_cold *find_cold(uint64_t nonce){for(unsigned i=0;i<PEER_MAX;i++)if(cold[i].live&&cold[i].nonce==nonce)return &cold[i];return NULL;}
unsigned graphics_peer_live_capabilities(void){unsigned count=0;for(unsigned i=1;i<=last_cap;i++)count+=caps[i].live;return count;}
unsigned graphics_peer_effects(void){return effects;}
int graphics_peer_ioctl(const struct graphics_peer_ops *ops,struct wpk_drm_owned_packet *p){
    assert(p->version==1&&p->transaction&&p->length<=256&&!p->magic&&!p->state&&!p->reserved);
    pthread_mutex_lock(&peer_lock);assert(!active_ops||active_ops==ops);
    if(!active_ops){active_ops=ops;pthread_once(&fork_once,peer_register_fork);}
    uint32_t action=p->action;int dispatched=0;
    if(action==WPK_DRM_OWNED_READ_LAST){
        if(graphics_peer_lose_reads){graphics_peer_lose_reads--;pthread_mutex_unlock(&peer_lock);errno=EIO;return -1;}
        struct wpk_drm_owned_packet *saved=NULL;
        if(!p->token){struct peer_cold *c=find_cold(p->transaction);if(c)saved=&c->reply;}
        else if(p->token<=last_cap&&caps[p->token].receipt&&caps[p->token].tx==p->transaction)saved=&caps[p->token].reply;
        /* A receipt proves the earlier allocation completed, but cannot
         * republish an alias now owned by another OFD. Recovery is read-only;
         * allocating a replacement here would replay a consumed operation. */
        if(saved){*p=*saved;if(p->action==WPK_DRM_OWNED_DUP_FD&&p->result>=0&&!ops->alias_matches(caps[p->token].file,p->result))p->result=-EBADF;}
        else{p->state=WPK_DRM_OWNED_ABSENT;p->result=-ENOENT;p->magic=WPK_DRM_OWNED_MAGIC;}
        pthread_mutex_unlock(&peer_lock);return 0;
    }
    if(action==WPK_DRM_OWNED_ACK){
        if(!p->token){struct peer_cold *c=find_cold(p->transaction);if(c)c->live=0;}
        else{assert(p->token<=last_cap);if(caps[p->token].tx==p->transaction)caps[p->token].receipt=0;}
        p->result=0;complete(p);pthread_mutex_unlock(&peer_lock);return 0;
    }
    assert(last_cap+2<PEER_MAX); /* constructor and child receipt reserved */
    if(action==WPK_DRM_OWNED_OPEN||action==WPK_DRM_OWNED_ACQUIRE){
        assert(!p->token&&!find_cold(p->transaction));struct peer_cold *c=NULL;
        for(unsigned i=0;i<PEER_MAX;i++)if(!cold[i].live){c=&cold[i];break;}assert(c);
        struct graphics_peer_file *file=action==WPK_DRM_OWNED_OPEN?ops->open(p->request):ops->acquire(p->fd,p->flags);
        /* acquire/open return one temporary custody reference; the minted cap
         * owns a separate reference before the temporary is relinquished. */
        p->token=file?mint(ops,file,NULL):0;p->result=file?0:-errno;if(file)ops->release(file);
        complete(p);*c=(struct peer_cold){.live=1,.nonce=p->transaction,.reply=*p};effects++;
    }else{
        assert(p->token&&p->token<=last_cap);struct peer_cap *cap=&caps[p->token];
        assert(cap->live&&p->transaction==cap->tx+1&&p->acknowledge==cap->tx);
        uint32_t source_token=p->source_token;
        struct graphics_peer_file *source=NULL;if(p->source_token){assert(p->source_token<=last_cap&&caps[p->source_token].live);source=caps[p->source_token].file;}
        int result=0;p->source_token=0;
        if(action==WPK_DRM_OWNED_IOCTL){
            assert(!cap->bo);uint32_t canonical=p->length,proof_count=0;struct graphics_peer_binding proofs[4];
            if(p->flags&WPK_DRM_OWNED_BO_BINDINGS){
                /* Canonical sizes come from the packet's appended trailer:
                 * accept exactly one unambiguous count/length, then verify
                 * every proof against the held file and original handle. */
                unsigned found=0;
                for(unsigned count=1;count<=4;count++)if(p->length>=4+8*count){
                    uint32_t n,offset=p->length-4-8*count;memcpy(&n,p->body+offset,4);
                    if(n!=count)continue;int valid=1;
                    for(unsigned i=0;i<count;i++){uint32_t at,token,handle;memcpy(&at,p->body+offset+4+i*8,4);memcpy(&token,p->body+offset+8+i*8,4);
                        if(at>offset||offset-at<4||!token||token>last_cap||!caps[token].live||!caps[token].bo||caps[token].file!=cap->file){valid=0;break;}
                        memcpy(&handle,p->body+at,4);if(handle!=caps[token].bo->handle){valid=0;break;}}
                    if(valid){canonical=offset;found++;proof_count=count;
                        for(unsigned i=0;i<count;i++){uint32_t at,token;memcpy(&at,p->body+offset+4+i*8,4);memcpy(&token,p->body+offset+8+i*8,4);proofs[i]=(struct graphics_peer_binding){at,caps[token].bo->handle,caps[token].bo->storage};}
                    }
                }assert(found==1);
            }
            in_flight++;dispatched=1;pthread_mutex_unlock(&peer_lock);
            result=ops->ioctl(cap->file,p->request,p->body,canonical,source,proofs,proof_count);int operation_errno=errno;
            pthread_mutex_lock(&peer_lock);errno=operation_errno;effects++;
            if(result>=0&&(p->flags&WPK_DRM_OWNED_CAPTURE_BO)){
                uint32_t handle=0;
                if(p->request==UINT32_C(0xc01064e0))memcpy(&handle,p->body+8,4);
                else if(p->request==UINT32_C(0xc02064b2))memcpy(&handle,p->body+16,4);
                else if(p->request==UINT32_C(0xc03064e3))memcpy(&handle,p->body+16,4);
                else memcpy(&handle,p->body,4);
                assert(handle);p->source_token=mint(ops,cap->file,capture_bo(ops,cap->file,handle));
            }else if(result>=0&&(p->flags&WPK_DRM_OWNED_CAPTURE_FD)){
                int fd;memcpy(&fd,p->body+8,4);struct graphics_peer_file *captured=ops->acquire(fd,0);assert(captured);
                p->source_token=mint(ops,captured,NULL);assert(!ops->close_alias(captured,fd));ops->release(captured);
            }
        }else if(action==WPK_DRM_OWNED_MMAP){
            /* Native construction finishes in this entry. READ_LAST only
             * copies this receipt; it cannot remap or overwrite later data.
             * Host staged-map finalization has separate actual adapter tests. */
            uint64_t address,length;int64_t offset;uint32_t prot,flags;
            memcpy(&address,p->body,8);memcpy(&length,p->body+8,8);memcpy(&offset,p->body+16,8);memcpy(&prot,p->body+24,4);memcpy(&flags,p->body+28,4);
            uint32_t handle=0;uint64_t storage=0;/* source resolved before zeroing output */
            if(source){assert(caps[source_token].bo&&source==cap->file);handle=caps[source_token].bo->handle;storage=caps[source_token].bo->storage;}
            void *mapped=ops->map(cap->file,address,length,offset,prot,flags,handle,storage);
            result=mapped==MAP_FAILED?-1:0;address=(uintptr_t)mapped;memcpy(p->body,&address,8);effects++;
        }else if(action==WPK_DRM_OWNED_BO_INFO){assert(cap->bo&&p->length==32);memcpy(p->body,&cap->bo->info,32);}
        else if(action==WPK_DRM_OWNED_DUP_FD){
            assert(!cap->bo);int previous=p->fd;if(p->flags&WPK_DRM_OWNED_BORROW_ALIAS&&cap->borrowed>=0)previous=cap->borrowed;
            result=ops->duplicate(cap->file,previous,!!(p->flags&WPK_DRM_OWNED_BORROW_ALIAS));
            if(result>=0&&(p->flags&WPK_DRM_OWNED_BORROW_ALIAS))cap->borrowed=result;effects++;
        }else if(action==WPK_DRM_OWNED_RELEASE||action==WPK_DRM_OWNED_BO_RELEASE){
            assert(!!cap->bo==(action==WPK_DRM_OWNED_BO_RELEASE));
            if(cap->borrowed>=0&&ops->alias_matches(cap->file,cap->borrowed))assert(!ops->close_alias(cap->file,cap->borrowed));
            if(cap->bo){assert(cap->bo->refs);if(!--cap->bo->refs)result=ops->bo_release(cap->file,cap->bo->handle,cap->bo->storage);}
            int saved_errno=errno;int released=ops->release(cap->file);if(result>=0){result=released;saved_errno=errno;}errno=saved_errno;
            cap->live=0;p->source_token=1;effects++;
        }else if(action==WPK_DRM_OWNED_POLL){
            uint32_t events,revents=0;int32_t timeout;memcpy(&events,p->body,4);memcpy(&timeout,p->body+8,4);
            result=ops->poll(cap->file,events,timeout,&revents);memcpy(p->body+4,&revents,4);memset(p->body+12,0,4);
        }else assert(!"unexpected owned native peer action");
        p->result=result<0?-errno:result;complete(p);cap->tx=p->transaction;cap->receipt=1;cap->reply=*p;
    }
    if(dispatched){assert(in_flight);in_flight--;pthread_cond_broadcast(&peer_idle);}
    if(graphics_peer_lose_action==action){graphics_peer_lose_action=0;pthread_mutex_unlock(&peer_lock);errno=EIO;return -1;}
    pthread_mutex_unlock(&peer_lock);return 0;
}
