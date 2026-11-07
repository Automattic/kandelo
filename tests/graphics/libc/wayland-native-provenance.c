/* Native allocation/admission component control. Raw public entry wrappers
 * are not enabled by this fixture; no complete D59 acceptance is claimed. */
#include "drm_owned.c"
#include "wayland-client-provenance.inc"
#define main original_connection_control_main
#include "wayland-connection.c"
#undef main
#include <sys/mman.h>
void _wpk_egl_request_native_drain(void){}
static void provenance_fresh(void){
    int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));
    struct wl_display *display=wl_display_connect_to_fd(pair[0]);assert(display);
    assert(wpk_wl_native_pointer_admitted(display));
    /* Embedded native records require a range admission, not base equality. */
    assert(wpk_wl_native_pointer_admitted(&display->proxy));
    assert(wpk_wl_native_pointer_admitted(&display->default_queue));
    assert(wpk_wl_native_pointer_admitted(&display->display_queue));
    struct wl_event_queue *queue=wl_display_create_queue(display);assert(queue&&wpk_wl_native_pointer_admitted(queue));
    struct wl_proxy *proxy=proxy_create(&display->proxy,&wl_surface_interface,1);assert(proxy&&wpk_wl_native_pointer_admitted(proxy));
    void *hold=NULL;const void *source=NULL;uint64_t identity=0;
    assert(_wpk_wl_surface_acquire_pending(proxy,&source,&identity,&hold));
    wl_proxy_destroy(proxy);
    struct wpk_wl_surface_retirement cap={.live=hold};
    /* Last valid proxy unref frees its indexed native allocation while the
     * owning metadata transaction already holds pub; no recursive lock. */
    assert(_wpk_wl_surface_release_pending(&cap)==WPK_WL_RETIRE_COMPLETE);
    assert(!wpk_wl_native_pointer_admitted(proxy)&&errno==ECHILD);
    wl_event_queue_destroy(queue);assert(!wpk_wl_native_pointer_admitted(queue));
    wl_display_disconnect(display);assert(!wpk_wl_native_pointer_admitted(display));
    assert(fcntl(pair[0],F_GETFD)<0&&errno==EBADF);close(pair[1]);
}
static unsigned provenance_verify_avl(struct wpk_wl_native_range *p,uintptr_t lower,uintptr_t upper){
    if(!p)return 0;assert(p->base>lower&&p->base<upper);
    unsigned a=provenance_verify_avl(p->left,lower,p->base),b=provenance_verify_avl(p->right,p->base,upper);
    assert(a<=b+1&&b<=a+1&&p->height==1+(a>b?a:b));return p->height;
}
int main(void){
    alarm(15);int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));
    struct wl_display *display=wl_display_connect_to_fd(pair[0]);assert(display);
    struct wl_event_queue *queue=wl_display_create_queue(display);assert(queue);
    assert(!_wpk_drm_native_fork_epoch()&&!wpk_wl_native_ranges);
    assert(wpk_wl_native_pointer_admitted(display)&&!wpk_wl_native_ranges);
    atomic_store(&wpk_native_fixture_multithread,1);pid_t child=fork();assert(child>=0);
    if(child)atomic_store(&wpk_native_fixture_multithread,0);
    if(!child){
        assert(_wpk_drm_native_fork_epoch()==1);
        assert(!wpk_wl_native_pointer_admitted(display)&&!wpk_wl_native_pointer_admitted(queue));
        void *poison=mmap(NULL,4096,PROT_NONE,MAP_ANON|MAP_PRIVATE,-1,0);assert(poison!=MAP_FAILED);
        assert(!wpk_wl_native_pointer_admitted(poison)&&errno==ECHILD);assert(!munmap(poison,4096));
        provenance_fresh();assert(!wpk_wl_native_ranges);
        void *blocks[257];for(unsigned i=0;i<257;i++){blocks[i]=wpk_wl_native_malloc(1+i);assert(blocks[i]);provenance_verify_avl(wpk_wl_native_ranges,0,UINTPTR_MAX);}
        for(unsigned i=0;i<257;i++){unsigned j=(i*97)%257;assert(wpk_wl_native_pointer_admitted((char*)blocks[j]+j));wpk_wl_native_free(blocks[j]);provenance_verify_avl(wpk_wl_native_ranges,0,UINTPTR_MAX);}
        assert(!wpk_wl_native_ranges);
        void *epoch1=wpk_wl_native_calloc(3,37);assert(epoch1&&wpk_wl_native_pointer_admitted(epoch1));
        assert(!wpk_wl_native_calloc(SIZE_MAX,2)&&errno==ENOMEM);
        atomic_store(&wpk_native_fixture_multithread,1);pid_t nested=fork();assert(nested>=0);
        if(!nested){assert(_wpk_drm_native_fork_epoch()==2&&!wpk_wl_native_pointer_admitted(epoch1));provenance_fresh();_exit(0);}
        atomic_store(&wpk_native_fixture_multithread,0);int status;assert(waitpid(nested,&status,0)==nested&&WIFEXITED(status)&&!WEXITSTATUS(status));
        assert(wpk_wl_native_pointer_admitted(epoch1));wpk_wl_native_free(epoch1);assert(!wpk_wl_native_ranges);_exit(0);
    }
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
    assert(!wpk_wl_native_ranges&&!_wpk_drm_native_fork_epoch());
    char c;assert(write(pair[1],"x",1)==1&&read(pair[0],&c,1)==1&&c=='x');
    wl_event_queue_destroy(queue);wl_display_disconnect(display);close(pair[1]);
    puts("PASS fresh-only native provenance, parent bypass, embedded ranges, poison, AVL, later epoch");return 0;
}
