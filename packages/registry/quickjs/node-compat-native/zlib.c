#include "zlib.h"
#include "cutils.h"

#include <zlib.h>
#include <stdlib.h>
#include <string.h>

#define ZLIB_MODE_DEFLATE 0
#define ZLIB_MODE_INFLATE 1

#define ZLIB_WBITS_ZLIB   (15)
#define ZLIB_WBITS_GZIP   (31)

#define ZLIB_OUT_HEADROOM 256

static JSClassID zlib_class_id;

typedef struct {
    z_stream zs;
    int mode; /* ZLIB_MODE_DEFLATE or ZLIB_MODE_INFLATE */
} JSNodeZlib;

static void zlib_destroy(JSNodeZlib *z)
{
    if (z->mode == ZLIB_MODE_DEFLATE) deflateEnd(&z->zs);
    else inflateEnd(&z->zs);
    free(z);
}

static void zlib_finalizer(JSRuntime *rt, JSValue val)
{
    JSNodeZlib *z = JS_GetOpaque(val, zlib_class_id);
    if (z) zlib_destroy(z);
}

static const JSClassDef zlib_class = {
    .class_name = "ZlibStream",
    .finalizer = zlib_finalizer,
};

static int normalize_level(JSContext *ctx, JSValueConst v, int *out)
{
    if (JS_IsUndefined(v)) {
        *out = Z_DEFAULT_COMPRESSION;
        return 0;
    }
    int32_t lvl;
    if (JS_ToInt32(ctx, &lvl, v) < 0) return -1;
    if (lvl != Z_DEFAULT_COMPRESSION && (lvl < 0 || lvl > 9)) {
        JS_ThrowRangeError(ctx, "zlib: level must be -1 or 0..9");
        return -1;
    }
    *out = lvl;
    return 0;
}

static JSNodeZlib *zlib_new(JSContext *ctx, int mode, int window_bits, int level)
{
    JSNodeZlib *z = calloc(1, sizeof(*z));
    if (!z) {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
    }
    int rc = (mode == ZLIB_MODE_DEFLATE)
        ? deflateInit2(&z->zs, level, Z_DEFLATED, window_bits,
                       8 /* memLevel */, Z_DEFAULT_STRATEGY)
        : inflateInit2(&z->zs, window_bits);
    if (rc != Z_OK) {
        free(z);
        JS_ThrowInternalError(ctx, "zlib: init failed (%d)", rc);
        return NULL;
    }
    z->mode = mode;
    return z;
}

static JSValue zlib_run(JSContext *ctx, JSNodeZlib *z,
                        const uint8_t *input, size_t input_len, int final)
{
    z->zs.next_in = (Bytef *)input;
    z->zs.avail_in = (uInt)input_len;

    /* Chunks list, not a realloc'd single buffer: in our wasm zlib + musl
     * realloc combination, growing the user output buffer mid-stream zero'd
     * the already-emitted prefix. */
    enum { CHUNK = 64 * 1024 };
    typedef struct chunk_s { struct chunk_s *next; size_t used; uint8_t data[CHUNK]; } chunk_t;
    chunk_t *head = NULL, *tail = NULL;
    size_t total = 0;
    int flush = final ? Z_FINISH : Z_NO_FLUSH;

    #define APPEND_CHUNK() do { \
        chunk_t *c = malloc(sizeof(chunk_t)); \
        if (!c) goto oom; \
        c->next = NULL; c->used = 0; \
        if (tail) tail->next = c; else head = c; \
        tail = c; \
    } while (0)

    APPEND_CHUNK();

    for (;;) {
        if (CHUNK - tail->used < ZLIB_OUT_HEADROOM) {
            APPEND_CHUNK();
        }
        z->zs.next_out = tail->data + tail->used;
        z->zs.avail_out = (uInt)(CHUNK - tail->used);

        int rc = (z->mode == ZLIB_MODE_DEFLATE)
            ? deflate(&z->zs, flush)
            : inflate(&z->zs, flush);

        size_t produced = (uint8_t *)z->zs.next_out - (tail->data + tail->used);
        tail->used += produced;
        total += produced;

        if (rc == Z_STREAM_END) break;
        if (rc == Z_BUF_ERROR) {
            if (z->zs.avail_in == 0 && z->zs.avail_out > 0) break;
            continue;
        }
        if (rc != Z_OK) {
            for (chunk_t *c = head; c; ) { chunk_t *n = c->next; free(c); c = n; }
            return JS_ThrowInternalError(ctx, "zlib: %s",
                                         z->zs.msg ? z->zs.msg : "error");
        }
        if (!final && z->zs.avail_in == 0) break;
    }

    uint8_t *out = malloc(total ? total : 1);
    if (!out) goto oom;
    size_t off = 0;
    for (chunk_t *c = head; c; c = c->next) {
        memcpy(out + off, c->data, c->used);
        off += c->used;
    }
    for (chunk_t *c = head; c; ) { chunk_t *n = c->next; free(c); c = n; }

    JSValue result = JS_NewUint8ArrayCopy(ctx, out, total);
    free(out);
    return result;

