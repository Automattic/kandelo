/* Actual common receiver with an independent VMA/receipt peer and real native
 * VM effects. This is a C phase control, not normal-kernel/browser evidence. */
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#include "drm_owned.h"
#include "owned-resource-peer.h"
static int exact_ioctl(int,unsigned long,...);
#define ioctl exact_ioctl
#include "drm_owned.c"
#undef ioctl
#include "owned-resource-peer.c"
struct graphics_peer_file {unsigned refs;};
static struct graphics_peer_file native_file;
static unsigned next_handle;
static int fail_map;
static struct graphics_peer_file *native_open(uint32_t node){assert(node==1);native_file.refs++;return &native_file;}
static struct graphics_peer_file *native_acquire(int fd,uint32_t flags){(void)flags;assert(fd==10);native_file.refs++;return &native_file;}
static void native_retain(struct graphics_peer_file *f){f->refs++;}
static int native_release(struct graphics_peer_file *f){assert(f->refs);f->refs--;return 0;}
static int native_duplicate(struct graphics_peer_file *f,int prior,int borrowed){(void)f;(void)prior;(void)borrowed;return 10;}
static int native_matches(struct graphics_peer_file *f,int fd){return f==&native_file&&fd==10;}
static int native_close(struct graphics_peer_file *f,int fd){assert(native_matches(f,fd));return 0;}
static int native_io(struct graphics_peer_file *f,uint32_t request,void *body,uint32_t length,
    struct graphics_peer_file *source,const struct graphics_peer_binding *bindings,uint32_t count){
    (void)f;(void)source;(void)bindings;assert(!count&&request==UINT32_C(0xc02064b2)&&length==32);
    uint32_t handle=++next_handle;memcpy((char *)body+16,&handle,4);return 0;
}
static int native_info(struct graphics_peer_file *f,uint32_t handle,uint64_t *storage,struct wpk_drm_bo_info *info){
    (void)f;*storage=handle;*info=(struct wpk_drm_bo_info){.size=0x10000,.width=64,.height=64,.stride=256};return 0;
}
static int native_bo_release(struct graphics_peer_file *f,uint32_t handle,uint64_t storage){(void)f;assert(handle==storage);return 0;}
static void *native_map(struct graphics_peer_file *f,uint64_t address,uint64_t length,int64_t offset,uint32_t prot,uint32_t flags,uint32_t handle,uint64_t storage){
    (void)f;(void)offset;assert(!handle||handle==storage);
    if(fail_map){fail_map=0;errno=ENOMEM;return MAP_FAILED;}
    return mmap((void *)(uintptr_t)address,length,prot,(flags&MAP_FIXED)|MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
}
static int native_poll(struct graphics_peer_file *f,uint32_t events,int32_t timeout,uint32_t *out){(void)f;(void)timeout;*out=events;return 0;}
static const struct graphics_peer_ops ops={native_open,native_acquire,native_retain,native_release,
    native_duplicate,native_matches,native_close,native_io,native_info,native_bo_release,native_map,native_poll};
static pthread_mutex_t phase_lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t phase_changed=PTHREAD_COND_INITIALIZER;
static int phase_action,phase_after,phase_ready,phase_continue;
static void phase_stop(void){pthread_mutex_lock(&phase_lock);phase_ready=1;pthread_cond_broadcast(&phase_changed);
    while(!phase_continue)pthread_cond_wait(&phase_changed,&phase_lock);pthread_mutex_unlock(&phase_lock);}
static int exact_ioctl(int fd,unsigned long request,...){
    assert(fd==-1&&request==WPK_DRM_IOCTL_OWNED_RESOURCE);va_list ap;va_start(ap,request);
    struct wpk_drm_owned_packet *p=va_arg(ap,void *);va_end(ap);unsigned action=p->action;
    if(phase_action==(int)action&&!phase_after)phase_stop();
    int rc=graphics_peer_ioctl(&ops,p);
    if(phase_action==(int)action&&phase_after)phase_stop();return rc;
}
static struct wpk_drm_mapping cell,replacement;
static struct wpk_drm_owner *file,*other,*bo;
static size_t page;
static void map_cell(struct wpk_drm_mapping *m,struct wpk_drm_owner *owner,uint64_t address,uint64_t length,int fixed){
    assert(!_wpk_drm_owned_map_exact(m,owner,bo,address,length,0,PROT_READ|PROT_WRITE,MAP_SHARED|(fixed?MAP_FIXED:0)));
    assert(m->phase==WPK_DRM_MAPPING_LIVE&&m->identity);
}
static void *unmap_thread(void *unused){(void)unused;assert(!_wpk_drm_owned_unmap_exact(&cell));return NULL;}
static void clean(void){assert(!_wpk_drm_owned_unmap_exact(&cell));assert(!_wpk_drm_owned_unmap_exact(&replacement));
    assert(!_wpk_drm_owned_release(&bo));assert(!_wpk_drm_owned_release(&other));assert(!_wpk_drm_owned_release(&file));
    assert(!graphics_peer_live_capabilities()&&!native_file.refs);}
int main(int argc,char **argv){
    assert(argc==2);page=sysconf(_SC_PAGESIZE);assert(!_wpk_drm_owned_open(1,&file));
    assert(!_wpk_drm_owned_acquire(10,0,&other));uint8_t request[32]={0};
    assert(!_wpk_drm_owned_ioctl(file,UINT32_C(0xc02064b2),request,32,NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo));
    if(!strcmp(argv[1],"failed")){
        fail_map=1;assert(_wpk_drm_owned_map_exact(&cell,file,bo,0,page,0,3,MAP_SHARED)==-1&&errno==ENOMEM);
        assert(cell.phase==WPK_DRM_MAPPING_EMPTY);uint64_t burned=last_mapping_id;
        map_cell(&cell,file,0,page,0);assert(cell.identity>burned);
    }else if(!strcmp(argv[1],"lost-map")||!strcmp(argv[1],"lost-map-acked")){
        graphics_peer_lose_action=WPK_DRM_OWNED_MMAP_EXACT;graphics_peer_lose_reads=1;
        assert(_wpk_drm_owned_map_exact(&cell,file,bo,0,page,0,3,MAP_SHARED)==-1);
        assert(cell.phase==WPK_DRM_MAPPING_MAP_PENDING);
        if(!strcmp(argv[1],"lost-map-acked")){
            uint32_t revents;assert(!_wpk_drm_owned_poll(file,0,0,&revents));
            assert(cell.phase==WPK_DRM_MAPPING_LIVE&&cell.identity);
        }
        assert(!_wpk_drm_owned_unmap_exact(&cell));
        assert(cell.phase==WPK_DRM_MAPPING_EMPTY);
    }else{
        map_cell(&cell,file,0,page*3,0);memset((void *)(uintptr_t)cell.address,0x2a,page*3);
        if(!strcmp(argv[1],"partial")){
            map_cell(&replacement,other,cell.address+page,page,1);memset((void *)(uintptr_t)replacement.address,0x5a,page);
            assert(!_wpk_drm_owned_unmap_exact(&cell));assert(*(unsigned char *)(uintptr_t)replacement.address==0x5a);
        }else if(!strcmp(argv[1],"lost-unmap")||!strcmp(argv[1],"lost-unmap-acked")){
            uint64_t addr=cell.address,id=cell.identity;
            graphics_peer_lose_action=WPK_DRM_OWNED_UNMAP_EXACT;graphics_peer_lose_reads=1;
            assert(_wpk_drm_owned_unmap_exact(&cell)==-1&&cell.phase==WPK_DRM_MAPPING_UNMAP_PENDING);
            if(!strcmp(argv[1],"lost-unmap-acked")){
                uint32_t revents;assert(!_wpk_drm_owned_poll(file,0,0,&revents));assert(cell.phase==WPK_DRM_MAPPING_EMPTY);
            }
            map_cell(&replacement,other,addr,page*3,1);assert(replacement.identity>id);
            memset((void *)(uintptr_t)addr,0x5a,page*3);assert(!_wpk_drm_owned_unmap_exact(&cell));assert(*(unsigned char *)(uintptr_t)addr==0x5a);
        }else if(!strncmp(argv[1],"fork-",5)){
            uint64_t addr=cell.address,id=cell.identity;phase_action=WPK_DRM_OWNED_UNMAP_EXACT;
            phase_after=!strcmp(argv[1],"fork-after");pthread_t thread;assert(!pthread_create(&thread,NULL,unmap_thread,NULL));
            pthread_mutex_lock(&phase_lock);while(!phase_ready)pthread_cond_wait(&phase_changed,&phase_lock);pthread_mutex_unlock(&phase_lock);
            if(phase_after){map_cell(&replacement,other,addr,page*3,1);assert(replacement.identity>id);memset((void *)(uintptr_t)addr,0x5a,page*3);}
            pid_t child=fork();assert(child>=0);
            if(!child){alarm(5);phase_action=0;assert(!_wpk_drm_owned_unmap_exact(&cell));
                if(phase_after)assert(*(unsigned char *)(uintptr_t)addr==0x5a);clean();_exit(0);}
            int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
            pthread_mutex_lock(&phase_lock);phase_continue=1;pthread_cond_broadcast(&phase_changed);pthread_mutex_unlock(&phase_lock);assert(!pthread_join(thread,NULL));
            if(phase_after)assert(*(unsigned char *)(uintptr_t)addr==0x5a);
        }else assert(!strcmp(argv[1],"ordinary"));
    }
    clean();puts("PASS exact mapping C custody");return 0;
}
