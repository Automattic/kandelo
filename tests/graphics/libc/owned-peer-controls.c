/* Causal controls for the native peer itself. Distinct OFD, namespace and
 * storage identities prevent a permissive double from blessing fd/handle
 * reuse. Shared backing makes fork release counts observable to both sides. */
#include "owned-resource-peer.h"
#include <assert.h>
#include <errno.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdlib.h>
#include <pthread.h>
#undef calloc
#undef free
static _Atomic unsigned allocations;
void *control_calloc(size_t count,size_t bytes){void *p=calloc(count,bytes);if(p)atomic_fetch_add(&allocations,1);return p;}
void control_free(void *p){if(p)assert(atomic_fetch_sub(&allocations,1));free(p);}
/* glibc exposes MAP_ANONYMOUS under the runner's feature-test macro;
 * BSD systems may provide its historical spelling instead. */
#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS MAP_ANON
#endif
#define CREATE UINT32_C(0xc004fe10)
#define INSPECT UINT32_C(0xc008fe11)
struct object {unsigned file;_Atomic unsigned holds,named;unsigned char pixels[4096];};
struct shared { _Atomic unsigned next_file,next_bo,opens,mutations,pins;_Atomic unsigned names[64];struct object objects[128];};
static struct shared *shared;
struct graphics_peer_file {unsigned identity,refs;};
static struct graphics_peer_file files[64],*aliases[64];
static int replace_dup;
static void retain_file(struct graphics_peer_file *file){assert(file->refs);file->refs++;}
static int release_file(struct graphics_peer_file *file){assert(file->refs);if(!--file->refs)assert(atomic_fetch_sub(&shared->pins,1));return 0;}
static struct graphics_peer_file *open_file(uint32_t node){
    assert(node==1);unsigned id=atomic_fetch_add(&shared->next_file,1)+1;assert(id<64);
    files[id]=(struct graphics_peer_file){id,1};atomic_fetch_add(&shared->opens,1);atomic_fetch_add(&shared->pins,1);return &files[id];
}
static int close_alias(struct graphics_peer_file *file,int fd){assert(fd>=0&&fd<64&&aliases[fd]==file);aliases[fd]=NULL;return release_file(file);}
static struct graphics_peer_file *acquire_file(int fd,uint32_t flags){
    struct graphics_peer_file *file=fd>=0&&fd<64?aliases[fd]:NULL;if(!file){errno=EBADF;return NULL;}
    retain_file(file);if(flags&WPK_DRM_OWNED_CONSUME_FD)close_alias(file,fd);return file;
}
static int alias_matches(struct graphics_peer_file *file,int fd){return fd>=0&&fd<64&&aliases[fd]==file;}
static int duplicate_file(struct graphics_peer_file *file,int previous,int borrowed){
    (void)borrowed;if(alias_matches(file,previous))return previous;int fd=10;while(fd<64&&aliases[fd])fd++;assert(fd<64);
    retain_file(file);aliases[fd]=file;
    if(replace_dup){replace_dup=0;close_alias(file,fd);aliases[fd]=open_file(1);}
    return fd;
}
static int device_ioctl(struct graphics_peer_file *file,uint32_t request,void *body,uint32_t length,
                        struct graphics_peer_file *source,const struct graphics_peer_binding *proofs,uint32_t count){
    assert(!source);uint32_t *words=body;
    if(request==CREATE){assert(length==4&&!count);unsigned id=atomic_fetch_add(&shared->next_bo,1)+1;assert(id<128);
        assert(!atomic_load(&shared->names[file->identity]));
        shared->objects[id].file=file->identity;atomic_store(&shared->objects[id].named,1);
        atomic_store(&shared->names[file->identity],id);words[0]=77;atomic_fetch_add(&shared->mutations,1);return 0;}
    assert(request==INSPECT&&length==8&&words[0]==77&&count<=1);
    unsigned id=count?(unsigned)proofs[0].storage:atomic_load(&shared->names[file->identity]);
    assert(id&&shared->objects[id].file==file->identity);
    if(count)assert(proofs[0].offset==0&&proofs[0].handle==77&&atomic_load(&shared->objects[id].holds));
    words[1]=id;return 0;
}
static int bo_info(struct graphics_peer_file *file,uint32_t handle,uint64_t *identity,struct wpk_drm_bo_info *info){
    assert(handle==77);*identity=atomic_load(&shared->names[file->identity]);assert(*identity);
    *info=(struct wpk_drm_bo_info){4096,32,32,128,0x34324258,0,0};return 0;
}
static void bo_retain(struct graphics_peer_file *file,uint32_t handle,uint64_t identity){
    assert(handle==77&&shared->objects[identity].file==file->identity);atomic_fetch_add(&shared->objects[identity].holds,1);
}
static int bo_release(struct graphics_peer_file *file,uint32_t handle,uint64_t identity){
    assert(handle==77&&shared->objects[identity].file==file->identity);
    unsigned prior=atomic_fetch_sub(&shared->objects[identity].holds,1);assert(prior);
    if(prior==1){unsigned expected=(unsigned)identity;
        if(atomic_compare_exchange_strong(&shared->names[file->identity],&expected,0))atomic_store(&shared->objects[identity].named,0);}
    return 0;
}
static void *map_bo(struct graphics_peer_file *file,uint64_t address,uint64_t length,int64_t offset,
                    uint32_t prot,uint32_t flags,uint32_t handle,uint64_t identity){
    (void)prot;(void)flags;assert(!address&&length==4096&&!offset&&handle==77);
    assert(shared->objects[identity].file==file->identity&&atomic_load(&shared->objects[identity].holds));return shared->objects[identity].pixels;
}
static int poll_file(struct graphics_peer_file *file,uint32_t events,int32_t timeout,uint32_t *revents){(void)file;(void)events;(void)timeout;(void)revents;assert(!"no sync_file in this peer control");return -1;}
static void fork_child(void){for(unsigned i=1;i<64;i++)if(files[i].refs)atomic_fetch_add(&shared->pins,1);}
static const struct graphics_peer_ops ops={open_file,acquire_file,retain_file,release_file,duplicate_file,alias_matches,close_alias,device_ioctl,bo_info,bo_release,map_bo,poll_file,bo_retain,fork_child};
static pthread_mutex_t drain_mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t drain_condition=PTHREAD_COND_INITIALIZER;
static _Thread_local int drainer_thread;
static int pause_read,drain_paused,drain_continue;
static unsigned fail_before_release;
static struct wpk_drm_owner *first_retirement;
int control_ioctl(int fd,unsigned long request,...){
    assert(fd==-1&&request==WPK_DRM_IOCTL_OWNED_RESOURCE);va_list args;va_start(args,request);struct wpk_drm_owned_packet *p=va_arg(args,void *);va_end(args);
    unsigned action=p->action;
    if(action==WPK_DRM_OWNED_RELEASE&&fail_before_release){fail_before_release=0;errno=EAGAIN;return -1;}
    int rc=graphics_peer_ioctl(&ops,p);
    /* The kernel entry has completed and released its gate; another guest
     * thread may now fork before this drainer observes its C return. */
    if(action==WPK_DRM_OWNED_READ_LAST&&drainer_thread&&pause_read){
        assert(!rc);pthread_mutex_lock(&drain_mutex);pause_read=0;drain_paused=1;pthread_cond_broadcast(&drain_condition);
        while(!drain_continue)pthread_cond_wait(&drain_condition,&drain_mutex);
        pthread_mutex_unlock(&drain_mutex);
    }
    return rc;
}
static void release(struct wpk_drm_owner **owner){assert(!_wpk_drm_owned_release(owner)&&!*owner);}
static struct wpk_drm_owner *create(struct wpk_drm_owner *file){struct wpk_drm_owner *bo=NULL;uint32_t handle=0;assert(!_wpk_drm_owned_ioctl(file,CREATE,&handle,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo)&&handle==77&&bo);return bo;}
static unsigned inspect(struct wpk_drm_owner *file,struct wpk_drm_owner *bo){uint32_t words[2]={77,0};struct wpk_drm_bo_binding proof={0,bo};assert(!_wpk_drm_owned_ioctl_bo(file,INSPECT,words,8,NULL,0,NULL,bo?&proof:NULL,bo?1:0));return words[1];}
static void raw_gem_close(unsigned file){unsigned id=atomic_exchange(&shared->names[file],0);assert(id);atomic_store(&shared->objects[id].named,0);}
static void init(void){shared=mmap(NULL,sizeof *shared,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);assert(shared!=MAP_FAILED);memset(shared,0,sizeof *shared);}
static void trigger_retirement(void){
    struct wpk_drm_owner *fresh=NULL;assert(!_wpk_drm_owned_open(1,&fresh));_wpk_drm_owned_retire(&fresh);assert(!fresh);
}
static void *drain_on_worker(void *unused){
    (void)unused;drainer_thread=1;
    if(first_retirement){struct wpk_drm_owner *owner=first_retirement;first_retirement=NULL;_wpk_drm_owned_retire(&owner);assert(!owner);}
    else trigger_retirement();return NULL;
}
static void queue_unknown(struct wpk_drm_owner **owner,unsigned existing,int nonentry){
    if(nonentry)fail_before_release=1;else graphics_peer_lose_action=WPK_DRM_OWNED_RELEASE;
    /* Initial recovery plus one bounded pass must each remain unknown. */
    graphics_peer_lose_reads=existing+2;_wpk_drm_owned_retire(owner);
    assert(!*owner&&atomic_load(&allocations)==existing+1&&!graphics_peer_lose_reads);
}
static void queue_fork_control(const char *name,struct wpk_drm_owner **file){
    int nonentry=!strcmp(name,"queue-fork-nonentry"),multiple=!strcmp(name,"queue-fork-multiple"),unknown=!strcmp(name,"queue-fork-unknown");
    int first=!strcmp(name,"queue-fork-first");
    unsigned queued=1;
    if(first){first_retirement=*file;*file=NULL;graphics_peer_lose_action=WPK_DRM_OWNED_RELEASE;}
    else queue_unknown(file,0,nonentry);
    if(multiple){struct wpk_drm_owner *second=NULL;assert(!_wpk_drm_owned_open(1,&second));queue_unknown(&second,1,0);queued++;}
    pthread_mutex_lock(&drain_mutex);pause_read=1;pthread_mutex_unlock(&drain_mutex);
    pthread_t worker;assert(!pthread_create(&worker,NULL,drain_on_worker,NULL));
    pthread_mutex_lock(&drain_mutex);while(!drain_paused)pthread_cond_wait(&drain_condition,&drain_mutex);pthread_mutex_unlock(&drain_mutex);
    assert(atomic_load(&allocations)==queued);unsigned parent_pins=atomic_load(&shared->pins);
    pid_t child=fork();assert(child>=0);
    if(!child){
        if(unknown){graphics_peer_lose_reads=1;trigger_retirement();assert(atomic_load(&allocations)==queued);
            pid_t nested=fork();assert(nested>=0);if(!nested){trigger_retirement();assert(!atomic_load(&allocations));_exit(0);}
            int status;assert(waitpid(nested,&status,0)==nested&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
        }
        trigger_retirement();assert(!atomic_load(&allocations)&&!graphics_peer_live_capabilities());
        assert(atomic_load(&shared->pins)==parent_pins);_exit(0);
    }
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    pthread_mutex_lock(&drain_mutex);drain_continue=1;pthread_cond_broadcast(&drain_condition);pthread_mutex_unlock(&drain_mutex);
    assert(!pthread_join(worker,NULL)&&!atomic_load(&allocations));
}
int main(int argc,char **argv){
    assert(argc==2);init();const char *name=argv[1];struct wpk_drm_owner *file=NULL,*bo=NULL;
    if(!strcmp(name,"cold-fork-unknown")){
        graphics_peer_lose_action=WPK_DRM_OWNED_OPEN;graphics_peer_lose_reads=1;
        assert(_wpk_drm_owned_open(1,&file)<0&&file);
    }else assert(!_wpk_drm_owned_open(1,&file));
    if(!strncmp(name,"queue-fork-",11)){queue_fork_control(name,&file);}
    else if(!strcmp(name,"fd-reuse")){
        int fd=_wpk_drm_owned_fd(file,-1,0);assert(fd==10);struct graphics_peer_file *original=aliases[fd];close_alias(original,fd);
        aliases[fd]=open_file(1);bo=create(file);assert(inspect(file,bo)==1&&shared->objects[1].file==original->identity);
        release(&bo);release(&file);assert(aliases[fd]->refs==1&&atomic_load(&shared->pins)==1);close_alias(aliases[fd],fd);
    }else if(!strcmp(name,"same-file-handle-reuse")){
        bo=create(file);unsigned first=inspect(file,bo);uint64_t mapped=0;
        assert(!_wpk_drm_owned_map_bo(file,bo,0,4096,0,PROT_READ|PROT_WRITE,MAP_SHARED,&mapped));*(unsigned char *)(uintptr_t)mapped=31;
        raw_gem_close(1);struct wpk_drm_owner *replacement=create(file);unsigned second=inspect(file,replacement);assert(first!=second);
        assert(inspect(file,bo)==first&&inspect(file,NULL)==second);uint64_t later=0;
        assert(!_wpk_drm_owned_map_bo(file,bo,0,4096,0,PROT_READ|PROT_WRITE,MAP_SHARED,&later)&&later==mapped&&*(unsigned char *)(uintptr_t)later==31);
        release(&bo);assert(atomic_load(&shared->names[1])==second&&atomic_load(&shared->objects[second].holds)==1);
        release(&replacement);release(&file);
    }else if(!strcmp(name,"create-lost")){
        graphics_peer_lose_action=WPK_DRM_OWNED_IOCTL;bo=create(file);assert(atomic_load(&shared->mutations)==1);release(&bo);release(&file);
    }else if(!strcmp(name,"dup-lost-reused")){
        replace_dup=1;graphics_peer_lose_action=WPK_DRM_OWNED_DUP_FD;
        assert(_wpk_drm_owned_fd(file,-1,0)<0&&errno==EBADF&&atomic_load(&shared->opens)==2);
        release(&file);assert(aliases[10]&&atomic_load(&shared->pins)==1);close_alias(aliases[10],10);
    }else if(!strcmp(name,"release-lost")){
        bo=create(file);graphics_peer_lose_action=WPK_DRM_OWNED_BO_RELEASE;release(&bo);assert(!atomic_load(&shared->objects[1].holds));release(&file);
    }else if(!strcmp(name,"fork-parent-first")||!strcmp(name,"fork-child-first")||!strcmp(name,"cold-fork-unknown")||!strcmp(name,"capture-fork-unknown")){
        int capture=!strcmp(name,"capture-fork-unknown");
        if(capture){graphics_peer_lose_action=WPK_DRM_OWNED_IOCTL;graphics_peer_lose_reads=1;uint32_t handle=0;assert(_wpk_drm_owned_ioctl(file,CREATE,&handle,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo)<0&&bo);}
        else if(strcmp(name,"cold-fork-unknown"))bo=create(file);
        int ready[2],proceed[2];assert(!pipe(ready)&&!pipe(proceed));pid_t child=fork();assert(child>=0);
        if(!child){close(ready[0]);close(proceed[1]);assert(write(ready[1],"r",1)==1);char byte;assert(read(proceed[0],&byte,1)==1);
            if(bo)release(&bo);release(&file);_exit(0);}
        close(ready[1]);close(proceed[0]);char byte;assert(read(ready[0],&byte,1)==1);
        int parent_first=!strcmp(name,"fork-parent-first");
        if(parent_first){release(&bo);release(&file);assert(atomic_load(&shared->objects[1].holds)==1&&atomic_load(&shared->names[1])==1);}
        assert(write(proceed[1],"p",1)==1);int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
        if(!parent_first){if(bo)release(&bo);release(&file);}assert(atomic_load(&shared->opens)==1&&atomic_load(&shared->mutations)==(unsigned)!!strcmp(name,"cold-fork-unknown"));
    }else assert(!"unknown control");
    assert(!graphics_peer_live_capabilities()&&!atomic_load(&shared->pins)&&!atomic_load(&allocations));
    for(unsigned i=1;i<128;i++)assert(!atomic_load(&shared->objects[i].holds)&&!atomic_load(&shared->objects[i].named));
    printf("PASS owned-peer %s\n",name);return 0;
}
