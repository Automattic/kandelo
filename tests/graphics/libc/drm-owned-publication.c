/* Actual common receiver source plus the independent transport peer. The
 * mutex interposer pauses only native controls at the real publication guard;
 * no test hook or extra lock is compiled into production. */
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
static int publication_lock(pthread_mutex_t *);
#include "drm-owned-double.h"
#define pthread_mutex_lock publication_lock
#include "drm_owned.c"
#undef pthread_mutex_lock
#define main transport_fixture_main
#include "drm-owned-transport.c"
#undef main
static pthread_mutex_t hook_mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t hook_condition=PTHREAD_COND_INITIALIZER;
static pthread_t publication_worker;
static int hook_phase,worker_phase,hook_entered,hook_release,fork_waiting,forking,worker_registered,pause_before,fork_guard_acquired;
static struct wpk_drm_owner *published_parent,*published_child;
static void pause_publication(void) {
    pthread_mutex_lock(&hook_mutex);hook_entered=1;
    pthread_cond_broadcast(&hook_condition);
    while(!hook_release)pthread_cond_wait(&hook_condition,&hook_mutex);
    pthread_mutex_unlock(&hook_mutex);
}
static int publication_lock(pthread_mutex_t *mutex) {
#ifdef WPK_CAPTURE_GUARD
    if(mutex==&capture_publication_mutex){
        int worker=worker_registered&&pthread_equal(pthread_self(),publication_worker);
        if(worker&&pause_before&&worker_phase+1==hook_phase)pause_publication();
        if(!worker&&forking){
            pthread_mutex_lock(&hook_mutex);fork_waiting=1;
            pthread_cond_broadcast(&hook_condition);pthread_mutex_unlock(&hook_mutex);
        }
        int result=pthread_mutex_lock(mutex);
        if(!worker&&forking){
            pthread_mutex_lock(&hook_mutex);fork_guard_acquired=1;
            pthread_cond_broadcast(&hook_condition);pthread_mutex_unlock(&hook_mutex);
        }
        if(worker&&++worker_phase==hook_phase&&!pause_before)pause_publication();
        return result;
    }
#endif
    return pthread_mutex_lock(mutex);
}

