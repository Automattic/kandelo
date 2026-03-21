/*
 * syscall_imports.h — Declarations of kernel_* Wasm imports.
 *
 * Every function here is provided by the kernel Wasm module and imported
 * by the program module.  The import_module/import_name attributes tell
 * the Wasm linker to generate the correct import entries.
 */

#ifndef SYSCALL_IMPORTS_H
#define SYSCALL_IMPORTS_H

#include <stdint.h>
#include <stddef.h>

#define KERNEL_IMPORT(name) \
    __attribute__((import_module("kernel"), import_name(#name)))

/* ------------------------------------------------------------------ */
/* Process / Fork / Exec management                                    */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_init)
void kernel_init(uint32_t pid);

KERNEL_IMPORT(kernel_get_fork_state)
int32_t kernel_get_fork_state(uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_init_from_fork)
int32_t kernel_init_from_fork(const uint8_t *buf_ptr, uint32_t buf_len,
                              uint32_t child_pid);

KERNEL_IMPORT(kernel_get_exec_state)
int32_t kernel_get_exec_state(uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_init_from_exec)
int32_t kernel_init_from_exec(const uint8_t *buf_ptr, uint32_t buf_len,
                              uint32_t pid);

KERNEL_IMPORT(kernel_convert_pipe_to_host)
int32_t kernel_convert_pipe_to_host(uint32_t ofd_idx, int64_t new_host_handle);

/* ------------------------------------------------------------------ */
/* File operations                                                     */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_open)
int32_t kernel_open(const uint8_t *path_ptr, uint32_t path_len,
                    uint32_t flags, uint32_t mode);

KERNEL_IMPORT(kernel_close)
int32_t kernel_close(int32_t fd);

KERNEL_IMPORT(kernel_read)
int32_t kernel_read(int32_t fd, uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_write)
int32_t kernel_write(int32_t fd, const uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_lseek)
int64_t kernel_lseek(int32_t fd, uint32_t offset_lo, int32_t offset_hi,
                     uint32_t whence);

KERNEL_IMPORT(kernel_pread)
int32_t kernel_pread(int32_t fd, uint8_t *buf_ptr, uint32_t buf_len,
                     uint32_t offset_lo, int32_t offset_hi);

KERNEL_IMPORT(kernel_pwrite)
int32_t kernel_pwrite(int32_t fd, const uint8_t *buf_ptr, uint32_t buf_len,
                      uint32_t offset_lo, int32_t offset_hi);

/* ------------------------------------------------------------------ */
/* FD operations                                                       */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_dup)
int32_t kernel_dup(int32_t fd);

KERNEL_IMPORT(kernel_dup2)
int32_t kernel_dup2(int32_t oldfd, int32_t newfd);

KERNEL_IMPORT(kernel_dup3)
int32_t kernel_dup3(int32_t oldfd, int32_t newfd, uint32_t flags);

KERNEL_IMPORT(kernel_pipe)
int32_t kernel_pipe(int32_t *fildes_ptr);

KERNEL_IMPORT(kernel_pipe2)
int32_t kernel_pipe2(uint32_t flags, int32_t *fd_ptr);

KERNEL_IMPORT(kernel_eventfd2)
int32_t kernel_eventfd2(uint32_t initval, uint32_t flags);

KERNEL_IMPORT(kernel_fcntl)
int32_t kernel_fcntl(int32_t fd, uint32_t cmd, uint32_t arg);

KERNEL_IMPORT(kernel_fcntl_lock)
int32_t kernel_fcntl_lock(int32_t fd, uint32_t cmd, uint8_t *flock_ptr);

/* ------------------------------------------------------------------ */
/* Stat                                                                */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_fstat)
int32_t kernel_fstat(int32_t fd, uint8_t *stat_ptr);

KERNEL_IMPORT(kernel_stat)
int32_t kernel_stat(const uint8_t *path_ptr, uint32_t path_len,
                    uint8_t *stat_ptr);

