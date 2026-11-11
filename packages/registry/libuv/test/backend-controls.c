/* Focused real guest libuv controls; no Node bootstrap or complete API claim. */
#include <uv.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>

#define CHECK(condition) do { if (!(condition)) { \
  fprintf(stderr, "FAIL line=%d condition=%s\n", __LINE__, #condition); \
  exit(1); } } while (0)
static unsigned cases;
static void passed(const char* name) {
  printf("{\"case\":\"%s\",\"status\":\"pass\"}\n", name);
  cases++;
}
static uv_loop_t loop;
static uv_timer_t timer;
static unsigned fired, closed;
static uint64_t started;
static void close_cb(uv_handle_t* handle) {
  CHECK(uv_is_closing(handle));
  closed++;
}
static void timer_cb(uv_timer_t* handle) {
  CHECK(handle == &timer);
  CHECK(uv_hrtime() - started >= 20000000);
  fired++;
  uv_close((uv_handle_t*)handle, close_cb);
}
static void unexpected_timer(uv_timer_t* handle) {
  CHECK(!"unreferenced timer fired");
}
static void repeat_cb(uv_timer_t* handle) {
  CHECK(uv_timer_get_repeat(handle) == 2);
  fired++;
  if (fired == 3) {
    CHECK(uv_timer_stop(handle) == 0);
    CHECK(!uv_is_active((uv_handle_t*)handle));
    uv_close((uv_handle_t*)handle, close_cb);
  }
}
static void watchdog_cb(uv_timer_t* handle) {
  CHECK(!"async/threadpool watchdog expired");
}
static void start_watchdog(void) {
  CHECK(uv_timer_init(&loop, &timer) == 0);
  CHECK(uv_timer_start(&timer, watchdog_cb, 5000, 0) == 0);
}
static void finish_watchdog(void) {
  CHECK(uv_timer_stop(&timer) == 0);
  uv_close((uv_handle_t*)&timer, NULL);
}
static uv_prepare_t prepare;
static uv_check_t check_handle;
static uv_idle_t idle;
static unsigned prepared, checked;
static void prepare_cb(uv_prepare_t* handle) { prepared++; }
static void idle_cb(uv_idle_t* handle) { CHECK(handle == &idle); }
static void check_cb(uv_check_t* handle) {
  CHECK(prepared == 1);
  checked++;
  uv_close((uv_handle_t*)&prepare, NULL);
  uv_close((uv_handle_t*)&check_handle, NULL);
  uv_close((uv_handle_t*)&idle, NULL);
}
static uv_async_t async_handle;
static uv_thread_t main_thread, sender_thread;
static atomic_int ready, payload;
static void async_prepare_cb(uv_prepare_t* handle) {
  atomic_store_explicit(&ready, 1, memory_order_release);
  uv_close((uv_handle_t*)handle, NULL);
}
static void sender(void* ignored) {
  uv_thread_t self = uv_thread_self();
  CHECK(!uv_thread_equal(&self, &main_thread));
  while (!atomic_load_explicit(&ready, memory_order_acquire)) uv_sleep(1);
  uv_sleep(20);
  atomic_store_explicit(&payload, 42, memory_order_release);
  CHECK(uv_async_send(&async_handle) == 0);
}
static void async_cb(uv_async_t* handle) {
  uv_thread_t self = uv_thread_self();
  CHECK(uv_thread_equal(&self, &main_thread));
  CHECK(atomic_load_explicit(&payload, memory_order_acquire) == 42);
  fired++;
  uv_close((uv_handle_t*)handle, close_cb);
  finish_watchdog();
}
static uv_work_t work;
static void work_cb(uv_work_t* request) {
  uv_thread_t self = uv_thread_self();
  CHECK(request == &work);
  CHECK(!uv_thread_equal(&self, &main_thread));
  atomic_store_explicit(&payload, 91, memory_order_release);
}
static void after_work_cb(uv_work_t* request, int status) {
  uv_thread_t self = uv_thread_self();
  CHECK(request == &work && status == 0);
  CHECK(uv_thread_equal(&self, &main_thread));
  CHECK(atomic_load_explicit(&payload, memory_order_acquire) == 91);
  fired++;
  finish_watchdog();
}
static int pipe_fds[2];
static uv_poll_t poll_handle;
static void poll_close_cb(uv_handle_t* handle) {
  CHECK(close(pipe_fds[0]) == 0);
  CHECK(close(pipe_fds[1]) == 0);
  closed++;
}
static void poll_cb(uv_poll_t* handle, int status, int events) {
  char byte;
  CHECK(status == 0 && (events & UV_READABLE));
  CHECK(read(pipe_fds[0], &byte, 1) == 1 && byte == 'K');
  CHECK(uv_poll_stop(handle) == 0);
  fired++;
  uv_close((uv_handle_t*)handle, poll_close_cb);
}
static uv_fs_t fs_request;
static uv_file file;
static char fs_data[] = "real libuv guest filesystem";
static char fs_readback[sizeof(fs_data)];
static uv_buf_t fs_buffer;
static void fs_read_cb(uv_fs_t* request) {
  uv_thread_t self = uv_thread_self();
  CHECK(uv_thread_equal(&self, &main_thread));
  CHECK(request->result == sizeof(fs_data));
  CHECK(memcmp(fs_data, fs_readback, sizeof(fs_data)) == 0);
  uv_fs_req_cleanup(request);
  fired++;
  finish_watchdog();
}
static void fs_write_cb(uv_fs_t* request) {
  CHECK(request->result == sizeof(fs_data));
  uv_fs_req_cleanup(request);
  fs_buffer = uv_buf_init(fs_readback, sizeof(fs_readback));
  CHECK(uv_fs_read(&loop, &fs_request, file, &fs_buffer, 1, 0, fs_read_cb) == 0);
}
int main(void) {
  CHECK(setvbuf(stdout, NULL, _IONBF, 0) == 0);
  CHECK(UV_VERSION_MAJOR == 1 && UV_VERSION_MINOR == 52 && UV_VERSION_PATCH == 1);
  CHECK(uv_loop_size() == sizeof(uv_loop_t));
  CHECK(uv_handle_size(UV_TIMER) == sizeof(uv_timer_t));
  CHECK(uv_handle_size(UV_ASYNC) == sizeof(uv_async_t));
  CHECK(uv_req_size(UV_FS) == sizeof(uv_fs_t));
  main_thread = uv_thread_self();
  passed("public-layout");

  CHECK(uv_loop_init(&loop) == 0);
  CHECK(uv_backend_fd(&loop) == -1); /* portable poll has no poller descriptor */
  CHECK(!uv_loop_alive(&loop));
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  CHECK(uv_loop_close(&loop) == 0);
  passed("empty-loop");

  CHECK(uv_loop_init(&loop) == 0);
  fired = closed = 0;
  CHECK(uv_timer_init(&loop, &timer) == 0);
  CHECK(uv_has_ref((uv_handle_t*)&timer));
  started = uv_hrtime();
  CHECK(uv_timer_start(&timer, timer_cb, 25, 0) == 0);
  CHECK(uv_loop_alive(&loop));
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  CHECK(fired == 1 && closed == 1);
  CHECK(uv_loop_close(&loop) == 0);
  passed("timer-deadline-and-close");

  CHECK(uv_loop_init(&loop) == 0);
  fired = closed = 0;
  CHECK(uv_timer_init(&loop, &timer) == 0);
  CHECK(uv_timer_start(&timer, repeat_cb, 0, 2) == 0);
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  CHECK(fired == 3 && closed == 1);
  CHECK(uv_loop_close(&loop) == 0);
  passed("repeating-timer-stop");

  CHECK(uv_loop_init(&loop) == 0);
  CHECK(uv_timer_init(&loop, &timer) == 0);
  CHECK(uv_timer_start(&timer, unexpected_timer, 0, 0) == 0);
  uv_unref((uv_handle_t*)&timer);
  CHECK(!uv_has_ref((uv_handle_t*)&timer));
  CHECK(!uv_loop_alive(&loop));
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  uv_ref((uv_handle_t*)&timer);
  CHECK(uv_has_ref((uv_handle_t*)&timer) && uv_loop_alive(&loop));
  uv_close((uv_handle_t*)&timer, NULL);
  CHECK(uv_loop_alive(&loop));
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  CHECK(uv_loop_close(&loop) == 0);
  passed("unreferenced-timer-liveness");

  CHECK(uv_loop_init(&loop) == 0);
  CHECK(uv_timer_init(&loop, &timer) == 0);
  CHECK(uv_timer_start(&timer, unexpected_timer, 60000, 0) == 0);
  CHECK(uv_run(&loop, UV_RUN_NOWAIT) != 0);
  CHECK(uv_loop_close(&loop) == UV_EBUSY);
  uv_close((uv_handle_t*)&timer, NULL);
  CHECK(uv_loop_close(&loop) == UV_EBUSY);
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  CHECK(uv_loop_close(&loop) == 0);
  passed("busy-close-and-nowait");

  CHECK(uv_loop_init(&loop) == 0);
  prepared = checked = 0;
  CHECK(uv_prepare_init(&loop, &prepare) == 0);
  CHECK(uv_check_init(&loop, &check_handle) == 0);
  CHECK(uv_idle_init(&loop, &idle) == 0);
  CHECK(uv_prepare_start(&prepare, prepare_cb) == 0);
  CHECK(uv_check_start(&check_handle, check_cb) == 0);
  CHECK(uv_idle_start(&idle, idle_cb) == 0);
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  CHECK(prepared == 1 && checked == 1);
  CHECK(uv_loop_close(&loop) == 0);
  passed("prepare-check-phases");

  CHECK(uv_loop_init(&loop) == 0);
  fired = closed = 0;
  atomic_store(&ready, 0); atomic_store(&payload, 0);
  start_watchdog();
  CHECK(uv_async_init(&loop, &async_handle, async_cb) == 0);
  CHECK(uv_prepare_init(&loop, &prepare) == 0);
  CHECK(uv_prepare_start(&prepare, async_prepare_cb) == 0);
  CHECK(uv_thread_create(&sender_thread, sender, NULL) == 0);
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  CHECK(uv_thread_join(&sender_thread) == 0);
  CHECK(fired == 1 && closed == 1);
  CHECK(uv_loop_close(&loop) == 0);
  passed("thread-to-loop-async-wakeup");

  CHECK(uv_loop_init(&loop) == 0);
  fired = 0; atomic_store(&payload, 0);
  start_watchdog();
  CHECK(uv_queue_work(&loop, &work, work_cb, after_work_cb) == 0);
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  CHECK(fired == 1);
  CHECK(uv_loop_close(&loop) == 0);
  passed("threadpool-work-and-main-callback");

  CHECK(uv_loop_init(&loop) == 0);
  fired = closed = 0;
  CHECK(pipe(pipe_fds) == 0);
  CHECK(uv_poll_init(&loop, &poll_handle, pipe_fds[0]) == 0);
  CHECK(uv_poll_start(&poll_handle, UV_READABLE, poll_cb) == 0);
  CHECK(write(pipe_fds[1], "K", 1) == 1);
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0);
  CHECK(fired == 1 && closed == 1);
  CHECK(uv_loop_close(&loop) == 0);
  passed("pipe-readiness-and-poll-close");

  CHECK(mkdir("/tmp", 0777) == 0 || errno == EEXIST);
  CHECK(uv_loop_init(&loop) == 0);
  file = uv_fs_open(&loop, &fs_request, "/tmp/libuv-backend-controls", O_CREAT|O_TRUNC|O_RDWR, 0600, NULL);
  CHECK(file >= 0);
  uv_fs_req_cleanup(&fs_request);
  fired = 0; memset(fs_readback, 0, sizeof(fs_readback));
  start_watchdog();
  fs_buffer = uv_buf_init(fs_data, sizeof(fs_data));
  CHECK(uv_fs_write(&loop, &fs_request, file, &fs_buffer, 1, 0, fs_write_cb) == 0);
  CHECK(uv_run(&loop, UV_RUN_DEFAULT) == 0 && fired == 1);
  CHECK(uv_fs_close(&loop, &fs_request, file, NULL) == 0);
  uv_fs_req_cleanup(&fs_request);
  CHECK(uv_fs_unlink(&loop, &fs_request, "/tmp/libuv-backend-controls", NULL) == 0);
  uv_fs_req_cleanup(&fs_request);
  CHECK(uv_fs_open(&loop, &fs_request, "/tmp/libuv-backend-controls", O_RDONLY, 0, NULL) == UV_ENOENT);
  uv_fs_req_cleanup(&fs_request);
  CHECK(uv_loop_close(&loop) == 0);
  passed("real-file-async-write-read-and-errors");

  char title[16] = "unchanged";
  CHECK(uv_set_process_title("probe") == UV_ENOSYS);
  CHECK(uv_get_process_title(title, sizeof(title)) == UV_ENOSYS);
  CHECK(strcmp(title, "unchanged") == 0);
  CHECK(uv_get_process_title(NULL, sizeof(title)) == UV_EINVAL);
  passed("process-title-explicit-unsupported");

  uv_fs_event_t watcher;
  CHECK(uv_loop_init(&loop) == 0);
  CHECK(uv_fs_event_init(&loop, &watcher) == UV_ENOSYS);
  CHECK(!uv_loop_alive(&loop));
  CHECK(uv_loop_close(&loop) == 0);
  passed("filesystem-watch-explicit-unsupported");
  uv_library_shutdown();
  printf("{\"kind\":\"libuv-backend-controls\",\"cases\":%u,\"failures\":0}\n", cases);
  return 0;
}
