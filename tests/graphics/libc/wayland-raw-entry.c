/* All pinned raw entry guards, actual native fresh allocations and transport.
 * Callback/log continuation stage is deliberately not enabled yet. */
#include "drm_owned.c"
#define main original_connection_control_main
#include "wayland-connection.c"
#undef main
#include <sys/mman.h>
void _wpk_egl_request_native_drain(void){}
static void check_all_poison_entries(void *poison){
    errno=0;wl_event_queue_destroy(poison);assert(errno==ECHILD);
    errno=0;assert(wl_display_create_queue(poison)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_display_create_queue_with_name(poison,NULL)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_create(poison,NULL)==NULL);assert(errno==ECHILD);
    errno=0;wl_proxy_destroy(poison);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_add_listener(poison,NULL,NULL)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_get_listener(poison)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_add_dispatcher(poison,NULL,NULL,NULL)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_marshal_array_constructor(poison,0,NULL,NULL)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_marshal_array_constructor_versioned(poison,0,NULL,NULL,0)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_marshal_flags(poison,0,NULL,0,0)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_marshal_array_flags(poison,0,NULL,0,0,NULL)==NULL);assert(errno==ECHILD);
    errno=0;wl_proxy_marshal(poison,0);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_marshal_constructor(poison,0,NULL)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_marshal_constructor_versioned(poison,0,NULL,0)==NULL);assert(errno==ECHILD);
    errno=0;wl_proxy_marshal_array(poison,0,NULL);assert(errno==ECHILD);
    errno=0;assert(wl_display_get_fd(poison)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_roundtrip_queue(poison,NULL)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_roundtrip(poison)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_read_events(poison)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_prepare_read_queue(poison,NULL)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_prepare_read(poison)==-1);assert(errno==ECHILD);
    errno=0;wl_display_cancel_read(poison);assert(errno==ECHILD);
    errno=0;assert(wl_display_dispatch_queue_timeout(poison,NULL,NULL)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_dispatch_timeout(poison,NULL)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_dispatch_queue(poison,NULL)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_dispatch_queue_pending(poison,NULL)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_dispatch(poison)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_dispatch_pending(poison)==-1);assert(errno==ECHILD);
    errno=0;assert(wl_display_get_error(poison)==ECHILD);assert(errno==ECHILD);
    errno=0;assert(wl_display_get_protocol_error(poison,NULL,NULL)==0);assert(errno==ECHILD);
    errno=0;assert(wl_display_flush(poison)==-1);assert(errno==ECHILD);
    errno=0;wl_display_set_max_buffer_size(poison,0);assert(errno==ECHILD);
    errno=0;wl_proxy_set_user_data(poison,NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_get_user_data(poison)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_get_version(poison)==0);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_get_id(poison)==0);assert(errno==ECHILD);
    errno=0;wl_proxy_set_tag(poison,NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_get_tag(poison)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_get_class(poison)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_get_interface(poison)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_get_display(poison)==NULL);assert(errno==ECHILD);
    errno=0;wl_proxy_set_queue(poison,NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_get_queue(poison)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_event_queue_get_name(poison)==NULL);assert(errno==ECHILD);
    errno=0;assert(wl_proxy_create_wrapper(poison)==NULL);assert(errno==ECHILD);
    errno=0;wl_proxy_wrapper_destroy(poison);assert(errno==ECHILD);
}
int main(void){
    alarm(15);int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));
    struct wl_display *parent=wl_display_connect_to_fd(pair[0]);assert(parent&&!wpk_wl_native_ranges);
    atomic_store(&wpk_native_fixture_multithread,1);pid_t child=fork();assert(child>=0);
    if(child)atomic_store(&wpk_native_fixture_multithread,0);
    if(!child){
        void *poison=mmap(NULL,4096,PROT_NONE,MAP_ANON|MAP_PRIVATE,-1,0);assert(poison!=MAP_FAILED);
        check_all_poison_entries(poison);
        int fresh[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,fresh));
        struct wl_display *display=wl_display_connect_to_fd(fresh[0]);assert(display&&wl_display_get_fd(display)==fresh[0]);
        struct wl_event_queue *queue=wl_display_create_queue_with_name(display,"fresh");assert(queue);
        struct wl_proxy *proxy=wl_proxy_create((void*)display,&wl_surface_interface);assert(proxy);
        assert(wl_proxy_get_version(proxy)==0&&wl_proxy_get_id(proxy)>0&&wl_proxy_get_display(proxy)==display);
        errno=0;assert(wl_display_dispatch_queue_pending(display,poison)==-1&&errno==ECHILD);
        struct wl_event_queue *before=wl_proxy_get_queue(proxy);errno=0;wl_proxy_set_queue(proxy,poison);
        assert(errno==ECHILD&&wl_proxy_get_queue(proxy)==before);
        /* Fresh primary is proven before reading its native signature, then
         * poisoned secondary object is rejected before any native effect. */
        union wl_argument args[3]={{.o=poison},{.i=0},{.i=0}};
        errno=0;assert(!wl_proxy_marshal_array_flags(proxy,WL_SURFACE_ATTACH,NULL,1,0,args)&&errno==ECHILD);
        errno=0;assert(!wl_proxy_marshal_flags(proxy,WL_SURFACE_ATTACH,NULL,1,0,poison,0,0)&&errno==ECHILD);
        assert(wl_display_get_error(display)==0&&wl_display_flush(display)==0);
        struct pollfd pfd={.fd=fresh[1],.events=POLLIN};assert(poll(&pfd,1,0)==0);
        wl_proxy_set_queue(proxy,queue);assert(wl_proxy_get_queue(proxy)==queue);
        wl_proxy_destroy(proxy);wl_event_queue_destroy(queue);wl_display_disconnect(display);close(fresh[1]);
        assert(!wpk_wl_native_ranges);assert(!munmap(poison,4096));
        wl_display_disconnect(parent);assert(errno==ECHILD&&fcntl(pair[0],F_GETFD)>=0);_exit(0);
    }
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
    char c;assert(write(pair[1],"a",1)==1&&read(pair[0],&c,1)==1&&c=='a');
    assert(write(pair[0],"b",1)==1&&read(pair[1],&c,1)==1&&c=='b');
    assert(!wpk_wl_native_ranges);wl_display_disconnect(parent);close(pair[1]);
    puts("PASS actual 47 raw guards before poison dereference, secondary queue/object, fresh child and parent transport");return 0;
}
