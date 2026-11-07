#ifndef WPK_DRM_OWNED_H
#define WPK_DRM_OWNED_H
#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>

/* A descriptor is a temporary name. This private, additive endpoint carries
 * kernel-owned OFD/BO capabilities so fd reuse cannot retarget driver work or
 * cleanup. Legacy DRM and GL packets keep their original layouts/semantics. */
#define WPK_DRM_IOCTL_OWNED_RESOURCE UINT32_C(0xc14064e7)
#define WPK_DRM_OWNED_VERSION UINT32_C(1)
#define WPK_DRM_OWNED_MAGIC UINT32_C(0x4f574e31)
#define WPK_DRM_OWNED_BODY_BYTES 256u
#define WPK_DRM_OWNED_OPEN 1u
#define WPK_DRM_OWNED_ACQUIRE 2u
#define WPK_DRM_OWNED_IOCTL 3u
#define WPK_DRM_OWNED_MMAP 4u
#define WPK_DRM_OWNED_RELEASE 5u
#define WPK_DRM_OWNED_READ_LAST 6u
#define WPK_DRM_OWNED_ACK 7u
#define WPK_DRM_OWNED_DUP_FD 8u
#define WPK_DRM_OWNED_BO_RELEASE 9u
#define WPK_DRM_OWNED_BO_INFO 10u
#define WPK_DRM_OWNED_POLL 11u
#define WPK_DRM_OWNED_CANCEL_POLL 12u
#define WPK_DRM_OWNED_MMAP_EXACT 13u
#define WPK_DRM_OWNED_UNMAP_EXACT 14u
#define WPK_DRM_OWNED_CONSUME_FD 1u
#define WPK_DRM_OWNED_CAPTURE_FD 2u
#define WPK_DRM_OWNED_CAPTURE_BO 4u
#define WPK_DRM_OWNED_REUSE_EXACT 8u
#define WPK_DRM_OWNED_BO_BINDINGS 16u
#define WPK_DRM_OWNED_BORROW_ALIAS 32u
#define WPK_DRM_OWNED_EXPECT_SYNC_FILE 64u
#define WPK_DRM_OWNED_MAX_BO_BINDINGS 4u
#define WPK_DRM_OWNED_COMPLETE 1u
#define WPK_DRM_OWNED_ABSENT 2u
#define WPK_DRM_OWNED_PENDING 3u
#define WPK_DRM_OWNED_RENDER_NODE 1u
#define WPK_DRM_OWNED_CARD_NODE 2u

struct wpk_drm_owned_packet {
    uint32_t version, action;
    uint64_t transaction, acknowledge;
    uint32_t token, source_token;
    int32_t fd;
    uint32_t request, length, flags;
    int32_t result;
    uint32_t state, magic, reserved;
    uint8_t body[WPK_DRM_OWNED_BODY_BYTES];
};
_Static_assert(sizeof(struct wpk_drm_owned_packet)==320,"Owned-resource packet size");
_Static_assert(offsetof(struct wpk_drm_owned_packet,transaction)==8,"Owned transaction offset");
_Static_assert(offsetof(struct wpk_drm_owned_packet,token)==24,"Owned token offset");
_Static_assert(offsetof(struct wpk_drm_owned_packet,result)==48,"Owned result offset");
_Static_assert(offsetof(struct wpk_drm_owned_packet,body)==64,"Owned body offset");

/* Each receiver is allocated before native/kernel effects. If a response and
 * its read-only recovery both fail, *owner remains non-NULL. A completed
 * error can also own a capability (for example after consuming a descriptor).
 * Its exact cleanup receiver survives until acknowledgement or process exit. */
struct wpk_drm_owner;
int _wpk_drm_owned_open(uint32_t node,struct wpk_drm_owner **owner);
int _wpk_drm_owned_acquire(int fd,uint32_t flags,struct wpk_drm_owner **owner);
int _wpk_drm_owned_ioctl(struct wpk_drm_owner *owner,uint32_t request,
                         void *body,uint32_t length,struct wpk_drm_owner *source,
                         uint32_t flags,struct wpk_drm_owner **capture);
struct wpk_drm_bo_binding {
    uint32_t byte_offset;
    struct wpk_drm_owner *owner;
};
/* The canonical ioctl bytes never change. Proofs follow them in the private
 * envelope, so legacy callers retain their original handles and layout. */
int _wpk_drm_owned_ioctl_bo(struct wpk_drm_owner *owner,uint32_t request,
                         void *body,uint32_t length,struct wpk_drm_owner *source,
                         uint32_t flags,struct wpk_drm_owner **capture,
                         const struct wpk_drm_bo_binding *bindings,uint32_t count);
int _wpk_drm_owned_map_bo(struct wpk_drm_owner *owner,struct wpk_drm_owner *bo,
                       uint64_t address,uint64_t length,int64_t offset,
                       uint32_t prot,uint32_t flags,uint64_t *mapped);
int _wpk_drm_owned_map(struct wpk_drm_owner *owner,uint64_t address,uint64_t length,
                       int64_t offset,uint32_t prot,uint32_t flags,uint64_t *mapped);
/* Stable, caller-rooted custody for one mapping instance. Publish the containing
 * object before map_exact and keep both source receivers alive until EMPTY.
 * Raw address/length cleanup can destroy a replacement after fork; the kernel
 * identity instead retires only surviving fragments of this original map. */
