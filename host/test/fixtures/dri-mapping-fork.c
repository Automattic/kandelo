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
struct prime {uint32_t handle,flags;int32_t fd;};
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
static void remapped_mapping(void) {
    const size_t page=65536;
    int fd=open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC);CHECK(fd>=0);
    struct dumb bo={.width=256,.height=192,.bpp=32};CHECK(ioctl(fd,0xc02064b2u,&bo)==0);
    struct mapping map={.handle=bo.handle};CHECK(ioctl(fd,0xc01064b3u,&map)==0);
    unsigned char *pixels=mmap(NULL,3*page,PROT_READ|PROT_WRITE,MAP_SHARED,fd,map.offset);
    CHECK(pixels!=MAP_FAILED && close(fd)==0);
    pixels[0]=17;
    CHECK(mremap(pixels,3*page,3*page,MREMAP_MAYMOVE)==pixels);
    for (int move=0;move<2;move++) {
        errno=0;
        CHECK(mremap(pixels,3*page,4*page,move?MREMAP_MAYMOVE:0)==MAP_FAILED && errno==EFAULT);
        CHECK(pixels[0]==17);
    }
    CHECK(mremap(pixels,3*page,page,0)==pixels);
    errno=0;CHECK(mremap(pixels+1,page,page,0)==MAP_FAILED && errno==EINVAL);
    errno=0;CHECK(mremap(pixels+page,page,page,0)==MAP_FAILED && errno==EFAULT);
    CHECK(mmap(pixels+page,2*page,PROT_READ|PROT_WRITE,
        MAP_FIXED|MAP_PRIVATE|MAP_ANONYMOUS,-1,0)==pixels+page);
    pixels[page]=55;
    errno=0;
    CHECK(mremap(pixels,page,2*page,MREMAP_MAYMOVE)==MAP_FAILED && errno==EFAULT);
    int parent_gate[2],child_gate[2];CHECK(pipe(parent_gate)==0 && pipe(child_gate)==0);
    pid_t child=fork();CHECK(child>=0);
    if (child==0) {
        CHECK(close(parent_gate[1])==0 && close(child_gate[0])==0);
        ready(parent_gate[0]);CHECK(pixels[0]==41 && pixels[page]==55);
        pixels[1]=59;CHECK(write(child_gate[1],"c",1)==1);
        CHECK(munmap(pixels,page)==0 && munmap(pixels+page,2*page)==0);
        CHECK(close(parent_gate[0])==0 && close(child_gate[1])==0);
        _exit(0);
    }
    CHECK(close(parent_gate[0])==0 && close(child_gate[1])==0);
    pixels[0]=41;pixels[page]=81;CHECK(write(parent_gate[1],"p",1)==1);
    ready(child_gate[0]);CHECK(pixels[0]==41 && pixels[1]==59 && pixels[page]==81);
    int status=0;CHECK(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0);
    CHECK(munmap(pixels,3*page)==0 && close(parent_gate[1])==0 && close(child_gate[0])==0);
    puts("OK device remap shrink retains storage and rejects expansion without side effects");
}

static void replaced_device_mapping(int same_bo) {
    const size_t page=65536;
    int fd=open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC);CHECK(fd>=0);
    struct dumb old={.width=256,.height=192,.bpp=32};CHECK(ioctl(fd,0xc02064b2u,&old)==0);
    struct mapping old_map={.handle=old.handle};CHECK(ioctl(fd,0xc01064b3u,&old_map)==0);
    unsigned char *base=mmap(NULL,4*page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    CHECK(base!=MAP_FAILED);
    CHECK(mmap(base,3*page,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_FIXED,fd,old_map.offset)==base);
    unsigned char *mirror=mmap(NULL,3*page,PROT_READ|PROT_WRITE,MAP_SHARED,fd,old_map.offset);
    CHECK(mirror!=MAP_FAILED);
    int replacement=-1;uint64_t replacement_offset=0;
    if (same_bo) {
        struct prime export={.handle=old.handle,.fd=-1};
        CHECK(ioctl(fd,0xc00c642du,&export)==0 && export.fd>=0);
        replacement=export.fd;
    }
    CHECK(close(fd)==0);
    if (!same_bo) {
        replacement=open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC);CHECK(replacement>=0);
        struct dumb next={.width=256,.height=64,.bpp=32};CHECK(ioctl(replacement,0xc02064b2u,&next)==0);
        struct mapping next_map={.handle=next.handle};CHECK(ioctl(replacement,0xc01064b3u,&next_map)==0);
        replacement_offset=next_map.offset;
    }
    base[0]=41;base[page]=55;base[2*page]=61;
    unsigned char *next=mmap(base+page,same_bo?3*page:page,PROT_READ|PROT_WRITE,
        MAP_SHARED|MAP_FIXED,replacement,replacement_offset);
    CHECK(next==base+page && close(replacement)==0);
    if (same_bo) CHECK(next[0]==41 && next[page]==55 && next[2*page]==61);
    else CHECK(next[0]==0);
    int parent_gate[2],child_gate[2];CHECK(pipe(parent_gate)==0 && pipe(child_gate)==0);
    pid_t child=fork();CHECK(child>=0);
    if (child==0) {
        CHECK(close(parent_gate[1])==0 && close(child_gate[0])==0);
        ready(parent_gate[0]);
        if (same_bo) {
            CHECK(base[0]==71 && next[0]==71 && next[page]==81 && next[2*page]==61);
            CHECK(mirror[0]==71 && mirror[page]==81 && mirror[2*page]==61);
            next[1]=59;mirror[2*page+2]=93;base[3]=101;
        } else {
            CHECK(base[0]==71 && next[0]==91 && base[2*page]==81);
            CHECK(mirror[0]==71 && mirror[page]==55 && mirror[2*page]==81);
            next[1]=59;base[2*page+2]=93;base[3]=101;
        }
        CHECK(write(child_gate[1],"c",1)==1);
        CHECK(munmap(base,4*page)==0 && munmap(mirror,3*page)==0);
        CHECK(close(parent_gate[0])==0 && close(child_gate[1])==0);
        _exit(0);
    }
    CHECK(close(parent_gate[0])==0 && close(child_gate[1])==0);
    if (same_bo) {next[0]=71;next[page]=81;}
    else {base[0]=71;base[2*page]=81;next[0]=91;}
    CHECK(write(parent_gate[1],"p",1)==1);
    ready(child_gate[0]);CHECK(next[1]==59 && base[3]==101 && mirror[2*page+2]==93);
    if (!same_bo) CHECK(mirror[page]==55);
    int status=0;CHECK(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0);
    CHECK(munmap(base,4*page)==0 && munmap(mirror,3*page)==0);
    CHECK(close(parent_gate[1])==0 && close(child_gate[0])==0);
    puts(same_bo ? "OK fixed PRIME replacement preserves alias storage across fork" :
        "OK fixed device replacement preserves unrelated BO bytes across fork");
}

int main(void) {
    full_mapping();
    fragmented_mapping(1);
    fragmented_mapping(0);
    fragmented_mapping(2);
    fragmented_mapping(3);
    remapped_mapping();
    replaced_device_mapping(0);
    replaced_device_mapping(1);
    return 0;
}
