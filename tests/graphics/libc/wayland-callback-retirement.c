/* Actual incoming native listener/dispatcher, SCM_RIGHTS, pthread exit and
 * callback fork return. Explicit native epoch double, not guest execution. */
#include "drm_owned.c"
static void callback_native_free(void *);
static int callback_native_setcancel(int,int *);
static void callback_native_testcancel(void);
#define pthread_setcancelstate callback_native_setcancel
#define pthread_testcancel callback_native_testcancel
#define main original_connection_control_main
#include "wayland-connection.c"
#undef main
#undef pthread_setcancelstate
#undef pthread_testcancel
static uintptr_t callback_target_address,callback_argument_address;
static unsigned callback_target_frees,callback_argument_frees;
static void callback_native_free(void *pointer){
    if((uintptr_t)pointer==callback_target_address)callback_target_frees++;
    if((uintptr_t)pointer==callback_argument_address)callback_argument_frees++;
#ifdef WPK_WL_RAW_ENTRY_ENABLED
    wpk_wl_native_free(pointer);
#else
    free(pointer);
#endif
}
static struct wl_display *callback_display;
static struct wl_proxy *callback_target,*callback_argument;
static int callback_pair[2],callback_feed[2],callback_replacements[2][2];
static struct wl_proxy *callback_replacement_proxy,*callback_discard_target;
static struct wl_event_queue *callback_read_queue;
static union wl_argument *callback_live_arguments;
static int callback_nested,callback_mutate,callback_second_cancel,callback_pending_restore,callback_disabled_mask,callback_first_discard;
static int callback_restore_fd=-1,callback_restore_release,callback_restore_observed,callback_testcancel_calls;
static int callback_count,callback_action,callback_dispatcher,callback_child_status=-1,callback_ready,callback_pre_destroy;
static int callback_explicit_capture,callback_disconnect_adopt;
static struct wpk_wl_log_scope callback_external_scope;
static pthread_mutex_t callback_gate=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t callback_changed=PTHREAD_COND_INITIALIZER;
static int callback_waiting;
static void callback_unlock(void *unused){(void)unused;pthread_mutex_unlock(&callback_gate);}
static int callback_native_setcancel(int state,int *prior){
#ifdef WPK_WL_RAW_ENTRY_ENABLED
    if(callback_pending_restore&&!callback_restore_observed&&state==PTHREAD_CANCEL_ENABLE&&wpk_wl_current_callback&&
            callback_count==0&&!wpk_wl_current_callback->delivered){
        assert(!pthread_mutex_trylock(&callback_display->mutex));pthread_mutex_unlock(&callback_display->mutex);
        assert(!pthread_mutex_trylock(&capture_publication_mutex));pthread_mutex_unlock(&capture_publication_mutex);
        callback_restore_fd=wpk_wl_current_callback->closure->args[1].h;assert(fcntl(callback_restore_fd,F_GETFD)>=0);
        callback_restore_observed=1;pthread_mutex_lock(&callback_gate);callback_waiting=1;pthread_cond_broadcast(&callback_changed);
        while(!callback_restore_release)pthread_cond_wait(&callback_changed,&callback_gate);
        pthread_mutex_unlock(&callback_gate);
    }
#endif
    return pthread_setcancelstate(state,prior);
}
static void callback_native_testcancel(void){callback_testcancel_calls++;pthread_testcancel();}
void _wpk_egl_request_native_drain(void){
    assert(!pthread_mutex_trylock(&capture_publication_mutex));pthread_mutex_unlock(&capture_publication_mutex);callback_ready++;
}
static const struct wl_interface *callback_types[]={&wl_buffer_interface,NULL};
static const struct wl_message callback_events[]={{"delivered","oh",callback_types}};
static const struct wl_interface callback_interface={"owned_callback",1,0,NULL,1,callback_events};
static void callback_recycle_fd(int fd,unsigned index){
    assert(index<2);
    assert(fcntl(fd,F_GETFD)&FD_CLOEXEC);assert(!close(fd));
    int replacement[2];assert(!pipe(replacement));
    int readfd=replacement[0],writefd=replacement[1];
    if(writefd==fd){writefd=fcntl(writefd,F_DUPFD_CLOEXEC,fd+1);assert(writefd>=0);close(replacement[1]);}
    if(readfd!=fd){assert(dup2(readfd,fd)==fd);close(readfd);}
    callback_replacements[index][0]=fd;callback_replacements[index][1]=writefd;
}
static void callback_fresh_child(void){
    errno=0;assert(wl_proxy_get_id(callback_target)==0&&errno==ECHILD);
    int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));
    struct wl_display *fresh=wl_display_connect_to_fd(pair[0]);assert(fresh&&wl_display_get_fd(fresh)==pair[0]);
    uint64_t identity;assert(_wpk_wl_display_metadata(fresh,&identity));
    wl_display_disconnect(fresh);assert(fcntl(pair[0],F_GETFD)<0&&errno==EBADF);close(pair[1]);
}
static void callback_user(struct wl_proxy *target,struct wl_proxy *argument,int fd){
    assert(target==callback_target);callback_count++;
    int inner=callback_nested&&callback_count==2;
    assert(argument==((callback_pre_destroy||inner)?NULL:callback_argument));
    assert(!pthread_mutex_trylock(&callback_display->mutex));pthread_mutex_unlock(&callback_display->mutex);
    assert(!pthread_mutex_trylock(&capture_publication_mutex));pthread_mutex_unlock(&capture_publication_mutex);
    assert(target->refcount==(callback_nested?3:2));
    if(callback_pre_destroy||inner)assert(callback_argument->refcount==(inner&&callback_nested?2:1));
    else{
        assert(argument->refcount==(callback_nested?3:2));wl_proxy_destroy(argument);
        assert(argument->refcount==(callback_nested?2:1));
    }
    callback_recycle_fd(fd,(unsigned)callback_count-1);
    if(callback_disabled_mask){int prior;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);assert(prior==PTHREAD_CANCEL_DISABLE);}
    if(callback_mutate){assert(callback_live_arguments&&callback_replacement_proxy);callback_live_arguments[0].o=(void*)callback_replacement_proxy;}
    if(callback_nested&&!inner){
        assert(wl_display_dispatch_pending(callback_display)==1&&callback_count==2);
        assert(callback_target->refcount==2&&callback_argument->refcount==1);
    }
    if(callback_action==4){
        pthread_mutex_lock(&callback_gate);callback_waiting=1;pthread_cond_broadcast(&callback_changed);
        pthread_cleanup_push(callback_unlock,NULL);
        for(;;)pthread_cond_wait(&callback_changed,&callback_gate);
        pthread_cleanup_pop(1);
    }
    if(callback_action==1&&!inner)pthread_exit(NULL);
    if(callback_action==2||callback_action==3){
#ifdef WPK_WL_RAW_ENTRY_ENABLED
        atomic_store(&wpk_native_fixture_multithread,1);pid_t child=fork();assert(child>=0);
        if(!child){
            alarm(5);assert(_wpk_drm_native_fork_epoch()==1);callback_fresh_child();
            if(callback_action==3)_exit(0);
            return; /* Adapter must reject BEFORE upstream clears/walks graph. */
        }
        atomic_store(&wpk_native_fixture_multithread,0);int status;
        assert(waitpid(child,&status,0)==child&&WIFEXITED(status));callback_child_status=WEXITSTATUS(status);
        assert(callback_child_status==(callback_action==2?125:0));
#else
        abort();
#endif
    }
}
static void callback_listener(void *data,struct wl_proxy *target,struct wl_proxy *argument,int fd){
    assert(data==&callback_count);callback_user(target,argument,fd);
}
static int callback_dispatch(const void *implementation,void *target,uint32_t opcode,const struct wl_message *message,union wl_argument *arguments){
    assert(implementation==&callback_count&&opcode==0&&message==&callback_events[0]);
    union wl_argument *prior=callback_live_arguments;callback_live_arguments=arguments;
    callback_user(target,(void*)arguments[0].o,arguments[1].h);callback_live_arguments=prior;return 0;
}
static void *callback_worker(void *unused){
    (void)unused;int prior=0;if(callback_disabled_mask)pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&prior);
    if(callback_explicit_capture)assert(_wpk_wl_log_capture_begin(&callback_external_scope));
    assert(wl_display_dispatch(callback_display)==(callback_first_discard?2:1));
    if(callback_explicit_capture)_wpk_wl_log_capture_end(&callback_external_scope);
    if(callback_disabled_mask)pthread_setcancelstate(prior,NULL);return NULL;
}
static void callback_send(struct wl_proxy *target){
    uint32_t wire[3]={target->object.id,12u<<16,callback_argument->object.id};
    struct iovec iov={.iov_base=wire,.iov_len=sizeof wire};
    union {struct cmsghdr align;char bytes[CMSG_SPACE(sizeof(int))];} control;
    memset(&control,0,sizeof control);
    struct msghdr message={.msg_iov=&iov,.msg_iovlen=1,.msg_control=control.bytes,.msg_controllen=sizeof control};
    struct cmsghdr *header=CMSG_FIRSTHDR(&message);header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;header->cmsg_len=CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header),&callback_feed[0],sizeof(int));
    assert(sendmsg(callback_pair[1],&message,0)==sizeof wire);
}
int main(int argc,char **argv){
    assert(argc==2);alarm(20);callback_dispatcher=strstr(argv[1],"dispatcher")!=NULL;
    callback_pre_destroy=strstr(argv[1],"pre-destroy")!=NULL;callback_nested=strstr(argv[1],"nested")!=NULL;callback_mutate=strstr(argv[1],"mutate")!=NULL;callback_second_cancel=strstr(argv[1],"second-cancel")!=NULL;callback_pending_restore=strstr(argv[1],"pending-restore")!=NULL;callback_disabled_mask=strstr(argv[1],"disabled-mask")!=NULL;
    callback_first_discard=callback_second_cancel||callback_pending_restore||callback_disabled_mask;
    callback_explicit_capture=strstr(argv[1],"explicit-capture")!=NULL;callback_disconnect_adopt=strstr(argv[1],"disconnect-adopt")!=NULL;
    callback_action=strstr(argv[1],"cancel")?4:strstr(argv[1],"fork-return")?2:strstr(argv[1],"fork-exit")?3:strstr(argv[1],"exit")?1:0;
    assert(!socketpair(AF_UNIX,SOCK_STREAM,0,callback_pair));assert(!pipe(callback_feed));
    callback_display=wl_display_connect_to_fd(callback_pair[0]);assert(callback_display);
    callback_target=wl_proxy_create((void*)callback_display,&callback_interface);assert(callback_target);
    callback_argument=wl_proxy_create((void*)callback_display,&wl_buffer_interface);assert(callback_argument);
    callback_target_address=(uintptr_t)callback_target;callback_argument_address=(uintptr_t)callback_argument;
    if(callback_first_discard){callback_discard_target=wl_proxy_create((void*)callback_display,&callback_interface);assert(callback_discard_target);}
    if(callback_mutate){callback_replacement_proxy=wl_proxy_create((void*)callback_display,&wl_buffer_interface);assert(callback_replacement_proxy);}
    static void (*listener[])(void)={(void(*)(void))callback_listener};
    if(callback_dispatcher)assert(!wl_proxy_add_dispatcher(callback_target,callback_dispatch,&callback_count,NULL));
    else assert(!wl_proxy_add_listener(callback_target,listener,&callback_count));
    if(callback_first_discard)callback_send(callback_discard_target);
    callback_send(callback_target);if(callback_nested)callback_send(callback_target);close(callback_feed[0]);
    if(callback_nested||callback_first_discard){
        callback_read_queue=wl_display_create_queue(callback_display);assert(callback_read_queue);
        while(wl_list_length(&callback_display->default_queue.event_list)<2){
            assert(!wl_display_prepare_read_queue(callback_display,callback_read_queue));assert(!wl_display_read_events(callback_display));
        }
        assert(callback_target->refcount==(callback_nested?3:2)&&callback_argument->refcount==3);
    }
    if(callback_pre_destroy){
        assert(!wl_display_prepare_read(callback_display));assert(!wl_display_read_events(callback_display));
        assert(callback_argument->refcount==2&&callback_target->refcount==2);
        wl_proxy_destroy(callback_argument);assert(callback_argument->refcount==1);
    }
    pthread_t worker;assert(!pthread_create(&worker,NULL,callback_worker,NULL));
    if(callback_action==4||callback_pending_restore){
        pthread_mutex_lock(&callback_gate);while(!callback_waiting)pthread_cond_wait(&callback_changed,&callback_gate);pthread_mutex_unlock(&callback_gate);
        assert(!pthread_cancel(worker));
        if(callback_pending_restore){pthread_mutex_lock(&callback_gate);callback_restore_release=1;pthread_cond_broadcast(&callback_changed);pthread_mutex_unlock(&callback_gate);}
    }
    void *result=NULL;assert(!pthread_join(worker,&result));if(callback_action==4||callback_pending_restore)assert(result==PTHREAD_CANCELED);
    assert(callback_count==(callback_pending_restore?0:callback_nested?2:1));
#ifdef WPK_WL_RAW_ENTRY_ENABLED
    if(callback_explicit_capture){
        _wpk_drm_owned_publication_begin();assert(_wpk_wl_log_capture_abandon_locked(&callback_external_scope));_wpk_drm_owned_publication_end();
        assert(_wpk_wl_log_deliver(&callback_external_scope));
    }
    if(callback_disconnect_adopt){
        assert(callback_action==1&&wpk_wl_callbacks&&wpk_wl_raw_retirements);
        wl_proxy_destroy(callback_target);assert(!callback_target_frees);
        wl_display_disconnect(callback_display);
        assert(!wpk_wl_callbacks&&!wpk_wl_raw_retirements&&callback_target_frees==1&&callback_argument_frees==1);
        assert(fcntl(callback_pair[0],F_GETFD)<0&&errno==EBADF);
        char value;assert(write(callback_replacements[0][1],"r",1)==1&&read(callback_replacements[0][0],&value,1)==1&&value=='r');
        close(callback_pair[1]);close(callback_feed[1]);close(callback_replacements[0][0]);close(callback_replacements[0][1]);
        puts("PASS public native disconnect adopts ended listener tail before exact final close");return 0;
    }
#endif
#ifndef WPK_WL_RAW_ENTRY_ENABLED
    if(callback_pre_destroy){assert(callback_target->refcount==(callback_action==1?2:1)&&callback_argument->refcount==1&&!callback_argument_frees);puts("OBS validate_closure_objects clears actual retained arg alias before native tail, ref stranded");return 42;}
    assert((callback_action==1||callback_action==4)&&callback_target->refcount==2&&callback_argument->refcount==1);
    assert(!callback_target_frees&&!callback_argument_frees);
    puts("OBS native callback exit strands actual closure target/argument ref tail outside native mutex");return 42;
#else
    if(callback_action==1||callback_action==4||callback_pending_restore){assert(callback_ready&&wpk_wl_callbacks);assert(!_wpk_wl_raw_drain_deferred());}
    assert(!wpk_wl_callbacks&&!wpk_wl_raw_retirements&&callback_target->refcount==1);
    if(callback_pre_destroy&&!callback_argument_frees){assert(callback_argument->refcount==1);puts("OBS validate_closure_objects clears actual retained arg alias before native tail, ref stranded");return 42;}
    if(callback_pending_restore){assert(!callback_argument_frees&&callback_argument->refcount==1);wl_proxy_destroy(callback_argument);}
    assert(callback_argument_frees==1&&!callback_target_frees);
    if(callback_first_discard)assert(wpk_wl_callback_pool_count==1);
    if(callback_disabled_mask)assert(!callback_testcancel_calls);
    if(callback_pending_restore)assert(callback_testcancel_calls==1);
    assert(!wpk_wl_find(callback_display)->users);
    if(callback_pending_restore){
        assert(callback_restore_observed&&callback_restore_fd>=0&&fcntl(callback_restore_fd,F_GETFD)<0&&errno==EBADF);
        int replacement=open("/dev/null",O_RDONLY);assert(replacement>=0);
        if(replacement!=callback_restore_fd){assert(dup2(replacement,callback_restore_fd)==callback_restore_fd);close(replacement);}
        assert(!_wpk_wl_raw_drain_deferred()&&fcntl(callback_restore_fd,F_GETFD)>=0);close(callback_restore_fd);
    }
    assert(!_wpk_wl_raw_drain_deferred()&&callback_count==(callback_pending_restore?0:callback_nested?2:1)&&callback_argument_frees==1);
    /* The delivered FD was closed and replaced by user code. Actual tail
     * retirement must leave that new OFD alone in both normal/ended cases. */
    char c;
    for(unsigned i=0;i<(unsigned)callback_count;i++){
        assert(write(callback_replacements[i][1],"r",1)==1&&read(callback_replacements[i][0],&c,1)==1&&c=='r');
        close(callback_replacements[i][0]);close(callback_replacements[i][1]);
    }
    if(callback_mutate){assert(callback_replacement_proxy->refcount==1);wl_proxy_destroy(callback_replacement_proxy);}
    assert(write(callback_pair[1],"s",1)==1&&read(callback_pair[0],&c,1)==1&&c=='s');
    assert(write(callback_pair[0],"t",1)==1&&read(callback_pair[1],&c,1)==1&&c=='t');
    if(callback_discard_target)wl_proxy_destroy(callback_discard_target);
    wl_proxy_destroy(callback_target);assert(callback_target_frees==1);if(callback_read_queue)wl_event_queue_destroy(callback_read_queue);
    wl_display_disconnect(callback_display);assert(fcntl(callback_pair[0],F_GETFD)<0&&errno==EBADF);
    close(callback_pair[1]);close(callback_feed[1]);
    printf("PASS actual native callback retirement %s, exact tail once, replacement FD and parent intact\n",argv[1]);return 0;
#endif
}
