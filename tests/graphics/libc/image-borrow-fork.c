/* Exercise the actual EGL image ownership helpers and shared metadata mutex
 * with native pthread/fork. Synthetic images deliberately have no kernel BO
 * capability: these assertions prove C custody, not target kernel cleanup or
 * browser parity. Renderer/Wayland stubs abort if accidentally reached. */
#include <stdlib.h>
#include <stdio.h>
#include <assert.h>
#include <pthread.h>
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>
static void *tracked_image;
static unsigned image_frees;
static int fail_allocation;
static void tracked_free(void *p) { if(p && p==tracked_image) image_frees++; free(p); }
static void *tracked_calloc(size_t n,size_t s) {if(fail_allocation){errno=ENOMEM;return NULL;}return calloc(n,s);}
#define free tracked_free
#define calloc tracked_calloc
#include "libegl_stub.c"
#undef free
#undef calloc
/* Renderer/Wayland paths are outside this image-helper control; entering any
 * would invalidate the bounded claim instead of silently simulating it. */
void _wpk_gbm_window_release(void *p){(void)p;abort();}
void _wpk_wl_display_release(void *p){(void)p;abort();}
void _wpk_wl_display_release_inherited(void *p){(void)p;abort();}
void _wpk_wlegl_release(void *p){(void)p;abort();}
void _wpk_wlegl_release_inherited(void *p){(void)p;abort();}
void _wpk_gl_destroy_encoder(struct wpk_gles_context *p){(void)p;abort();}
void _wpk_gl_end_name_scope(struct wpk_gl_name_scope *p){(void)p;abort();}
void _wpk_gl_flush(void){abort();}
struct wpk_gl_name_scope _wpk_gl_lock_encoder_retirement(struct wpk_gles_context *p){(void)p;abort();}
int _wpk_gl_prepare_encoder_retirement(struct wpk_gles_context *p,int i){(void)p;(void)i;abort();}
int _wpk_gl_prepare_encoder_retirement_with_peer(struct wpk_gles_context *p,struct wpk_gles_context *q){(void)p;(void)q;abort();}
void _wpk_gl_retire_encoder_programs(struct wpk_gles_context *p){(void)p;abort();}
static struct egl_generation generation;
static _Thread_local struct egl_thread_binding binding;
static pthread_mutex_t gate=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed=PTHREAD_COND_INITIALIZER;
static int ready,proceed,exit_mode;
#ifdef WPK_BORROW_NEW
static struct wpk_egl_image_borrow *caller;
#else
static struct wpk_egl_image *caller;
#endif
static void bind_thread(void){binding.generation=&generation;binding.process_epoch=_wpk_drm_process_generation();g_destructor_binding=&binding;}
static struct wpk_egl_image *make_image(void){
 struct wpk_egl_image *p=calloc(1,sizeof *p);assert(p);p->public_live=1;p->public_handle=123;p->generation=&generation;
#ifndef WPK_BORROW_NEW
 p->references=1;
#endif
 p->next=g_images;g_images=p;tracked_image=p;return p;
}
static void public_destroy(struct wpk_egl_image *image){
#ifdef WPK_BORROW_NEW
 lock_images();
#else
 _wpk_drm_mutex_lock(&g_image_mutex);
#endif
 image->public_live=0;image_release_locked(image);_wpk_drm_mutex_unlock(&g_image_mutex);
}
static void *peer(void *unused){(void)unused;bind_thread();
#ifdef WPK_BORROW_NEW
 struct wpk_egl_image_borrow *borrow=NULL;assert(_wpk_egl_image_borrow_lookup((void *)123,&borrow));
#else
 struct wpk_egl_image *borrow=_wpk_egl_image_lookup((void *)123);assert(borrow);
#endif
 pthread_mutex_lock(&gate);ready=1;pthread_cond_signal(&changed);while(!proceed)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);
 if(exit_mode)return NULL;
#ifdef WPK_BORROW_NEW
 _wpk_egl_image_borrow_release(&borrow);assert(!borrow);
#else
 _wpk_egl_image_release(borrow);
#endif
 return NULL;
}
int main(int argc,char **argv){assert(argc==2);bind_thread();struct wpk_egl_image *image=make_image();
 if(!strcmp(argv[1],"exit")||!strcmp(argv[1],"cancel")) {exit_mode=1;pthread_t thread;assert(!pthread_create(&thread,NULL,peer,NULL));pthread_mutex_lock(&gate);while(!ready)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);public_destroy(image);assert(!image_frees);if(!strcmp(argv[1],"cancel"))assert(!pthread_cancel(thread));else{pthread_mutex_lock(&gate);proceed=1;pthread_cond_signal(&changed);pthread_mutex_unlock(&gate);}assert(!pthread_join(thread,NULL));assert(image_frees==1);puts("PASS thread exit/cancel retires scoped admission");return 0;}
