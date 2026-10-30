/* Actual pinned upstream client, closure and socket machinery, with the same
 * lifetime bridge appended by the normal package recipe. Native source test;
 * no compositor/browser/guest execution is claimed here. */
#include <poll.h>
#include <signal.h>
#include <time.h>
static int wpk_native_ppoll(struct pollfd *,nfds_t,const struct timespec *,const sigset_t *);
#define ppoll wpk_native_ppoll
#define wl_display_connect _wpk_upstream_display_connect
#define wl_display_connect_to_fd _wpk_upstream_display_connect_to_fd
#define wl_display_disconnect _wpk_upstream_display_disconnect
#include WPK_WAYLAND_CLIENT_SOURCE
#include "../../../libc/glue/wayland-client-lifetime.inc"
#include <assert.h>

static pthread_mutex_t fixture_wait_mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t fixture_wait_cond=PTHREAD_COND_INITIALIZER;
static int fixture_wait_fd=-1,fixture_wait_entered;
struct fixture_dispatch {struct wl_display *display;struct wl_event_queue *queue;int result;};
static void *fixture_dispatch_thread(void *data) {
    struct fixture_dispatch *call=data;
    call->result=wl_display_dispatch_queue(call->display,call->queue);return NULL;
}

int main(void) {
    int pair[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);
    struct wl_display *display=wl_display_connect_to_fd(pair[0]);assert(display);
    uint64_t identity=0,next=0;
    assert(!_wpk_wl_display_metadata((void *)1,&identity));
    assert(_wpk_wl_display_metadata(display,&identity) && identity);
    void *hold=_wpk_wl_display_acquire(display,identity);assert(hold);
    assert(!_wpk_wl_display_acquire(display,identity+1));
    pthread_mutex_lock(&display->mutex);
    struct wl_proxy *surface=proxy_create(&display->proxy,&wl_surface_interface,1);assert(surface);
    pthread_mutex_unlock(&display->mutex);
    const void *source=NULL;uint64_t source_id=0;
    assert(!_wpk_wl_surface_acquire((void *)1,&source,&source_id));
    void *surface_hold=_wpk_wl_surface_acquire(surface,&source,&source_id);assert(surface_hold);
    assert(source==display && source_id==identity && surface->refcount==2);
    assert(_wpk_wl_surface_alive(surface_hold));
    pthread_mutex_lock(&display->mutex);
    struct wl_proxy *buffer=proxy_create(&display->proxy,&wl_buffer_interface,1);assert(buffer);
    pthread_mutex_unlock(&display->mutex);
    assert(_wpk_wl_surface_present(surface_hold,buffer,32,24));
    assert(wl_display_flush(display)>=0);
    uint32_t wire[32];ssize_t bytes=read(pair[1],wire,sizeof wire);
    assert(bytes==52 && wire[0]==surface->object.id && (wire[1]&0xffffu)==WL_SURFACE_ATTACH);
    assert(wire[2]==buffer->object.id && (wire[6]&0xffffu)==WL_SURFACE_DAMAGE && (wire[12]&0xffffu)==WL_SURFACE_COMMIT);
    wl_proxy_destroy(buffer);
    // The real proxy survives public destruction until the native owner lets
    // go, but the destroyed bit revokes all new present/marshal authority.
    wl_proxy_destroy(surface);assert(surface->refcount==1);
    assert(!_wpk_wl_surface_alive(surface_hold));
    assert(!_wpk_wl_surface_present(surface_hold,NULL,32,24));
    assert(!_wpk_wl_surface_acquire(surface,&source,&source_id));
    wl_display_disconnect(display);
    assert(!_wpk_wl_display_metadata(display,&next));
    assert(!_wpk_wl_display_alive(hold));
    assert(!_wpk_wl_display_acquire(display,identity));
    assert(fcntl(pair[0],F_GETFD)>=0); // actual native capabilities still own it
    _wpk_wl_surface_release(surface_hold);
    _wpk_wl_display_release(hold);
    assert(fcntl(pair[0],F_GETFD)==-1 && errno==EBADF);close(pair[1]);
    // Recycled allocator addresses still receive a fresh connection identity.
    assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);
    struct wl_display *replacement=wl_display_connect_to_fd(pair[0]);assert(replacement);
    assert(_wpk_wl_display_metadata(replacement,&next) && next!=identity);
    assert(!_wpk_wl_display_acquire(replacement,identity));
    // Disconnect first must also retain a still-live proxy. The reverse
    // teardown order cannot marshal onto the revoked transport or free a
    // proxy that the native window still owns.
    pthread_mutex_lock(&replacement->mutex);
    surface=proxy_create(&replacement->proxy,&wl_surface_interface,1);assert(surface);
    pthread_mutex_unlock(&replacement->mutex);
    surface_hold=_wpk_wl_surface_acquire(surface,&source,&source_id);assert(surface_hold);
    wl_display_disconnect(replacement);
    assert(!_wpk_wl_surface_alive(surface_hold));
    assert(!_wpk_wl_surface_present(surface_hold,NULL,16,16));
    assert(fcntl(pair[0],F_GETFD)>=0);
    wl_proxy_destroy(surface);
    _wpk_wl_surface_release(surface_hold);
    assert(fcntl(pair[0],F_GETFD)==-1 && errno==EBADF);close(pair[1]);
    // Front-ring backpressure dispatches a private queue. Public disconnect
    // must wake the actual upstream socket wait while a native hold retains
    // the physical connection until queue and reader teardown complete.
    assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);
    display=wl_display_connect_to_fd(pair[0]);assert(display);
    assert(_wpk_wl_display_metadata(display,&identity));
    hold=_wpk_wl_display_acquire(display,identity);assert(hold);
    struct fixture_dispatch blocked={.display=display,.queue=wl_display_create_queue(display),.result=0};
    assert(blocked.queue);pthread_t reader;
    pthread_mutex_lock(&fixture_wait_mutex);fixture_wait_fd=pair[0];fixture_wait_entered=0;
    assert(!pthread_create(&reader,NULL,fixture_dispatch_thread,&blocked));
    while(!fixture_wait_entered)pthread_cond_wait(&fixture_wait_cond,&fixture_wait_mutex);
    pthread_mutex_unlock(&fixture_wait_mutex);
    wl_display_disconnect(display);
    assert(!pthread_join(reader,NULL) && blocked.result==-1);
    assert(fcntl(pair[0],F_GETFD)>=0);
    wl_event_queue_destroy(blocked.queue);_wpk_wl_display_release(hold);
    assert(fcntl(pair[0],F_GETFD)==-1 && errno==EBADF);close(pair[1]);
    fixture_wait_fd=-1;
    // Identity exhaustion fails before publishing a connection, closes the
    // acquired transport, and never wraps into an older display identity.
    assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);
    wpk_wl_serial=UINT64_MAX;
    assert(!wl_display_connect_to_fd(pair[0]) && errno==ENOMEM);
    assert(fcntl(pair[0],F_GETFD)==-1 && errno==EBADF);close(pair[1]);
    puts("PASS actual Wayland connection/proxy retirement and identity");return 0;
}

