#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#define P 65536
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL shared-file line=%d errno=%d: %s\n",__LINE__,errno,#e);return 1; } } while(0)
static int spin(_Atomic unsigned *word, unsigned value) {
  for (unsigned n=0;n<100000000u;n++) if(atomic_load_explicit(word,memory_order_acquire)==value)return 0;
  return -1;
}
int main(void) {
  int fd=open("/tmp/grouped-shared-file",O_CREAT|O_EXCL|O_RDWR,0600); CHECK(fd>=0);
  CHECK(unlink("/tmp/grouped-shared-file")==0);
  CHECK(ftruncate(fd,2*P-17)==0);
  CHECK(pwrite(fd,"initial",7,P)==7);
  _Atomic unsigned *a=mmap(0,2*P,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0); CHECK(a!=MAP_FAILED);
  CHECK(!memcmp((char*)a+P,"initial",7));
  _Atomic unsigned *b=mmap(0,2*P,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0); CHECK(b!=MAP_FAILED&&b!=a);
  memcpy((char*)a+P,"current",7); CHECK(!memcmp((char*)b+P,"current",7));
  char bytes[8]={0}; CHECK(pread(fd,bytes,7,P)==7&&!memcmp(bytes,"current",7));
  char *private=mmap(0,2*P,PROT_READ|PROT_WRITE,MAP_PRIVATE,fd,0); CHECK(private!=MAP_FAILED);
  CHECK(!memcmp(private+P,"current",7));private[P]='X';CHECK(((char*)a)[P]=='c');
  pid_t child=fork();CHECK(child>=0);
  if(!child) {
    _Atomic unsigned *c=mmap(0,2*P,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);CHECK(c!=MAP_FAILED);
    atomic_store_explicit(c,1,memory_order_release);CHECK(spin(c+1,2)==0);
    memcpy((char*)c+P,"child!!",7);atomic_store_explicit(c+2,3,memory_order_release);
    CHECK(close(fd)==0);CHECK(munmap(c,2*P)==0);_exit(23);
  }
  CHECK(spin(a,1)==0);atomic_store_explicit(b+1,2,memory_order_release);CHECK(spin(a+2,3)==0);
  CHECK(!memcmp((char*)b+P,"child!!",7)); CHECK(private[P]=='X');
  int status=0;CHECK(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==23);
  CHECK(pread(fd,bytes,7,P)==7&&!memcmp(bytes,"child!!",7));
  errno=0;CHECK(pwrite(fd,"x",1,0)==-1&&errno==EOPNOTSUPP);
  errno=0;CHECK(ftruncate(fd,3*P)==-1&&errno==EOPNOTSUPP);
  struct stat st;CHECK(fstat(fd,&st)==0&&st.st_size==2*P-17);
  CHECK(close(fd)==0);CHECK(((char*)a)[P]=='c');
  CHECK(munmap(a,2*P)==0&&munmap(b,2*P)==0&&munmap(private,2*P)==0);
  puts("grouped-sdk-shared-file PASS");return 0;
}
