#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
/* Shared connection TU keeps canonical server behavior when no client hook is
 * linked/active. Actual client callbacks alone supply retained context. */
#include <ffi.h>
#include "wayland-private.h"
#if defined(__APPLE__)
__attribute__((weak_import)) void _wpk_wl_client_ffi_call(ffi_cif *,void (*)(void),void *,void **);
__attribute__((weak_import)) int _wpk_wl_client_dispatcher_call(wl_dispatcher_func_t,const void *,void *,uint32_t,const struct wl_message *,union wl_argument *);
#else
__attribute__((weak)) void _wpk_wl_client_ffi_call(ffi_cif *,void (*)(void),void *,void **);
__attribute__((weak)) int _wpk_wl_client_dispatcher_call(wl_dispatcher_func_t,const void *,void *,uint32_t,const struct wl_message *,union wl_argument *);
#endif
static void wpk_wl_connection_ffi_call(ffi_cif *cif,void (*fn)(void),void *result,void **args){
    if(_wpk_wl_client_ffi_call)_wpk_wl_client_ffi_call(cif,fn,result,args);else ffi_call(cif,fn,result,args);
}
static int wpk_wl_connection_dispatcher(wl_dispatcher_func_t fn,const void *implementation,void *target,uint32_t opcode,const struct wl_message *message,union wl_argument *args){
    return _wpk_wl_client_dispatcher_call?_wpk_wl_client_dispatcher_call(fn,implementation,target,opcode,message,args):fn(implementation,target,opcode,message,args);
}
#define ffi_call wpk_wl_connection_ffi_call
#define dispatcher(implementation,target,opcode,message,args) wpk_wl_connection_dispatcher(dispatcher,implementation,target,opcode,message,args)
