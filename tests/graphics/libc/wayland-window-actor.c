/* The real window/allocation owner, real ActorScopes and device receiver,
 * with protocol pending-leaf doubles. Actual native leaf/log machinery has
 * independent causal controls; this layer proves its parent root survives. */
#define WPK_WAYLAND_WINDOW_MAIN window_semantics_main
#include "wayland-window.c"
#include <sys/wait.h>
static int actor_mode,actor_child,actor_failed;
static unsigned actor_callbacks,actor_protocol_at_fork,actor_native_at_fork,actor_order;
static int frame_mode(void){return (actor_mode>=6&&actor_mode<=8)||actor_mode==11||actor_mode==13||actor_mode==14;}
static struct wl_egl_window *actor_window;
static void *actor_lease;
static pthread_mutex_t actor_facade=PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t actor_gate=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t actor_changed=PTHREAD_COND_INITIALIZER;
static int actor_ready,actor_proceed,actor_pause_lock;
static pthread_t actor_completer;
static struct wpk_wlegl_retirement actor_last_release;
static void before_completion_lock(void){
    if(actor_pause_lock&&pthread_equal(pthread_self(),actor_completer)){
        actor_pause_lock=0;pthread_mutex_lock(&actor_gate);actor_ready=1;pthread_cond_broadcast(&actor_changed);
        while(!actor_proceed)pthread_cond_wait(&actor_changed,&actor_gate);pthread_mutex_unlock(&actor_gate);
    }
}
static void completion_log(void){actor_callbacks++;actor_pause_lock=1;}
static void *produce_window_work(void *unused){
    (void)unused;struct wpk_wlegl_frame frame;pthread_mutex_lock(&actor_facade);window_facade_locked=1;
    assert(_wpk_wlegl_prepare_present(actor_lease,&frame));assert(_wpk_wlegl_finish(actor_lease,1));
    window_facade_locked=0;pthread_mutex_unlock(&actor_facade);return NULL;
}
static void *complete_window_work(void *unused){(void)unused;actor_completer=pthread_self();_wpk_wlegl_drain_deferred();return NULL;}

static void acquire_pause(void){
    pthread_mutex_lock(&actor_gate);actor_ready=1;pthread_cond_broadcast(&actor_changed);
    while(!actor_proceed)pthread_cond_wait(&actor_changed,&actor_gate);pthread_mutex_unlock(&actor_gate);
}
static void *acquire_operation(void *unused){(void)unused;actor_window=wl_egl_window_create((void *)&proxies[126],32,24);return NULL;}

