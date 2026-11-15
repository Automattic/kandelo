#define _GNU_SOURCE
#include <time.h>
#include <stdint.h>
#include <stdio.h>
#include <errno.h>
#include <signal.h>
#include <sys/time.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <string.h>
__attribute__((import_module("kandelo.clock.v1"),import_name("__kandelo_clock_query_v1")))extern int query(void*,int,unsigned);
static unsigned hits,slow;
static int expect_fast=1;
static volatile sig_atomic_t alarms,handler_error;
static int stamp(struct timespec*t){
 int r=query(t,CLOCK_MONOTONIC,0);
 if(r==0)hits++;else if(r==1){slow++;r=clock_gettime(CLOCK_MONOTONIC,t);}else return -1;
 return r||t->tv_sec<0||t->tv_nsec<0||t->tv_nsec>=1000000000L?-1:0;
}
static int repeated(struct timespec*t){unsigned before=hits;for(int i=0;i<128;i++)if(stamp(t))return -1;return !expect_fast||hits>before?0:-1;}
static void handler(int sig){(void)sig;struct timespec t;int r=query(&t,CLOCK_MONOTONIC,0);if(r==1)r=clock_gettime(CLOCK_MONOTONIC,&t);if(r||t.tv_sec<0||t.tv_nsec<0||t.tv_nsec>=1000000000L)handler_error=1;alarms++;}
static void*thread(void*p){return p;}
static int child_status(pid_t pid){int s;if(waitpid(pid,&s,0)!=pid||!WIFEXITED(s)||WEXITSTATUS(s))return -1;return 0;}
int main(int argc,char**argv){
 expect_fast=!(argc>1&&!strcmp(argv[argc-1],"--off"));
 struct timespec t={123,456};
 if(argc>1&&!strcmp(argv[1],"--exec-child")){
  if(query(&t,CLOCK_MONOTONIC,0)!=1||t.tv_sec!=123||t.tv_nsec!=456)return 70;
  if(repeated(&t))return 71;
  puts("__COMMON_MEMORY_EXEC_PASS__");return 0;
 }
 if(repeated(&t))return 10;
 const long page=sysconf(_SC_PAGESIZE);if(page<=16)return 11;
 char*p=mmap(0,page*2,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(p==MAP_FAILED)return 12;
 struct timespec*split=(void*)(p+page-8);if(repeated(split))return 13;
 if(mprotect(p,page*2,PROT_READ))return 14;
 if(query(split,CLOCK_MONOTONIC,0)!=1)return 15;
 if(mprotect(p,page*2,PROT_READ|PROT_WRITE))return 16;
 if(repeated(split))return 17;
 if(munmap(p,page*2))return 18;
 if(query(split,CLOCK_MONOTONIC,0)!=1)return 19;
 puts("__COMMON_MEMORY_MAPPINGS_PASS__");
 // Shared groups refuse secondary threads before publishing any TID.
 pthread_t th;if(pthread_create(&th,0,thread,0)!=EAGAIN)return 20;
 if(repeated(&t))return 24;
 puts("__COMMON_MEMORY_CLOCK_THREADS_REFUSED__");
 struct sigaction action={0};action.sa_handler=handler;sigemptyset(&action.sa_mask);
 if(sigaction(SIGALRM,&action,0))return 30;
 struct sigevent event={0};event.sigev_notify=SIGEV_SIGNAL;event.sigev_signo=SIGALRM;
 timer_t timer_id;if(timer_create(CLOCK_MONOTONIC,&event,&timer_id))return 31;
 struct itimerspec timer={{0,2000000},{0,2000000}};
 if(timer_settime(timer_id,0,&timer,0))return 31;
 struct timespec start,now;if(stamp(&start))return 32;
 do{if(stamp(&now))return 33;if(now.tv_sec-start.tv_sec>2)return 34;}while(alarms<3);
 memset(&timer,0,sizeof(timer));if(timer_settime(timer_id,0,&timer,0)||handler_error)return 35;
 // A blocked pending signal is not deliverable; unblocking must deliver it.
 sigset_t mask,old;sigemptyset(&mask);sigaddset(&mask,SIGALRM);
 if(sigprocmask(SIG_BLOCK,&mask,&old))return 36;
 sig_atomic_t before=alarms;if(raise(SIGALRM))return 37;
 for(int i=0;i<64;i++)if(stamp(&t))return 38;
 if(alarms!=before)return 39;
 if(sigprocmask(SIG_SETMASK,&old,0)||alarms<=before||handler_error)return 40;
 puts("__COMMON_MEMORY_SIGNALS_PASS__");
 // Internal deadline clocks may not consume ppoll's caught signal.
 before=alarms;timer.it_value.tv_nsec=20000000;
 if(timer_settime(timer_id,0,&timer,0))return 41;
 struct timespec timeout={0,150000000};errno=0;
 int pr=ppoll(0,0,&timeout,0),pe=errno;
 memset(&timer,0,sizeof(timer));if(timer_settime(timer_id,0,&timer,0)||timer_delete(timer_id))return 42;
 if(pr!=-1||pe!=EINTR||alarms<=before||handler_error)return 43;
 puts("__COMMON_MEMORY_PPOLL_PASS__");
 pid_t child=fork();if(child<0)return 50;
 if(!child){struct timespec c={123,456};if(query(&c,CLOCK_MONOTONIC,0)!=1||c.tv_sec!=123||c.tv_nsec!=456)_exit(51);_exit(repeated(&c)?52:0);}
 if(child_status(child)||repeated(&t))return 53;
 puts("__COMMON_MEMORY_FORK_PASS__");
 child=fork();if(child<0)return 54;
 if(!child){if(repeated(&t))_exit(55);execl("/tmp/clock-advanced.wasm","clock","--exec-child",expect_fast?"--fast":"--off",(char*)0);_exit(56);}
 if(child_status(child)||repeated(&t))return 57;
 if(!expect_fast&&hits)return 80;
 printf("__COMMON_MEMORY_ADVANCED_CLOCK_PASS__ fast=%u slow=%u alarms=%d\n",hits,slow,(int)alarms);return 0;
}
