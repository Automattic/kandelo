/* An independent device-peer model judges the C receiver's custody and
 * no-replay behavior. Rust integration tests own actual OFD/BO semantics. */
#include "drm_owned.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#undef calloc
#undef free
#undef ioctl
static unsigned allocations,deny_allocation;
void *owned_calloc(size_t n,size_t bytes){if(deny_allocation){errno=ENOMEM;return NULL;}void *p=calloc(n,bytes);if(p)allocations++;return p;}
void owned_free(void *p){if(p){assert(allocations);allocations--;}free(p);}
struct cap {int live,bo,receipt;unsigned ofd;int borrowed;uint64_t transaction;struct wpk_drm_owned_packet reply;};
struct cold {uint64_t nonce;int live;struct wpk_drm_owned_packet reply;};
static struct cap caps[64];static struct cold colds[64];
static unsigned next_cap,ofd_sequence,open_entries,release_entries,bo_release_entries,native_effects,read_entries,fd_entries;
static unsigned lost_action,before_action,read_failures,ack_loss,corrupt_action,replace_fd_after,consume_error,release_preflight_error,release_consumed_error;
static unsigned aliases[128];static int next_fd=10;
static pthread_mutex_t peer_mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t peer_condition=PTHREAD_COND_INITIALIZER;
static int pause_io,io_entered,io_release,cancel_on_open,pause_poll,poll_entered;
static unsigned poll_cancels;
static struct wpk_drm_mutex metadata_mutex=WPK_DRM_MUTEX_INITIALIZER;
static unsigned metadata_counter;
static void *metadata_increment(void *unused){
    (void)unused;for(unsigned i=0;i<10000;i++){_wpk_drm_mutex_lock(&metadata_mutex);metadata_counter++;_wpk_drm_mutex_unlock(&metadata_mutex);}return NULL;
}
static void *metadata_held(void *unused){
    (void)unused;_wpk_drm_mutex_lock(&metadata_mutex);
    pthread_mutex_lock(&peer_mutex);io_entered=1;pthread_cond_broadcast(&peer_condition);
    while(!io_release)pthread_cond_wait(&peer_condition,&peer_mutex);
    pthread_mutex_unlock(&peer_mutex);_wpk_drm_mutex_unlock(&metadata_mutex);return NULL;
}
static void peer_after_fork(void){pause_io=0;}