KERNEL_IMPORT(kernel_lstat)
int32_t kernel_lstat(const uint8_t *path_ptr, uint32_t path_len,
                     uint8_t *stat_ptr);

/* ------------------------------------------------------------------ */
/* Directory operations                                                */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_mkdir)
int32_t kernel_mkdir(const uint8_t *path_ptr, uint32_t path_len,
                     uint32_t mode);

KERNEL_IMPORT(kernel_rmdir)
int32_t kernel_rmdir(const uint8_t *path_ptr, uint32_t path_len);

KERNEL_IMPORT(kernel_unlink)
int32_t kernel_unlink(const uint8_t *path_ptr, uint32_t path_len);

KERNEL_IMPORT(kernel_rename)
int32_t kernel_rename(const uint8_t *old_ptr, uint32_t old_len,
                      const uint8_t *new_ptr, uint32_t new_len);

KERNEL_IMPORT(kernel_link)
int32_t kernel_link(const uint8_t *old_ptr, uint32_t old_len,
                    const uint8_t *new_ptr, uint32_t new_len);

KERNEL_IMPORT(kernel_symlink)
int32_t kernel_symlink(const uint8_t *target_ptr, uint32_t target_len,
                       const uint8_t *link_ptr, uint32_t link_len);

KERNEL_IMPORT(kernel_readlink)
int32_t kernel_readlink(const uint8_t *path_ptr, uint32_t path_len,
                        uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_chmod)
int32_t kernel_chmod(const uint8_t *path_ptr, uint32_t path_len,
                     uint32_t mode);

KERNEL_IMPORT(kernel_chown)
int32_t kernel_chown(const uint8_t *path_ptr, uint32_t path_len,
                     uint32_t uid, uint32_t gid);

KERNEL_IMPORT(kernel_access)
int32_t kernel_access(const uint8_t *path_ptr, uint32_t path_len,
                      uint32_t amode);

KERNEL_IMPORT(kernel_chdir)
int32_t kernel_chdir(const uint8_t *path_ptr, uint32_t path_len);

KERNEL_IMPORT(kernel_fchdir)
int32_t kernel_fchdir(int32_t fd);

KERNEL_IMPORT(kernel_getcwd)
int32_t kernel_getcwd(uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_opendir)
int32_t kernel_opendir(const uint8_t *path_ptr, uint32_t path_len);

KERNEL_IMPORT(kernel_readdir)
int32_t kernel_readdir(int32_t dir_handle, uint8_t *dirent_ptr,
                       uint8_t *name_ptr, uint32_t name_len);

KERNEL_IMPORT(kernel_closedir)
int32_t kernel_closedir(int32_t dir_handle);

KERNEL_IMPORT(kernel_getdents64)
int32_t kernel_getdents64(int32_t fd, uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_rewinddir)
int32_t kernel_rewinddir(int32_t dir_handle);

KERNEL_IMPORT(kernel_telldir)
int64_t kernel_telldir(int32_t dir_handle);

KERNEL_IMPORT(kernel_seekdir)
int32_t kernel_seekdir(int32_t dir_handle, uint32_t loc_lo, uint32_t loc_hi);

/* ------------------------------------------------------------------ */
/* Process info                                                        */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_getpid)
int32_t kernel_getpid(void);

KERNEL_IMPORT(kernel_getppid)
int32_t kernel_getppid(void);

KERNEL_IMPORT(kernel_getuid)
uint32_t kernel_getuid(void);

KERNEL_IMPORT(kernel_geteuid)
uint32_t kernel_geteuid(void);

KERNEL_IMPORT(kernel_getgid)
uint32_t kernel_getgid(void);

KERNEL_IMPORT(kernel_getegid)
uint32_t kernel_getegid(void);

KERNEL_IMPORT(kernel_getpgrp)
uint32_t kernel_getpgrp(void);

