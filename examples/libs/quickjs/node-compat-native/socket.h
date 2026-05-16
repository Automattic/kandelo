#ifndef NODE_COMPAT_NATIVE_SOCKET_H
#define NODE_COMPAT_NATIVE_SOCKET_H

#include "quickjs.h"

JSValue js_node_native_socket_connect(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv);
JSValue js_node_native_socket_read(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv);
JSValue js_node_native_socket_write(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv);
JSValue js_node_native_socket_close(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv);

/* Drive pending fd watches one tick. Returns number of resolved entries.
   Called from the main loop in node-main.c after pending jobs are drained. */
int js_node_socket_dispatch(JSContext *ctx);

/* True if any fd is currently being watched. Lets the loop know it needs
   to keep ticking even when there are no JS jobs / timers. */
int js_node_socket_has_watches(void);

#endif
