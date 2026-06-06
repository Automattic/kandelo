/* Stubs for test modules excluded from the wasm32 testfixture build.
 *
 * test_thread.c is still excluded because it creates native pthreads.
 * test_tclsh.c references its _Init function unconditionally, so provide a
 * no-op stub to satisfy the linker.
 */

#include <tcl.h>

int SqlitetestThread_Init(Tcl_Interp *interp) {
    return TCL_OK;
}
