#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#define P 65536
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL line=%d errno=%d: %s\n",__LINE__,errno,#e);return 1; } } while(0)
static volatile int identity=37;
int main(int argc,char **argv) {
 int grouped=argc>1 && strcmp(argv[1],"grouped")==0;
 volatile unsigned char *heap=malloc(192*1024); CHECK(heap);
 heap[0]=11;heap[192*1024-1]=44;
 unsigned char *mapped=mmap(NULL,2*P,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);CHECK(mapped!=MAP_FAILED);
 mapped[0]=99;mapped[P]=77;CHECK(mprotect(mapped+P,P,PROT_READ)==0);
 int pipefd[2];CHECK(pipe(pipefd)==0);
 pid_t child=fork();CHECK(child>=0);
 if(child==0) {
  CHECK(identity==37 && heap[0]==11 && heap[192*1024-1]==44 && mapped[0]==99 && mapped[P]==77);
  CHECK(close(pipefd[1])==0);
  errno=0;ssize_t n=read(pipefd[0],mapped+P,1);
  if(grouped) CHECK(n==-1 && errno==EFAULT); else CHECK(n==1);
  CHECK(mprotect(mapped+P,P,PROT_READ|PROT_WRITE)==0);
  if(grouped) CHECK(read(pipefd[0],mapped+P,1)==1);
  CHECK(mapped[P]=='q');identity=42;heap[0]=22;mapped[0]=55;
  CHECK(close(pipefd[0])==0);
  puts("grouped-fork-child PASS");fflush(stdout);_exit(23);
 }
 CHECK(close(pipefd[0])==0);CHECK(write(pipefd[1],"q",1)==1);CHECK(close(pipefd[1])==0);
 int status=0;CHECK(waitpid(child,&status,0)==child);CHECK(WIFEXITED(status)&&WEXITSTATUS(status)==23);
 CHECK(identity==37 && heap[0]==11 && heap[192*1024-1]==44 && mapped[0]==99 && mapped[P]==77);
 CHECK(mprotect(mapped+P,P,PROT_READ|PROT_WRITE)==0);CHECK(munmap(mapped,2*P)==0);free((void*)heap);
 puts("grouped-sdk-fork PASS");return 0;
}
