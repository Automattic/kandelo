/* Actual pinned native queue destroy + utility logging adapter + ActorScope.
 * No normal Wasm/compositor/complete native cleanup acceptance is implied. */
#include <sched.h>
#include "drm_owned.c"
#define main original_connection_control_main
#include "wayland-connection.c"
#undef main
#include "wayland-retirement.h"
extern unsigned wpk_log_allocations,wpk_log_deny;
void wl_log_set_handler_server(wl_log_func_t);
static unsigned native_allocation_fail;
#undef calloc
void *wpk_native_calloc(size_t n,size_t bytes){
    if(native_allocation_fail){native_allocation_fail=0;errno=ENOMEM;return NULL;}
    return calloc(n,bytes);
}
static struct wpk_wl_proxy_retirement proxy_state;
static int proxy_case,proxy_plain,proxy_local;
static uint32_t destroyed_id;
static struct wpk_wl_queue_retirement queue_state;
static struct wpk_wl_log_scope nested_logs,outer_logs,resolver_logs;
static unsigned resolver_calls;
static struct wpk_wl_log_scope *fixture_resolver(void){resolver_calls++;return &resolver_logs;}

static int nested_capture,defer_case,defer_ready,defer_proceed;
static unsigned deferred_ready_calls;
static pthread_mutex_t facade_mutex=PTHREAD_MUTEX_INITIALIZER;
static struct wpk_drm_actor_claim outer_claim;
static struct wl_display *native_display;
static struct wl_event_queue *native_queue;
static struct wl_proxy *native_buffer;
static int native_pair[2],mode,callback_child,callback_count,direct_count;
static char captured[4096];
static void fifo_handler(const char *fmt,va_list args){
    assert(!pthread_mutex_trylock(&capture_publication_mutex));pthread_mutex_unlock(&capture_publication_mutex);
    char text[32];assert(vsnprintf(text,sizeof text,fmt,args)>0);strcat(captured,text);
}
static const char direct_format[]="direct=%d\n";
static pthread_mutex_t log_gate=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t log_changed=PTHREAD_COND_INITIALIZER;
static int handler_ready,seal_ready,seal_proceed,foreign_seal_child;
static void log_leaf_publication_end(void);
#define _wpk_drm_owned_publication_end log_leaf_publication_end
#ifndef WPK_WAYLAND_LEAF_SOURCE
#define WPK_WAYLAND_LEAF_SOURCE "wayland-client-retirement.inc"
#endif
#include WPK_WAYLAND_LEAF_SOURCE
#undef _wpk_drm_owned_publication_end
static struct wpk_wl_log_scope *operation_logs=&queue_state.logs;
static int operation_live(void){return proxy_case?proxy_state.live!=NULL:queue_state.live!=NULL;}
static enum wpk_wl_retire_result pending_leaf(void){
    return proxy_case?(proxy_local?_wpk_wl_proxy_destroy_local_pending(&proxy_state):
        _wpk_wl_proxy_destroy_pending(&proxy_state,WL_BUFFER_DESTROY)):_wpk_wl_queue_destroy_pending(&queue_state);
}
void _wpk_egl_request_native_drain(void){
    assert(!pthread_mutex_trylock(&capture_publication_mutex));pthread_mutex_unlock(&capture_publication_mutex);
    deferred_ready_calls++;
}
static void log_gate_unlock(void *unused){(void)unused;pthread_mutex_unlock(&log_gate);}
static void handler_quiet(const char *fmt,va_list args){vfprintf(stderr,fmt,args);}
static void finish_scope(void){
    if(actor_current_scope){
        struct wpk_drm_actor_scope *p=actor_current_scope;
        assert(!pthread_setspecific(actor_scope_key,NULL));actor_scope_ended(p);
    }
    assert(!actor_scopes);
}
static void owner_begin(void){
    assert(_wpk_drm_actor_prepare());_wpk_drm_owned_publication_begin();
    assert(_wpk_drm_actor_try_claim_locked(&outer_claim));_wpk_drm_owned_publication_end();
}
static void owner_end(void){_wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&outer_claim);_wpk_drm_owned_publication_end();}
static void handler_direct(const char *fmt,va_list args){
    assert(fmt==direct_format);assert(va_arg(args,int)==5);direct_count++;
}
static void log_leaf_publication_end(void){
    _wpk_drm_owned_publication_end();
    if(mode==6&&!operation_live())wl_log_set_handler_server(handler_direct);
    if(mode==7&&!operation_live()&&!seal_ready){
        pthread_mutex_lock(&log_gate);seal_ready=1;pthread_cond_broadcast(&log_changed);
        while(!seal_proceed)pthread_cond_wait(&log_changed,&log_gate);
        pthread_mutex_unlock(&log_gate);
    }
}
static void handler_capture(const char *fmt,va_list args){
    char text[2048];assert(vsnprintf(text,sizeof text,fmt,args)>0);
    /* Every native leaf has actually returned and its slot has sealed. */
    assert(!operation_live());
    if(!foreign_seal_child){assert(!pthread_mutex_trylock(&native_display->mutex));pthread_mutex_unlock(&native_display->mutex);}
    assert(!pthread_mutex_trylock(&capture_publication_mutex));pthread_mutex_unlock(&capture_publication_mutex);
    assert(!pthread_mutex_trylock(&facade_mutex));pthread_mutex_unlock(&facade_mutex);
    callback_count++;assert(strlen(captured)+strlen(text)<sizeof captured);strcat(captured,text);
    if(callback_count==1&&mode==1){
        /* Independent nested capture; ordinary callback logging stays direct. */
        assert(_wpk_wl_log_capture_begin(&nested_logs));wl_log("nested=%d\n",7);_wpk_wl_log_capture_end(&nested_logs);
        int prior=mode;mode=0;assert(_wpk_wl_log_deliver(&nested_logs));mode=prior;
        wl_log_set_handler_server(handler_direct);wl_log(direct_format,5);wl_log_set_handler_client(handler_capture);
    }
    if(callback_count==1&&mode==2){
        pid_t child=fork();assert(child>=0);
        if(!child){callback_child=1;assert(pending_leaf()==WPK_WL_RETIRE_PENDING);assert((*operation_logs).messages);}
        else{int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));}
    }
    if(callback_count==1&&mode==3)pthread_exit(NULL);
    if(callback_count==1&&mode==4){
        int prior;assert(!pthread_setcancelstate(PTHREAD_CANCEL_ENABLE,&prior));
        pthread_mutex_lock(&log_gate);handler_ready=1;pthread_cond_broadcast(&log_changed);
        pthread_cleanup_push(log_gate_unlock,NULL);
        for(;;)pthread_cond_wait(&log_changed,&log_gate);
        pthread_cleanup_pop(1);
    }
}
static void handler_fatal(const char *fmt,va_list args){
    assert(!(*operation_logs).messages);fputs("IMMEDIATE FATAL: ",stderr);vfprintf(stderr,fmt,args);
}
static void native_setup(void){
    assert(!socketpair(AF_UNIX,SOCK_STREAM,0,native_pair));
    native_display=wl_display_connect_to_fd(native_pair[0]);assert(native_display);
    native_queue=wl_display_create_queue_with_name(native_display,"owned-queue");assert(native_queue);
    queue_state.live=native_queue;
    native_buffer=proxy_create(&native_display->proxy,proxy_local?&wl_registry_interface:&wl_buffer_interface,1);assert(native_buffer);
    wl_proxy_set_queue(native_buffer,native_queue);
    destroyed_id=wl_proxy_get_id(native_buffer);
    if(proxy_case){proxy_state.live=native_buffer;operation_logs=&proxy_state.logs;}
}
static void *native_cleanup(void *unused){
    (void)unused;int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);owner_begin();
    if(nested_capture||defer_case){
        assert(_wpk_wl_log_capture_begin(&outer_logs));
        if(nested_capture)wl_log("outer-before\n");
    }
    if(mode==5)wpk_log_deny=1;
    if(proxy_case){
        native_buffer=NULL; /* owning native pointer is the proxy capsule */
        if(!proxy_plain&&!proxy_local)native_allocation_fail=1;
    }else native_queue=NULL; /* fixture alias only; queue_state owns the queue */
    assert(pending_leaf()==WPK_WL_RETIRE_COMPLETE);
    if(nested_capture||defer_case){
        assert(!callback_count&&!queue_state.logs.messages&&outer_logs.messages);
        if(nested_capture)wl_log("outer-after\n");
        _wpk_drm_owned_publication_begin();_wpk_wl_log_capture_end_locked(&outer_logs);_wpk_drm_owned_publication_end();
        operation_logs=&outer_logs;
        if(defer_case){
            assert(_wpk_wl_log_defer(&outer_logs));assert(!outer_logs.messages);owner_end();
            if(defer_case==2){
                pthread_mutex_lock(&log_gate);defer_ready=1;pthread_cond_broadcast(&log_changed);
                while(!defer_proceed)pthread_cond_wait(&log_changed,&log_gate);
                pthread_mutex_unlock(&log_gate);
                assert(!_wpk_wl_log_drain_deferred());
            }else if(defer_case==3)pthread_exit(NULL);
            else if(defer_case==4)(void)_wpk_wl_log_drain_deferred();
            pthread_setcancelstate(prior,NULL);return NULL;
        }
        assert(_wpk_wl_log_deliver(&outer_logs));
    }
    owner_end();pthread_setcancelstate(prior,NULL);return NULL;
}
int main(int argc,char **argv){
    assert(argc==2);alarm(15);
    mode=!strcmp(argv[1],"nested")?1:!strcmp(argv[1],"self-fork")?2:!strcmp(argv[1],"exit")?3:!strcmp(argv[1],"cancel")?4:!strcmp(argv[1],"oom")?5:!strcmp(argv[1],"handler-identity")?6:!strcmp(argv[1],"foreign-seal")?7:0;
    nested_capture=!strcmp(argv[1],"nested-capture");
    defer_case=!strcmp(argv[1],"defer")?1:!strcmp(argv[1],"defer-live-peer")?2:
        !strcmp(argv[1],"defer-origin-exit")?3:!strcmp(argv[1],"defer-callback-exit")?4:0;
    if(defer_case==4)mode=3;
    proxy_case=strstr(argv[1],"proxy-")!=NULL;
    proxy_plain=!strcmp(argv[1],"proxy-plain");proxy_local=!strcmp(argv[1],"proxy-local");
    if(!strcmp(argv[1],"proxy-exit"))mode=3;
    if(!strcmp(argv[1],"defer-fifo")){
        struct wpk_wl_log_scope first={0},second={0};owner_begin();
        wl_log_set_handler_client(fifo_handler);
        assert(_wpk_wl_log_capture_begin(&first));wl_log("A");_wpk_wl_log_capture_end(&first);
        assert(_wpk_wl_log_defer(&first));
        assert(_wpk_wl_log_capture_begin(&second));wl_log("B");_wpk_wl_log_capture_end(&second);
        assert(_wpk_wl_log_defer(&second));owner_end();
        assert(!*captured&&deferred_ready_calls==2);assert(!_wpk_wl_log_drain_deferred());
        assert(!strcmp(captured,"AB")&&!wpk_log_allocations);finish_scope();
        puts("PASS actual utility deferred separate-owner FIFO A then B");return 0;
    }
    native_setup();wl_log_set_handler_client(handler_capture);
    if(!strcmp(argv[1],"resolver")){
        assert(_wpk_wl_log_set_resolver(fixture_resolver));owner_begin();
        assert(wl_proxy_get_id(native_buffer)==destroyed_id&&!resolver_calls);
        wl_event_queue_destroy(native_queue);native_queue=NULL;
        assert(resolver_calls==1&&!callback_count&&resolver_logs.messages&&resolver_logs.capturing);
        _wpk_drm_owned_publication_begin();queue_state.live=NULL;
        _wpk_wl_log_capture_end_locked(&resolver_logs);_wpk_drm_owned_publication_end();
        operation_logs=&resolver_logs;assert(_wpk_wl_log_defer(&resolver_logs));owner_end();
        assert(!_wpk_wl_log_drain_deferred()&&callback_count==2&&!wpk_log_allocations);
        wl_proxy_destroy(native_buffer);wl_log_set_handler_client(handler_quiet);wl_display_disconnect(native_display);close(native_pair[1]);
        finish_scope();puts("PASS actual native error-only resolver capture and post-unlock delivery");return 0;
    }
    if(!strcmp(argv[1],"fatal")){
        owner_begin();assert(_wpk_wl_log_capture_begin(&(*operation_logs)));wl_log_set_handler_server(handler_fatal);wl_abort("fatal capture %d\n",3);
    }
    if(defer_case){
        pthread_mutex_lock(&facade_mutex);
        if(defer_case==1){
            native_cleanup(NULL);assert(!callback_count&&deferred_ready_calls==1);
            pthread_mutex_unlock(&facade_mutex);assert(!_wpk_wl_log_drain_deferred());
        }else{
            pthread_t worker;assert(!pthread_create(&worker,NULL,native_cleanup,NULL));
            if(defer_case==2){
                pthread_mutex_lock(&log_gate);while(!defer_ready)pthread_cond_wait(&log_changed,&log_gate);pthread_mutex_unlock(&log_gate);
                assert(_wpk_wl_log_drain_deferred()==1&&!callback_count&&deferred_ready_calls==1);
                pthread_mutex_unlock(&facade_mutex);
                pthread_mutex_lock(&log_gate);defer_proceed=1;pthread_cond_broadcast(&log_changed);pthread_mutex_unlock(&log_gate);
            }else pthread_mutex_unlock(&facade_mutex);
            assert(!pthread_join(worker,NULL));mode=0;
            assert(callback_count==(defer_case==4?1:defer_case==2?2:0));
            assert(!_wpk_wl_log_drain_deferred());
        }
    }else if(mode==7){
        pthread_t worker;assert(!pthread_create(&worker,NULL,native_cleanup,NULL));
        pthread_mutex_lock(&log_gate);while(!seal_ready)pthread_cond_wait(&log_changed,&log_gate);pthread_mutex_unlock(&log_gate);
#ifdef KANDELO_WAYLAND_NATIVE_EPOCH_DOUBLE
        atomic_store(&wpk_native_fixture_multithread,1);
#endif
        pid_t child=fork();assert(child>=0);
#ifdef KANDELO_WAYLAND_NATIVE_EPOCH_DOUBLE
        if(child)atomic_store(&wpk_native_fixture_multithread,0);
#endif
        if(!child){
            foreign_seal_child=1;mode=0;owner_begin();
            assert(pending_leaf()==WPK_WL_RETIRE_COMPLETE);
            owner_end();assert(callback_count==2&&!wpk_log_allocations);finish_scope();_exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
        pthread_mutex_lock(&log_gate);seal_proceed=1;pthread_cond_broadcast(&log_changed);pthread_mutex_unlock(&log_gate);
        assert(!pthread_join(worker,NULL));
    }else if(mode==3||mode==4){
        pthread_t worker;assert(!pthread_create(&worker,NULL,native_cleanup,NULL));
        if(mode==4){
            pthread_mutex_lock(&log_gate);while(!handler_ready)pthread_cond_wait(&log_changed,&log_gate);pthread_mutex_unlock(&log_gate);
            assert(!pthread_cancel(worker));
        }
        void *result=NULL;assert(!pthread_join(worker,&result));if(mode==4)assert(result==PTHREAD_CANCELED);
        assert(!operation_live()&&(*operation_logs).messages&&callback_count==1);mode=0;owner_begin();
        assert(pending_leaf()==WPK_WL_RETIRE_COMPLETE);owner_end();
    }else native_cleanup(NULL);
    assert(!(*operation_logs).messages&&!nested_logs.messages&&!wpk_log_allocations);
    assert(callback_count==((proxy_plain||proxy_local)?0:nested_capture?4:!strcmp(argv[1],"nested")?3:2));
    if(proxy_case&&!proxy_plain&&!proxy_local){
        assert(strstr(captured,"could not allocate closure")&&strstr(captured,"wl_buffer.destroy"));
        assert(native_display->last_error==ENOMEM);
    }else if(!proxy_case)assert(strstr(captured,"owned-queue")&&strstr(captured,"wl_buffer#"));
    if(nested_capture){
        char *before=strstr(captured,"outer-before"),*middle=strstr(captured,"owned-queue"),*after=strstr(captured,"outer-after");
        assert(before&&middle&&after&&before<middle&&middle<after);
    }
    if(!strcmp(argv[1],"nested"))assert(direct_count==1&&strstr(captured,"nested=7"));
    wl_log_set_handler_client(handler_direct);wl_log(direct_format,5);
    assert(direct_count==(!strcmp(argv[1],"nested")?2:1));
    if(proxy_case){
        /* Completed/retried native leaf must not queue another destructor. */
        assert(pending_leaf()==WPK_WL_RETIRE_COMPLETE);
        if(proxy_plain||proxy_local)assert(wl_display_flush(native_display)>=0);
        struct pollfd pfd={.fd=native_pair[1],.events=POLLIN};
        if(proxy_plain){
            uint32_t request[2];assert(read(native_pair[1],request,sizeof request)==sizeof request);
            assert(request[0]==destroyed_id&&request[1]==(8u<<16|WL_BUFFER_DESTROY));
        }
        assert(poll(&pfd,1,0)==0);
        assert(_wpk_wl_queue_destroy_pending(&queue_state)==WPK_WL_RETIRE_COMPLETE);native_queue=NULL;
    }else wl_proxy_destroy(native_buffer);
    wl_log_set_handler_client(handler_quiet);
    wl_display_disconnect(native_display);assert(fcntl(native_pair[0],F_GETFD)<0&&errno==EBADF);close(native_pair[1]);
    finish_scope();printf("PASS actual native Wayland deferred logs %s\n",argv[1]);
    if(callback_child)_exit(0);return 0;
}
