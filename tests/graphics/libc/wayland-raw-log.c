/* Real native ordinary logs: handlers exit after (after) or during (before)
 * actual native queue/marshal/constructor/protocol error work. */
#include <sys/socket.h>
#include "drm_owned.c"
static int raw_observed_socket=-1;
static int raw_socket_observer(int,int,int);
#define socket raw_socket_observer
#define main original_connection_control_main
#include "wayland-connection.c"
#undef main
#undef socket
static int raw_socket_observer(int domain,int type,int protocol){
    int fd=socket(domain,type,protocol);raw_observed_socket=fd;return fd;
}
static unsigned native_allocation_fail,native_fail_closure;
#undef calloc
void *wpk_native_calloc(size_t count,size_t bytes){
    if(native_allocation_fail||(native_fail_closure&&count==1&&bytes==sizeof(struct wl_closure))){
        native_allocation_fail=native_fail_closure=0;errno=ENOMEM;return NULL;
    }
    return calloc(count,bytes);
}
static struct wl_display *raw_display;
static struct wl_event_queue *raw_queue;
static struct wl_proxy *raw_buffer;
static uint32_t raw_created_id;
static int raw_pair[2],raw_mode,raw_callbacks,raw_exit=1,raw_ready,raw_fd_was_open,raw_state_was_unsealed;
void _wpk_egl_request_native_drain(void){
    assert(!pthread_mutex_trylock(&capture_publication_mutex));pthread_mutex_unlock(&capture_publication_mutex);raw_ready++;
}
static void raw_handler(const char *format,va_list args){
    char text[2048];assert(vsnprintf(text,sizeof text,format,args)>0);fputs(text,stderr);raw_callbacks++;
    assert(!pthread_mutex_trylock(&capture_publication_mutex));pthread_mutex_unlock(&capture_publication_mutex);
    if(raw_mode==2){
        assert(raw_observed_socket>=0);raw_fd_was_open=fcntl(raw_observed_socket,F_GETFD)>=0;
    }else{
        int locked=pthread_mutex_trylock(&raw_display->mutex);
        if(!locked)pthread_mutex_unlock(&raw_display->mutex);else raw_state_was_unsealed=1;
        if(raw_mode==3&&raw_display->last_error!=EPROTO)raw_state_was_unsealed=1;
        if((raw_mode==1||raw_mode==4)&&raw_display->last_error!=ENOMEM)raw_state_was_unsealed=1;
    }
#ifdef WPK_WL_RAW_ENTRY_ENABLED
    assert(!raw_fd_was_open&&!raw_state_was_unsealed);
    assert(wpk_wl_raw_retirements&&wpk_wl_raw_retirements->native_returned);
    if(raw_mode==4){assert(wpk_wl_raw_retirements->proxy.live);raw_created_id=wl_proxy_get_id(wpk_wl_raw_retirements->proxy.live);}
#endif
    if(raw_exit)pthread_exit(NULL);
}
static void raw_quiet(const char *format,va_list args){vfprintf(stderr,format,args);}
static void *raw_operation(void *unused){
    (void)unused;
    if(raw_mode==2){
        char path[256];memset(path,'x',sizeof path);path[0]='/';path[sizeof path-1]=0;
        assert(!wl_display_connect(path));
    }else if(raw_mode==1){
        assert(_wpk_drm_actor_prepare());native_allocation_fail=1;
        struct wl_proxy *proxy=raw_buffer;raw_buffer=NULL;
        wl_proxy_marshal_array_flags(proxy,WL_BUFFER_DESTROY,NULL,1,WL_MARSHAL_FLAG_DESTROY,NULL);
    }else if(raw_mode==4){
        assert(_wpk_drm_actor_prepare());native_fail_closure=1;
        union wl_argument args[1]={{.o=NULL}};
        (void)wl_proxy_marshal_array_flags((void*)raw_display,WL_DISPLAY_GET_REGISTRY,&wl_registry_interface,1,0,args);
    }else if(raw_mode==3)(void)wl_display_dispatch(raw_display);
    else{struct wl_event_queue *queue=raw_queue;raw_queue=NULL;wl_event_queue_destroy(queue);}
    return NULL;
}
int main(int argc,char **argv){
    assert(argc==2);alarm(15);
    raw_mode=!strcmp(argv[1],"proxy-constructor-exit")?4:!strcmp(argv[1],"constructor-exit")?2:!strcmp(argv[1],"protocol-error-exit")?3:!strcmp(argv[1],"marshal-exit")?1:0;
    if(raw_mode!=2){
        assert(!socketpair(AF_UNIX,SOCK_STREAM,0,raw_pair));raw_display=wl_display_connect_to_fd(raw_pair[0]);assert(raw_display);
        raw_queue=wl_display_create_queue_with_name(raw_display,"raw-exit");assert(raw_queue);
        raw_buffer=proxy_create(&raw_display->proxy,&wl_buffer_interface,1);assert(raw_buffer);wl_proxy_set_queue(raw_buffer,raw_queue);
        if(raw_mode==3){
            uint32_t wire[6]={1,24u<<16|0u,raw_buffer->object.id,WL_DISPLAY_ERROR_INVALID_OBJECT,4,0};
            memcpy(&wire[5],"bad",4);assert(write(raw_pair[1],wire,sizeof wire)==sizeof wire);
        }
    }
    wl_log_set_handler_client(raw_handler);pthread_t worker;assert(!pthread_create(&worker,NULL,raw_operation,NULL));
    assert(!pthread_join(worker,NULL)&&raw_callbacks==1);
#ifndef WPK_WL_RAW_ENTRY_ENABLED
    printf("OBS raw handler exit constructor_fd_open=%d native_state_unsealed=%d\n",raw_fd_was_open,raw_state_was_unsealed);
    assert(raw_fd_was_open||raw_state_was_unsealed);return 42;
#else
    assert(raw_ready&&wpk_wl_raw_retirements);raw_exit=0;
    assert(!_wpk_wl_raw_drain_deferred()&&!wpk_wl_raw_retirements);
    assert(raw_callbacks==((raw_mode==0||raw_mode==1||raw_mode==4)?2:1));
    if(raw_mode==4)assert(raw_created_id&&wl_map_lookup_flags(&raw_display->objects,raw_created_id)&WL_MAP_ENTRY_ZOMBIE);
    wl_log_set_handler_client(raw_quiet);
    if(raw_mode==2){assert(fcntl(raw_observed_socket,F_GETFD)<0&&errno==EBADF);}
    else{
        if(raw_mode==1){
            /* Native failed request destructor already freed its exact proxy.
             * No pointer replay may run during adoption. */
            assert(raw_display->last_error==ENOMEM);
        }else wl_proxy_destroy(raw_buffer);
        /* Actual native custom queue still owns its independent public handle
         * for protocol/error tests; queue-exit already destroyed that handle. */
        if(raw_mode==3||raw_mode==1||raw_mode==4)wl_event_queue_destroy(raw_queue);
        wl_display_disconnect(raw_display);assert(fcntl(raw_pair[0],F_GETFD)<0&&errno==EBADF);close(raw_pair[1]);
    }
    printf("PASS actual raw native handler exit %s, progress sealed and dead owner adopted\n",argv[1]);return 0;
#endif
}
