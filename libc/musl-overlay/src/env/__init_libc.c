#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#include "syscall.h"
#include "libc.h"
#include "pthread_impl.h"

extern unsigned long __wasm_tp_storage[64];
extern _Thread_local unsigned long __wasm_thread_pointer;
extern int __init_tp(void *);
extern int32_t kernel_get_secure_exec(void)
	__attribute__((import_module("kernel"), import_name("kernel_get_secure_exec")));

static _Noreturn void secure_startup_failure(void)
{
	__syscall(SYS_exit_group, 127);
	for (;;) __asm__ ("" ::: "memory");
}

static void secure_standard_fds(void)
{
	for (int fd = 0; fd != 3; ++fd) {
		if (__syscall(SYS_fcntl, fd, F_GETFD) != -EBADF) continue;
		int opened = __syscall(SYS_openat, AT_FDCWD, "/dev/null", O_RDWR, 0);
		if (opened < 0) secure_startup_failure();
		if (opened != fd && __syscall(SYS_dup2, opened, fd) < 0)
			secure_startup_failure();
		if (opened != fd) __syscall(SYS_close, opened);
	}
}

void __init_libc(char **envp, char *pn)
{
	size_t index;
	libc.secure = kernel_get_secure_exec() != 0;
	if (libc.secure) secure_standard_fds();
	__environ = envp;
	libc.page_size = 65536;
	libc.tls_size = 2*sizeof(void *) + sizeof(struct pthread);
	libc.tls_align = _Alignof(struct pthread) > 4 ? _Alignof(struct pthread) : 4;
	if (!pn) pn = "";
	__progname = __progname_full = pn;
	for (index=0; pn[index]; index++) if (pn[index]=='/') __progname = pn+index+1;
	__wasm_thread_pointer = (unsigned long)__wasm_tp_storage;
	__init_tp((void *)__wasm_tp_storage);
}