static void actor_log(void){
    actor_callbacks++;
    if((actor_mode==13||actor_mode==14)&&window_facade_locked){actor_failed=75;return;}
    if(frame_mode()){assert(!window_facade_locked);assert(!pthread_mutex_trylock(&actor_facade));pthread_mutex_unlock(&actor_facade);}
    if(actor_mode==6||actor_mode==7)pthread_exit(NULL);
    if(actor_mode==1||actor_mode==3)pthread_exit(NULL);
    if(actor_mode==2||actor_mode==9||actor_mode==10){
        pid_t child=fork();assert(child>=0);
        if(!child){
            actor_child=1;actor_protocol_at_fork=window_protocol_destroys;actor_native_at_fork=window_native_destroys;
            if(actor_mode==9){window_native_epoch++;window_boundary_required=1;}
            alarm(10);wl_egl_window_destroy(NULL);
            if(!windows||!surface_holds||bo_created==bo_destroyed)_exit(63);
        }else{int status;assert(waitpid(child,&status,0)==child);if(!WIFEXITED(status)||WEXITSTATUS(status))actor_failed=WIFEXITED(status)?WEXITSTATUS(status):63;}
    }else{
        wl_egl_window_destroy(NULL);if(!windows||!surface_holds||bo_created==bo_destroyed)actor_failed=64;
    }
}
static void first_frame_log(void){actor_order=actor_order*10+1;actor_log();}
static void second_frame_log(void){actor_order=actor_order*10+2;actor_log();}
static struct wl_egl_window *nested_window;
static void *nested_lease;
static int nested_error,nested_callbacks;
static void nested_present_log(void){
    if(window_facade_locked){nested_error=75;return;}
    assert(!pthread_mutex_trylock(&actor_facade));pthread_mutex_unlock(&actor_facade);nested_callbacks++;
    _wpk_wl_log_drain_deferred();
}
static void outer_constructor_log(void){
    window_log_on_buffer=0;window_log_on_present=1;window_present_hook=nested_present_log;fail_present=1;
    struct wpk_wlegl_frame frame;pthread_mutex_lock(&actor_facade);window_facade_locked=1;
    assert(_wpk_wlegl_prepare_present(nested_lease,&frame));assert(!_wpk_wlegl_finish(nested_lease,1));
    if(!nested_error&&window_resolved_scope!=&((struct wpk_wlegl *)nested_window->driver_private)->logs)nested_error=76;
    window_facade_locked=0;pthread_mutex_unlock(&actor_facade);_wpk_wl_log_drain_deferred();
    window_log_on_present=0;fail_present=0;wl_egl_window_destroy(nested_window);_wpk_wlegl_release(nested_lease);
}
static void *actor_operation(void *unused){
    (void)unused;
    if(frame_mode()){
        struct wpk_wlegl_frame frame;pthread_mutex_lock(&actor_facade);window_facade_locked=1;
        if(!_wpk_wlegl_prepare_present(actor_lease,&frame)){actor_failed=72;window_facade_locked=0;pthread_mutex_unlock(&actor_facade);return NULL;}
        int finished=_wpk_wlegl_finish(actor_lease,1);
        if(actor_mode==13||actor_mode==14)assert(!finished);else assert(finished);
        if(actor_failed==75){window_facade_locked=0;pthread_mutex_unlock(&actor_facade);return NULL;}
        assert(!actor_callbacks&&window_requested);
        if(actor_mode==8){pthread_mutex_lock(&actor_gate);actor_ready=1;pthread_cond_broadcast(&actor_changed);while(!actor_proceed)pthread_cond_wait(&actor_changed,&actor_gate);pthread_mutex_unlock(&actor_gate);}
        window_facade_locked=0;pthread_mutex_unlock(&actor_facade);
        _wpk_wlegl_drain_deferred();_wpk_wl_log_drain_deferred();return NULL;
    }
    if(actor_mode==3||actor_mode==10)actor_window=wl_egl_window_create((void *)&proxies[126],32,24);
    else if(actor_mode==4)wl_egl_window_resize(actor_window,48,32,0,0);
    else wl_egl_window_destroy(actor_window);
    if(actor_child){
        if(actor_mode==9){
            if(window_native_destroys!=actor_native_at_fork)_exit(67);
            struct wpk_wlegl *w=actor_window->driver_private;
            if(windows||!w->boundary.transferred||!surface_holds||opens==closed)_exit(68);
            _exit(0);
        }
        if(window_protocol_destroys!=actor_protocol_at_fork)_exit(66);
        if(surface_holds||opens!=closed||bo_created!=bo_destroyed)_exit(65);_exit(0);
    }
    return NULL;
}
int main(int argc,char **argv){
    assert(argc==2);
    if(!strcmp(argv[1],"nested-constructor-present")){
        nested_window=wl_egl_window_create((void *)&proxies[126],32,24);assert(nested_window);
        struct wpk_wlegl_frame frame;assert(_wpk_wlegl_acquire(nested_window,&proxies[125],surface_identity,&nested_lease,&frame));assert(_wpk_wlegl_finish(nested_lease,0));
        window_log_on_buffer=1;window_native_hook=outer_constructor_log;
        actor_window=wl_egl_window_create((void *)&proxies[126],32,24);window_log_on_buffer=0;assert(actor_window);
        wl_egl_window_destroy(actor_window);
        assert(!windows&&!surface_holds&&opens==closed&&bo_created==bo_destroyed&&!window_deferred);
        if(nested_error)return nested_error;assert(nested_callbacks==1);
        puts("PASS older live constructor scope cannot steal nested window native-error capture");return 0;
    }
    if(!strcmp(argv[1],"final-handoff")){
        struct wpk_wlegl_frame frame;void *lease=NULL;
        actor_window=wl_egl_window_create((void *)&proxies[126],32,24);assert(actor_window);
        assert(_wpk_wlegl_acquire(actor_window,&proxies[125],surface_identity,&lease,&frame));assert(_wpk_wlegl_finish(lease,0));
        wl_egl_window_resize(actor_window,48,32,0,0);
        /* Actual producer thread exit ends its real TLS-owned ActorScope;
         * no fixture changes the production origin/ref/claim state. */
        actor_lease=lease;pthread_t producer;assert(!pthread_create(&producer,NULL,produce_window_work,NULL));assert(!pthread_join(producer,NULL));
        window_native_hook=completion_log;window_before_lock=before_completion_lock;
        pthread_t worker;assert(!pthread_create(&worker,NULL,complete_window_work,NULL));
        pthread_mutex_lock(&actor_gate);while(!actor_ready)pthread_cond_wait(&actor_changed,&actor_gate);pthread_mutex_unlock(&actor_gate);
        wl_egl_window_destroy(actor_window);actor_last_release.live=lease;
        assert(_wpk_wlegl_release_pending(&actor_last_release)==WPK_WL_RETIRE_PENDING);
        pthread_mutex_lock(&actor_gate);actor_proceed=1;pthread_cond_broadcast(&actor_changed);pthread_mutex_unlock(&actor_gate);
        assert(!pthread_join(worker,NULL));window_before_lock=NULL;
        if(actor_last_release.live||actor_last_release.retired||windows){fprintf(stderr,"FAIL final owner withdrawal missed completion actor handoff\n");return 74;}
        assert(actor_callbacks==1&&!surface_holds&&opens==closed&&bo_created==bo_destroyed);
        puts("PASS concurrent last owner withdrawal and completion release share one handoff");return 0;
    }
    if(!strcmp(argv[1],"acquire-publication")){
        window_acquire_phase=acquire_pause;pthread_t worker;assert(!pthread_create(&worker,NULL,acquire_operation,NULL));
        pthread_mutex_lock(&actor_gate);while(!actor_ready)pthread_cond_wait(&actor_changed,&actor_gate);pthread_mutex_unlock(&actor_gate);
        pid_t child=fork();assert(child>=0);
        if(!child){
            alarm(10);struct wpk_wlegl *w=windows;assert(w);window_native_epoch++;window_boundary_required=1;
            wl_egl_window_destroy(NULL);
            if(!window_boundary_queries){fprintf(stderr,"FAIL native acquire effect escaped rooted caller slot; D59 was skipped\n");_exit(69);}
            assert(w->boundary.transferred&&!windows&&surface_holds==1&&!window_native_destroys);_exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status));
        pthread_mutex_lock(&actor_gate);actor_proceed=1;pthread_cond_broadcast(&actor_changed);pthread_mutex_unlock(&actor_gate);
        assert(!pthread_join(worker,NULL));window_acquire_phase=NULL;assert(actor_window);wl_egl_window_destroy(actor_window);
        assert(!windows&&!surface_holds&&opens==closed&&bo_created==bo_destroyed);
        if(WEXITSTATUS(status))return WEXITSTATUS(status);
        puts("PASS constructor acquire publishes exact native hold before effect becomes visible");return 0;
    }