KERNEL_IMPORT(kernel_setpgid)
int32_t kernel_setpgid(uint32_t pid, uint32_t pgid);

KERNEL_IMPORT(kernel_getsid)
int32_t kernel_getsid(uint32_t pid);

KERNEL_IMPORT(kernel_setsid)
int32_t kernel_setsid(void);

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_kill)
int32_t kernel_kill(int32_t pid, uint32_t sig);

KERNEL_IMPORT(kernel_deliver_signal)
int32_t kernel_deliver_signal(uint32_t sig);

KERNEL_IMPORT(kernel_raise)
int32_t kernel_raise(uint32_t sig);

KERNEL_IMPORT(kernel_sigaction)
int32_t kernel_sigaction(uint32_t sig, const uint8_t *act_ptr,
                         uint8_t *oldact_ptr);

KERNEL_IMPORT(kernel_signal)
int32_t kernel_signal(uint32_t signum, uint32_t handler);

KERNEL_IMPORT(kernel_sigprocmask)
int64_t kernel_sigprocmask(uint32_t how, uint32_t set_lo, uint32_t set_hi);

KERNEL_IMPORT(kernel_alarm)
int32_t kernel_alarm(uint32_t seconds);

KERNEL_IMPORT(kernel_setitimer)
int32_t kernel_setitimer(uint32_t which, const uint8_t *new_ptr,
                         uint8_t *old_ptr);

KERNEL_IMPORT(kernel_getitimer)
int32_t kernel_getitimer(uint32_t which, uint8_t *curr_ptr);

KERNEL_IMPORT(kernel_sigsuspend)
int32_t kernel_sigsuspend(uint32_t mask_lo, uint32_t mask_hi);

KERNEL_IMPORT(kernel_pause)
int32_t kernel_pause(void);

KERNEL_IMPORT(kernel_rt_sigtimedwait)
int32_t kernel_rt_sigtimedwait(uint32_t mask_lo, uint32_t mask_hi,
                               int32_t timeout_ms);

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_clock_gettime)
int32_t kernel_clock_gettime(uint32_t clock_id, uint8_t *ts_ptr);

KERNEL_IMPORT(kernel_clock_getres)
int32_t kernel_clock_getres(uint32_t clock_id, uint8_t *ts_ptr);

KERNEL_IMPORT(kernel_clock_nanosleep)
int32_t kernel_clock_nanosleep(uint32_t clock_id, uint32_t flags,
                               const uint8_t *req_ptr);

KERNEL_IMPORT(kernel_nanosleep)
int32_t kernel_nanosleep(const uint8_t *req_ptr);

KERNEL_IMPORT(kernel_time)
int64_t kernel_time(void);

KERNEL_IMPORT(kernel_gettimeofday)
int32_t kernel_gettimeofday(int64_t *sec_ptr, int64_t *usec_ptr);

KERNEL_IMPORT(kernel_usleep)
int32_t kernel_usleep(uint32_t usec);

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_getenv)
int32_t kernel_getenv(const uint8_t *name_ptr, uint32_t name_len,
                      uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_setenv)
int32_t kernel_setenv(const uint8_t *name_ptr, uint32_t name_len,
                      const uint8_t *val_ptr, uint32_t val_len,
                      uint32_t overwrite);

KERNEL_IMPORT(kernel_unsetenv)
int32_t kernel_unsetenv(const uint8_t *name_ptr, uint32_t name_len);

KERNEL_IMPORT(kernel_environ_count)
uint32_t kernel_environ_count(void);

KERNEL_IMPORT(kernel_environ_get)
int32_t kernel_environ_get(uint32_t index, uint8_t *buf_ptr, uint32_t buf_len);

/* ------------------------------------------------------------------ */
/* Terminal                                                            */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_isatty)
int32_t kernel_isatty(int32_t fd);

