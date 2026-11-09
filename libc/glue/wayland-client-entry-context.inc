/* Private stack dispatch token; actual native obligations live in rooted
 * heap continuations created only for cold constructors/logs/callbacks. */
struct wpk_wl_raw_retirement;
struct wpk_wl_raw_entry {
    struct wpk_wl_raw_entry *previous;
    struct wpk_wl_raw_retirement *diagnostic;
    void *display;
    int cancel_suspended,cancel_prior;
    uint64_t custody_nonce;
    unsigned callback_roots;
};
enum wpk_wl_raw_result { WPK_RAW_NONE,WPK_RAW_PROXY,WPK_RAW_DISPLAY };
static _Thread_local struct wpk_wl_raw_entry *wpk_wl_raw_current_entry;
static void wpk_wl_raw_entry_begin(struct wpk_wl_raw_entry *,void *);
static int wpk_wl_raw_entry_end(struct wpk_wl_raw_entry *,void *,enum wpk_wl_raw_result);
static void wpk_wl_raw_entry_abandon(void *);
static int wpk_wl_raw_drain(void);
static void wpk_wl_private_queue_forget(void *);
static int wpk_wl_callbacks_abandon_locked(struct wpk_wl_raw_entry *);
static int wpk_wl_callbacks_finish_entry(struct wpk_wl_raw_entry *);
static int wpk_wl_callbacks_drain(void);
static int wpk_wl_callbacks_present_locked(void);
#define WPK_WL_RAW_ENTRY_ENABLED 1

#if defined(__APPLE__)
__attribute__((weak_import)) void _wpk_egl_request_native_drain(void);
#else
__attribute__((weak)) void _wpk_egl_request_native_drain(void);
#endif
