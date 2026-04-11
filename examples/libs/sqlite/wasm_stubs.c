/* Stubs for test modules excluded from the wasm32 testfixture build.
 *
 * test_thread.c requires pthreads (SQLITE_THREADSAFE=0 disables threading).
 * test_syscall.c overrides Unix VFS syscalls (conflicts with wasm kernel).
 *
 * test_tclsh.c references both _Init functions unconditionally, so we
 * provide no-op stubs to satisfy the linker.
 */

#include <tcl.h>

int SqlitetestThread_Init(Tcl_Interp *interp) {
    return TCL_OK;
}

int SqlitetestSyscall_Init(Tcl_Interp *interp) {
    return TCL_OK;
}
