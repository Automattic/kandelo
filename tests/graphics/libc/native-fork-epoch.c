/* Execute the actual child-rebinding implementation with explicit musl-state
 * doubles. This does not substitute for normal SDK/Node/browser execution. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
struct epoch_thread { int tid;struct { long off;void *pending; } robust_list;struct epoch_thread *next,*prev; };
static struct epoch_thread current,peer;
static struct { int threads_minus_1,need_locks; } fixture_libc;
static int __thread_list_lock;
static int fixture_syscall(long number,void *address){assert(number==17&&address==&__thread_list_lock);return 501;}
#define pthread_t epoch_pthread_t
#define libc fixture_libc
#define __pthread_self() (&current)
#define __syscall fixture_syscall
#include WPK_POST_FORK_SOURCE
#undef pthread_t
#undef libc
static void prepare(unsigned threads){
    current=(struct epoch_thread){.tid=42,.robust_list={7,&peer},.next=&peer,.prev=&peer};
    fixture_libc.threads_minus_1=threads;fixture_libc.need_locks=1;__thread_list_lock=9;
}
static void check_rebound(void){
    assert(current.tid==501&&!current.robust_list.off&&!current.robust_list.pending);
    assert(current.next==&current&&current.prev==&current&&!__thread_list_lock);
    assert(!fixture_libc.threads_minus_1&&fixture_libc.need_locks==-1);
}
int main(void){
    assert(!__wasm_posix_native_fork_epoch());
    prepare(0);__wasm_posix_after_fork_child();check_rebound();assert(!native_fork_epoch);
    prepare(2);__wasm_posix_after_fork_child();check_rebound();assert(native_fork_epoch==1);
    uint64_t fresh=__wasm_posix_native_fork_epoch();
    prepare(0);__wasm_posix_after_fork_child();check_rebound();assert(native_fork_epoch==fresh);
    prepare(1);__wasm_posix_after_fork_child();check_rebound();assert(native_fork_epoch==2&&fresh!=native_fork_epoch);
    prepare(3);pid_t child=fork();assert(child>=0);
    if(!child){__wasm_posix_after_fork_child();check_rebound();_exit(native_fork_epoch==3?0:41);}
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
    assert(native_fork_epoch==2&&fixture_libc.threads_minus_1==3&&current.tid==42);
    child=fork();assert(child>=0);
    if(!child){native_fork_epoch=UINT64_MAX;__wasm_posix_after_fork_child();_exit(42);}
    assert(waitpid(child,&status,0)==child&&WIFSIGNALED(status));
    assert(WTERMSIG(status)==SIGILL||WTERMSIG(status)==SIGTRAP);
    puts("PASS actual child rebind: single/multithread, nested/fresh epochs, parent isolation, no wrap");return 0;
}