#ifdef WPK_BORROW_NEW
 if(!strcmp(argv[1],"saturation")){atomic_store(&g_next_image_scope,UINTPTR_MAX);struct wpk_egl_image_borrow *borrow=(void *)1;assert(!_wpk_egl_image_borrow_lookup((void *)123,&borrow));assert(!borrow&&errno==EOVERFLOW&&!image->borrows);public_destroy(image);assert(image_frees==1);puts("PASS scope saturation refuses before publication");return 0;}
 if(!strcmp(argv[1],"oom")){struct wpk_egl_image_borrow *borrow=(void *)1;fail_allocation=1;assert(!_wpk_egl_image_borrow_lookup((void *)123,&borrow));assert(!borrow&&errno==ENOMEM&&!image->borrows);fail_allocation=0;assert(_wpk_egl_image_borrow_lookup((void *)123,&borrow));_wpk_egl_image_borrow_release(&borrow);fail_allocation=1;assert(!_wpk_egl_image_borrow_lookup((void *)123,&borrow));assert(!borrow&&errno==ENOMEM&&!image->borrows);fail_allocation=0;public_destroy(image);assert(image_frees==1);puts("PASS borrow-node OOM publishes no borrow");return 0;}
 assert(_wpk_egl_image_borrow_lookup((void *)123,&caller));
#else
 caller=_wpk_egl_image_lookup((void *)123);assert(caller);
#endif
 int storage=!strcmp(argv[1],"storage");if(storage)_wpk_egl_image_retain(image);
#ifdef WPK_BORROW_NEW
 assert(_wpk_egl_image_retain_renderer(image));assert(_wpk_egl_image_retain_renderer(image));
#else
 _wpk_egl_image_retain(image);_wpk_egl_image_retain(image);
#endif
 pthread_t thread;assert(!pthread_create(&thread,NULL,peer,NULL));pthread_mutex_lock(&gate);while(!ready)pthread_cond_wait(&changed,&gate);pthread_mutex_unlock(&gate);
 pid_t pid=fork();assert(pid>=0);if(!pid){alarm(5);
#ifdef WPK_BORROW_NEW
 lock_images();_wpk_drm_mutex_unlock(&g_image_mutex);assert(image->renderer_references==0);assert(image->borrows==caller&&caller->next==NULL);
#endif
 if(!strcmp(argv[1],"nested")){pid_t nested=fork();assert(nested>=0);if(!nested){
#ifdef WPK_BORROW_NEW
 lock_images();_wpk_drm_mutex_unlock(&g_image_mutex);assert(image->borrows==caller&&caller->next==NULL);
#endif
 _exit(0);}int nested_status;assert(waitpid(nested,&nested_status,0)==nested);assert(WIFEXITED(nested_status)&&!WEXITSTATUS(nested_status));}
 public_destroy(image);assert(!image_frees);
#ifdef WPK_BORROW_NEW
 _wpk_egl_image_borrow_release(&caller);assert(!caller);
#else
 _wpk_egl_image_release(caller);
#endif
 if(storage){assert(!image_frees);_wpk_egl_image_release(image);}assert(image_frees==1);assert(!g_images);_exit(0);}
 int status;assert(waitpid(pid,&status,0)==pid);assert(WIFEXITED(status)&&WEXITSTATUS(status)==0);
 assert(!image_frees&&image->public_live);
#ifdef WPK_BORROW_NEW
 assert(image->renderer_references==2);_wpk_egl_image_borrow_release(&caller);_wpk_egl_image_release_renderer(image);_wpk_egl_image_release_renderer(image);
#else
 _wpk_egl_image_release(caller);_wpk_egl_image_release(image);_wpk_egl_image_release(image);
#endif
 if(storage)_wpk_egl_image_release(image);
 public_destroy(image);assert(!image_frees);pthread_mutex_lock(&gate);proceed=1;pthread_cond_signal(&changed);pthread_mutex_unlock(&gate);assert(!pthread_join(thread,NULL));assert(image_frees==1);puts("PASS vanished peer vs surviving caller/public/storage/renderer custody");return 0;
}