static void peer_unlock(void *unused){(void)unused;pthread_mutex_unlock(&peer_mutex);}
static struct cold *find_cold(uint64_t nonce){for(unsigned i=0;i<64;i++)if(colds[i].live&&colds[i].nonce==nonce)return &colds[i];return NULL;}
static unsigned create_cap(int bo,unsigned ofd){assert(next_cap+1<64);unsigned token=++next_cap;caps[token].live=1;caps[token].bo=bo;caps[token].ofd=ofd?ofd:++ofd_sequence;caps[token].borrowed=-1;return token;}
static unsigned live_caps(void){unsigned n=0;for(unsigned i=1;i<=next_cap;i++)n+=caps[i].live;return n;}
static void complete(struct wpk_drm_owned_packet *p){p->version=WPK_DRM_OWNED_VERSION;p->state=WPK_DRM_OWNED_COMPLETE;p->magic=WPK_DRM_OWNED_MAGIC;p->reserved=0;}
int owned_ioctl(int fd,unsigned long request,...){
    assert(fd==-1&&request==WPK_DRM_IOCTL_OWNED_RESOURCE);
    va_list args;va_start(args,request);struct wpk_drm_owned_packet *p=va_arg(args,void*);va_end(args);
    assert(p->version==1&&p->transaction&&p->length<=256&&!p->state&&!p->magic&&!p->reserved);
    pthread_mutex_lock(&peer_mutex);
    unsigned action=p->action;
    if(before_action==action){before_action=0;pthread_mutex_unlock(&peer_mutex);errno=EAGAIN;return -1;}
    if(action==WPK_DRM_OWNED_READ_LAST){
        read_entries++;
        if(read_failures){read_failures--;pthread_mutex_unlock(&peer_mutex);errno=EIO;return -1;}
        struct wpk_drm_owned_packet *saved=NULL;
        if(!p->token){struct cold *c=find_cold(p->transaction);if(c)saved=&c->reply;}
        else if(p->token<=next_cap&&caps[p->token].receipt&&caps[p->token].transaction==p->transaction)saved=&caps[p->token].reply;
        if(saved){
            *p=*saved;
            if(p->action==WPK_DRM_OWNED_DUP_FD&&p->result>=0&&aliases[p->result]!=caps[p->token].ofd)p->result=-EBADF;
        }else{p->state=WPK_DRM_OWNED_ABSENT;p->result=-ENOENT;p->magic=WPK_DRM_OWNED_MAGIC;}
        pthread_mutex_unlock(&peer_mutex);return 0;
    }
    if(action==WPK_DRM_OWNED_CANCEL_POLL){
        struct cap *cap=&caps[p->token];assert(cap->live&&cap->receipt&&cap->transaction==p->transaction&&cap->reply.action==WPK_DRM_OWNED_POLL);
        cap->reply.state=WPK_DRM_OWNED_COMPLETE;cap->reply.result=-EINTR;memset(cap->reply.body+12,0,4);*p=cap->reply;
        poll_cancels++;pthread_mutex_unlock(&peer_mutex);return 0;
    }
    if(action==WPK_DRM_OWNED_ACK){
        if(!p->token){struct cold *c=find_cold(p->transaction);if(c)c->live=0;}
        else{assert(p->token<=next_cap);if(caps[p->token].transaction==p->transaction)caps[p->token].receipt=0;}
        p->result=0;complete(p);
        if(ack_loss){ack_loss--;pthread_mutex_unlock(&peer_mutex);errno=EIO;return -1;}
        pthread_mutex_unlock(&peer_mutex);return 0;
    }
    if(action==WPK_DRM_OWNED_OPEN||action==WPK_DRM_OWNED_ACQUIRE){
        open_entries++;assert(!p->token&&!find_cold(p->transaction));
        struct cold *c=NULL;for(unsigned i=0;i<64;i++)if(!colds[i].live){c=&colds[i];break;}assert(c);
        p->result=0;
        if(action==WPK_DRM_OWNED_ACQUIRE&&p->fd<0){p->result=-EBADF;p->token=0;}
        else p->token=create_cap(0,0);
        if(consume_error){consume_error=0;p->result=-EIO;}
        complete(p);c->nonce=p->transaction;c->live=1;c->reply=*p;
    }else{
        assert(p->token&&p->token<=next_cap);struct cap *cap=&caps[p->token];
        assert(cap->live&&p->transaction==cap->transaction+1&&p->acknowledge==cap->transaction);
        p->result=0;
        if(action==WPK_DRM_OWNED_IOCTL){
            assert(!cap->bo);
            if(pause_io&&p->token==1){io_entered=1;pthread_cond_broadcast(&peer_condition);while(!io_release)pthread_cond_wait(&peer_condition,&peer_mutex);}
            native_effects++;
            if(p->flags&WPK_DRM_OWNED_BO_BINDINGS){
                uint32_t count;memcpy(&count,p->body+16,4);assert(count==4&&p->length==52);
                for(uint32_t i=0;i<count;i++){
                    uint32_t off,token;memcpy(&off,p->body+20+i*8,4);memcpy(&token,p->body+24+i*8,4);
                    assert(off==i*4&&token<=next_cap&&caps[token].live&&caps[token].bo);
                }
            }
            uint32_t value;assert(p->length>=4);memcpy(&value,p->body,4);value+=7;memcpy(p->body,&value,4);
            if(p->flags&(WPK_DRM_OWNED_CAPTURE_BO|WPK_DRM_OWNED_CAPTURE_FD))p->source_token=create_cap(!!(p->flags&WPK_DRM_OWNED_CAPTURE_BO),0);
        }else if(action==WPK_DRM_OWNED_MMAP){uint64_t mapped=UINT64_C(0x123456780);assert(p->length==32);memcpy(p->body,&mapped,8);}
        else if(action==WPK_DRM_OWNED_POLL){
            assert(!cap->bo&&p->length==16);
            if(pause_poll){
                cap->transaction=p->transaction;cap->reply=*p;cap->reply.state=WPK_DRM_OWNED_PENDING;cap->reply.magic=WPK_DRM_OWNED_MAGIC;cap->receipt=1;
                poll_entered=1;pthread_cond_broadcast(&peer_condition);
                pthread_cleanup_push(peer_unlock,NULL);
                while(pause_poll)pthread_cond_wait(&peer_condition,&peer_mutex);
                pthread_cleanup_pop(0);
            }
            uint32_t events=1;memcpy(p->body+4,&events,4);p->result=1;
        }else if(action==WPK_DRM_OWNED_BO_INFO){
            assert(cap->bo&&p->length==32);struct wpk_drm_bo_info info={4096,32,32,128,0x34325241,0,0};memcpy(p->body,&info,32);
        }else if(action==WPK_DRM_OWNED_DUP_FD){
            assert(!cap->bo);fd_entries++;
            if(p->fd>=0&&aliases[p->fd]==cap->ofd)p->result=p->fd;
            else{assert(next_fd<128);p->result=next_fd++;aliases[p->result]=cap->ofd;}
            if(p->flags&WPK_DRM_OWNED_BORROW_ALIAS)cap->borrowed=p->result;
        }else if(action==WPK_DRM_OWNED_RELEASE||action==WPK_DRM_OWNED_BO_RELEASE){
            assert(cap->bo==(action==WPK_DRM_OWNED_BO_RELEASE));
            if(release_preflight_error){release_preflight_error=0;p->result=-EAGAIN;p->source_token=0;}
            else{cap->live=0;p->source_token=1;
                if(cap->borrowed>=0&&aliases[cap->borrowed]==cap->ofd)aliases[cap->borrowed]=0;if(cap->bo)bo_release_entries++;else release_entries++;
                if(release_consumed_error){release_consumed_error=0;p->result=-EIO;}}

        }else assert(!"unexpected private owner operation");
        complete(p);cap->transaction=p->transaction;cap->reply=*p;cap->receipt=1;
    }
    if(replace_fd_after&&action==WPK_DRM_OWNED_DUP_FD){replace_fd_after=0;aliases[p->result]=999;}
    if(corrupt_action==action){corrupt_action=0;p->action=99;p->transaction+=42;}
    if(lost_action==action){lost_action=0;pthread_mutex_unlock(&peer_mutex);errno=EIO;return -1;}
    int cancel=cancel_on_open&&action==WPK_DRM_OWNED_OPEN;cancel_on_open=0;
    pthread_mutex_unlock(&peer_mutex);if(cancel)pthread_cancel(pthread_self());return 0;
}
static void release_owner(struct wpk_drm_owner **owner){assert(_wpk_drm_owned_release(owner)==0&&!*owner);}
static void *blocked_io(void *pointer){uint32_t value=1;assert(_wpk_drm_owned_ioctl(pointer,0x1234,&value,4,NULL,0,NULL)==0&&value==8);return NULL;}
static void cancel_cleanup(void *pointer){struct wpk_drm_owner **owner=pointer;release_owner(owner);}
static void *canceled_open(void *pointer){struct wpk_drm_owner **owner=pointer;pthread_cleanup_push(cancel_cleanup,owner);(void)_wpk_drm_owned_open(1,owner);pthread_testcancel();pthread_cleanup_pop(1);return NULL;}
static void *canceled_poll(void *pointer){
    struct wpk_drm_owner *owner=pointer;uint32_t revents=0;
    pthread_cleanup_push(cancel_cleanup,&owner);
    (void)_wpk_drm_owned_poll(owner,1,-1,&revents);
    pthread_cleanup_pop(1);return NULL;
}
int main(int argc,char **argv){
    assert(argc==2);const char *name=argv[1];struct wpk_drm_owner *owner=NULL,*capture=NULL;
    if(!strcmp(name,"cold-nonentry")){before_action=1;assert(_wpk_drm_owned_open(1,&owner)==-1&&!owner&&open_entries==0&&read_entries==1);}
    else if(!strcmp(name,"cold-loss")||!strcmp(name,"cold-unknown")||!strcmp(name,"cold-corrupt")||!strcmp(name,"cold-ack")){
        if(!strcmp(name,"cold-corrupt"))corrupt_action=1;else if(!strcmp(name,"cold-ack"))ack_loss=1;else lost_action=1;
        if(!strcmp(name,"cold-unknown"))read_failures=1;
        int rc=_wpk_drm_owned_open(1,&owner);assert(owner&&open_entries==1&&live_caps()==1);
        assert(rc==((read_failures||!strcmp(name,"cold-unknown")||!strcmp(name,"cold-ack"))?-1:0));
        release_owner(&owner);assert(open_entries==1&&release_entries==1);
    }else if(!strcmp(name,"consume-error")){
        consume_error=1;assert(_wpk_drm_owned_acquire(10,WPK_DRM_OWNED_CONSUME_FD,&owner)==-1&&owner&&errno==EIO&&live_caps()==1);release_owner(&owner);
    }else if(!strcmp(name,"invalid-acquire")){assert(_wpk_drm_owned_acquire(-5,0,&owner)==-1&&!owner&&errno==EBADF&&live_caps()==0);}
    else if(!strcmp(name,"cancellation")){
        cancel_on_open=1;pthread_t thread;assert(!pthread_create(&thread,NULL,canceled_open,&owner));void *result;assert(!pthread_join(thread,&result)&&result==PTHREAD_CANCELED);assert(!owner&&release_entries==1);
    }else{
        assert(_wpk_drm_owned_open(1,&owner)==0&&owner&&live_caps()==1);
        if(!strcmp(name,"release-live-error")){
            release_preflight_error=1;assert(_wpk_drm_owned_release(&owner)==-1&&owner&&errno==EAGAIN&&release_entries==0&&live_caps()==1);release_owner(&owner);assert(release_entries==1);
        }else if(!strcmp(name,"release-consumed-error")){
            release_consumed_error=1;assert(_wpk_drm_owned_release(&owner)==-1&&!owner&&errno==EIO&&release_entries==1&&live_caps()==0);
        }else if(!strcmp(name,"release-loss")||!strcmp(name,"release-unknown")||!strcmp(name,"release-ack")){
            if(!strcmp(name,"release-ack"))ack_loss=1;else lost_action=5;
            if(!strcmp(name,"release-unknown"))read_failures=1;
            int rc=_wpk_drm_owned_release(&owner);
            if(!strcmp(name,"release-loss"))assert(rc==0&&!owner);
            else{assert(rc==-1&&owner);release_owner(&owner);}
            assert(release_entries==1);
        }else if(!strcmp(name,"io-loss")){
            uint32_t value=5;lost_action=3;assert(_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,0,NULL)==0&&value==12&&native_effects==1);release_owner(&owner);
        }else if(!strcmp(name,"capture-unknown")||!strcmp(name,"capture-nonentry")||!strcmp(name,"capture-absent")){
            uint32_t value=5;
            if(!strcmp(name,"capture-unknown"))lost_action=3;else before_action=3;
            if(strcmp(name,"capture-nonentry"))read_failures=1;
            assert(_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&capture)==-1);
            if(!strcmp(name,"capture-nonentry"))assert(!capture&&!native_effects);
            else{assert(capture);release_owner(&capture);}
            assert(bo_release_entries==(!strcmp(name,"capture-unknown")?1u:0u));release_owner(&owner);
        }else if(!strcmp(name,"capture-parent-first")){
            uint32_t value=5;lost_action=3;read_failures=1;
            assert(_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&capture)==-1&&capture);
            release_owner(&owner);assert(!owner&&live_caps()==2);
            release_owner(&capture);assert(bo_release_entries==1&&release_entries==1);
        }else if(!strcmp(name,"captured-fd")){
            uint32_t value=5;assert(_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_FD,&capture)==0&&capture);
            /* A known captured file has its own exact kernel pin. The C parent
             * may retire immediately; child operations must remain valid. */
            release_owner(&owner);assert(live_caps()==1&&release_entries==1);
            value=5;assert(_wpk_drm_owned_ioctl(capture,0x1234,&value,4,NULL,0,NULL)==0&&value==12);
            release_owner(&capture);assert(release_entries==2);
        }else if(!strcmp(name,"fd-reuse")||!strcmp(name,"fd-lost-reused")){
            if(!strcmp(name,"fd-lost-reused")){lost_action=8;replace_fd_after=1;assert(_wpk_drm_owned_fd(owner,-1,0)==-1&&errno==EBADF&&aliases[10]==999&&fd_entries==1);}
            else{int fd=_wpk_drm_owned_fd(owner,-1,0);assert(fd==10);aliases[fd]=999;}
            int fresh=_wpk_drm_owned_fd(owner,10,0);assert(fresh==11&&aliases[10]==999&&aliases[11]!=999&&fd_entries==2);release_owner(&owner);aliases[11]=0;
        }else if(!strcmp(name,"metadata-contended")){
            pthread_t threads[4];for(unsigned i=0;i<4;i++)assert(!pthread_create(&threads[i],NULL,metadata_increment,NULL));
            for(unsigned i=0;i<4;i++)assert(!pthread_join(threads[i],NULL));assert(metadata_counter==40000);release_owner(&owner);
        }else if(!strcmp(name,"metadata-fork-locked")){
            pthread_t thread;assert(!pthread_create(&thread,NULL,metadata_held,NULL));
            pthread_mutex_lock(&peer_mutex);while(!io_entered)pthread_cond_wait(&peer_condition,&peer_mutex);pthread_mutex_unlock(&peer_mutex);
            pid_t child=fork();assert(child>=0);
            if(!child){alarm(5);_wpk_drm_mutex_lock(&metadata_mutex);metadata_counter=1;_wpk_drm_mutex_unlock(&metadata_mutex);_exit(0);}
            int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0&&metadata_counter==0);
            pthread_mutex_lock(&peer_mutex);io_release=1;pthread_cond_broadcast(&peer_condition);pthread_mutex_unlock(&peer_mutex);
            assert(!pthread_join(thread,NULL));_wpk_drm_mutex_lock(&metadata_mutex);metadata_counter=2;_wpk_drm_mutex_unlock(&metadata_mutex);release_owner(&owner);
        }else if(!strcmp(name,"source-pending")){
            struct wpk_drm_owner *destination=NULL;assert(_wpk_drm_owned_open(1,&destination)==0);
            pause_io=1;pthread_t thread;assert(!pthread_create(&thread,NULL,blocked_io,owner));
            pthread_mutex_lock(&peer_mutex);while(!io_entered)pthread_cond_wait(&peer_condition,&peer_mutex);pthread_mutex_unlock(&peer_mutex);
            uint32_t value=5;assert(_wpk_drm_owned_ioctl(destination,0x1234,&value,4,owner,0,NULL)==0&&value==12);
            pthread_mutex_lock(&peer_mutex);io_release=1;pthread_cond_broadcast(&peer_condition);pthread_mutex_unlock(&peer_mutex);
            assert(!pthread_join(thread,NULL));release_owner(&destination);release_owner(&owner);
        }else if(!strcmp(name,"poll-cancel")){
            pause_poll=1;assert(_wpk_drm_owned_retain(owner)==0);pthread_t thread;
            assert(!pthread_create(&thread,NULL,canceled_poll,owner));
            pthread_mutex_lock(&peer_mutex);while(!poll_entered)pthread_cond_wait(&peer_condition,&peer_mutex);pthread_mutex_unlock(&peer_mutex);
            assert(!pthread_cancel(thread));void *result;assert(!pthread_join(thread,&result)&&result==PTHREAD_CANCELED);
            assert(poll_cancels==1&&live_caps()==1);release_owner(&owner);assert(release_entries==1);
        }else if(!strcmp(name,"poll-basic")){
            uint32_t revents=0;assert(_wpk_drm_owned_poll(owner,1,0,&revents)==1&&revents==1);release_owner(&owner);
        }else if(!strcmp(name,"retain")){
            struct wpk_drm_owner *peer=owner;assert(_wpk_drm_owned_retain(peer)==0);
            release_owner(&owner);assert(live_caps()==1&&!release_entries);release_owner(&peer);assert(release_entries==1);
        }else if(!strcmp(name,"retire-unknown")){
            lost_action=5;read_failures=2;_wpk_drm_owned_retire(&owner);
            assert(!owner&&release_entries==1&&allocations==1);
            struct wpk_drm_owner *fresh=NULL;assert(_wpk_drm_owned_open(1,&fresh)==0);_wpk_drm_owned_retire(&fresh);
            assert(!fresh&&release_entries==2);
        }else if(!strcmp(name,"borrowed-alias")||!strcmp(name,"borrowed-recycled")){
            int fd=_wpk_drm_owned_fd(owner,-1,WPK_DRM_OWNED_BORROW_ALIAS);assert(fd==10);
            if(!strcmp(name,"borrowed-recycled"))aliases[fd]=999;
            release_owner(&owner);assert(aliases[fd]==(!strcmp(name,"borrowed-recycled")?999u:0u));
        }else if(!strcmp(name,"bo-proofs")){
            uint32_t value=5;assert(_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&capture)==0&&capture);
            struct {uint32_t value,guard;} body={5,UINT32_C(0xcafed00d)};
            struct wpk_drm_bo_binding bindings[4]={{0,capture},{1,capture},{2,capture},{3,capture}};
            /* Unaligned offsets are rejected by the canonical kernel schema;
             * the transport preserves offsets and never copies proof tails
             * across the caller's canonical buffer boundary. */
            assert(_wpk_drm_owned_ioctl_bo(owner,0x1234,&body,4,NULL,0,NULL,bindings,4)==-1&&errno==EINVAL);
            bindings[1].byte_offset=0;
            assert(_wpk_drm_owned_ioctl_bo(owner,0x1234,&body,4,NULL,0,NULL,bindings,2)==-1&&errno==EINVAL);
            struct wpk_drm_bo_binding one={0,capture};
            assert(_wpk_drm_owned_ioctl_bo(owner,0x1234,&body,4,NULL,0,NULL,&one,5)==-1&&errno==EINVAL);
            assert(native_effects==1&&body.guard==UINT32_C(0xcafed00d));
            struct {uint32_t value[4];uint32_t guard;} many={{5,6,7,8},UINT32_C(0xdecafbad)};
            for(unsigned i=0;i<4;i++)bindings[i].byte_offset=i*4;
            assert(_wpk_drm_owned_ioctl_bo(owner,0x1234,&many,16,NULL,0,NULL,bindings,4)==0);
            assert(many.value[0]==12&&many.guard==UINT32_C(0xdecafbad));
            struct wpk_drm_bo_info info;assert(_wpk_drm_owned_bo_info(capture,&info)==0&&info.size==4096&&info.stride==128);
            uint64_t address;assert(_wpk_drm_owned_map_bo(owner,capture,0,4096,0,1,2,&address)==0&&address==UINT64_C(0x123456780));
            release_owner(&capture);release_owner(&owner);
        }else if(!strcmp(name,"fork-locked")){
            pause_io=1;pthread_t thread;assert(!pthread_create(&thread,NULL,blocked_io,owner));
            pthread_mutex_lock(&peer_mutex);while(!io_entered)pthread_cond_wait(&peer_condition,&peer_mutex);pthread_mutex_unlock(&peer_mutex);
            assert(!pthread_atfork(NULL,NULL,peer_after_fork));
            pid_t child=fork();assert(child>=0);if(!child){alarm(5);uint32_t value=1;_exit(_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,0,NULL)==0&&value==8?0:1);}
            int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
            pthread_mutex_lock(&peer_mutex);io_release=1;pthread_cond_broadcast(&peer_condition);pthread_mutex_unlock(&peer_mutex);assert(!pthread_join(thread,NULL));release_owner(&owner);
        }else if(!strcmp(name,"capture-allocation")){
            deny_allocation=1;uint32_t value=5;assert(_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&capture)==-1&&!capture&&errno==ENOMEM&&!native_effects);deny_allocation=0;release_owner(&owner);
        }else{
            assert(!strcmp(name,"basic"));uint32_t value=5;
            assert(_wpk_drm_owned_ioctl(owner,0x1234,&value,4,NULL,0,NULL)==0&&value==12);
            uint64_t address=0;assert(_wpk_drm_owned_map(owner,0,4096,0,1,2,&address)==0&&address==UINT64_C(0x123456780));release_owner(&owner);
        }
    }
    assert(live_caps()==0&&allocations==0);
    printf("PASS drm-owned-transport %s\n",name);return 0;
}
