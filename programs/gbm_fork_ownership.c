/* The inherited C GBM object, not a reconstructed wrapper or private lease
 * API, must retain exact ordinary DRM storage in child and nested child. */
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
static void check_bytes(struct gbm_bo *bo,uint32_t expected,uint32_t replacement){
    uint32_t stride;void *lease=NULL;
    uint32_t *pixels=gbm_bo_map(bo,0,0,16,16,GBM_BO_TRANSFER_READ_WRITE,&stride,&lease);
    assert(pixels&&stride>=64&&*pixels==expected);*pixels=replacement;gbm_bo_unmap(bo,lease);
}
static void wait_ok(pid_t pid){int status;assert(waitpid(pid,&status,0)==pid&&WIFEXITED(status)&&WEXITSTATUS(status)==0);}
static int mapped_at(uintptr_t address) {
    FILE *maps=fopen("/proc/self/maps","r");assert(maps);
    char line[512];int found=0;
    while(fgets(line,sizeof line,maps)){
        unsigned long long begin,end;
        assert(sscanf(line,"%llx-%llx",&begin,&end)==2);
        if(address>=begin&&address<end)found=1;
    }
    assert(!ferror(maps)&&!fclose(maps));return found;
}
static void verify_replacement(uint32_t *pixels,size_t extent,size_t page,unsigned index) {
    /* Wasm linear-memory bytes remain readable even after guest munmap.
     * Kernel VMA metadata must independently prove the replacement survived
     * and the old mapping's remaining fragments actually retired. */
    uintptr_t base=(uintptr_t)pixels;
    assert(mapped_at(base+index*page));
    assert(!mapped_at(base+(index?0:1)*page));
    assert(!mapped_at(base+extent-page));
    assert(*(uint32_t *)(base+index*page)==UINT32_C(0x52b17ace));
}
static int mapping_replacement(unsigned mode) {
    size_t page=(size_t)sysconf(_SC_PAGESIZE);assert(page);
    const uint32_t height=4096;
    int card=open("/dev/dri/card0",O_RDWR|O_CLOEXEC);assert(card>=0);
    struct gbm_device *device=gbm_create_device(card);assert(device);
    struct gbm_bo *bo=gbm_bo_create(device,16,height,GBM_FORMAT_ARGB8888,
        GBM_BO_USE_WRITE|GBM_BO_USE_LINEAR);assert(bo);
    uint32_t stride;void *lease=NULL;
    uint32_t *pixels=gbm_bo_map(bo,0,0,16,height,GBM_BO_TRANSFER_READ_WRITE,&stride,&lease);
    assert(pixels&&stride>=64&&(uintptr_t)pixels%page==0);
    size_t extent=((size_t)stride*height+page-1)/page*page;assert(extent>=2*page);
    assert(mapped_at((uintptr_t)pixels+page));
    if(!mode)assert(!munmap(pixels,extent));
    unsigned index=mode>=2?1:0;
    void *address=(uint8_t *)pixels+index*page;
    if(mode==3){
        /* The same BO at the same address is still a different mapping.
         * BO identity or address comparison alone must not retire it. */
        struct drm_mode_map_dumb map={.handle=gbm_bo_get_handle(bo).u32};
        assert(!ioctl(card,DRM_IOCTL_MODE_MAP_DUMB,&map));
        assert(mmap(address,page,PROT_READ|PROT_WRITE,
            MAP_SHARED|MAP_FIXED,card,(off_t)map.offset)==address);
    }else assert(mmap(address,page,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED,-1,0)==address);
    *(uint32_t *)address=UINT32_C(0x52b17ace);
    pid_t child=fork();assert(child>=0);
    if(!child){
        alarm(10);assert(!close(card));
        int replacement=open("/dev/null",O_WRONLY|O_CLOEXEC);assert(replacement==card);
        gbm_bo_unmap(bo,lease);gbm_bo_destroy(bo);gbm_device_destroy(device);
        verify_replacement(pixels,extent,page,index);
        assert(write(replacement,"x",1)==1&&!close(replacement));
        assert(!munmap(address,page));_exit(0);
    }
    wait_ok(child);
    /* Child cleanup must not consume the parent's copied mapping capability.
     * Its original fragments still exist until this process retires them. */
    assert(mapped_at((uintptr_t)pixels+(index?0:1)*page)==(mode!=0));
    gbm_bo_unmap(bo,lease);gbm_bo_destroy(bo);gbm_device_destroy(device);
    verify_replacement(pixels,extent,page,index);assert(!munmap(address,page)&&!close(card));
    puts("OK exact GBM mapping replacement custody");return 0;
}
int main(int argc,char **argv){
    if(argc==2&&!strcmp(argv[1],"mapping-replacement"))return mapping_replacement(0);
    if(argc==2&&!strcmp(argv[1],"mapping-partial"))return mapping_replacement(1);
    if(argc==2&&!strcmp(argv[1],"mapping-middle"))return mapping_replacement(2);
    if(argc==2&&!strcmp(argv[1],"mapping-same-bo"))return mapping_replacement(3);
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
