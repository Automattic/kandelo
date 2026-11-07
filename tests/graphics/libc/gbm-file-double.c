/* Native tests run on macOS too. Model the new query using actual dup
 * operations, never inode/path equality. Only the test process uses this
 * descriptor registry; actual SDK guests exercise the kernel command. */
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#include <pthread.h>
#include "drm_owned.h"
#define QUERY 1027
struct alias { int fd; uint64_t identity; struct alias *next; };
static struct alias *aliases;
static uint64_t next_identity = 1;
/* All descriptor actors in this fixture use these entry points. Keep the
 * identity check and close/dup in one critical section: a comparison followed
 * by an unlocked close would reproduce the very fd-reuse bug being judged.
 * Epoch reconstruction avoids an inherited host mutex or new atfork order. */
static struct wpk_drm_mutex alias_mutex=WPK_DRM_MUTEX_INITIALIZER;
static _Thread_local unsigned alias_depth;
static _Thread_local uint64_t alias_epoch;
static _Thread_local int alias_cancel_state;
static void alias_enter(void){
    uint64_t epoch=_wpk_drm_process_generation();assert(epoch);
    if(alias_epoch!=epoch){alias_epoch=epoch;alias_depth=0;}
    if(!alias_depth){assert(!pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&alias_cancel_state));_wpk_drm_mutex_lock(&alias_mutex);}
    alias_depth++;
}
static void alias_leave(void){
    int saved_errno=errno;
    assert(alias_depth);if(!--alias_depth){_wpk_drm_mutex_unlock(&alias_mutex);assert(!pthread_setcancelstate(alias_cancel_state,NULL));}
    errno=saved_errno;
}

int graphics_gbm_fail_file_query;
static struct alias *observe(int fd) {
    if (fcntl(fd, F_GETFD, 0) < 0) return NULL;
    for (struct alias *a = aliases; a; a = a->next) if (a->fd == fd) return a;
    struct alias *a = calloc(1, sizeof *a); assert(a);
    a->fd = fd; a->identity = next_identity++; a->next = aliases; aliases = a;
    return a;
}
static int close_locked(int fd) {
    int result = close(fd);
    if (!result) {
        struct alias **slot = &aliases;
        while (*slot && (*slot)->fd != fd) slot = &(*slot)->next;
        if (*slot) { struct alias *a = *slot; *slot = a->next; free(a); }
    }
    return result;
}
static int dup_locked(int fd) {
    struct alias *source = observe(fd);
    if (!source) return -1;
    int result = dup(fd);
    if (result >= 0) observe(result)->identity = source->identity;
    return result;
}
static int fcntl_locked(int fd,int command,int argument) {
    if (command == QUERY) {
        int other = argument;
        if (graphics_gbm_fail_file_query) {
            graphics_gbm_fail_file_query = 0; errno = EIO; return -1;
        }
        struct alias *a = observe(fd), *b = observe(other);
        if (!a || !b) return -1;
        return a->identity == b->identity;
    }
    int arg = argument;
    struct alias *source = observe(fd);
    if (!source) return -1;
    int result = fcntl(fd, command, arg);
    if (result >= 0 && (command == F_DUPFD || command == F_DUPFD_CLOEXEC))
        observe(result)->identity = source->identity;
    return result;
}

int graphics_gbm_close(int fd){alias_enter();int result=close_locked(fd);alias_leave();return result;}
int graphics_gbm_dup(int fd){alias_enter();int result=dup_locked(fd);alias_leave();return result;}
int graphics_gbm_fcntl(int fd,int command,...){
    va_list args;va_start(args,command);
    int argument=command==F_GETFD?0:command==QUERY?(int)va_arg(args,unsigned long):va_arg(args,int);
    va_end(args);alias_enter();int result=fcntl_locked(fd,command,argument);alias_leave();return result;
}

/* The native descriptor is a real OFD pin, not the C driver's old integer.
 * Closing/recycling the caller alias cannot change callbacks' target. */
