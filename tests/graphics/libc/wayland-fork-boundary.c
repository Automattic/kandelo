/* Actual common actor/boundary implementation and query include. Native graph
 * pointers are inaccessible storage; the epoch getter is an explicit libc
 * authority double. Actual child-rebind code has its separate source control. */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
static uint64_t fixture_epoch=1;
#include "drm_owned.c"
uint64_t __wasm_posix_native_fork_epoch(void){return fixture_epoch;}
struct wpk_wl_connection {
 void *display;uint64_t native_fork_epoch;unsigned boundary_reported,users;int alive;
 struct wpk_wl_boundary_hold boundary;
};
struct wpk_wl_surface {
 struct wpk_wl_connection *connection;void *proxy;struct wpk_wl_boundary_hold boundary;
};
static struct wpk_drm_mutex wpk_wl_mutex=WPK_DRM_MUTEX_INITIALIZER;
#include "wayland-fork-boundary.inc"
static struct wpk_drm_actor_claim main_claim,ended_claim;
static void *peer(void *unused){
 (void)unused;assert(_wpk_drm_actor_prepare());_wpk_drm_owned_publication_begin();
 assert(!_wpk_drm_actor_claim_current_locked(&main_claim));
 assert(_wpk_drm_actor_try_claim_locked(&ended_claim));
 assert(_wpk_drm_actor_claim_current_locked(&ended_claim));
 _wpk_drm_owned_publication_end();return NULL;
}
int main(void){
 alarm(10);assert(_wpk_drm_actor_prepare());_wpk_drm_owned_publication_begin();
 assert(!_wpk_drm_actor_claim_current_locked(NULL));assert(_wpk_drm_actor_try_claim_locked(&main_claim));
 assert(_wpk_drm_actor_claim_current_locked(&main_claim));_wpk_drm_owned_publication_end();
 pthread_t thread;assert(!pthread_create(&thread,NULL,peer,NULL));assert(!pthread_join(thread,NULL));
 _wpk_drm_owned_publication_begin();assert(!_wpk_drm_actor_claim_live_locked(&ended_claim));
 assert(!_wpk_drm_actor_claim_current_locked(&ended_claim));assert(_wpk_drm_actor_try_claim_locked(&ended_claim));
 assert(_wpk_drm_actor_claim_current_locked(&ended_claim));_wpk_drm_actor_release_locked(&ended_claim);_wpk_drm_owned_publication_end();
 void *graph=mmap(NULL,4096,PROT_NONE,MAP_PRIVATE|MAP_ANON,-1,0);assert(graph!=MAP_FAILED);
 struct wpk_wl_connection *record=calloc(1,sizeof *record);assert(record);
 *record=(struct wpk_wl_connection){.display=graph,.native_fork_epoch=fixture_epoch,.users=7,.alive=1};record->boundary.owner=record;
 struct wpk_wl_surface *hold=calloc(1,sizeof *hold);assert(hold);
 *hold=(struct wpk_wl_surface){.connection=record,.proxy=graph};hold->boundary.owner=hold;
 assert(!_wpk_wl_display_boundary_required(record)&&!_wpk_wl_surface_boundary_required(hold));
 int channel[2];assert(!pipe(channel));pid_t child=fork();assert(child>=0);
 if(!child){
  fixture_epoch++;assert(_wpk_wl_display_boundary_required(record)&&errno==ECHILD);
  assert(_wpk_wl_surface_boundary_required(hold)&&errno==ECHILD);
  assert(_wpk_wl_surface_transfer_boundary(hold)&&record->users==7&&!record->alive);
  assert(record->display==graph&&hold->proxy==graph&&hold->connection==record);
  assert(hold->boundary.transferred&&record->boundary.transferred);
  assert(wayland_boundary_roots==&hold->boundary&&hold->boundary.next==&record->boundary);
  assert(_wpk_wl_display_transfer_boundary(record));assert(wayland_boundary_roots==&hold->boundary);
  struct wpk_wl_connection fresh={.display=graph,.native_fork_epoch=fixture_epoch,.alive=1};
  assert(!_wpk_wl_display_boundary_required(&fresh)&&!_wpk_wl_display_transfer_boundary(&fresh));
  struct wpk_wl_surface sealed={.connection=(void*)(uintptr_t)1};
  assert(!_wpk_wl_surface_boundary_required(&sealed)&&!_wpk_wl_surface_transfer_boundary(&sealed));
  _wpk_drm_owned_publication_begin();assert(_wpk_drm_actor_claim_current_locked(&main_claim));_wpk_drm_owned_publication_end();
  assert(write(channel[1],"X",1)==1);_exit(0);
 }
 int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
 char value;assert(read(channel[0],&value,1)==1&&value=='X');
 assert(fixture_epoch==1&&record->alive&&record->users==7&&!record->boundary.transferred&&!hold->boundary.transferred&&!wayland_boundary_roots);
 assert(!_wpk_wl_surface_boundary_required(hold));close(channel[0]);close(channel[1]);
 free(hold);free(record);assert(!munmap(graph,4096));
 _wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&main_claim);_wpk_drm_owned_publication_end();
 puts("PASS metadata-only boundary: inaccessible graph, whole-owner idempotent transfer, fresh/single-thread admission, sealed shell, parent/FD isolation; exact live/current/ended actor routing");return 0;
}
