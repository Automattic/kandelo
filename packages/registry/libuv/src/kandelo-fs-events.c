/* Per-handle guest VFS notifications over a pollable kernel device. */
#include "uv.h"
#include "internal.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define EVENT_DEVICE "/dev/kandelo/fs-events"

typedef struct {
  uv__io_t io;
  uv_fs_event_t* handle;
  int target_fd;
  int is_directory;
} kandelo_watch_t;

int uv_fs_event_init(uv_loop_t* loop, uv_fs_event_t* handle) {
  struct stat st;

  if (stat(EVENT_DEVICE, &st) < 0)
    return errno == ENOENT ? UV_ENOSYS : UV__ERR(errno);
  if (!S_ISCHR(st.st_mode))
    return UV_ENODEV;
  uv__handle_init(loop, handle, UV_FS_EVENT);
  handle->u.reserved[0] = NULL;
  handle->path = NULL;
  return 0;
}

void uv__fs_event(uv_loop_t* loop, uv__io_t* io, unsigned int events) {
  unsigned char record[257];
  kandelo_watch_t* watch = container_of(io, kandelo_watch_t, io);
  uv_fs_event_t* handle = watch->handle;
  const char* name;
  ssize_t length;
  int status;

  /* One record per turn lets callbacks stop, close or restart this handle. */
  do
    length = read(io->fd, record, sizeof(record) - 1);
  while (length < 0 && errno == EINTR);
  if (length < 0 && errno == EAGAIN)
    return;
  if (length <= 0 || record[0] < 1 || record[0] > 3) {
    status = length < 0 ? UV__ERR(errno) : UV_EIO;
    handle->cb(handle, NULL, 0, status);
    return;
  }
  if (record[0] == 3) {
    handle->cb(handle, NULL, 0, UV_ENOBUFS);
    return;
  }
  record[length] = 0;
  name = length > 1 ? (const char*) &record[1] : NULL;
  if (name == NULL && !watch->is_directory) {
    name = strrchr(handle->path, '/');
    name = name == NULL ? handle->path : name + 1;
  }
  handle->cb(handle, name, record[0] == 1 ? UV_RENAME : UV_CHANGE, 0);
}

int uv_fs_event_start(uv_fs_event_t* handle, uv_fs_event_cb cb,
                      const char* path, unsigned int flags) {
  struct stat st;
  kandelo_watch_t* watch;
  ssize_t count;
  int target;
  int device;
  int err;

  if (path == NULL || cb == NULL || uv__is_active(handle))
    return UV_EINVAL;
  if (flags & UV_FS_EVENT_RECURSIVE)
    return UV_ENOTSUP;
  target = uv__open_cloexec(path, O_RDONLY | O_NONBLOCK);
  if (target < 0)
    return target;
  if (fstat(target, &st) < 0) {
    err = UV__ERR(errno);
    goto fail_target;
  }
  device = uv__open_cloexec(EVENT_DEVICE, O_RDWR | O_NONBLOCK);
  if (device < 0) {
    err = device;
    goto fail_target;
  }
  /* Kandelo's guest targets are little endian with 32-bit descriptors. */
  do
    count = write(device, &target, sizeof(int32_t));
  while (count < 0 && errno == EINTR);
  if (count != sizeof(int32_t)) {
    err = count < 0 ? UV__ERR(errno) : UV_EIO;
    goto fail_device;
  }
  watch = uv__malloc(sizeof(*watch));
  if (watch == NULL) {
    err = UV_ENOMEM;
    goto fail_device;
  }
  handle->path = uv__strdup(path);
  if (handle->path == NULL) {
    err = UV_ENOMEM;
    goto fail_watch;
  }
  err = uv__io_init_start(handle->loop, &watch->io, UV__FS_EVENT, device, POLLIN);
  if (err < 0) {
    uv__free(handle->path);
    handle->path = NULL;
    goto fail_watch;
  }
  watch->handle = handle;
  watch->target_fd = target;
  watch->is_directory = S_ISDIR(st.st_mode);
  handle->u.reserved[0] = watch;
  handle->cb = cb;
  uv__handle_start(handle);
  return 0;

fail_watch:
  uv__free(watch);
fail_device:
  uv__close_nocheckstdio(device);
fail_target:
  uv__close_nocheckstdio(target);
  return err;
}

int uv_fs_event_stop(uv_fs_event_t* handle) {
  kandelo_watch_t* watch = handle->u.reserved[0];
  if (watch == NULL)
    return 0;
  uv__handle_stop(handle);
  uv__io_close(handle->loop, &watch->io);
  uv__close_nocheckstdio(watch->io.fd);
  uv__close_nocheckstdio(watch->target_fd);
  uv__free(watch);
  handle->u.reserved[0] = NULL;
  uv__free(handle->path);
  handle->path = NULL;
  return 0;
}

void uv__fs_event_close(uv_fs_event_t* handle) {
  uv_fs_event_stop(handle);
}
