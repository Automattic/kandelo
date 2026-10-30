#include <gbm.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <sys/socket.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); exit(1); } } while (0)
static void check_peer(struct gbm_bo *bo, unsigned value) {
    uint32_t pitch; void *token = NULL;
    unsigned char *bytes = gbm_bo_map(bo, 0, 0, 4, 3, GBM_BO_TRANSFER_READ_WRITE, &pitch, &token);
    CHECK(bytes && token && pitch >= 16 && bytes[0] == value);
    bytes[1] = 93;
    gbm_bo_unmap(bo, token);
    int exported = gbm_bo_get_fd(bo); CHECK(exported >= 0 && !close(exported));
}
static int transferred_alias(int fd) {
    int pair[2]; CHECK(!socketpair(AF_UNIX, SOCK_STREAM, 0, pair));
    char byte = 'x'; struct iovec iov = {.iov_base=&byte, .iov_len=1};
    union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } control;
    memset(&control,0,sizeof control);
    struct msghdr msg = {.msg_iov=&iov, .msg_iovlen=1,
        .msg_control=control.bytes, .msg_controllen=sizeof control};
    struct cmsghdr *header = CMSG_FIRSTHDR(&msg);
    header->cmsg_level=SOL_SOCKET; header->cmsg_type=SCM_RIGHTS; header->cmsg_len=CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header),&fd,sizeof fd);
    CHECK(sendmsg(pair[0],&msg,0)==1);
    memset(&control,0,sizeof control); msg.msg_controllen=sizeof control;
    CHECK(recvmsg(pair[1],&msg,0)==1 && !(msg.msg_flags&MSG_CTRUNC));
    header=CMSG_FIRSTHDR(&msg);
    CHECK(header && header->cmsg_level==SOL_SOCKET && header->cmsg_type==SCM_RIGHTS
        && header->cmsg_len==CMSG_LEN(sizeof(int)));
    int received=-1; memcpy(&received,CMSG_DATA(header),sizeof received);
    CHECK(received>=0 && !close(pair[0]) && !close(pair[1]));
    return received;
}
static void aliases(int reverse, int transferred) {
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC); CHECK(fd >= 0);
    int duplicate = transferred ? transferred_alias(fd) : dup(fd); CHECK(duplicate >= 0);
    int other = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC); CHECK(other >= 0);
    CHECK(fcntl(fd, F_DUPFD_QUERY, (unsigned long)duplicate) == 1);
    CHECK(fcntl(duplicate, F_DUPFD_QUERY, (unsigned long)fd) == 1);
    CHECK(fcntl(fd, F_DUPFD_QUERY, (unsigned long)other) == 0);
    CHECK(fcntl(fd, F_DUPFD_QUERY, (unsigned long)-1) == -1 && errno == EBADF);
    struct gbm_device *a = gbm_create_device(fd); CHECK(a);
    struct gbm_bo *original = gbm_bo_create(a, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE); CHECK(original);
    gbm_device_destroy(a); /* The file owner outlives its public wrapper. */
    struct gbm_device *b = gbm_create_device(duplicate); CHECK(b && a != b);
    unsigned char pixels[48] = {71}; CHECK(!gbm_bo_write(original, pixels, sizeof pixels));
    int prime = gbm_bo_get_fd(original); CHECK(prime >= 0);
    struct gbm_import_fd_data data = {.fd=prime, .width=4, .height=3,
        .stride=gbm_bo_get_stride(original), .format=GBM_FORMAT_ABGR8888};
    struct gbm_bo *peer = gbm_bo_import(b, GBM_BO_IMPORT_FD, &data, GBM_BO_USE_WRITE); CHECK(peer);
    CHECK(gbm_bo_get_handle(peer).u32 == gbm_bo_get_handle(original).u32);
    CHECK(!close(prime));
    gbm_device_destroy(b);
    CHECK(!close(fd) && !close(duplicate));
    int reused = open("/dev/null", O_RDWR); CHECK(reused == fd);
    gbm_bo_destroy(reverse ? peer : original);
    check_peer(reverse ? original : peer, 71);
    gbm_bo_destroy(reverse ? original : peer);
    CHECK(!close(reused) && !close(other));
}
static void independent_files(void) {
    int first = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    int second = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC); CHECK(first >= 0 && second >= 0);
    struct gbm_device *a = gbm_create_device(first), *b = gbm_create_device(second); CHECK(a && b);
    struct gbm_bo *x = gbm_bo_create(a,4,3,GBM_FORMAT_ABGR8888,GBM_BO_USE_WRITE);
    struct gbm_bo *y = gbm_bo_create(b,4,3,GBM_FORMAT_ABGR8888,GBM_BO_USE_WRITE); CHECK(x && y);
    CHECK(gbm_bo_get_handle(x).u32 == gbm_bo_get_handle(y).u32);
    unsigned char pixels[48] = {37}; CHECK(!gbm_bo_write(y,pixels,sizeof pixels));
    gbm_device_destroy(a); gbm_device_destroy(b); CHECK(!close(first) && !close(second));
    gbm_bo_destroy(x); check_peer(y,37); gbm_bo_destroy(y);
}
int main(void) {
    for (int transfer=0; transfer<2; ++transfer) { aliases(0,transfer); aliases(1,transfer); }
    independent_files();
    puts("OK GBM file aliases retain shared GEM names and independent files stay separate");
    return 0;
}
