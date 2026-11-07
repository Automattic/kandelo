#ifndef WPK_WAYLAND_RETIREMENT_H
#define WPK_WAYLAND_RETIREMENT_H
#include "drm_owned.h"
#include <stdarg.h>
/* Private C continuations, never guest/kernel wire layout. Parent records
 * root these capsules before effects and hold an independent exclusive actor. */
enum wpk_wl_retire_result {
    WPK_WL_RETIRE_ERROR=-1,
    WPK_WL_RETIRE_PENDING=0,
    WPK_WL_RETIRE_COMPLETE=1,
    WPK_WL_RETIRE_BOUNDARY_TRANSFERRED=2
};
struct wpk_wl_log_message;
struct wpk_wl_log_scope {
    struct wpk_wl_log_message *messages,*tail;
    struct wpk_wl_log_scope *previous;
    struct wpk_drm_actor_claim capture_claim,origin_claim;
    int capturing;
};
typedef struct wpk_wl_log_scope *(*wpk_wl_log_resolver)(void);
int _wpk_wl_log_set_resolver(wpk_wl_log_resolver);
void _wpk_wl_logv(const char *,va_list);
int _wpk_wl_log_capture_begin(struct wpk_wl_log_scope *);
void _wpk_wl_log_capture_end_locked(struct wpk_wl_log_scope *);
void _wpk_wl_log_capture_end(struct wpk_wl_log_scope *);
int _wpk_wl_log_defer(struct wpk_wl_log_scope *);
int _wpk_wl_log_drain_deferred(void);
int _wpk_wl_log_deliver(struct wpk_wl_log_scope *);
/* live is one exact caller hold. retired owns any withdrawn continuation until
 * COMPLETE, or until the approved inherited owner explicitly accepts transfer.
 * No caller may infer completion from a raw void native release returning. */
struct wpk_wl_display_retirement { void *live,*retired; };
struct wpk_wl_surface_retirement { void *live,*retired; };
struct wpk_wlegl_retirement { void *live,*retired; };
struct wpk_wl_proxy_retirement {
    void *live;
    struct wpk_wl_log_scope logs;
};
struct wpk_wl_queue_retirement {
    void *live;
    struct wpk_wl_log_scope logs;
};
int _wpk_wl_surface_acquire_pending(const void *,const void **,uint64_t *,void **);
int _wpk_wl_display_boundary_required(void *);
int _wpk_wl_surface_boundary_required(void *);
int _wpk_wl_display_transfer_boundary(void *);
int _wpk_wl_surface_transfer_boundary(void *);
enum wpk_wl_retire_result _wpk_wl_display_release_pending(struct wpk_wl_display_retirement *);
enum wpk_wl_retire_result _wpk_wl_surface_release_pending(struct wpk_wl_surface_retirement *);
enum wpk_wl_retire_result _wpk_wlegl_release_pending(struct wpk_wlegl_retirement *);
enum wpk_wl_retire_result _wpk_wl_proxy_destroy_pending(struct wpk_wl_proxy_retirement *,uint32_t);
enum wpk_wl_retire_result _wpk_wl_proxy_destroy_local_pending(struct wpk_wl_proxy_retirement *);
enum wpk_wl_retire_result _wpk_wl_proxy_discard_pending(struct wpk_wl_proxy_retirement *);
enum wpk_wl_retire_result _wpk_wl_queue_discard_pending(struct wpk_wl_queue_retirement *);
enum wpk_wl_retire_result _wpk_wl_queue_destroy_pending(struct wpk_wl_queue_retirement *);
#endif
