#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); exit(1); } } while (0)
#define PAGE 65536
struct dumb { uint32_t height,width,bpp,flags,handle,pitch; uint64_t size; };
struct mapping { uint32_t handle,pad; uint64_t offset; };
struct prime { uint32_t handle,flags; int32_t fd; };
static struct mapping make_bo(int fd, struct dumb *bo) {
    *bo=(struct dumb){.width=256,.height=64,.bpp=32};
    CHECK(ioctl(fd,0xc02064b2u,bo)==0 && bo->size==PAGE);
    struct mapping map={.handle=bo->handle};
    CHECK(ioctl(fd,0xc01064b3u,&map)==0);
    return map;
}
static unsigned char *map_bo(int fd, uint64_t offset, void *at) {
    void *bytes=mmap(at,PAGE,PROT_READ|PROT_WRITE,MAP_SHARED|(at?MAP_FIXED:0),fd,offset);
    CHECK(bytes!=MAP_FAILED && (!at || bytes==at));
    return bytes;
}
int main(void) {
    int fd=open("/dev/dri/renderD128",O_RDWR|O_CLOEXEC); CHECK(fd>=0);
    int alias=dup(fd); CHECK(alias>=0);
    struct dumb a,b,next;
    struct mapping am=make_bo(alias,&a),bm=make_bo(alias,&b);
    unsigned char *first=map_bo(alias,am.offset,NULL),*second=map_bo(alias,bm.offset,NULL);
    first[0]=37;second[0]=73;
    CHECK(msync(first,PAGE,MS_SYNC)==0 && msync(second,PAGE,MS_SYNC)==0);
    struct prime exported={.handle=a.handle,.flags=O_RDWR,.fd=-1};
    CHECK(ioctl(alias,0xc00c642du,&exported)==0 && exported.fd>=0);

    /* The host control refuses only the second inherited alias. The real
     * libc/kernel path must retire its admitted child before reporting OOM. */
    errno=0;pid_t failed=fork();CHECK(failed==-1 && errno==ENOMEM);
    int status=0;errno=0;CHECK(waitpid(-1,&status,WNOHANG)==-1 && errno==ECHILD);
    struct stat st;CHECK(fstat(alias,&st)==0);
    CHECK(first[0]==37 && second[0]==73);
    CHECK(close(fd)==0);int replacement_fd=open("/dev/null",O_RDWR);CHECK(replacement_fd==fd);
    CHECK(write(replacement_fd,"x",1)==1);

    /* Keep an independent old BO alias, then reuse its former address for a
     * different BO. Cleanup of the failed child must not revoke either one. */
    unsigned char *old=map_bo(exported.fd,0,NULL);CHECK(old[0]==37);
    struct mapping nm=make_bo(alias,&next);
    CHECK(map_bo(alias,nm.offset,first)==first);
    first[0]=109;CHECK(msync(first,PAGE,MS_SYNC)==0);
    CHECK(old[0]==37 && second[0]==73);
    pid_t child=fork();CHECK(child>=0);
    if (child==0) {
        CHECK(first[0]==109 && second[0]==73 && old[0]==37);
        CHECK(fstat(alias,&st)==0 && write(replacement_fd,"y",1)==1);
        first[1]=117;second[1]=83;old[1]=43;
        _exit(0);
    }
    CHECK(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0);
    CHECK(first[0]==109 && first[1]==117 && second[0]==73 && second[1]==83 && old[0]==37 && old[1]==43);
    CHECK(write(replacement_fd,"z",1)==1);
    errno=0;CHECK(waitpid(-1,&status,WNOHANG)==-1 && errno==ECHILD);
    CHECK(munmap(first,PAGE)==0 && munmap(second,PAGE)==0 && munmap(old,PAGE)==0);
    CHECK(close(exported.fd)==0 && close(alias)==0 && close(replacement_fd)==0);
    puts("OK second inherited BO bind refusal retires exact child and preserves replacement resources");
    return 0;
}
