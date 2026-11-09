/* Candidate EGL on frozen session R676 plus exact af260 common source, actual existing initialize and
 * device-peer fixture. No phase hooks, implementation substitutions or
 * synthetic generation graph. Actual metadata lock contention stops the
 * worker between ordinary effects. Only native kernel/renderer transport
 * and its host-width allocations use the existing disclosed device peer. */
#include "device-double.h"
#define _wpk_drm_owned_ioctl graphics_owned_ioctl_impl
#include "drm_owned.c"
#undef _wpk_drm_owned_ioctl
int _wpk_drm_owned_ioctl(struct wpk_drm_owner *,uint32_t,void *,uint32_t,struct wpk_drm_owner *,uint32_t,struct wpk_drm_owner **);
#include "libegl_stub.c"
#include "owned-resource-peer.h"
#include <assert.h>
#include <sys/wait.h>
void review_peer_snapshot(unsigned *,unsigned *,uint32_t *,uint64_t *);
void review_device_set_format_error(int);
uint64_t review_device_replace_fd100(void);
void review_device_check_replacement(uint64_t,int);
static EGLDisplay display;
static unsigned result;
static void *import_peer(void *unused){(void)unused;result=wpkEglImportDmabufHandle(display,100,UINT32_C(0x34324258));return NULL;}
static void wait_contended(struct wpk_drm_mutex *m){while((atomic_load_explicit(&m->state,memory_order_relaxed)&3)!=2)sched_yield();}
int main(int argc,char **argv){
 assert(argc==2);alarm(15);int stage=!strcmp(argv[1],"prime")?0:(!strcmp(argv[1],"bo")||!strcmp(argv[1],"replace"))?1:2;
 display=eglGetDisplay(EGL_DEFAULT_DISPLAY);assert(display&&eglInitialize(display,NULL,NULL));
 struct egl_generation *generation=active_generation(display);assert(generation&&!generation->constructing&&generation->sessions&&!generation->sessions->constructing);
 assert(!generation->imported_bos&&!generation->storage_owner->capture);
 unsigned baseline=graphics_peer_live_capabilities();assert(baseline);
 if(!strcmp(argv[1],"format-failure")||!strcmp(argv[1],"unknown")){
  int unknown=!strcmp(argv[1],"unknown");
  if(unknown){graphics_peer_lose_action=WPK_DRM_OWNED_IOCTL;graphics_peer_lose_reads=100;}
  else review_device_set_format_error(EINVAL);
  assert(!wpkEglImportDmabufHandle(display,100,UINT32_C(0x34324258)));
  assert(!generation->import.active&&!generation->import.record&&!generation->import.prime&&!generation->import.bo&&!generation->imported_bos);
  if(unknown){assert(atomic_load_explicit(&retired_owners,memory_order_relaxed));graphics_peer_lose_reads=0;}
  _wpk_drm_owned_drain();_wpk_drm_owned_drain();assert(graphics_peer_live_capabilities()==baseline);
  assert(eglTerminate(display)&&eglReleaseThread());_wpk_drm_owned_drain();assert(!graphics_peer_live_capabilities());puts("PASS format failure/unknown receipt retains exact rooted cleanup; repeated drain exact");return 0;
 }
 if(!strcmp(argv[1],"live-caller")||!strcmp(argv[1],"live-session")){
  int session_mode=!strcmp(argv[1],"live-session");
  struct egl_session *old_session=generation->sessions;
  /* Isolated same-ActorScope continuation classification, not an invented
   * DRM callback/fork hook. Populate the exact pending root before effects. */
  if(session_mode){assert(begin_bo_transfer(old_session));assert(!_wpk_drm_owned_acquire(100,0,&old_session->transfer.acquired));}
  else{assert(_wpk_drm_actor_prepare());
  _wpk_drm_owned_publication_begin();generation->import.active=1;generation->import.epoch=_wpk_drm_process_generation();
  generation->import.record=calloc(1,sizeof *generation->import.record);assert(generation->import.record);
  assert(_wpk_drm_actor_try_claim_locked(&generation->import.claim));_wpk_drm_owned_publication_end();
  assert(!_wpk_drm_owned_acquire(100,0,&generation->import.prime));}
  pid_t child=fork();assert(child>=0);
  if(!child){
   alarm(10);assert(eglInitialize(display,NULL,NULL));
   struct egl_generation *fresh=active_generation(display);assert(fresh&&fresh!=generation&&fresh->initialized);
   assert(generation->storage_owner&&generation->sessions==old_session&&old_session->owner);
   if(session_mode){
    assert(bo_transfer_live_caller(old_session));
    /* Direct ownership classification control: re-adopt the metadata mutex
     * generation before invoking the unchanged frozen session end helper. */
    _wpk_drm_mutex_lock(&old_session->transfer.mutex);finish_bo_transfer(old_session);
   }else{
    assert(generation->import.active&&generation->import.prime&&dmabuf_import_live(generation));assert(!retire_dmabuf_import(generation));
    _wpk_drm_owned_publication_begin();defer_dmabuf_import_locked(generation);_wpk_drm_owned_publication_end();
   }
   _wpk_drm_owned_drain();assert(cleanup_inherited_generations_locked());
   assert(eglTerminate(display)&&eglReleaseThread());_wpk_drm_owned_drain();assert(!graphics_peer_live_capabilities());
   puts("PASS live forkcaller retains OLD graph while fresh generation initializes independently");fflush(stdout);_exit(0);
  }
  int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
  if(session_mode)finish_bo_transfer(old_session);
  else{_wpk_drm_owned_publication_begin();defer_dmabuf_import_locked(generation);_wpk_drm_owned_publication_end();}_wpk_drm_owned_drain();
  assert(eglTerminate(display)&&eglReleaseThread());assert(!graphics_peer_live_capabilities());return 0;
 }
 if(stage==0)_wpk_drm_mutex_lock(&generation->storage_owner->mutex);else _wpk_drm_mutex_lock(&g_image_mutex);
 pthread_t worker;assert(!pthread_create(&worker,NULL,import_peer,NULL));
 wait_contended(stage==0?&generation->storage_owner->mutex:&g_image_mutex);
 if(stage==2){
  _wpk_drm_mutex_lock(&generation->storage_owner->mutex);
  _wpk_drm_mutex_unlock(&g_image_mutex);
  assert(!pthread_join(worker,NULL));
 }
 assert(!generation->storage_owner->capture&&!generation->storage_owner->pending);
 assert(graphics_peer_live_capabilities()==baseline+(stage==1?2:1));
 if(stage==0)assert(generation->import.active&&generation->import.prime&&!generation->import.bo&&generation->import.record);
 if(stage==1)assert(generation->import.active&&generation->import.prime&&generation->import.bo&&generation->import.record);
 if(stage<2)assert(!generation->imported_bos);
 else assert(generation->imported_bos&&generation->imported_bos->handle==77&&generation->imported_bos->owner->references==1);
 struct wpk_drm_owner *replacement_file=NULL,*replacement_bo=NULL;
 uint64_t replacement_identity=0;
 if(!strcmp(argv[1],"replace")){
  replacement_identity=review_device_replace_fd100();
  assert(!_wpk_drm_owned_open(WPK_DRM_OWNED_RENDER_NODE,&replacement_file));
  struct gl_init_info info={WPK_GL_OP_VERSION,WPK_GL_SESSION_OBJECTS,-1,generation->id};
  assert(!_wpk_drm_owned_ioctl(replacement_file,GLIO_INIT,&info,sizeof info,generation->display_owner,0,NULL));
  struct wpk_drm_owner *input=NULL;assert(!_wpk_drm_owned_acquire(100,0,&input));
  struct wpk_drm_prime_handle imported={.fd=-1};
  assert(!_wpk_drm_owned_ioctl(replacement_file,WPK_DRM_IOCTL_PRIME_FD_TO_HANDLE,&imported,sizeof imported,input,WPK_DRM_OWNED_CAPTURE_BO,&replacement_bo));
  assert(imported.handle==77);_wpk_drm_owned_retire(&input);
  review_device_check_replacement(replacement_identity,0);
 }
 pid_t child=fork();assert(child>=0);
 if(!child){
  alarm(10);
  /* Entire ordinary supported child lifecycle: revoke inherited renderer,
   * reconcile its known construction/session roots, initialize a fresh one,
   * close any published imported name, terminate and drain. No debug pointer
   * to the vanished worker's receiver is passed to cleanup. */
  assert(eglInitialize(display,NULL,NULL));
  wpkEglCloseBoHandle(display,77);
  assert(eglTerminate(display));assert(eglReleaseThread());_wpk_drm_owned_drain();
  unsigned survivors=graphics_peer_live_capabilities();
  assert(survivors==(replacement_identity?2:0));
  if(replacement_identity){
   struct wpk_drm_bo_info info;assert(!_wpk_drm_owned_bo_info(replacement_bo,&info));assert(info.size);
   review_device_check_replacement(replacement_identity,0);
   _wpk_drm_owned_retire(&replacement_bo);_wpk_drm_owned_retire(&replacement_file);
   review_device_check_replacement(replacement_identity,1);assert(!graphics_peer_live_capabilities());
  }
  unsigned file_survivors,bo_survivors;uint32_t handle;uint64_t storage;
  review_peer_snapshot(&file_survivors,&bo_survivors,&handle,&storage);
  assert(!file_survivors&&!bo_survivors);
  for(struct egl_generation *p=g_generations;p;p=p->next)assert(!p->imported_bos&&!p->storage_owner);
  assert(!atomic_load_explicit(&retired_owners,memory_order_relaxed));
  dprintf(1,"OBS candidate import receiver %s: initialized child, public close, terminate/release/drain leave0 capabilities FILE=%u BO=%u handle=%u storage=%llu; all published import/storage/retirement roots empty\n",argv[1],file_survivors,bo_survivors,handle,(unsigned long long)storage);
  _exit(0);
 }
 int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
 if(stage==1)_wpk_drm_mutex_unlock(&g_image_mutex);else _wpk_drm_mutex_unlock(&generation->storage_owner->mutex);
 if(stage!=2)assert(!pthread_join(worker,NULL));assert(result==77&&generation->imported_bos&&generation->imported_bos->owner->references==1);
 wpkEglCloseBoHandle(display,result);assert(eglTerminate(display));assert(eglReleaseThread());_wpk_drm_owned_drain();
 if(replacement_identity){
  struct wpk_drm_bo_info info;assert(!_wpk_drm_owned_bo_info(replacement_bo,&info));
  review_device_check_replacement(replacement_identity,0);
  _wpk_drm_owned_retire(&replacement_bo);_wpk_drm_owned_retire(&replacement_file);review_device_check_replacement(replacement_identity,1);
 }
 assert(!graphics_peer_live_capabilities());puts("PASS generation-rooted import custody; child and parent cleanup exact");return 0;
}