KERNEL_IMPORT(kernel_tcgetattr)
int32_t kernel_tcgetattr(int32_t fd, uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_tcsetattr)
int32_t kernel_tcsetattr(int32_t fd, uint32_t action, const uint8_t *buf_ptr,
                         uint32_t buf_len);

KERNEL_IMPORT(kernel_ioctl)
int32_t kernel_ioctl(int32_t fd, uint32_t request, uint8_t *buf_ptr,
                     uint32_t buf_len);

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_mmap)
uint32_t kernel_mmap(uint32_t addr, uint32_t len, uint32_t prot,
                     uint32_t flags, int32_t fd, uint32_t offset_lo,
                     int32_t offset_hi);

KERNEL_IMPORT(kernel_munmap)
int32_t kernel_munmap(uint32_t addr, uint32_t len);

KERNEL_IMPORT(kernel_brk)
uint32_t kernel_brk(uint32_t addr);

KERNEL_IMPORT(kernel_mprotect)
int32_t kernel_mprotect(uint32_t addr, uint32_t len, uint32_t prot);

KERNEL_IMPORT(kernel_mremap)
uint32_t kernel_mremap(uint32_t old_addr, uint32_t old_len, uint32_t new_len,
                       uint32_t flags);

/* ------------------------------------------------------------------ */
/* Truncate / Sync                                                     */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_ftruncate)
int32_t kernel_ftruncate(int32_t fd, uint32_t length_lo, uint32_t length_hi);

KERNEL_IMPORT(kernel_fsync)
int32_t kernel_fsync(int32_t fd);

KERNEL_IMPORT(kernel_truncate)
int32_t kernel_truncate(const uint8_t *path_ptr, uint32_t path_len,
                        uint32_t length_lo, uint32_t length_hi);

KERNEL_IMPORT(kernel_fdatasync)
int32_t kernel_fdatasync(int32_t fd);

KERNEL_IMPORT(kernel_fchmod)
int32_t kernel_fchmod(int32_t fd, uint32_t mode);

KERNEL_IMPORT(kernel_fchown)
int32_t kernel_fchown(int32_t fd, uint32_t uid, uint32_t gid);

/* ------------------------------------------------------------------ */
/* Scatter-gather I/O                                                  */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_writev)
int32_t kernel_writev(int32_t fd, const uint8_t *iov_ptr, int32_t iovcnt);

KERNEL_IMPORT(kernel_readv)
int32_t kernel_readv(int32_t fd, uint8_t *iov_ptr, int32_t iovcnt);

KERNEL_IMPORT(kernel_preadv)
int32_t kernel_preadv(int32_t fd, uint8_t *iov_ptr, int32_t iovcnt,
                      uint32_t offset_lo, int32_t offset_hi);

KERNEL_IMPORT(kernel_pwritev)
int32_t kernel_pwritev(int32_t fd, const uint8_t *iov_ptr, int32_t iovcnt,
                       uint32_t offset_lo, int32_t offset_hi);

KERNEL_IMPORT(kernel_sendfile)
int32_t kernel_sendfile(int32_t out_fd, int32_t in_fd, uint8_t *offset_ptr,
                        uint32_t count);

KERNEL_IMPORT(kernel_statx)
int32_t kernel_statx(int32_t dirfd, const uint8_t *path_ptr,
                     uint32_t path_len, uint32_t flags, uint32_t mask,
                     uint8_t *statx_ptr);

/* ------------------------------------------------------------------ */
/* Thread / runtime                                                    */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_gettid)
int32_t kernel_gettid(void);

KERNEL_IMPORT(kernel_set_tid_address)
int32_t kernel_set_tid_address(uint32_t tidptr);

KERNEL_IMPORT(kernel_set_robust_list)
int32_t kernel_set_robust_list(uint32_t head, uint32_t len);

KERNEL_IMPORT(kernel_get_robust_list)
int32_t kernel_get_robust_list(uint32_t pid, uint32_t head_ptr, uint32_t len_ptr);

