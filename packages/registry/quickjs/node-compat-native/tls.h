#ifndef NODE_COMPAT_NATIVE_TLS_H
#define NODE_COMPAT_NATIVE_TLS_H

#include "quickjs.h"

JSValue js_node_native_tls_connect(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv);
JSValue js_node_native_tls_read(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv);
JSValue js_node_native_tls_write(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv);
JSValue js_node_native_tls_close(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv);

int js_node_tls_dispatch(JSContext *ctx);
int js_node_tls_has_watches(void);

#endif
