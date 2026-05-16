#ifndef NODE_COMPAT_NATIVE_ZLIB_H
#define NODE_COMPAT_NATIVE_ZLIB_H

#include "quickjs.h"

int node_native_zlib_init(JSContext *ctx);

JSValue js_node_native_create_deflate(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv);
JSValue js_node_native_create_inflate(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv);
JSValue js_node_native_create_gzip(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv);
JSValue js_node_native_create_gunzip(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv);

JSValue js_node_native_deflate_sync(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv);
JSValue js_node_native_inflate_sync(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv);
JSValue js_node_native_gzip_sync(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv);
JSValue js_node_native_gunzip_sync(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv);

#endif