KERNEL_IMPORT(kernel_futex)
int32_t kernel_futex(uint32_t uaddr, uint32_t op, uint32_t val,
                     uint32_t timeout, uint32_t uaddr2, uint32_t val3);

KERNEL_IMPORT(kernel_clone)
int32_t kernel_clone(uint32_t fn_ptr, uint32_t stack_ptr, uint32_t flags,
                     uint32_t arg, uint32_t ptid_ptr, uint32_t tls_ptr,
                     uint32_t ctid_ptr);

/* ------------------------------------------------------------------ */
/* Process control                                                     */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_exit)
_Noreturn void kernel_exit(int32_t status);

KERNEL_IMPORT(kernel_execve)
int32_t kernel_execve(const uint8_t *path_ptr, uint32_t path_len);

KERNEL_IMPORT(kernel_fork)
int32_t kernel_fork(void);

KERNEL_IMPORT(kernel_is_fork_child)
int32_t kernel_is_fork_child(void);

KERNEL_IMPORT(kernel_get_fork_exec_path)
int32_t kernel_get_fork_exec_path(uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_get_fork_exec_argv)
int32_t kernel_get_fork_exec_argv(uint32_t idx, uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_get_fork_exec_argc)
int32_t kernel_get_fork_exec_argc(void);

KERNEL_IMPORT(kernel_set_fork_exec)
int32_t kernel_set_fork_exec(const uint8_t *path_ptr, uint32_t path_len,
                              const uint32_t *argv_ptrs, uint32_t argc);

KERNEL_IMPORT(kernel_set_fork_fd_action)
int32_t kernel_set_fork_fd_action(uint32_t action_type, int32_t fd1, int32_t fd2);

KERNEL_IMPORT(kernel_apply_fork_fd_actions)
int32_t kernel_apply_fork_fd_actions(void);

KERNEL_IMPORT(kernel_clear_fork_exec)
int32_t kernel_clear_fork_exec(void);

/* ------------------------------------------------------------------ */
/* Resource limits                                                     */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_getrlimit)
int32_t kernel_getrlimit(uint32_t resource, uint8_t *rlim_ptr);

KERNEL_IMPORT(kernel_setrlimit)
int32_t kernel_setrlimit(uint32_t resource, const uint8_t *rlim_ptr);

KERNEL_IMPORT(kernel_getrusage)
int32_t kernel_getrusage(int32_t who, uint8_t *buf_ptr, uint32_t buf_len);

/* ------------------------------------------------------------------ */
/* System info                                                         */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_prctl)
int32_t kernel_prctl(uint32_t option, uint32_t arg2, uint8_t *buf_ptr,
                     uint32_t buf_len);

KERNEL_IMPORT(kernel_umask)
uint32_t kernel_umask(uint32_t mask);

KERNEL_IMPORT(kernel_uname)
int32_t kernel_uname(uint8_t *buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_sysconf)
int64_t kernel_sysconf(int32_t name);

KERNEL_IMPORT(kernel_pathconf)
int64_t kernel_pathconf(const uint8_t *path_ptr, uint32_t path_len, int32_t name);

KERNEL_IMPORT(kernel_fpathconf)
int64_t kernel_fpathconf(int32_t fd, int32_t name);

KERNEL_IMPORT(kernel_realpath)
int32_t kernel_realpath(const uint8_t *path_ptr, uint32_t path_len,
                        uint8_t *buf_ptr, uint32_t buf_len);

/* ------------------------------------------------------------------ */
/* *at() variants                                                      */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_openat)
int32_t kernel_openat(int32_t dirfd, const uint8_t *path_ptr,
                      uint32_t path_len, uint32_t flags, uint32_t mode);

KERNEL_IMPORT(kernel_fstatat)
int32_t kernel_fstatat(int32_t dirfd, const uint8_t *path_ptr,
                       uint32_t path_len, uint8_t *stat_ptr, uint32_t flags);

