/* Actual pinned native client operations. Hooks only pause at existing
 * publication/unlock boundaries; the production source has no test hooks. */
#include "drm_owned.c"
static void custody_publication_end(void);
static int custody_mutex_unlock(pthread_mutex_t *);
#define _wpk_drm_owned_publication_end custody_publication_end
#define pthread_mutex_unlock custody_mutex_unlock
#define main original_connection_control_main
#include "wayland-connection.c"
#undef main
#undef pthread_mutex_unlock
#undef _wpk_drm_owned_publication_end
#include "wayland-retirement.h"
static pthread_mutex_t custody_gate=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t custody_changed=PTHREAD_COND_INITIALIZER;
static int custody_mode,custody_armed,custody_ready,custody_proceed;
static struct wl_display *custody_display;
static struct wl_proxy *custody_proxy;
static struct wpk_wl_surface_retirement custody_cap;
#define custody_receiver custody_cap.live
static const void *custody_source;
static uint64_t custody_identity;
static void custody_pause(void){
    pthread_mutex_lock(&custody_gate);custody_ready=1;pthread_cond_broadcast(&custody_changed);
    while(!custody_proceed)pthread_cond_wait(&custody_changed,&custody_gate);
    pthread_mutex_unlock(&custody_gate);
}
static void custody_publication_end(void){
    _wpk_drm_owned_publication_end();
#ifndef WPK_CUSTODY_BEFORE
    struct wpk_wl_surface *hold=custody_receiver;
    if(custody_armed&&hold&&((custody_mode==1&&hold->constructing&&!hold->proxy)||
            (custody_mode==2&&!hold->constructing&&hold->proxy))){custody_armed=0;custody_pause();}
#endif
}
static int custody_mutex_unlock(pthread_mutex_t *mutex){
    int result=pthread_mutex_unlock(mutex);
#ifdef WPK_CUSTODY_BEFORE
    if(custody_armed&&mutex==&custody_display->mutex){custody_armed=0;custody_pause();}
#endif
    return result;
}
void _wpk_egl_request_native_drain(void){}
static void *custody_acquire(void *unused){
    (void)unused;
#ifdef WPK_CUSTODY_BEFORE
    custody_receiver=_wpk_wl_surface_acquire(custody_proxy,&custody_source,&custody_identity);
    assert(custody_receiver);
#else
    assert(_wpk_wl_surface_acquire_pending(custody_proxy,&custody_source,&custody_identity,&custody_receiver));
#endif
    return NULL;
}
static void custody_release(void){
#ifdef WPK_CUSTODY_BEFORE
    _wpk_wl_surface_release(custody_receiver);custody_receiver=NULL;
#else
    assert(_wpk_wl_surface_release_pending(&custody_cap)==WPK_WL_RETIRE_COMPLETE);
#endif
    wl_proxy_destroy(custody_proxy);wl_display_disconnect(custody_display);
}
static void custody_fork_control(int phase){
    int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));
    custody_display=wl_display_connect_to_fd(pair[0]);assert(custody_display);
    custody_proxy=proxy_create(&custody_display->proxy,&wl_surface_interface,1);assert(custody_proxy);
    custody_mode=phase;custody_armed=1;pthread_t worker;
    assert(!pthread_create(&worker,NULL,custody_acquire,NULL));
    pthread_mutex_lock(&custody_gate);while(!custody_ready)pthread_cond_wait(&custody_changed,&custody_gate);pthread_mutex_unlock(&custody_gate);
    atomic_store(&wpk_native_fixture_multithread,1);pid_t child=fork();assert(child>=0);
    if(child)atomic_store(&wpk_native_fixture_multithread,0);
    if(!child){
        alarm(5);
#ifdef WPK_CUSTODY_BEFORE
        /* Actual native ref/users effect has happened, but no caller root
         * exists until raw helper return. Only copied library metadata read. */
        assert(wpk_wl_find(custody_display)->users==1);_exit(custody_receiver?0:41);
#else
        struct wpk_wl_surface *hold=custody_receiver;assert(hold);
        struct wpk_wl_surface_retirement *cap=&custody_cap;
        if(phase==1){
            assert(hold->constructing&&!hold->proxy&&!hold->connection);
            assert(_wpk_wl_surface_release_pending(cap)==WPK_WL_RETIRE_COMPLETE);
        }else{
            assert(!hold->constructing&&hold->proxy==custody_proxy&&hold->connection==wpk_wl_find(custody_display));
            assert(hold->connection->users==1);
            assert(_wpk_wl_surface_release_pending(cap)==WPK_WL_RETIRE_BOUNDARY_TRANSFERRED);
            assert(hold->boundary.transferred&&hold->connection->boundary.transferred);
            assert(hold->proxy==custody_proxy&&hold->connection->users==1);
        }
        assert(!cap->live&&!cap->retired&&fcntl(pair[0],F_GETFD)>=0);_exit(0);
#endif
    }
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status));
    pthread_mutex_lock(&custody_gate);custody_proceed=1;pthread_cond_broadcast(&custody_changed);pthread_mutex_unlock(&custody_gate);
    assert(!pthread_join(worker,NULL));
    assert(custody_receiver&&custody_source==custody_display&&custody_proxy->refcount==2&&wpk_wl_find(custody_display)->users==1);
    custody_release();assert(fcntl(pair[0],F_GETFD)<0&&errno==EBADF);close(pair[1]);
    printf("OBS actual native acquire phase%d child=%d parent intact\n",phase,WEXITSTATUS(status));
    if(WEXITSTATUS(status))exit(WEXITSTATUS(status));
}
static void custody_single_fork(int admission){
    int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));
    custody_display=wl_display_connect_to_fd(pair[0]);assert(custody_display);
    uint64_t identity;assert(_wpk_wl_display_metadata(custody_display,&identity));
    void *display_hold=_wpk_wl_display_acquire(custody_display,identity);assert(display_hold);
    custody_proxy=proxy_create(&custody_display->proxy,&wl_surface_interface,1);assert(custody_proxy);
    custody_receiver=_wpk_wl_surface_acquire(custody_proxy,&custody_source,&custody_identity);assert(custody_receiver);
    /* No other thread exists here; the explicit multithread detector double
     * stays zero, while the real common process identity changes after fork. */
    assert(!atomic_load(&wpk_native_fixture_multithread));pid_t child=fork();assert(child>=0);
    if(!child){
        alarm(5);assert(!_wpk_drm_native_fork_epoch());
        if(admission){
            uint64_t old=identity;
            assert(!_wpk_wl_display_metadata(custody_display,&old)&&old==identity&&errno==ECHILD);
            assert(!_wpk_wl_display_acquire(custody_display,identity)&&errno==ECHILD);
            assert(!_wpk_wl_display_alive(display_hold)&&errno==ECHILD);
            assert(!_wpk_wl_surface_alive(custody_receiver)&&errno==ECHILD);
            const void *source=NULL;uint64_t id=0;
            assert(!_wpk_wl_surface_acquire(custody_proxy,&source,&id));
            int fresh[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,fresh));
            struct wl_display *display=wl_display_connect_to_fd(fresh[0]);assert(display);
            assert(_wpk_wl_display_metadata(display,&id)&&id!=identity);
            wl_display_disconnect(display);close(fresh[1]);
        }
        wl_proxy_destroy(custody_proxy);wl_display_disconnect(custody_display);
        _wpk_wl_surface_release_inherited(custody_receiver);_wpk_wl_display_release_inherited(display_hold);
        assert(fcntl(pair[0],F_GETFD)<0&&errno==EBADF);_exit(0);
    }
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
    assert(custody_proxy->refcount==2&&wpk_wl_find(custody_display)->users==2&&_wpk_wl_surface_alive(custody_receiver));
    signal(SIGPIPE,SIG_IGN);char c=0;
    /* Real bidirectional OFD behavior, not just unchanged fd integers. */
    assert(write(pair[1],"a",1)==1&&read(pair[0],&c,1)==1&&c=='a');
    assert(write(pair[0],"b",1)==1&&read(pair[1],&c,1)==1&&c=='b');
    _wpk_wl_display_release(display_hold);custody_release();close(pair[1]);
    puts("PASS single-thread child cleanup preserves parent socket and admission");
}
int main(int argc,char **argv){
    assert(argc==2);alarm(15);
    if(!strcmp(argv[1],"pre-effect"))custody_fork_control(1);
    else if(!strcmp(argv[1],"post-effect"))custody_fork_control(2);
    else custody_single_fork(!strcmp(argv[1],"admission"));
    return 0;
}
