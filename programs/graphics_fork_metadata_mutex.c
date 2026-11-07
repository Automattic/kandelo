/* Actual guest controls for the private graphics metadata lock. The target
 * uses the ordinary futex/clone/fork/signal path, with no renderer or browser
 * graphics adapter required. */
#include "../libc/glue/drm_owned.h"
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
static struct wpk_drm_mutex metadata=WPK_DRM_MUTEX_INITIALIZER;
static pthread_mutex_t rendezvous=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition=PTHREAD_COND_INITIALIZER;
static unsigned counter,held,release_holder;
static _Atomic unsigned waiter_started,waiter_entered,signals_seen;
static void signal_received(int signal){(void)signal;atomic_fetch_add(&signals_seen,1);}
static void *increment(void *unused){
    (void)unused;
    for(unsigned i=0;i<2000;i++){
        _wpk_drm_mutex_lock(&metadata);unsigned prior=counter;
        /* Yield while owned so real peers contend and park; an uncontended
         * increment loop alone would not exercise futex wake ordering. */
        if((i&15)==0)sched_yield();
        counter=prior+1;_wpk_drm_mutex_unlock(&metadata);
    }
    return NULL;
}
static void *hold_across_fork(void *unused){
    (void)unused;_wpk_drm_mutex_lock(&metadata);
    assert(!pthread_mutex_lock(&rendezvous));held=1;assert(!pthread_cond_broadcast(&condition));
    while(!release_holder)assert(!pthread_cond_wait(&condition,&rendezvous));
    assert(!pthread_mutex_unlock(&rendezvous));_wpk_drm_mutex_unlock(&metadata);return NULL;
}
static void *interrupted_waiter(void *unused){
    (void)unused;atomic_store(&waiter_started,1);
    _wpk_drm_mutex_lock(&metadata);atomic_store(&waiter_entered,1);_wpk_drm_mutex_unlock(&metadata);return NULL;
}
int main(int argc,char **argv){
    assert(argc==2);
    if(!strcmp(argv[1],"contention")){
        pthread_t threads[4];for(unsigned i=0;i<4;i++)assert(!pthread_create(&threads[i],NULL,increment,NULL));
        for(unsigned i=0;i<4;i++)assert(!pthread_join(threads[i],NULL));assert(counter==8000);
        puts("OK metadata contention");return 0;
    }
    if(!strcmp(argv[1],"locked-fork")){
        pthread_t thread;assert(!pthread_create(&thread,NULL,hold_across_fork,NULL));
        assert(!pthread_mutex_lock(&rendezvous));while(!held)assert(!pthread_cond_wait(&condition,&rendezvous));assert(!pthread_mutex_unlock(&rendezvous));
        pid_t child=fork();assert(child>=0);
        if(!child){
            alarm(5);_wpk_drm_mutex_lock(&metadata);counter=1;_wpk_drm_mutex_unlock(&metadata);
            /* Nested fork starts another independent generation. */
            pid_t nested=fork();assert(nested>=0);
            if(!nested){_wpk_drm_mutex_lock(&metadata);counter=2;_wpk_drm_mutex_unlock(&metadata);_exit(0);}
            int status;assert(waitpid(nested,&status,0)==nested&&WIFEXITED(status)&&WEXITSTATUS(status)==0&&counter==1);_exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0&&counter==0);
        assert(!pthread_mutex_lock(&rendezvous));release_holder=1;assert(!pthread_cond_broadcast(&condition));assert(!pthread_mutex_unlock(&rendezvous));
        assert(!pthread_join(thread,NULL));_wpk_drm_mutex_lock(&metadata);counter=3;_wpk_drm_mutex_unlock(&metadata);
        puts("OK metadata locked fork");return 0;
    }
    assert(!strcmp(argv[1],"signal-wake"));
    struct sigaction action={.sa_handler=signal_received};assert(!sigemptyset(&action.sa_mask));assert(!sigaction(SIGUSR1,&action,NULL));
    for(unsigned attempt=0;attempt<40;attempt++){
        atomic_store(&waiter_started,0);atomic_store(&waiter_entered,0);
        _wpk_drm_mutex_lock(&metadata);pthread_t thread;assert(!pthread_create(&thread,NULL,interrupted_waiter,NULL));
        while(!atomic_load(&waiter_started))sched_yield();
        assert(!pthread_kill(thread,SIGUSR1));
        /* Spurious futex wake must never transfer the owned critical section.
         * Signals may race parking; host trace evidence distinguishes actual
         * EINTR from a handler that ran before a waiter entered the kernel. */
        assert(syscall(SYS_futex,(long)(uintptr_t)&metadata.state,(long)1,(long)INT_MAX,(long)0,(long)0,(long)0)>=0);
        assert(!atomic_load(&waiter_entered));_wpk_drm_mutex_unlock(&metadata);
        assert(!pthread_join(thread,NULL)&&atomic_load(&waiter_entered));
    }
    assert(atomic_load(&signals_seen)>0);puts("OK metadata signal wake");return 0;
}