KERNEL_IMPORT(kernel_unlinkat)
int32_t kernel_unlinkat(int32_t dirfd, const uint8_t *path_ptr,
                        uint32_t path_len, uint32_t flags);

KERNEL_IMPORT(kernel_mkdirat)
int32_t kernel_mkdirat(int32_t dirfd, const uint8_t *path_ptr,
                       uint32_t path_len, uint32_t mode);

KERNEL_IMPORT(kernel_renameat)
int32_t kernel_renameat(int32_t olddirfd, const uint8_t *old_ptr,
                        uint32_t old_len, int32_t newdirfd,
                        const uint8_t *new_ptr, uint32_t new_len);

KERNEL_IMPORT(kernel_faccessat)
int32_t kernel_faccessat(int32_t dirfd, const uint8_t *path_ptr,
                         uint32_t path_len, uint32_t amode, uint32_t flags);

KERNEL_IMPORT(kernel_fchmodat)
int32_t kernel_fchmodat(int32_t dirfd, const uint8_t *path_ptr,
                        uint32_t path_len, uint32_t mode, uint32_t flags);

KERNEL_IMPORT(kernel_fchownat)
int32_t kernel_fchownat(int32_t dirfd, const uint8_t *path_ptr,
                        uint32_t path_len, uint32_t uid, uint32_t gid,
                        uint32_t flags);

KERNEL_IMPORT(kernel_linkat)
int32_t kernel_linkat(int32_t olddirfd, const uint8_t *old_ptr,
                      uint32_t old_len, int32_t newdirfd,
                      const uint8_t *new_ptr, uint32_t new_len,
                      uint32_t flags);

KERNEL_IMPORT(kernel_symlinkat)
int32_t kernel_symlinkat(const uint8_t *target_ptr, uint32_t target_len,
                         int32_t newdirfd, const uint8_t *link_ptr,
                         uint32_t link_len);

KERNEL_IMPORT(kernel_readlinkat)
int32_t kernel_readlinkat(int32_t dirfd, const uint8_t *path_ptr,
                          uint32_t path_len, uint8_t *buf_ptr,
                          uint32_t buf_len);

/* ------------------------------------------------------------------ */
/* Socket operations                                                   */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_socket)
int32_t kernel_socket(uint32_t domain, uint32_t sock_type, uint32_t protocol);

KERNEL_IMPORT(kernel_socketpair)
int32_t kernel_socketpair(uint32_t domain, uint32_t sock_type,
                          uint32_t protocol, int32_t *sv_ptr);

KERNEL_IMPORT(kernel_bind)
int32_t kernel_bind(int32_t fd, const uint8_t *addr_ptr, uint32_t addr_len);

KERNEL_IMPORT(kernel_listen)
int32_t kernel_listen(int32_t fd, uint32_t backlog);

KERNEL_IMPORT(kernel_accept)
int32_t kernel_accept(int32_t fd);

KERNEL_IMPORT(kernel_connect)
int32_t kernel_connect(int32_t fd, const uint8_t *addr_ptr, uint32_t addr_len);

KERNEL_IMPORT(kernel_send)
int32_t kernel_send(int32_t fd, const uint8_t *buf_ptr, uint32_t buf_len,
                    uint32_t flags);

KERNEL_IMPORT(kernel_recv)
int32_t kernel_recv(int32_t fd, uint8_t *buf_ptr, uint32_t buf_len,
                    uint32_t flags);

KERNEL_IMPORT(kernel_shutdown)
int32_t kernel_shutdown(int32_t fd, uint32_t how);

KERNEL_IMPORT(kernel_getsockopt)
int32_t kernel_getsockopt(int32_t fd, uint32_t level, uint32_t optname,
                          uint32_t *optval_ptr);

KERNEL_IMPORT(kernel_setsockopt)
int32_t kernel_setsockopt(int32_t fd, uint32_t level, uint32_t optname,
                          uint32_t optval);

