#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
struct dumb {uint32_t height,width,bpp,flags,handle,pitch;uint64_t size;};
struct mapping {uint32_t handle,pad;uint64_t offset;};
#define CHECK(x) do {if (!(x)) {fprintf(stderr,"line %d: %s errno=%d\n",__LINE__,#x,errno);exit(1);}} while (0)
static void ready(int fd) {
    struct pollfd p={.fd=fd,.events=POLLIN};
    CHECK(poll(&p,1,10000)==1 && (p.revents&POLLIN));
    char byte;CHECK(read(fd,&byte,1)==1);
}
int main(void) {
    int fd=open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC);CHECK(fd>=0);
    struct dumb bo={.width=4,.height=4,.bpp=32};CHECK(ioctl(fd,0xc02064b2u,&bo)==0);
    struct mapping map={.handle=bo.handle};CHECK(ioctl(fd,0xc01064b3u,&map)==0);
    unsigned char *pixels=mmap(NULL,65536,PROT_READ|PROT_WRITE,MAP_SHARED,fd,map.offset);
    CHECK(pixels!=MAP_FAILED && close(fd)==0);
    pixels[0]=17;
    int parent_gate[2],child_gate[2];CHECK(pipe(parent_gate)==0 && pipe(child_gate)==0);
    pid_t child=fork();CHECK(child>=0);
    if (child==0) {
        CHECK(close(parent_gate[1])==0 && close(child_gate[0])==0);
        ready(parent_gate[0]);CHECK(pixels[0]==41);
        pixels[1]=59;CHECK(write(child_gate[1],"c",1)==1);
        /* Retire the writer before the parent consumes its final bytes. */
        CHECK(munmap(pixels,65536)==0);
        CHECK(close(parent_gate[0])==0 && close(child_gate[1])==0);
        _exit(0);
    }
    CHECK(close(parent_gate[0])==0 && close(child_gate[1])==0);
    pixels[0]=41;CHECK(write(parent_gate[1],"p",1)==1);
    ready(child_gate[0]);CHECK(pixels[0]==41 && pixels[1]==59);
    int status=0;CHECK(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0);
    pixels[2]=101;CHECK(pixels[0]==41 && pixels[1]==59 && pixels[2]==101);
    CHECK(munmap(pixels,65536)==0 && close(parent_gate[1])==0 && close(child_gate[0])==0);
    puts("OK inherited DRI mapping survives descriptor and writer retirement");
    return 0;
}
