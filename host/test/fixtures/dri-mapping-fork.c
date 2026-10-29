#define _GNU_SOURCE
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
static void full_mapping(void) {
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
}

static void fragmented_mapping(int middle_hole) {
    const size_t page=65536;
    int fd=open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC);CHECK(fd>=0);
    struct dumb bo={.width=256,.height=192,.bpp=32};CHECK(ioctl(fd,0xc02064b2u,&bo)==0);
    CHECK(bo.size==3*page);
    struct mapping map={.handle=bo.handle};CHECK(ioctl(fd,0xc01064b3u,&map)==0);
    unsigned char *pixels=mmap(NULL,3*page,PROT_READ|PROT_WRITE,MAP_SHARED,fd,map.offset);
    CHECK(pixels!=MAP_FAILED && close(fd)==0);
    pixels[0]=17;pixels[page]=23;pixels[2*page]=29;
    unsigned char *left,*right;
    if (middle_hole) {
        if (middle_hole==1) CHECK(munmap(pixels+page,page)==0);
        left=pixels;right=pixels+2*page;
        if (middle_hole==3) {
            int replacement=memfd_create("fixed-file",MFD_CLOEXEC);CHECK(replacement>=0);
            CHECK(ftruncate(replacement,page)==0 && write(replacement,"x",1)==1);
            CHECK(mmap(pixels+page,page,PROT_READ|PROT_WRITE,
                MAP_FIXED|MAP_PRIVATE,replacement,0)==pixels+page);
            CHECK(close(replacement)==0 && pixels[page]=='x');
        } else CHECK(mmap(pixels+page,page,PROT_READ|PROT_WRITE,
            MAP_FIXED|MAP_PRIVATE|MAP_ANONYMOUS,-1,0)==pixels+page);
        pixels[page]=55;
    } else {
        CHECK(munmap(pixels,page)==0 && munmap(pixels+2*page,page)==0);
        left=pixels+page;right=left+128;
    }
    int parent_gate[2],child_gate[2];CHECK(pipe(parent_gate)==0 && pipe(child_gate)==0);
    pid_t child=fork();CHECK(child>=0);
    if (child==0) {
        CHECK(close(parent_gate[1])==0 && close(child_gate[0])==0);
        ready(parent_gate[0]);CHECK(left[0]==41 && right[0]==61);
        if (middle_hole) CHECK(pixels[page]==55);
        left[1]=59;right[1]=79;
        CHECK(write(child_gate[1],"c",1)==1);
        if (middle_hole) CHECK(munmap(left,page)==0 && munmap(right,page)==0);
        else CHECK(munmap(left,page)==0);
        CHECK(close(parent_gate[0])==0 && close(child_gate[1])==0);
        _exit(0);
    }
    CHECK(close(parent_gate[0])==0 && close(child_gate[1])==0);
    left[0]=41;right[0]=61;
    if (middle_hole) pixels[page]=81;
    CHECK(write(parent_gate[1],"p",1)==1);
    ready(child_gate[0]);CHECK(left[0]==41 && left[1]==59 && right[0]==61 && right[1]==79);
    int status=0;CHECK(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0);
    left[2]=101;right[2]=103;CHECK(left[1]==59 && right[1]==79);
    if (middle_hole) CHECK(pixels[page]==81 && munmap(pixels+page,page)==0);
    if (middle_hole) CHECK(munmap(right,page)==0 && munmap(left,page)==0);
    else CHECK(munmap(left,page)==0);
    CHECK(close(parent_gate[1])==0 && close(child_gate[0])==0);
    puts(middle_hole==3 ? "OK fixed file replacement retires only the replaced DRI interval" :
        middle_hole==2 ? "OK fixed anonymous replacement retires only the replaced DRI interval" :
        middle_hole ? "OK middle-unmap fragments retain storage offsets across fork" :
        "OK prefix and suffix unmaps preserve the surviving mapping across fork");
}
int main(void) {
    full_mapping();
    fragmented_mapping(1);
    fragmented_mapping(0);
    fragmented_mapping(2);
    fragmented_mapping(3);
    return 0;
}