oom:
    for (chunk_t *c = head; c; ) { chunk_t *n = c->next; free(c); c = n; }
    return JS_ThrowOutOfMemory(ctx);
}

static uint8_t *get_input_buffer(JSContext *ctx, JSValueConst v, size_t *len_out)
{
    uint8_t *buf = JS_GetUint8Array(ctx, len_out, v);
    if (!buf) {
        JS_ThrowTypeError(ctx, "zlib: input must be Uint8Array or Buffer");
        return NULL;
    }
    return buf;
}

static JSValue js_zlib_write(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    JSNodeZlib *z = JS_GetOpaque(this_val, zlib_class_id);
    if (!z)
        return JS_ThrowTypeError(ctx, "zlib: write on invalid object");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "zlib.write: input required");

    size_t in_len = 0;
    uint8_t *in_buf = get_input_buffer(ctx, argv[0], &in_len);
    if (!in_buf) return JS_EXCEPTION;

    int final = (argc >= 2) ? JS_ToBool(ctx, argv[1]) : 0;
    if (final < 0) return JS_EXCEPTION;

    return zlib_run(ctx, z, in_buf, in_len, final);
}

static const JSCFunctionListEntry zlib_proto_funcs[] = {
    JS_CFUNC_DEF("write", 2, js_zlib_write),
};

int node_native_zlib_init(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    if (zlib_class_id == 0)
        JS_NewClassID(rt, &zlib_class_id);
    if (!JS_IsRegisteredClass(rt, zlib_class_id)) {
        if (JS_NewClass(rt, zlib_class_id, &zlib_class) < 0)
            return -1;
    }
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, zlib_proto_funcs,
                               countof(zlib_proto_funcs));
    JS_SetClassProto(ctx, zlib_class_id, proto);
    return 0;
}

static JSValue make_stream(JSContext *ctx, int mode, int window_bits, int level)
{
    JSNodeZlib *z = zlib_new(ctx, mode, window_bits, level);
    if (!z) return JS_EXCEPTION;
    JSValue obj = JS_NewObjectClass(ctx, zlib_class_id);
    if (JS_IsException(obj)) {
        zlib_destroy(z);
        return obj;
    }
    JS_SetOpaque(obj, z);
    return obj;
}

JSValue js_node_native_create_deflate(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    int level = Z_DEFAULT_COMPRESSION;
    if (argc >= 1 && normalize_level(ctx, argv[0], &level) < 0)
        return JS_EXCEPTION;
    return make_stream(ctx, ZLIB_MODE_DEFLATE, ZLIB_WBITS_ZLIB, level);
}

JSValue js_node_native_create_inflate(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    return make_stream(ctx, ZLIB_MODE_INFLATE, ZLIB_WBITS_ZLIB, 0);
}

JSValue js_node_native_create_gzip(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    int level = Z_DEFAULT_COMPRESSION;
    if (argc >= 1 && normalize_level(ctx, argv[0], &level) < 0)
        return JS_EXCEPTION;
    return make_stream(ctx, ZLIB_MODE_DEFLATE, ZLIB_WBITS_GZIP, level);
}

JSValue js_node_native_create_gunzip(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    return make_stream(ctx, ZLIB_MODE_INFLATE, ZLIB_WBITS_GZIP, 0);
}

static JSValue one_shot(JSContext *ctx, int mode, int window_bits, int level,
                        JSValueConst input_val)
{
    size_t in_len = 0;
    uint8_t *in_buf = get_input_buffer(ctx, input_val, &in_len);
    if (!in_buf) return JS_EXCEPTION;

    JSNodeZlib *z = zlib_new(ctx, mode, window_bits, level);
    if (!z) return JS_EXCEPTION;
    JSValue result = zlib_run(ctx, z, in_buf, in_len, 1);
    zlib_destroy(z);
    return result;
}

JSValue js_node_native_deflate_sync(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "deflateSync: input required");
    int level = Z_DEFAULT_COMPRESSION;
    if (argc >= 2 && normalize_level(ctx, argv[1], &level) < 0)
        return JS_EXCEPTION;
    return one_shot(ctx, ZLIB_MODE_DEFLATE, ZLIB_WBITS_ZLIB, level, argv[0]);
}

JSValue js_node_native_inflate_sync(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "inflateSync: input required");
    return one_shot(ctx, ZLIB_MODE_INFLATE, ZLIB_WBITS_ZLIB, 0, argv[0]);
}

JSValue js_node_native_gzip_sync(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "gzipSync: input required");
    int level = Z_DEFAULT_COMPRESSION;
    if (argc >= 2 && normalize_level(ctx, argv[1], &level) < 0)
        return JS_EXCEPTION;
    return one_shot(ctx, ZLIB_MODE_DEFLATE, ZLIB_WBITS_GZIP, level, argv[0]);
}

JSValue js_node_native_gunzip_sync(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "gunzipSync: input required");
    return one_shot(ctx, ZLIB_MODE_INFLATE, ZLIB_WBITS_GZIP, 0, argv[0]);
}
