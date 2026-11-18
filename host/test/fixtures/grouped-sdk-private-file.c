#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#define P 65536
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL line=%d errno=%d: %s\n",__LINE__,errno,#e);return 1; } } while(0)
static unsigned char contents[3*P];
int main(int argc, char **argv) {
 const char *path="/tmp/grouped-sdk-private-source";
 int fd=open(path,O_CREAT|O_TRUNC|O_RDWR,0600); CHECK(fd>=0);
 memset(contents,'a',P); memset(contents+P,'b',P); memset(contents+2*P,'c',P);
 CHECK(write(fd,contents,sizeof contents)==sizeof contents);
 int readonly=open(path,O_RDONLY); CHECK(readonly>=0);
 CHECK(dup2(readonly,fd)==fd); CHECK(close(readonly)==0);
 unsigned char *p=mmap(NULL,P,PROT_READ|PROT_WRITE,MAP_PRIVATE,fd,P);
 CHECK(p!=MAP_FAILED);
 CHECK(p[0]=='b' && p[P-1]=='b');
 p[0]='x'; unsigned char byte=0; CHECK(pread(fd,&byte,1,P)==1 && byte=='b');
 CHECK(unlink(path)==0); CHECK(close(fd)==0);
 CHECK(p[0]=='x' && p[P-1]=='b');
 int replacement=open(path,O_CREAT|O_TRUNC|O_RDWR,0600); CHECK(replacement==fd);
 CHECK(write(replacement,contents,P)==P);
 p=mremap(p,P,2*P,MREMAP_MAYMOVE); CHECK(p!=MAP_FAILED);
 CHECK(p[0]=='x' && p[P-1]=='b');
 if (argc == 2 && !strcmp(argv[1],"ordinary")) {
  CHECK(p[P]==0 && p[2*P-1]==0);
  puts("ordinary-private-file-growth-partial");
 } else { CHECK(p[P]=='c' && p[2*P-1]=='c'); }
 CHECK(munmap(p,2*P)==0);
 CHECK(close(replacement)==0); CHECK(unlink(path)==0);
 puts("grouped-sdk-private-file PASS"); return 0;
}
