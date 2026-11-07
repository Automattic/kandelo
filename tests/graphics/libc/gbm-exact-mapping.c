/* Actual GBM destruction/unmap paths with native VM effects and the common
 * receipt peer. The old raw-munmap implementations fail these fork phases. */
#define main exact_mapping_receiver_fixture_main
#include "exact-mapping-custody.c"
#undef main
#if defined(__APPLE__)
#include <mach/mach.h>
#include <mach/mach_vm.h>
#endif
#include "libgbm_stub.c"
static struct gbm_bo *mapped_bo;
static struct gbm_device *mapped_device;
static struct wpk_gbm_window_retirement retirement;
static int surface_mode;
static int still_mapped(uint64_t address){
#if defined(__APPLE__)
    mach_vm_address_t start=address;mach_vm_size_t size=0;
    vm_region_basic_info_data_64_t info;mach_msg_type_number_t count=VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t object=MACH_PORT_NULL;
    kern_return_t rc=mach_vm_region(mach_task_self(),&start,&size,VM_REGION_BASIC_INFO_64,(vm_region_info_t)&info,&count,&object);
    if(object!=MACH_PORT_NULL)mach_port_deallocate(mach_task_self(),object);
    assert(rc==KERN_SUCCESS||rc==KERN_INVALID_ADDRESS);
    return rc==KERN_SUCCESS&&start<=address&&address<start+size;
#else
    unsigned char resident;errno=0;int rc=mincore((void *)(uintptr_t)address,page,&resident);
    assert(!rc||(rc==-1&&errno==ENOMEM));return !rc;
#endif
}
static void setup(void){
    page=sysconf(_SC_PAGESIZE);assert(!_wpk_drm_owned_open(1,&file));
    assert(!_wpk_drm_owned_acquire(10,0,&other));uint8_t request[32]={0};
    assert(!_wpk_drm_owned_ioctl(file,UINT32_C(0xc02064b2),request,32,NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo));
    mapped_device=calloc(1,sizeof *mapped_device);mapped_bo=calloc(1,sizeof *mapped_bo);assert(mapped_device&&mapped_bo);
    assert(!_wpk_drm_owned_retain(file)&&!_wpk_drm_owned_retain(bo));
    mapped_device->owner=file;mapped_device->references=2;mapped_device->fd=mapped_device->public_fd=-1;
    live_devices=mapped_device;mapped_bo->dev=mapped_device;mapped_bo->plane_count=1;mapped_bo->planes[0].owner=bo;
    live_bos=mapped_bo;map_cell(&mapped_bo->mapping,file,0,page,0);
    mapped_bo->map_addr=(void *)(uintptr_t)mapped_bo->mapping.address;mapped_bo->map_len=page;
    struct gbm_mapping *lease=calloc(1,sizeof *lease);assert(lease);lease->token=1;mapped_bo->mappings=lease;
    memset(mapped_bo->map_addr,0x2a,page);
    if(surface_mode){
        struct gbm_surface *surface=calloc(1,sizeof *surface);assert(surface);mapped_device->references++;
        surface->dev=mapped_device;surface->window_owned=1;surface->bos[0]=mapped_bo;live_surfaces=surface;
        mapped_bo->surface=surface;retirement.live=surface;gbm_device_destroy(mapped_device);
    }
}
static void *cleanup_phase(void *unused){(void)unused;
    if(surface_mode)_wpk_gbm_window_release_pending(&retirement);
    else gbm_bo_unmap(mapped_bo,(void *)(uintptr_t)1);return NULL;
}
int main(int argc,char **argv){
    assert(argc==2);surface_mode=!strcmp(argv[1],"lost-actor");setup();
    uint64_t address=mapped_bo->mapping.address;
    if(!strcmp(argv[1],"ordinary")){
        gbm_bo_unmap(mapped_bo,(void *)(uintptr_t)1);assert(!still_mapped(address));
    }else if(!strcmp(argv[1],"lost-reply")){
        graphics_peer_lose_action=WPK_DRM_OWNED_UNMAP_EXACT;graphics_peer_lose_reads=1;
        gbm_bo_unmap(mapped_bo,(void *)(uintptr_t)1);
        assert(mapped_bo->mappings&&mapped_bo->mapping.phase==WPK_DRM_MAPPING_UNMAP_PENDING);
        map_cell(&replacement,other,address,page,1);memset((void *)(uintptr_t)address,0x5a,page);
        gbm_bo_unmap(mapped_bo,(void *)(uintptr_t)1);assert(*(unsigned char *)(uintptr_t)address==0x5a);
    }else{
        assert(surface_mode||!strcmp(argv[1],"replacement"));phase_action=WPK_DRM_OWNED_UNMAP_EXACT;phase_after=!surface_mode;
        pthread_t worker;assert(!pthread_create(&worker,NULL,cleanup_phase,NULL));
        pthread_mutex_lock(&phase_lock);while(!phase_ready)pthread_cond_wait(&phase_changed,&phase_lock);pthread_mutex_unlock(&phase_lock);
        if(phase_after){assert(!still_mapped(address));map_cell(&replacement,other,address,page,1);memset((void *)(uintptr_t)address,0x5a,page);}
        pid_t child=fork();assert(child>=0);
        if(!child){alarm(5);phase_action=0;
            if(surface_mode){_wpk_gbm_window_release_pending(&retirement);assert(!still_mapped(address)&&!retirement.retired&&!live_bos);}
            else {gbm_bo_unmap(mapped_bo,(void *)(uintptr_t)1);assert(still_mapped(address)&&*(unsigned char *)(uintptr_t)address==0x5a);}
            _exit(0);
        }
        int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
        pthread_mutex_lock(&phase_lock);phase_continue=1;pthread_cond_broadcast(&phase_changed);pthread_mutex_unlock(&phase_lock);
        assert(!pthread_join(worker,NULL));
        if(surface_mode)assert(!still_mapped(address)&&!retirement.retired&&!live_bos);
        else assert(still_mapped(address)&&*(unsigned char *)(uintptr_t)address==0x5a);
    }
    if(!surface_mode){gbm_bo_destroy(mapped_bo);gbm_device_destroy(mapped_device);}
    assert(!live_bos&&!live_devices&&!live_surfaces&&!retired_bos);clean();
    puts("PASS actual GBM exact mapping custody");return 0;
}