#include "owned-resource-peer.h"
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>
#include <xf86drm.h>
#include <drm/drm_mode.h>
struct graphics_peer_file {uint64_t identity;unsigned refs;int pin;};
static struct graphics_peer_file files[128];
extern int graphics_gbm_native_bo_info(uint32_t,int,struct wpk_drm_bo_info *);
static void forget_alias(int fd){
    struct alias **slot=&aliases;while(*slot&&(*slot)->fd!=fd)slot=&(*slot)->next;
    if(*slot){struct alias *old=*slot;*slot=old->next;free(old);}
}
int graphics_gbm_fclose(FILE *file){alias_enter();int fd=fileno(file);int rc=fclose(file);if(!rc)forget_alias(fd);alias_leave();return rc;}
int graphics_gbm_same_file(int a,int b){alias_enter();struct alias *left=observe(a),*right=observe(b);int same=left&&right&&left->identity==right->identity;alias_leave();return same;}
static struct graphics_peer_file *acquire_locked(int fd,uint32_t flags){
    if(graphics_gbm_fail_file_query){graphics_gbm_fail_file_query=0;errno=EIO;return NULL;}
    if(flags&WPK_DRM_OWNED_EXPECT_SYNC_FILE){errno=EINVAL;return NULL;}
    struct alias *source=observe(fd);if(!source)return NULL;uint64_t identity=source->identity;
    struct graphics_peer_file *f=NULL;for(unsigned i=0;i<128;i++)if(files[i].refs&&files[i].identity==identity){f=&files[i];break;}
    if(!f){for(unsigned i=0;i<128;i++)if(!files[i].refs){f=&files[i];break;}assert(f);
        int pin=graphics_gbm_fcntl(fd,F_DUPFD_CLOEXEC,0);if(pin<0)return NULL;
        *f=(struct graphics_peer_file){identity,0,pin};}
    f->refs++;
    if(flags&WPK_DRM_OWNED_CONSUME_FD)assert(!graphics_gbm_close(fd));return f;
}
static struct graphics_peer_file *gbm_peer_acquire(int fd,uint32_t flags){
    alias_enter();struct graphics_peer_file *file=acquire_locked(fd,flags);alias_leave();return file;
}
static struct graphics_peer_file *gbm_peer_open(uint32_t node){(void)node;errno=ENOSYS;return NULL;}
static void gbm_peer_retain(struct graphics_peer_file *f){assert(f->refs);f->refs++;}
static int gbm_peer_release(struct graphics_peer_file *f){assert(f->refs);return --f->refs?0:graphics_gbm_close(f->pin);}
static int gbm_peer_matches(struct graphics_peer_file *f,int fd){alias_enter();struct alias *a=observe(fd);int same=a&&a->identity==f->identity;alias_leave();return same;}
static int gbm_peer_close(struct graphics_peer_file *f,int fd){alias_enter();int result;if(!gbm_peer_matches(f,fd)){errno=EBADF;result=-1;}else result=graphics_gbm_close(fd);alias_leave();return result;}
static int gbm_peer_dup(struct graphics_peer_file *f,int previous,int borrowed){(void)borrowed;alias_enter();int fd=previous>=0&&gbm_peer_matches(f,previous)?previous:graphics_gbm_fcntl(f->pin,F_DUPFD_CLOEXEC,0);alias_leave();return fd;}
static int gbm_peer_io(struct graphics_peer_file *f,uint32_t request,void *body,uint32_t length,struct graphics_peer_file *source,const struct graphics_peer_binding *proofs,uint32_t count){
    for(uint32_t i=0;i<count;i++)assert(proofs[i].storage==proofs[i].handle);
    (void)length;int original=-1;
    if(source&&request==DRM_IOCTL_PRIME_FD_TO_HANDLE){struct drm_prime_handle *prime=body;original=prime->fd;prime->fd=source->pin;}
    int result=drmIoctl(f->pin,request,body),saved=errno;
    if(source&&request==DRM_IOCTL_PRIME_FD_TO_HANDLE)((struct drm_prime_handle *)body)->fd=original;
    errno=saved;return result;
}
static int gbm_peer_info(struct graphics_peer_file *f,uint32_t handle,uint64_t *storage,struct wpk_drm_bo_info *info){(void)f;*storage=handle;return graphics_gbm_native_bo_info(handle,-1,info);}
static int gbm_peer_bo_release(struct graphics_peer_file *f,uint32_t handle,uint64_t storage){assert(storage==handle);return drmCloseBufferHandle(f->pin,handle);}
static void *gbm_peer_map(struct graphics_peer_file *f,uint64_t address,uint64_t length,int64_t offset,uint32_t prot,uint32_t flags,uint32_t handle,uint64_t storage){assert(!handle||storage==handle);return mmap((void *)(uintptr_t)address,length,prot,flags,f->pin,offset);}
static int gbm_peer_poll(struct graphics_peer_file *f,uint32_t events,int32_t timeout,uint32_t *revents){(void)f;(void)events;(void)timeout;(void)revents;errno=ENOSYS;return -1;}
static const struct graphics_peer_ops gbm_peer_ops={gbm_peer_open,gbm_peer_acquire,gbm_peer_retain,gbm_peer_release,gbm_peer_dup,gbm_peer_matches,gbm_peer_close,gbm_peer_io,gbm_peer_info,gbm_peer_bo_release,gbm_peer_map,gbm_peer_poll};
int graphics_gbm_ioctl(int fd,unsigned long request,...){
    va_list ap;va_start(ap,request);void *arg=va_arg(ap,void *);va_end(ap);
    assert(fd==-1&&request==WPK_DRM_IOCTL_OWNED_RESOURCE);return graphics_peer_ioctl(&gbm_peer_ops,arg);
}