#ifndef WPK_WAYLAND_WINDOW_BEFORE
    if(!strcmp(argv[1],"boundary")){
        actor_window=wl_egl_window_create((void *)&proxies[126],32,24);assert(actor_window);
        struct wpk_wlegl *w=actor_window->driver_private;struct wpk_wlegl_frame frame;void *lease=NULL;
        assert(_wpk_wlegl_acquire(actor_window,&proxies[125],surface_identity,&lease,&frame));assert(_wpk_wlegl_finish(lease,0));
        static struct wpk_wlegl_retirement request;request.live=lease;
        unsigned native=window_native_destroys;window_native_epoch++;window_boundary_required=1;
        wl_egl_window_destroy(actor_window);
        assert(_wpk_wlegl_release_pending(&request)==WPK_WL_RETIRE_BOUNDARY_TRANSFERRED);
        assert(!request.live&&!request.retired&&w->boundary.transferred&&!w->release_request&&!windows);
        assert(window_native_destroys==native&&surface_holds==1&&opens==closed+1&&bo_created>bo_destroyed);
        puts("PASS explicit image-lifetime boundary transfer; no native traversal; owned surface/BO/FILE graph retained");return 0;
    }
#endif
    actor_mode=!strcmp(argv[1],"exit")?1:!strcmp(argv[1],"self-fork")?2:!strcmp(argv[1],"constructor-exit")?3:!strcmp(argv[1],"resize-exit")?4:!strcmp(argv[1],"pending")?5:!strcmp(argv[1],"frame-exit")?6:!strcmp(argv[1],"frame-garbage-exit")?7:!strcmp(argv[1],"frame-peer-origin")?8:!strcmp(argv[1],"self-fork-boundary")?9:!strcmp(argv[1],"constructor-fork")?10:!strcmp(argv[1],"dispatch-log")?11:!strcmp(argv[1],"present-log")?13:!strcmp(argv[1],"construct-present-log")?14:0;
    if(actor_mode!=3&&actor_mode!=10){actor_window=wl_egl_window_create((void *)&proxies[126],32,24);assert(actor_window);}
    if(actor_mode==2||actor_mode==9){
        struct wpk_wlegl_frame f;void *lease=NULL;assert(_wpk_wlegl_acquire(actor_window,&proxies[125],surface_identity,&lease,&f));assert(_wpk_wlegl_finish(lease,0));
        for(unsigned i=0;i<2;i++){assert(_wpk_wlegl_prepare_present(lease,&f));assert(_wpk_wlegl_finish(lease,1));}
        _wpk_wlegl_release(lease);
    }
    if(!strcmp(argv[1],"retarget")){
        struct wpk_wlegl_frame f;void *lease=NULL;assert(_wpk_wlegl_acquire(actor_window,&proxies[125],surface_identity,&lease,&f));assert(_wpk_wlegl_finish(lease,0));
        wl_egl_window_resize(actor_window,48,32,0,0);
        int error=window_retarget_error;
        if(!error)assert(actor_window->attached_width==48&&!((struct wpk_wlegl *)actor_window->driver_private)->active);
        wl_egl_window_destroy(actor_window);_wpk_wlegl_release(lease);
        assert(!windows&&!surface_holds&&opens==closed&&bo_created==bo_destroyed);
        if(error)return error;puts("PASS native-window metadata retarget sequence preserves live outer resize actor");return 0;
    }
    if(!strcmp(argv[1],"cached")){
        struct wpk_wlegl_frame frame;assert(_wpk_wlegl_acquire(actor_window,&proxies[125],surface_identity,&actor_lease,&frame));assert(_wpk_wlegl_finish(actor_lease,0));
        unsigned captures=window_capture_count,native=window_native_destroys,resolvers=window_resolver_calls;
        for(unsigned i=0;i<10;i++){assert(_wpk_wlegl_prepare_present(actor_lease,&frame));assert(_wpk_wlegl_finish(actor_lease,1));release_buffer((int *)last_presented-proxies);}
        assert(window_capture_count==captures&&window_native_destroys==native&&window_resolver_calls==resolvers&&!window_requested);
        wl_egl_window_destroy(actor_window);_wpk_wlegl_release(actor_lease);assert(!windows&&!surface_holds&&opens==closed&&bo_created==bo_destroyed);
        puts("PASS cached frames add no logging capture, native scratch teardown or ready notification");return 0;
    }
    if(frame_mode()){
        struct wpk_wlegl_frame frame;assert(_wpk_wlegl_acquire(actor_window,&proxies[125],surface_identity,&actor_lease,&frame));assert(_wpk_wlegl_finish(actor_lease,0));
        assert(_wpk_wlegl_prepare_present(actor_lease,&frame));assert(_wpk_wlegl_finish(actor_lease,1));
        if(actor_mode==7)wl_egl_window_resize(actor_window,48,32,0,0);
        if(actor_mode==11){
            unsigned first=(int *)last_presented-proxies;
            for(unsigned i=0;i<2;i++){assert(_wpk_wlegl_prepare_present(actor_lease,&frame));assert(_wpk_wlegl_finish(actor_lease,1));}
            release_on_dispatch=(int)first;window_log_on_dispatch=1;
        }
        window_native_hook=actor_log;window_log_on_buffer=actor_mode!=7&&actor_mode!=11;
        if(actor_mode==13||actor_mode==14){
            window_log_on_present=1;fail_present=1;window_present_hook=actor_mode==14?second_frame_log:actor_log;
            window_native_hook=actor_mode==14?first_frame_log:NULL;window_log_on_buffer=actor_mode==14;
        }
    }
    else if(actor_mode==4){window_exit_retarget=destroy_during_retarget=1;}
    else if(actor_mode==5)window_leaf_defer_once=1;
    else{window_native_hook=actor_log;window_log_on_buffer=actor_mode==3||actor_mode==10;}
    pthread_t worker;assert(!pthread_create(&worker,NULL,actor_operation,NULL));
    if(actor_mode==8){
        pthread_mutex_lock(&actor_gate);while(!actor_ready)pthread_cond_wait(&actor_changed,&actor_gate);pthread_mutex_unlock(&actor_gate);
        assert(_wpk_wl_log_drain_deferred()==1&&!actor_callbacks);
        pthread_mutex_lock(&actor_gate);actor_proceed=1;pthread_cond_broadcast(&actor_changed);pthread_mutex_unlock(&actor_gate);
    }
    assert(!pthread_join(worker,NULL));
    if(frame_mode()){_wpk_wlegl_drain_deferred();_wpk_wl_log_drain_deferred();assert(actor_callbacks==(actor_mode==14?2:1)&&!window_deferred);if(actor_mode==14&&!actor_failed)assert(actor_order==12);wl_egl_window_destroy(actor_window);_wpk_wlegl_release(actor_lease);}
    window_exit_retarget=destroy_during_retarget=window_log_on_buffer=0;window_native_hook=NULL;
    if(actor_mode==10)wl_egl_window_destroy(actor_window);
    if(actor_mode==5)assert(windows&&surface_holds&&opens>closed);
    wl_egl_window_destroy(NULL);
    if(actor_failed)return actor_failed;
    if(windows||surface_holds||opens!=closed||bo_created!=bo_destroyed){fprintf(stderr,"FAIL window/allocation actor lost after native callback\n");return 61;}
    for(unsigned i=0;i<16;i++)assert(!descriptors[i]&&!exported[i]);
    if(actor_mode<4||actor_mode>=9)assert(actor_callbacks==(actor_mode==14?2:1));
    puts("PASS globally rooted window/allocation actor across callback continuation");return 0;
}