KERNEL_IMPORT(kernel_getsockname)
int32_t kernel_getsockname(int32_t fd, uint32_t buf_ptr, uint32_t buf_len);

KERNEL_IMPORT(kernel_getpeername)
int32_t kernel_getpeername(int32_t fd, uint32_t buf_ptr, uint32_t buf_len);

/* ------------------------------------------------------------------ */
/* I/O multiplexing                                                    */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_poll)
int32_t kernel_poll(uint8_t *fds_ptr, uint32_t nfds, int32_t timeout);

KERNEL_IMPORT(kernel_ppoll)
int32_t kernel_ppoll(uint8_t *fds_ptr, uint32_t nfds, int32_t timeout_ms,
                     uint32_t mask_lo, uint32_t mask_hi);

KERNEL_IMPORT(kernel_pselect6)
int32_t kernel_pselect6(int32_t nfds, uint8_t *readfds_ptr,
                        uint8_t *writefds_ptr, uint8_t *exceptfds_ptr,
                        int32_t timeout_ms, uint32_t mask_lo, uint32_t mask_hi);

KERNEL_IMPORT(kernel_sendto)
int32_t kernel_sendto(int32_t fd, const uint8_t *buf_ptr, uint32_t buf_len,
                      uint32_t flags, const uint8_t *addr_ptr,
                      uint32_t addr_len);

KERNEL_IMPORT(kernel_recvfrom)
int32_t kernel_recvfrom(int32_t fd, uint8_t *buf_ptr, uint32_t buf_len,
                        uint32_t flags, uint8_t *addr_ptr, uint32_t addr_len);

KERNEL_IMPORT(kernel_select)
int32_t kernel_select(int32_t nfds, uint8_t *readfds_ptr,
                      uint8_t *writefds_ptr, uint8_t *exceptfds_ptr,
                      int32_t timeout_ms);

/* ------------------------------------------------------------------ */
/* User / Group                                                        */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_setuid)
int32_t kernel_setuid(uint32_t uid);

KERNEL_IMPORT(kernel_setgid)
int32_t kernel_setgid(uint32_t gid);

KERNEL_IMPORT(kernel_seteuid)
int32_t kernel_seteuid(uint32_t euid);

KERNEL_IMPORT(kernel_setegid)
int32_t kernel_setegid(uint32_t egid);

/* ------------------------------------------------------------------ */
/* Random                                                              */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_getrandom)
int32_t kernel_getrandom(uint8_t *buf_ptr, uint32_t buf_len, uint32_t flags);

/* ------------------------------------------------------------------ */
/* File locking                                                        */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_flock)
int32_t kernel_flock(int32_t fd, uint32_t operation);

KERNEL_IMPORT(kernel_utimensat)
int32_t kernel_utimensat(int32_t dirfd, const uint8_t *path_ptr,
                         uint32_t path_len, const uint8_t *times_ptr,
                         uint32_t flags);

KERNEL_IMPORT(kernel_madvise)
int32_t kernel_madvise(uint32_t addr, uint32_t len, uint32_t advice);

/* ------------------------------------------------------------------ */
/* Filesystem info                                                     */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_statfs)
int32_t kernel_statfs(const uint8_t *path_ptr, uint32_t path_len,
                      uint8_t *buf_ptr);

KERNEL_IMPORT(kernel_fstatfs)
int32_t kernel_fstatfs(int32_t fd, uint8_t *buf_ptr);

/* ------------------------------------------------------------------ */
/* Identity (res* variants)                                            */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_setresuid)
int32_t kernel_setresuid(uint32_t ruid, uint32_t euid, uint32_t suid);

KERNEL_IMPORT(kernel_getresuid)
int32_t kernel_getresuid(uint32_t *ruid_ptr, uint32_t *euid_ptr,
                         uint32_t *suid_ptr);

