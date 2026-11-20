#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"identity FAIL line=%d errno=%d: %s\n",__LINE__,errno,#e);return 1;} } while(0)
int main(int argc,char **argv) {
 CHECK(argc>=2);
 struct stat source, executable;
 CHECK(stat(argv[1],&source)==0); CHECK(stat("/proc/self/exe",&executable)==0);
 CHECK(source.st_dev==executable.st_dev && source.st_ino==executable.st_ino);
 char path[256]; ssize_t n=readlink("/proc/self/exe",path,sizeof(path)-1); CHECK(n>0);path[n]=0;CHECK(strcmp(path,argv[1])==0);
 if(argc==2) {
  pid_t child;char *args[]={argv[1],argv[1],"spawn-child",NULL};
  int spawn_error=posix_spawn(&child,argv[1],NULL,NULL,args,environ);if(spawn_error)fprintf(stderr,"posix_spawn returned %d\n",spawn_error);CHECK(spawn_error==0);
  int status;CHECK(waitpid(child,&status,0)==child);CHECK(WIFEXITED(status)&&WEXITSTATUS(status)==0);
 }
 puts("grouped-sdk-executable-identity PASS");return 0;
}
