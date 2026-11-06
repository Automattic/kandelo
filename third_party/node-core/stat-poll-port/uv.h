// Private port declarations. Only the unchanged fs-poll.c unit includes this.
#ifndef KANDELO_STAT_POLL_PORT_UV_H
#define KANDELO_STAT_POLL_PORT_UV_H
#define UV_FS_POLL 1
#define UV_HANDLE_ACTIVE 1
#define UV_HANDLE_CLOSING 2
#define UV_HANDLE_INTERNAL 4
#define UV_HANDLE_REF 8
#define UV_ENOMEM (-ENOMEM)
#define UV_EINVAL (-EINVAL)
#define UV_ENOBUFS (-ENOBUFS)
static inline void uv__handle_init(uv_loop_t* loop, uv_handle_t* h, int) { h->loop=loop;h->flags=UV_HANDLE_REF;h->data=nullptr; }
static inline void uv__handle_start(uv_handle_t* h) { h->flags|=UV_HANDLE_ACTIVE; }
static inline void uv__handle_stop(uv_handle_t* h) { h->flags&=~UV_HANDLE_ACTIVE; }
static inline void uv__handle_unref(uv_handle_t* h) { h->flags&=~UV_HANDLE_REF; }
static inline int uv_is_active(uv_handle_t* h) { return (h->flags&UV_HANDLE_ACTIVE)!=0; }
static inline int uv__is_closing(uv_fs_poll_t* h) { return (h->flags&UV_HANDLE_CLOSING)!=0; }
static inline uint64_t uv_now(uv_loop_t* loop) { return loop->time; }
static poll_ctx* uv__calloc(size_t, size_t);
static void uv__free(void*);
static int uv_timer_init(uv_loop_t*,uv_timer_t*);
static int uv_timer_start(uv_timer_t*,uv_timer_cb,uint64_t,uint64_t);
static void uv_close(uv_handle_t*,uv_close_cb);
static void uv__poll_close_pending(uv_fs_poll_t*);
#define uv__make_close_pending(h) uv__poll_close_pending(h)
static int uv_fs_stat(uv_loop_t* loop,uv_fs_t* req,const char* path,uv_fs_cb cb) {
  req->loop=loop;req->path=path;req->callback=cb;return loop->submit(loop,req);
}
static inline void uv_fs_req_cleanup(uv_fs_t* request) {
  // The polling context owns path bytes and the native work owner owns its job.
  // Retire this request's borrowed leases; there is no separate UV heap path.
  request->path=nullptr;request->callback=nullptr;
}
#endif