KERNEL_IMPORT(kernel_setresgid)
int32_t kernel_setresgid(uint32_t rgid, uint32_t egid, uint32_t sgid);

KERNEL_IMPORT(kernel_getresgid)
int32_t kernel_getresgid(uint32_t *rgid_ptr, uint32_t *egid_ptr,
                         uint32_t *sgid_ptr);

KERNEL_IMPORT(kernel_getgroups)
int32_t kernel_getgroups(uint32_t size, uint32_t *list_ptr);

KERNEL_IMPORT(kernel_setgroups)
int32_t kernel_setgroups(uint32_t size, const uint32_t *list_ptr);

/* ------------------------------------------------------------------ */
/* Message-based socket I/O                                            */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_sendmsg)
int32_t kernel_sendmsg(int32_t fd, const uint8_t *msg_ptr, uint32_t flags);

KERNEL_IMPORT(kernel_recvmsg)
int32_t kernel_recvmsg(int32_t fd, uint8_t *msg_ptr, uint32_t flags);

KERNEL_IMPORT(kernel_getaddrinfo)
int32_t kernel_getaddrinfo(const uint8_t *name_ptr, uint32_t name_len,
                           uint8_t *result_ptr);

/* ------------------------------------------------------------------ */
/* Process waiting                                                     */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_wait4)
int32_t kernel_wait4(int32_t pid, int32_t *wstatus_ptr, uint32_t options,
                     uint8_t *rusage_ptr);

/* ------------------------------------------------------------------ */
/* Argv                                                                */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_push_argv)
void kernel_push_argv(const uint8_t *ptr, uint32_t len);

KERNEL_IMPORT(kernel_get_argc)
uint32_t kernel_get_argc(void);

KERNEL_IMPORT(kernel_argv_read)
uint32_t kernel_argv_read(uint32_t index, uint8_t *buf_ptr, uint32_t buf_max);

/* ------------------------------------------------------------------ */
/* SysV IPC                                                            */
/* ------------------------------------------------------------------ */

KERNEL_IMPORT(kernel_ipc_msgget)
int32_t kernel_ipc_msgget(int32_t key, int32_t flags);

KERNEL_IMPORT(kernel_ipc_msgsnd)
int32_t kernel_ipc_msgsnd(int32_t qid, int32_t msg_ptr, int32_t msg_sz,
                          int32_t flags);

KERNEL_IMPORT(kernel_ipc_msgrcv)
int32_t kernel_ipc_msgrcv(int32_t qid, int32_t msg_ptr, int32_t msg_sz,
                          int32_t msgtyp, int32_t flags);

KERNEL_IMPORT(kernel_ipc_msgctl)
int32_t kernel_ipc_msgctl(int32_t qid, int32_t cmd, int32_t buf_ptr);

KERNEL_IMPORT(kernel_ipc_semget)
int32_t kernel_ipc_semget(int32_t key, int32_t nsems, int32_t flags);

KERNEL_IMPORT(kernel_ipc_semop)
int32_t kernel_ipc_semop(int32_t semid, int32_t sops_ptr, int32_t nsops);

KERNEL_IMPORT(kernel_ipc_semctl)
int32_t kernel_ipc_semctl(int32_t semid, int32_t semnum, int32_t cmd,
                          int32_t arg);

KERNEL_IMPORT(kernel_ipc_shmget)
int32_t kernel_ipc_shmget(int32_t key, int32_t size, int32_t flags);

KERNEL_IMPORT(kernel_ipc_shmat)
int32_t kernel_ipc_shmat(int32_t shmid, int32_t shmaddr, int32_t flags);

KERNEL_IMPORT(kernel_ipc_shmdt)
int32_t kernel_ipc_shmdt(int32_t addr);

KERNEL_IMPORT(kernel_ipc_shmctl)
int32_t kernel_ipc_shmctl(int32_t shmid, int32_t cmd, int32_t buf_ptr);

#endif /* SYSCALL_IMPORTS_H */
