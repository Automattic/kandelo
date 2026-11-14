#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/wait.h>

struct node { struct node *next; uint32_t value; };
static int await_word(int32_t *p, int32_t value) {
    for (unsigned retry=0; retry<4; retry++) {
        if (__atomic_load_n(p,__ATOMIC_SEQ_CST)==value) return 0;
        // These are actual Wasm waits/notifications, not Kandelo syscall
        // boundaries that could accidentally reconcile separate copies.
        int32_t observed=__atomic_load_n(p,__ATOMIC_SEQ_CST);
        int result=__builtin_wasm_memory_atomic_wait32(p,observed,2000000000LL);
        if(result==2) return -1;
    }
    return __atomic_load_n(p,__ATOMIC_SEQ_CST)==value?0:-1;
}
static void publish(int32_t *p, int32_t value) {
    __atomic_store_n(p,value,__ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify(p,1);
}
int main(void) {
    struct node *private=malloc(2*sizeof(*private));
    if(!private) return 20;
    private[0]=(struct node){private+1,11}; private[1]=(struct node){private,17};
    int32_t *shared=mmap(NULL,65536,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
    if(shared==MAP_FAILED) { perror("mmap");return 21; }
    shared[2]=(int32_t)(uintptr_t)(shared+16); shared[16]=41;
    pid_t child=fork();
    if(child<0) { perror("fork");return 22; }
    if(!child) {
        if(private->next->value!=17) _exit(23);
        private->next->value=99;
        int32_t *pointer=(int32_t *)(uintptr_t)(uint32_t)shared[2];
        if(pointer!=shared+16 || *pointer!=41) _exit(24);
        *pointer=42;
        publish(shared,1);
        if(await_word(shared+1,2)) _exit(25);
        int32_t *replacement=mmap(shared,65536,PROT_READ|PROT_WRITE,
            MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED,-1,0);
        if(replacement!=shared || replacement[16]!=0) _exit(29);
        replacement[16]=99;
        if(mprotect(replacement,65536,PROT_READ) || replacement[16]!=99) _exit(30);
        if(mprotect(replacement,65536,PROT_READ|PROT_WRITE)) _exit(31);
        int32_t *moved=mremap(replacement,65536,131072,MREMAP_MAYMOVE);
        if(moved==MAP_FAILED || moved[16]!=99 || moved[65536/4]!=0) _exit(32);
        if(munmap(moved,131072)) _exit(33);
        replacement=mmap(shared,65536,PROT_READ|PROT_WRITE,
            MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED,-1,0);
        if(replacement!=shared || replacement[16]!=0) _exit(34);
        replacement[16]=111;
        _exit(0);
    }
    if(await_word(shared,1)) { fprintf(stderr,"shared native Wasm wait timed out\n");return 26; }
    if(private->next->value!=17 || shared[16]!=42) return 27;
    publish(shared+1,2);
    int status=0;
    if(waitpid(child,&status,0)!=child || !WIFEXITED(status) || WEXITSTATUS(status)) return 28;
    if(shared[16]!=42) return 35;
    puts("PASS real fork: private/shared pointer graphs, native Wasm wait/notify, fixed replacement, protection, remap and unmap");
    return 0;
}
