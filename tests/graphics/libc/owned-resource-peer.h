#ifndef GRAPHICS_OWNED_RESOURCE_PEER_H
#define GRAPHICS_OWNED_RESOURCE_PEER_H
#include "drm_owned.h"
#include <stdint.h>
/* Native fixture identities are deliberately opaque. A descriptor resolves
 * once at acquire; all later effects receive the retained resource, including
 * when the descriptor has been closed and reused for another resource. */
struct graphics_peer_file;
struct graphics_peer_binding {uint32_t offset,handle;uint64_t storage;};
struct graphics_peer_ops {
    struct graphics_peer_file *(*open)(uint32_t node);
    struct graphics_peer_file *(*acquire)(int fd,uint32_t flags);
    void (*retain)(struct graphics_peer_file *);
    int (*release)(struct graphics_peer_file *);
    int (*duplicate)(struct graphics_peer_file *,int previous,int borrowed);
    int (*alias_matches)(struct graphics_peer_file *,int fd);
    int (*close_alias)(struct graphics_peer_file *,int fd);
    int (*ioctl)(struct graphics_peer_file *,uint32_t,void *,uint32_t,struct graphics_peer_file *,const struct graphics_peer_binding *,uint32_t);
    int (*bo_info)(struct graphics_peer_file *,uint32_t,uint64_t *,struct wpk_drm_bo_info *);
    int (*bo_release)(struct graphics_peer_file *,uint32_t,uint64_t);
    void *(*map)(struct graphics_peer_file *,uint64_t,uint64_t,int64_t,uint32_t,uint32_t,uint32_t,uint64_t);
    int (*poll)(struct graphics_peer_file *,uint32_t,int32_t,uint32_t *);
    void (*bo_retain)(struct graphics_peer_file *,uint32_t,uint64_t);
    void (*fork_child)(void);
    int (*unmap)(void *,uint64_t);
};
int graphics_peer_ioctl(const struct graphics_peer_ops *,struct wpk_drm_owned_packet *);
/* Causal tests can lose only the copyout: the immutable receipt must recover
 * the original result, without dispatching its mutation for a second time. */
extern unsigned graphics_peer_lose_action,graphics_peer_lose_reads;
unsigned graphics_peer_live_capabilities(void);
unsigned graphics_peer_effects(void);
#endif
