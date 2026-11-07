/* Actual EGL unlock/drain code with protocol-leaf doubles. The probe reenters
 * the real context lock, so calling a backend under that lock deadlocks and
 * fails the process deadline rather than relying on a source-text assertion. */
#include "drm-owned-double.h"
#include "drm_owned.c"
#define main transport_fixture_main
#include "drm-owned-transport.c"
#undef main
#define calloc owned_calloc
#define free owned_free
#include "libegl_stub.c"
#undef calloc
#undef free
void _wpk_gl_destroy_encoder(struct wpk_gles_context *p){(void)p;abort();}
void _wpk_gl_end_name_scope(struct wpk_gl_name_scope *p){(void)p;abort();}
void _wpk_gl_flush(void){abort();}
struct wpk_gl_name_scope _wpk_gl_lock_encoder_retirement(struct wpk_gles_context *p){(void)p;abort();}
int _wpk_gl_prepare_encoder_retirement(struct wpk_gles_context *p,int i){(void)p;(void)i;abort();}
int _wpk_gl_prepare_encoder_retirement_with_peer(struct wpk_gles_context *p,struct wpk_gles_context *q){(void)p;(void)q;abort();}
void _wpk_gl_retire_encoder_programs(struct wpk_gles_context *p){(void)p;abort();}
/* These native leaves must never run: this fixture queues diagnostics only. */
void _wpk_gbm_window_release_pending(struct wpk_gbm_window_retirement *p){(void)p;abort();}
void _wpk_wl_display_release(void *p){(void)p;abort();}
void _wpk_wl_display_release_inherited(void *p){(void)p;abort();}
void _wpk_wlegl_release(void *p){(void)p;abort();}
void _wpk_wlegl_release_inherited(void *p){(void)p;abort();}
static int mode,window_calls,log_calls;
int _wpk_wlegl_drain_deferred(void){
 ++window_calls;
 /* READY work was consumed before callbacks, so the nested ordinary unlock
  * has no reason to recurse. It must be able to acquire the actual mutex. */
 lock_context();unlock_context();
 if((mode==1||mode==4)&&window_calls==1)return 1; /* live foreign origin */
 return 0; /* complete or blocked: no every-frame scans */
}
int _wpk_wl_log_drain_deferred(void){
 ++log_calls;
 if(mode==2&&log_calls==1)_wpk_egl_request_native_drain();
 if(mode==3||mode==4)pthread_exit((void*)41);
 return 0;
}
static void *exit_on_log(void *unused){
 (void)unused;lock_context();_wpk_egl_request_native_drain();unlock_context();abort();
}
int main(int argc,char **argv){
 assert(argc==2);alarm(10);
 mode=atoi(argv[1]);
 for(int n=0;n<40;n++){lock_context();unlock_context();}
 assert(!window_calls&&!log_calls&&!actor_current_scope);
 if(mode==3||mode==4){
  pthread_t thread;assert(!pthread_create(&thread,NULL,exit_on_log,NULL));
  void *result=NULL;assert(!pthread_join(thread,&result)&&result==(void*)41);
  assert(window_calls==1&&log_calls==1);
  assert(!!atomic_load_explicit(&g_release_work,memory_order_relaxed)==(mode==4));mode=0;
  lock_context();unlock_context(); /* ended callback cannot strand EGL */
 }else{
  lock_context();_wpk_egl_request_native_drain();assert(!window_calls&&!log_calls);unlock_context();
  assert(window_calls==1&&log_calls==1);
  if(mode==1||mode==2){
   assert(atomic_load_explicit(&g_release_work,memory_order_relaxed));
   lock_context();unlock_context();assert(window_calls==2&&log_calls==2);
  }
 }
 assert(!atomic_load_explicit(&g_release_work,memory_order_relaxed));
 int prior=window_calls;
 for(int n=0;n<40;n++){lock_context();unlock_context();}
 assert(window_calls==prior&&log_calls==prior);
 printf("PASS actual EGL post-unlock native bridge mode%d\n",atoi(argv[1]));return 0;
}