enum wpk_drm_mapping_phase {
    WPK_DRM_MAPPING_EMPTY, WPK_DRM_MAPPING_MAP_PENDING,
    WPK_DRM_MAPPING_LIVE, WPK_DRM_MAPPING_UNMAP_PENDING
};
struct wpk_drm_mapping {
    struct wpk_drm_owner *file, *bo;
    uint64_t address, length, identity, requested_address;
    int64_t offset;
    uint32_t prot, flags;
    _Atomic(enum wpk_drm_mapping_phase) phase;
};
/* A different FILE caller may recover this capsule's pending receipt.
 * EMPTY must be observable without touching already-retired source receivers;
 * acquire also publishes immutable source/address/identity fields to readers.
 * The facade root still serializes map reuse and final object withdrawal. */
static inline enum wpk_drm_mapping_phase _wpk_drm_mapping_phase(const struct wpk_drm_mapping *mapping) {
    return atomic_load_explicit(&mapping->phase,memory_order_acquire);
}
int _wpk_drm_owned_map_exact(struct wpk_drm_mapping *mapping,
    struct wpk_drm_owner *file, struct wpk_drm_owner *bo,
    uint64_t address,uint64_t length,int64_t offset,uint32_t prot,uint32_t flags);
int _wpk_drm_owned_unmap_exact(struct wpk_drm_mapping *mapping);
int _wpk_drm_owned_poll(struct wpk_drm_owner *owner,uint32_t events,int32_t timeout_ms,uint32_t *revents);
int _wpk_drm_owned_fd(struct wpk_drm_owner *owner,int previous,uint32_t flags);
/* Transfers an otherwise unreturnable constructor/void-cleanup receiver to
 * cold retirement. Failed read-only recovery never loses kernel custody. */
void _wpk_drm_owned_retire(struct wpk_drm_owner **owner);
/* A facade withdrawing published ownership must transfer its exact receiver
 * while holding this prepared, cold publication guard. defer_locked only
 * changes C metadata; release/drain, unmap, receiver locks and device work
 * belong after publication_end. Construction prepares the guard before any
 * owned resource effect, so these transfers cannot allocate or fail. Callers
 * keep cancellation disabled until the facade transaction has finished. */
void _wpk_drm_owned_publication_begin(void);
void _wpk_drm_owned_publication_end(void);
void _wpk_drm_owned_defer_locked(struct wpk_drm_owner **owner);
void _wpk_drm_owned_drain(void);
struct wpk_drm_bo_info {
    uint64_t size;
    uint32_t width,height,stride,format,tier,reserved;
};
_Static_assert(sizeof(struct wpk_drm_bo_info)==32,"Owned BO info size");
int _wpk_drm_owned_bo_info(struct wpk_drm_owner *bo,struct wpk_drm_bo_info *info);
int _wpk_drm_owned_retain(struct wpk_drm_owner *owner);
/* Successful begin holds the cold publication guard: pair it with end on
 * the same owner/state. Failure holds no guard and requires no end. Publish
 * pure C metadata only; no I/O, callbacks, locks or futex wakes before end. */
int _wpk_drm_owned_retain_begin(struct wpk_drm_owner *owner, int *cancel_state);
void _wpk_drm_owned_retain_end(struct wpk_drm_owner *owner, int cancel_state);
int _wpk_drm_owned_release(struct wpk_drm_owner **owner);
/* These private metadata locks can be reconstructed after fork without
 * acquiring a vanished parent's pthread mutex or taking an atfork lock
 * hierarchy. Production contention parks on the normal kernel futex path. */
struct wpk_drm_mutex { _Atomic uint64_t state; };
#define WPK_DRM_MUTEX_INITIALIZER {0}
void _wpk_drm_mutex_lock(struct wpk_drm_mutex *mutex);
void _wpk_drm_mutex_unlock(struct wpk_drm_mutex *mutex);
/* One process-wide cold nonce source, shared by every graphics archive. */
uint64_t _wpk_owned_resource_nonce(void);
uint64_t _wpk_drm_process_generation(void);
/* D-59 compares this child-only epoch with a connection's creation epoch.
 * Kept in libc so every linked Wayland archive observes the same authority. */
uint64_t _wpk_drm_native_fork_epoch(void);
/* An intrusive heap owner, independent of a caller's soon-freed EGL shell.
 * Only an explicitly approved inherited-Wayland boundary may use this root.
 * Transfer under the publication guard before clearing the caller's slot;
 * no native graph traversal, numeric close, allocation or release is implied.
 * Exec/exit discards C state; ordinary descriptors keep normal kernel policy. */
struct wpk_wl_boundary_hold {
    struct wpk_wl_boundary_hold *next;
    void *owner;
    unsigned transferred;
};
void _wpk_wl_boundary_transfer_locked(struct wpk_wl_boundary_hold *);
/* A cleanup stack can survive fork on its own thread. An epoch-only claim
 * would let a reentrant child drain free that stack's node. These cold claims
 * retain heap thread identities, so only an ended/vanished actor is adoptable.
 * Prepare outside the publication guard before effects; all *_locked calls
 * require that guard. Preparation failure leaves queued custody untouched and
 * emits a diagnostic; the caller must not enter cleanup without a scope. */
struct wpk_drm_actor_scope;
struct wpk_drm_actor_claim { struct wpk_drm_actor_scope *scope; };
int _wpk_drm_actor_prepare(void);
int _wpk_drm_actor_try_claim_locked(struct wpk_drm_actor_claim *claim);
int _wpk_drm_actor_claim_live_locked(const struct wpk_drm_actor_claim *claim);
/* Deferred diagnostics retain their original live actor: another thread must
 * not deliver them merely because it reached an unrelated EGL unlock first. */
int _wpk_drm_actor_claim_current_locked(const struct wpk_drm_actor_claim *claim);
void _wpk_drm_actor_release_locked(struct wpk_drm_actor_claim *claim);
#endif
