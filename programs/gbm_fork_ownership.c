/* The inherited C GBM object, not a reconstructed wrapper or private lease
 * API, must retain exact ordinary DRM storage in child and nested child. */
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>
static void check_bytes(struct gbm_bo *bo,uint32_t expected,uint32_t replacement){
    uint32_t stride;void *lease=NULL;
    uint32_t *pixels=gbm_bo_map(bo,0,0,16,16,GBM_BO_TRANSFER_READ_WRITE,&stride,&lease);
    assert(pixels&&stride>=64&&*pixels==expected);*pixels=replacement;gbm_bo_unmap(bo,lease);
}
static void wait_ok(pid_t pid){int status;assert(waitpid(pid,&status,0)==pid&&WIFEXITED(status)&&WEXITSTATUS(status)==0);}
int main(void){
    int card=open("/dev/dri/card0",O_RDWR|O_CLOEXEC);assert(card>=0);
    struct gbm_device *device=gbm_create_device(card);assert(device);
    struct gbm_bo *bo=gbm_bo_create(device,16,16,GBM_FORMAT_ARGB8888,GBM_BO_USE_WRITE|GBM_BO_USE_LINEAR);assert(bo);
    uint32_t stride;void *lease=NULL;
    uint32_t *pixels=gbm_bo_map(bo,0,0,16,16,GBM_BO_TRANSFER_READ_WRITE,&stride,&lease);assert(pixels&&stride>=64);
    *pixels=UINT32_C(0x11223344);gbm_bo_unmap(bo,lease);
    pid_t child=fork();assert(child>=0);
    if(!child){
        alarm(10);assert(close(card)==0);
        int prime=gbm_bo_get_fd(bo);assert(prime>=0&&close(prime)==0);
        check_bytes(bo,UINT32_C(0x11223344),UINT32_C(0x55667788));
        pid_t nested=fork();assert(nested>=0);
        if(!nested){
            check_bytes(bo,UINT32_C(0x55667788),UINT32_C(0xaabbccdd));
            gbm_bo_destroy(bo);gbm_device_destroy(device);_exit(0);
        }
        wait_ok(nested);check_bytes(bo,UINT32_C(0xaabbccdd),UINT32_C(0x99887766));
        gbm_bo_destroy(bo);gbm_device_destroy(device);_exit(0);
    }
    wait_ok(child);
    /* Child retirement must not remove the parent's public GEM name or
     * storage, even though every process inherited the same scalar handle. */
    int prime=gbm_bo_get_fd(bo);assert(prime>=0&&close(prime)==0);
    check_bytes(bo,UINT32_C(0x99887766),UINT32_C(0x12345678));
    gbm_bo_destroy(bo);gbm_device_destroy(device);assert(close(card)==0);
    puts("OK inherited GBM storage and custody");return 0;
}
