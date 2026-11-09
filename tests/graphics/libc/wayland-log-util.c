/* Same unmodified upstream utility TU + appended platform adapter as recipe. */
#define wl_log _wpk_upstream_wl_log
#include WPK_WAYLAND_UTIL_SOURCE
#undef wl_log
#include <assert.h>
unsigned wpk_log_allocations,wpk_log_deny;
static void *wpk_log_calloc(size_t n,size_t bytes){
    if(wpk_log_deny){errno=ENOMEM;return NULL;}
    void *p=calloc(n,bytes);if(p)wpk_log_allocations++;return p;
}
static void *wpk_log_malloc(size_t bytes){
    if(wpk_log_deny){errno=ENOMEM;return NULL;}
    void *p=malloc(bytes);if(p)wpk_log_allocations++;return p;
}
static void wpk_log_free(void *p){if(p){assert(wpk_log_allocations);wpk_log_allocations--;}free(p);}
#undef calloc
#define calloc wpk_log_calloc
#define malloc wpk_log_malloc
#define free wpk_log_free
#include "wayland-owned-log.inc"