/* Host-native device boundary for the three OS helpers used by the upstream
 * client/connection sources. The transport itself is a real socket pair. */
int wl_os_socket_cloexec(int domain,int type,int protocol) {
    int fd=socket(domain,type,protocol);if(fd>=0)fcntl(fd,F_SETFD,FD_CLOEXEC);return fd;
}
int wl_os_dupfd_cloexec(int fd,int minimum) {return fcntl(fd,F_DUPFD_CLOEXEC,minimum);}
ssize_t wl_os_recvmsg_cloexec(int fd,struct msghdr *message,int flags) {
    ssize_t result=recvmsg(fd,message,flags);
    if(result>=0)for(struct cmsghdr *header=CMSG_FIRSTHDR(message);header;header=CMSG_NXTHDR(message,header))
        if(header->cmsg_level==SOL_SOCKET && header->cmsg_type==SCM_RIGHTS) {
            size_t count=(header->cmsg_len-CMSG_LEN(0))/sizeof(int);int *descriptors=(int *)CMSG_DATA(header);
            for(size_t i=0;i<count;i++)fcntl(descriptors[i],F_SETFD,FD_CLOEXEC);
        }
    return result;
}

/* Native fixture adapter: this case does not test guest ppoll; the actual
 * Kandelo build compiles the upstream call against its real libc ppoll. */
static int wpk_native_ppoll(struct pollfd *fds,nfds_t count,const struct timespec *timeout,const sigset_t *mask) {
    assert(mask==NULL);
    int milliseconds=-1;
    if(timeout) {
        int64_t duration=(int64_t)timeout->tv_sec*1000+(timeout->tv_nsec+999999)/1000000;
        milliseconds=duration>INT_MAX ? INT_MAX : (int)duration;
    }
    pthread_mutex_lock(&fixture_wait_mutex);
    if(count==1 && fds[0].fd==fixture_wait_fd) {
        fixture_wait_entered=1;pthread_cond_signal(&fixture_wait_cond);
    }
    pthread_mutex_unlock(&fixture_wait_mutex);
    return poll(fds,count,milliseconds);
}
