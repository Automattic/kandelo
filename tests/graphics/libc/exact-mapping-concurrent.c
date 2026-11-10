/* Receipt recovery may run on an unrelated FILE caller, outside the facade's
 * mapping lock. Race that publisher with cleanup's genuine EMPTY fast path. */
#define main exact_receiver_fixture_main
#include "exact-mapping-custody.c"
#undef main
#ifndef WPK_MAPPING_PHASE_BEFORE
_Static_assert(_Generic(&((struct wpk_drm_mapping *)0)->phase,
    _Atomic(enum wpk_drm_mapping_phase)*:1,default:0),"mapping phase must publish across FILE callers");
#endif
static _Atomic int start_workers;
static void await_workers(void){while(!atomic_load_explicit(&start_workers,memory_order_acquire))sched_yield();}
static void *recover_file(void *unused){(void)unused;await_workers();uint32_t revents;
    assert(!_wpk_drm_owned_poll(file,0,0,&revents));return NULL;}
static void *retire_mapping(void *unused){(void)unused;await_workers();
    assert(!_wpk_drm_owned_unmap_exact(&cell));return NULL;}
int main(void){
    page=sysconf(_SC_PAGESIZE);assert(!_wpk_drm_owned_open(1,&file));
    assert(!_wpk_drm_owned_acquire(10,0,&other));uint8_t request[32]={0};
    assert(!_wpk_drm_owned_ioctl(file,UINT32_C(0xc02064b2),request,32,NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo));
    for(unsigned i=0;i<100;i++){
        map_cell(&cell,file,0,page,0);
        graphics_peer_lose_action=WPK_DRM_OWNED_UNMAP_EXACT;graphics_peer_lose_reads=1;
        assert(_wpk_drm_owned_unmap_exact(&cell)==-1&&cell.phase==WPK_DRM_MAPPING_UNMAP_PENDING);
        atomic_store_explicit(&start_workers,0,memory_order_relaxed);
        pthread_t publisher,cleanup;
        assert(!pthread_create(&publisher,NULL,recover_file,NULL));
        assert(!pthread_create(&cleanup,NULL,retire_mapping,NULL));
        atomic_store_explicit(&start_workers,1,memory_order_release);
        assert(!pthread_join(publisher,NULL)&&!pthread_join(cleanup,NULL));
        assert(cell.phase==WPK_DRM_MAPPING_EMPTY);
    }
    clean();
    /* A genuinely EMPTY capsule must ignore retired source addresses. Make
     * their inaccessibility deterministic rather than relying on malloc reuse. */
    void *retired=mmap(NULL,page,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    assert(retired!=MAP_FAILED);cell.file=cell.bo=retired;
    assert(!_wpk_drm_owned_unmap_exact(&cell)&&!_wpk_drm_owned_unmap_exact(&replacement));
    assert(!munmap(retired,page));
    puts("PASS concurrent exact receipt recovery and EMPTY after source retirement");return 0;
}
