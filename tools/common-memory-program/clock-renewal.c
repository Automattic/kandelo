#define _GNU_SOURCE
#include <time.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
__attribute__((import_module("kandelo.clock.v1"),import_name("__kandelo_clock_query_v1"))) extern int __kandelo_clock_query_v1(void*,int,unsigned);
int main(int argc,char**argv){
 if(argc!=2)return 10;int expected=!strcmp(argv[1],"renew"),fd=open("/tmp/clock-renew-input",O_CREAT|O_RDWR|O_TRUNC,0600);if(fd<0||write(fd,"abcdef",6)!=6)return 11;
 struct timespec *t=mmap(0,65536,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(t==MAP_FAILED||clock_gettime(1,t))return 12;
 unsigned fast=0,slow=0;
 for(int kind=0;kind<4;kind++){
  unsigned local=0;
  for(int i=0;i<64;i++){
   struct stat st;int r=kind==0?stat("/tmp/clock-renew-input",&st):kind==1?lstat("/tmp/clock-renew-input",&st):kind==2?fstat(fd,&st):fstatat(AT_FDCWD,"/tmp/clock-renew-input",&st,0);
   if(r||st.st_size!=6||!S_ISREG(st.st_mode))return 20+kind;
   errno=71;r=__kandelo_clock_query_v1(t,1,0);if(errno!=71||r<0||r>1)return 30+kind;
   if(r==0){fast++;local++;}else{slow++;if(clock_gettime(1,t))return 40+kind;}
   if(t->tv_sec<0||t->tv_nsec<0||t->tv_nsec>=1000000000L)return 50+kind;
  }
  if(expected?!local:local!=0)return 60+kind;
 }
 struct stat protected_stat;
 if(clock_gettime(1,t))return 73;
 t->tv_sec=123;t->tv_nsec=456;
 if(mprotect(t,65536,PROT_READ)||stat("/tmp/clock-renew-input",&protected_stat))return 74;
 if(__kandelo_clock_query_v1(t,1,0)!=1||t->tv_sec!=123||t->tv_nsec!=456)return 75;
 if(mprotect(t,65536,PROT_READ|PROT_WRITE)||clock_gettime(1,t))return 76;
 if(munmap(t,65536)||stat("/tmp/clock-renew-input",&protected_stat)||__kandelo_clock_query_v1(t,1,0)!=1)return 77;
 struct stat st;errno=0;if(stat("/tmp/clock-renew-missing",&st)!=-1||errno!=ENOENT)return 70;
 if(__kandelo_clock_query_v1(t,1,0)!=1)return 71;
 if(close(fd))return 72;
 printf("__COMMON_MEMORY_CLOCK_RENEW_PASS__ fast=%u slow=%u\n",fast,slow);return 0;
}
