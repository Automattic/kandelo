/* Pause at actual C helper boundaries after native completion. No production
 * hook or extra host-to-guest callback participates in these fork controls. */
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
static int cancel_state_hook(int,int *);
#include "drm-owned-double.h"
#define pthread_setcancelstate cancel_state_hook
#ifndef WPK_OWNED_COMMON_SOURCE
#define WPK_OWNED_COMMON_SOURCE "drm_owned.c"
#endif
#include WPK_OWNED_COMMON_SOURCE
#undef pthread_setcancelstate
#define owned_ioctl model_ioctl
#define main transport_fixture_main
#include "drm-owned-transport.c"
#undef main
#undef owned_ioctl
static pthread_mutex_t phase_mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t phase_condition=PTHREAD_COND_INITIALIZER;
static int paused,resume_worker;
static _Thread_local int actor;
static const char *mode;
static struct wpk_drm_owner *published;
static void pause_phase(void){
    pthread_mutex_lock(&phase_mutex);paused=1;pthread_cond_broadcast(&phase_condition);
    while(!resume_worker)pthread_cond_wait(&phase_condition,&phase_mutex);
    pthread_mutex_unlock(&phase_mutex);
}
static int cancel_state_hook(int state,int *prior){
    if(actor&&!paused&&!strcmp(mode,"cold-preentry")&&published)pause_phase();
    return pthread_setcancelstate(state,prior);
}
int owned_ioctl(int fd,unsigned long request,...){
    va_list args;va_start(args,request);struct wpk_drm_owned_packet *p=va_arg(args,void *);va_end(args);
    unsigned action=p->action;int rc=model_ioctl(fd,request,p);
    if(actor&&!paused&&action==WPK_DRM_OWNED_ACK&&(!strcmp(mode,"cold-ack")||!strcmp(mode,"cold-ack-owned-error")||!strcmp(mode,"cold-ack-rejected")||!strcmp(mode,"cold-ack-lost")||!strcmp(mode,"cold-acquire-ack")))pause_phase();
    return rc;
}
static void snapshot_prepare(void){pthread_mutex_lock(&peer_mutex);}
static void snapshot_parent(void){pthread_mutex_unlock(&peer_mutex);}
static void snapshot_child(void){actor=0;pthread_mutex_unlock(&peer_mutex);}
static void *invoke(void *unused){
    (void)unused;actor=1;
    if(!strncmp(mode,"cold-",5)){
        if(!strcmp(mode,"cold-ack-owned-error"))consume_error=1;
        if(!strcmp(mode,"cold-ack-lost"))ack_loss=1;
        int rc=!strcmp(mode,"cold-ack-rejected")?_wpk_drm_owned_acquire(-5,0,&published):
            !strcmp(mode,"cold-acquire-ack")?_wpk_drm_owned_acquire(10,0,&published):_wpk_drm_owned_open(1,&published);
        assert(rc==(!strcmp(mode,"cold-ack-owned-error")||!strcmp(mode,"cold-ack-rejected")||!strcmp(mode,"cold-ack-lost")?-1:0));return NULL;
    }
    int cancel_state;assert(lock_owner(published,&cancel_state));
    unsigned action=!strncmp(mode,"release",7)?WPK_DRM_OWNED_RELEASE:WPK_DRM_OWNED_IOCTL;
    assert(begin_request(published,action));
    if(action==WPK_DRM_OWNED_IOCTL){published->request.request=0x1234;published->request.length=4;uint32_t value=5;memcpy(published->request.body,&value,4);}
    int entered;
    if(!strcmp(mode,"release-error"))release_consumed_error=1;
    if(!strcmp(mode,"recover")){lost_action=3;read_failures=1;assert(enter_request(published)<0);entered=recover_pending(published);}
    else{if(!strcmp(mode,"nonentry"))before_action=3;entered=enter_request(published);}
    assert(entered==(!strcmp(mode,"nonentry")?0:1));
    if(!strcmp(mode,"mid-progress"))published->transaction=published->request.transaction;
    int committed=!strcmp(mode,"release-committed");
    if(committed)assert(complete_request(published,entered)==0);
    fprintf(stderr,"PHASE %s pending=%d tx=%llu accepted=%llu\n",mode,published->pending,(unsigned long long)published->transaction,(unsigned long long)published->pending_transaction);
    pause_phase();
    if(!committed)assert(complete_request(published,entered)==(!strcmp(mode,"nonentry")||!strcmp(mode,"release-error")?-1:0));
    unlock_owner(published,cancel_state);return NULL;
}
int main(int argc,char **argv){
    assert(argc==2);mode=argv[1];
    assert(!pthread_atfork(snapshot_prepare,snapshot_parent,snapshot_child));
    if(strncmp(mode,"cold-",5))assert(!_wpk_drm_owned_open(1,&published));
    pthread_t worker;assert(!pthread_create(&worker,NULL,invoke,NULL));
    pthread_mutex_lock(&phase_mutex);while(!paused)pthread_cond_wait(&phase_condition,&phase_mutex);pthread_mutex_unlock(&phase_mutex);
    pid_t child=fork();assert(child>=0);if(!child){alarm(5);
        if(!strcmp(mode,"release-error"))assert(_wpk_drm_owned_release(&published)==-1&&!published&&errno==EIO);
        else release_owner(&published);
        assert(!allocations&&!live_caps());_exit(0);}
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    pthread_mutex_lock(&phase_mutex);resume_worker=1;pthread_cond_broadcast(&phase_condition);pthread_mutex_unlock(&phase_mutex);
    assert(!pthread_join(worker,NULL));
    if(!strcmp(mode,"release-error"))assert(_wpk_drm_owned_release(&published)==-1&&!published&&errno==EIO);
    else release_owner(&published);
    assert(!allocations&&!live_caps());
    printf("PASS completion-publication %s\n",mode);return 0;
}
