#define _GNU_SOURCE
#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#define P 65536
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL line=%d errno=%d: %s\n",__LINE__,errno,#e);return 1; } } while(0)
static int phase(unsigned n) {
  printf("anonymous-phase %u\n",n);fflush(stdout);
  char ack;return read(0,&ack,1)==1?0:-1;
}
static int spin(_Atomic unsigned *word,unsigned value) {
  for(unsigned n=0;n<100000000u;n++) if(atomic_load_explicit(word,memory_order_acquire)==value)return 0;
  return -1;
}
int main(void) {
  volatile unsigned char *data=mmap(0,3*P,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
  _Atomic unsigned *control=mmap(0,P,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
  volatile unsigned char *private=mmap(0,P,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  CHECK(data!=MAP_FAILED&&control!=MAP_FAILED&&private!=MAP_FAILED);
  CHECK(data[0]==0&&data[P]==0&&data[2*P]==0);
  data[0]=11;data[P]=22;data[2*P]=33;private[0]=44;
  volatile unsigned char *old_tail=data+P;
  volatile unsigned char *tail=mremap((void*)old_tail,2*P,P,0);CHECK(tail==old_tail);
  void *blocker=mmap((void*)(data+2*P),P,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED,-1,0);
  CHECK(blocker==(void*)(data+2*P));
  tail=mremap((void*)tail,P,2*P,MREMAP_MAYMOVE);CHECK(tail!=MAP_FAILED&&tail!=old_tail);
  CHECK(data[0]==11&&tail[0]==22&&tail[P]==33);
  CHECK(phase(1)==0);
  pid_t child=fork();CHECK(child>=0);
  if(child==0) {
    CHECK(private[0]==44);private[0]=99;
    atomic_store_explicit(control,1,memory_order_release);
    CHECK(spin(control+1,1)==0);
    CHECK(data[0]==11&&tail[0]==22&&tail[P]==33);
    data[0]=55;tail[0]=66;
    atomic_store_explicit(control+2,1,memory_order_release);
    CHECK(spin(control+3,1)==0);
    tail[0]=77;
    atomic_store_explicit(control+4,1,memory_order_release);
    CHECK(spin(control+5,1)==0);
    CHECK(data[0]==55&&tail[0]==77&&tail[P]==33&&private[0]==99);
    tail[P]=88;
    atomic_store_explicit(control+6,88,memory_order_release);
    CHECK(spin(control+7,1)==0);
    CHECK(munmap((void*)data,P)==0);CHECK(munmap((void*)tail,2*P)==0);
    _exit(23);
  }
  CHECK(spin(control,1)==0);CHECK(phase(2)==0);
  atomic_store_explicit(control+1,1,memory_order_release);
  CHECK(spin(control+2,1)==0);
  CHECK(data[0]==55&&tail[0]==66&&private[0]==44);
  CHECK(mprotect((void*)(tail),P,PROT_READ)==0);
  atomic_store_explicit(control+3,1,memory_order_release);
  CHECK(spin(control+4,1)==0);CHECK(tail[0]==77);
  CHECK(mprotect((void*)(tail),P,PROT_READ|PROT_WRITE)==0);
  CHECK(phase(3)==0);
  CHECK(munmap((void*)data,P)==0);CHECK(munmap((void*)tail,2*P)==0);
  unsigned char *reuse=mmap(0,4*P,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);CHECK(reuse!=MAP_FAILED);
  memset(reuse,0xcd,4*P);
  atomic_store_explicit(control+5,1,memory_order_release);
  CHECK(spin(control+6,88)==0);CHECK(phase(4)==0);
  atomic_store_explicit(control+7,1,memory_order_release);
  int status=0;CHECK(waitpid(child,&status,0)==child);
  CHECK(WIFEXITED(status)&&WEXITSTATUS(status)==23);CHECK(phase(5)==0);
  CHECK(munmap(control,P)==0);CHECK(munmap((void*)private,P)==0);CHECK(munmap(reuse,4*P)==0);
  CHECK(munmap(blocker,P)==0);CHECK(phase(6)==0);
  puts("grouped-sdk-anonymous-shared PASS direct-visibility private-isolation offset-regrowth peer-lifetime");
  return 0;
}
