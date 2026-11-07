#ifndef WPK_WL_CLIENT_PROVENANCE_INC
#define WPK_WL_CLIENT_PROVENANCE_INC
/* Client-TU-only allocator admission, before unmodified upstream source.
 * This is not a server allocator or a generic C pointer validity promise. */
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include "drm_owned.h"
struct wpk_wl_native_range {
    struct wpk_wl_native_range *left,*right;
    uintptr_t base;
    size_t bytes;
    uint64_t epoch;
    unsigned height;
    max_align_t alignment;
};
static struct wpk_wl_native_range *wpk_wl_native_ranges;
static _Thread_local unsigned wpk_wl_native_publication_held;
static unsigned wpk_wl_range_height(struct wpk_wl_native_range *p){return p?p->height:0;}
static void wpk_wl_range_height_update(struct wpk_wl_native_range *p){
    unsigned a=wpk_wl_range_height(p->left),b=wpk_wl_range_height(p->right);p->height=1+(a>b?a:b);
}
static struct wpk_wl_native_range *wpk_wl_range_rotate_left(struct wpk_wl_native_range *p){
    struct wpk_wl_native_range *q=p->right;p->right=q->left;q->left=p;
    wpk_wl_range_height_update(p);wpk_wl_range_height_update(q);return q;
}
static struct wpk_wl_native_range *wpk_wl_range_rotate_right(struct wpk_wl_native_range *p){
    struct wpk_wl_native_range *q=p->left;p->left=q->right;q->right=p;
    wpk_wl_range_height_update(p);wpk_wl_range_height_update(q);return q;
}
static struct wpk_wl_native_range *wpk_wl_range_balance(struct wpk_wl_native_range *p){
    if(!p)return NULL;wpk_wl_range_height_update(p);
    int balance=(int)wpk_wl_range_height(p->left)-(int)wpk_wl_range_height(p->right);
    if(balance>1){
        if(wpk_wl_range_height(p->left->right)>wpk_wl_range_height(p->left->left))p->left=wpk_wl_range_rotate_left(p->left);
        return wpk_wl_range_rotate_right(p);
    }
    if(balance< -1){
        if(wpk_wl_range_height(p->right->left)>wpk_wl_range_height(p->right->right))p->right=wpk_wl_range_rotate_right(p->right);
        return wpk_wl_range_rotate_left(p);
    }
    return p;
}
static struct wpk_wl_native_range *wpk_wl_range_insert(struct wpk_wl_native_range *root,struct wpk_wl_native_range *p){
    if(!root)return p;
    if(p->base<root->base)root->left=wpk_wl_range_insert(root->left,p);
    else if(p->base>root->base)root->right=wpk_wl_range_insert(root->right,p);
    else abort();
    return wpk_wl_range_balance(root);
}
static struct wpk_wl_native_range *wpk_wl_range_take_min(struct wpk_wl_native_range *root,struct wpk_wl_native_range **result){
    if(!root->left){*result=root;return root->right;}
    root->left=wpk_wl_range_take_min(root->left,result);return wpk_wl_range_balance(root);
}
static struct wpk_wl_native_range *wpk_wl_range_remove(struct wpk_wl_native_range *root,uintptr_t base){
    if(!root)abort();
    if(base<root->base)root->left=wpk_wl_range_remove(root->left,base);
    else if(base>root->base)root->right=wpk_wl_range_remove(root->right,base);
    else{
        if(!root->right)return root->left;
        struct wpk_wl_native_range *replacement=NULL;
        struct wpk_wl_native_range *right=wpk_wl_range_take_min(root->right,&replacement);
        replacement->left=root->left;replacement->right=right;return wpk_wl_range_balance(replacement);
    }
    return wpk_wl_range_balance(root);
}
static struct wpk_wl_native_range *wpk_wl_range_find(uintptr_t value){
    struct wpk_wl_native_range *p=wpk_wl_native_ranges;
    while(p){
        if(value<p->base)p=p->left;
        else if(value-p->base>=p->bytes)p=p->right;
        else return p;
    }
    return NULL;
}
static void wpk_wl_native_publication_begin(void){
    if(!wpk_wl_native_publication_held)_wpk_drm_owned_publication_begin();
}
static void wpk_wl_native_publication_end(void){
    if(!wpk_wl_native_publication_held)_wpk_drm_owned_publication_end();
}
static void *wpk_wl_native_allocate(size_t bytes,int zero){
    uint64_t epoch=_wpk_drm_native_fork_epoch();
    /* WHY: before the first multithreaded fork no native graph is restricted.
     * Keep ordinary parent allocations untouched. Thereafter unknown ranges
     * default to rejected, so only fresh allocations need provenance metadata. */
    if(!epoch)return zero?calloc(1,bytes):malloc(bytes);
    size_t capacity=bytes?bytes:1;
    if(capacity>SIZE_MAX-sizeof(struct wpk_wl_native_range)){errno=ENOMEM;return NULL;}
    wpk_wl_native_publication_begin();
    struct wpk_wl_native_range *p=zero?calloc(1,sizeof *p+capacity):malloc(sizeof *p+capacity);
    if(p){
        p->left=p->right=NULL;p->base=(uintptr_t)(p+1);p->bytes=capacity;p->epoch=epoch;p->height=1;
        wpk_wl_native_ranges=wpk_wl_range_insert(wpk_wl_native_ranges,p);
    }
    wpk_wl_native_publication_end();return p?(void *)(p+1):NULL;
}
static void *wpk_wl_native_malloc(size_t bytes){return wpk_wl_native_allocate(bytes,0);}
static void *wpk_wl_native_calloc(size_t count,size_t bytes){
    if(bytes&&count>SIZE_MAX/bytes){errno=ENOMEM;return NULL;}
    return wpk_wl_native_allocate(count*bytes,1);
}
static void *wpk_wl_native_zalloc(size_t bytes){return wpk_wl_native_calloc(1,bytes);}
static void wpk_wl_native_free(void *pointer){
    if(!pointer)return;
    if(!_wpk_drm_native_fork_epoch()){free(pointer);return;}
    wpk_wl_native_publication_begin();
    struct wpk_wl_native_range *p=wpk_wl_range_find((uintptr_t)pointer);
    if(p&&p->base==(uintptr_t)pointer){
        wpk_wl_native_ranges=wpk_wl_range_remove(wpk_wl_native_ranges,p->base);free(p);
    }else free(pointer); /* non-object strings may come from libc strdup */
    wpk_wl_native_publication_end();
}
static int wpk_wl_native_pointer_admitted(const void *pointer){
    uint64_t epoch=_wpk_drm_native_fork_epoch();if(!epoch)return 1;
    /* WHY: look up only the scalar address before touching any native object.
     * Balanced interval lookup also admits the display's embedded proxy/queues
     * without scanning a forbidden inherited graph or all allocations. */
    wpk_wl_native_publication_begin();
    struct wpk_wl_native_range *p=wpk_wl_range_find((uintptr_t)pointer);
    int admitted=p&&p->epoch==epoch;
    wpk_wl_native_publication_end();
    if(!admitted)errno=ECHILD;return admitted;
}

#define WPK_WL_NATIVE_METADATA_BEGIN() (++wpk_wl_native_publication_held)
#define WPK_WL_NATIVE_METADATA_END() (--wpk_wl_native_publication_held)

#endif