static void snapshot_prepare(void) {
    /* Model the kernel's serialized resource snapshot and keep native peer
     * condition bookkeeping out of the fork image's vanished-thread state. */
    pthread_mutex_lock(&peer_mutex);pthread_mutex_lock(&hook_mutex);
}
static void snapshot_parent(void) {pthread_mutex_unlock(&hook_mutex);pthread_mutex_unlock(&peer_mutex);}
static void snapshot_child(void) {pause_io=0;forking=hook_phase=0;pthread_mutex_unlock(&hook_mutex);pthread_mutex_unlock(&peer_mutex);}
static void *capture_worker(void *unused) {
    (void)unused;publication_worker=pthread_self();worker_registered=1;uint32_t value=5;
    assert(!_wpk_drm_owned_ioctl(published_parent,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&published_child));
    assert(value==12);return NULL;
}
static void *release_worker(void *unused) {
    (void)unused;publication_worker=pthread_self();worker_registered=1;release_owner(&published_child);return NULL;
}
static void *release_publication(void *unused) {
    (void)unused;pthread_mutex_lock(&hook_mutex);
    while(!fork_waiting||(pause_before&&!fork_guard_acquired))pthread_cond_wait(&hook_condition,&hook_mutex);
    hook_release=1;pthread_cond_broadcast(&hook_condition);pthread_mutex_unlock(&hook_mutex);return NULL;
}
static void check_custody(void) {
#ifdef WPK_CAPTURE_GUARD
    if(!published_child){
        if(published_parent)assert(published_parent->references==1&&allocations==1&&live_caps()==1);
        else assert(!allocations&&!live_caps());
        return;
    }
    struct wpk_drm_owner *parent=published_parent?published_parent:published_child->creation_parent;
    if(parent){
        unsigned references=(published_parent?1u:0u)+(published_child->creation_parent?1u:0u);
        assert(parent->references==references);
        if(published_child->capture_resolved)assert(!parent->capture);
        else assert(published_child->creation_parent==parent&&parent->capture==published_child);
    }else assert(published_child->released);

#endif
}
int main(int argc,char **argv) {
    assert(argc==2);
    /* Register the native kernel-snapshot model before driver construction.
     * Its prepare must run AFTER every guest publication guard, just as the
     * real kernel snapshots only after pthread prepare handlers finish. */
    assert(!pthread_atfork(snapshot_prepare,snapshot_parent,snapshot_child));
    assert(!_wpk_drm_owned_open(1,&published_parent));
    if(!strcmp(argv[1],"known-child-blocked")){
        uint32_t value=5;
        assert(!_wpk_drm_owned_ioctl(published_parent,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&published_child));
        pause_io=1;pthread_t thread;assert(!pthread_create(&thread,NULL,blocked_io,published_parent));
        pthread_mutex_lock(&peer_mutex);while(!io_entered)pthread_cond_wait(&peer_condition,&peer_mutex);pthread_mutex_unlock(&peer_mutex);
        /* Native IO on the parent stays blocked until AFTER child retirement.
         * The old C creation-parent hold waited on that unrelated receiver. */
        fputs("CONTROL parent transport blocked; retiring known child\n",stderr);
        release_owner(&published_child);assert(bo_release_entries==1&&live_caps()==1);
        pthread_mutex_lock(&peer_mutex);io_release=1;pthread_cond_broadcast(&peer_condition);pthread_mutex_unlock(&peer_mutex);
        assert(!pthread_join(thread,NULL));release_owner(&published_parent);
    }else{
#ifdef WPK_CAPTURE_GUARD
        int completed_claim=!strcmp(argv[1],"fork-completed-claim");
        int recovery=completed_claim||!strncmp(argv[1],"fork-recovery-",14);
        if(completed_claim){hook_phase=3;pause_before=1;}
        else if(recovery){
            if(!strcmp(argv[1],"fork-recovery-claim"))hook_phase=1;
            else if(!strcmp(argv[1],"fork-recovery-complete"))hook_phase=2;
            else {assert(!strcmp(argv[1],"fork-recovery-retire"));hook_phase=5;}
        }else{
            assert(!strcmp(argv[1],"fork-establish")||!strcmp(argv[1],"fork-complete"));
            hook_phase=!strcmp(argv[1],"fork-establish")?1:2;
        }
        if(recovery){
            uint32_t value=5;lost_action=3;read_failures=1;
            assert(_wpk_drm_owned_ioctl(published_parent,0x1234,&value,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&published_child)==-1&&published_child);
            if(!completed_claim)release_owner(&published_parent);
            assert(live_caps()==2);
        }
        pthread_t worker,controller;assert(!pthread_create(&worker,NULL,recovery?release_worker:capture_worker,NULL));
        pthread_mutex_lock(&hook_mutex);while(!hook_entered)pthread_cond_wait(&hook_condition,&hook_mutex);pthread_mutex_unlock(&hook_mutex);
        assert(!pthread_create(&controller,NULL,release_publication,NULL));
        forking=1;pid_t child=fork();assert(child>=0);
        if(!child){
            alarm(5);check_custody();
            if(completed_claim){
                assert(published_parent&&published_child&&published_child->capture_resolved&&published_child->creation_parent==published_parent);
                pause_io=1;io_entered=io_release=0;pthread_t blocked;
                assert(!pthread_create(&blocked,NULL,blocked_io,published_parent));
                pthread_mutex_lock(&peer_mutex);while(!io_entered)pthread_cond_wait(&peer_condition,&peer_mutex);pthread_mutex_unlock(&peer_mutex);
                fputs("CONTROL inherited completed claim; parent IO blocked\n",stderr);
                release_owner(&published_child);
                pthread_mutex_lock(&peer_mutex);io_release=1;pthread_cond_broadcast(&peer_condition);pthread_mutex_unlock(&peer_mutex);
                assert(!pthread_join(blocked,NULL));release_owner(&published_parent);assert(!allocations&&!live_caps());_exit(0);
            }
            pid_t nested=fork();assert(nested>=0);
            if(!nested){check_custody();if(published_child)release_owner(&published_child);if(published_parent)release_owner(&published_parent);assert(!allocations&&!live_caps());_exit(0);}
            int nested_status;assert(waitpid(nested,&nested_status,0)==nested&&WIFEXITED(nested_status)&&!WEXITSTATUS(nested_status));
            if(published_child)release_owner(&published_child);if(published_parent)release_owner(&published_parent);assert(!allocations&&!live_caps());_exit(0);
        }
        forking=0;int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
        assert(!pthread_join(worker,NULL)&&!pthread_join(controller,NULL));check_custody();
        if(published_child)release_owner(&published_child);if(published_parent)release_owner(&published_parent);
#else
        assert(!"publication controls require the new guard");
#endif
    }
    assert(!allocations&&!live_caps());printf("PASS capture publication %s\n",argv[1]);return 0;
}
