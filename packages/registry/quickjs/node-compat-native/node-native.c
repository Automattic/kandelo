#include "node-native.h"
#include "cutils.h"

#include <errno.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <termios.h>
#include <unistd.h>

#include "hash.h"
#include "hmac.h"
#include "zlib.h"
#include "socket.h"
#include "tls.h"
#include "json.h"

/* evalScriptAsFunction(source, filename) — JS_Eval with caller-supplied
   filename. Used by the bootstrap's CommonJS require() so wrapped module
   bodies have a real [[ScriptOrModule]] identity; without that, dynamic
   import() inside a require()'d file falls back to JS_ATOM_NULL and
   bare-specifier resolution can't tell which node_modules tree to walk. */
static JSValue js_node_native_eval_script_as_function(JSContext *ctx,
                                                       JSValueConst this_val,
                                                       int argc,
                                                       JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "evalScriptAsFunction(source, filename)");
    size_t source_len;
    const char *source = JS_ToCStringLen(ctx, &source_len, argv[0]);
    if (!source)
        return JS_EXCEPTION;
    const char *filename = JS_ToCString(ctx, argv[1]);
    if (!filename) {
        JS_FreeCString(ctx, source);
        return JS_EXCEPTION;
    }
    JSValue ret = JS_Eval(ctx, source, source_len, filename, JS_EVAL_TYPE_GLOBAL);
    JS_FreeCString(ctx, source);
    JS_FreeCString(ctx, filename);
    return ret;
}

/* decodeUtf8(u8) — UTF-8 bytes to JS string in one pass. The TextDecoder
   polyfill walks bytes in JS and joins 8 K codepoint chunks; on a 38 MB
   npm packument that's ~10 s. JS_NewStringLen takes UTF-8 directly. */
static JSValue js_node_native_decode_utf8(JSContext *ctx,
                                          JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    size_t len;
    uint8_t *buf = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!buf)
        return JS_ThrowTypeError(ctx,
            "decodeUtf8: arg must be Uint8Array/Buffer");
    return JS_NewStringLen(ctx, (const char *)buf, len);
}

/* setRawMode(fd, raw) — Node-parity binding for tcsetattr(cfmakeraw(...)).
   JS can't call tcsetattr directly; without raw mode the kernel's cooked
   PTY (ICRNL/ICANON/ECHO) line-buffers input and echoes, breaking TUIs.
   One saved-termios slot is enough — only stdin is ever set raw. */
static struct termios g_saved_termios;
static int g_saved_fd = -1; /* -1 → no saved state */

static JSValue js_node_native_set_raw_mode(JSContext *ctx,
                                           JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
    int fd;
    int raw;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "setRawMode(fd, raw)");
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    raw = JS_ToBool(ctx, argv[1]);
    if (raw < 0)
        return JS_EXCEPTION;

    if (raw) {
        struct termios t;
        if (tcgetattr(fd, &t) < 0) {
            return JS_ThrowInternalError(ctx,
                "setRawMode: tcgetattr(%d) failed (errno=%d)", fd, errno);
        }
        if (g_saved_fd != fd) {
            g_saved_termios = t;
            g_saved_fd = fd;
        }
        cfmakeraw(&t);
        if (tcsetattr(fd, TCSANOW, &t) < 0) {
            return JS_ThrowInternalError(ctx,
                "setRawMode: tcsetattr(%d, raw) failed (errno=%d)", fd, errno);
        }
    } else {
        if (g_saved_fd == fd) {
            if (tcsetattr(fd, TCSANOW, &g_saved_termios) < 0) {
                return JS_ThrowInternalError(ctx,
                    "setRawMode: tcsetattr(%d, restore) failed (errno=%d)",
                    fd, errno);
            }
            g_saved_fd = -1;
        }
        /* No saved state → nothing to restore; treat as a no-op. */
    }
    return JS_UNDEFINED;
}

static int native_errno(int ret)
{
    return ret == -1 ? -errno : ret;
}

static JSValue js_node_native_chmod(JSContext *ctx,
                                    JSValueConst this_val,
                                    int argc,
                                    JSValueConst *argv)
{
    const char *path;
    int32_t mode;
    int ret;

    if (argc < 2)
        return JS_ThrowTypeError(ctx, "chmod(path, mode)");
    path = JS_ToCString(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &mode, argv[1])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    ret = native_errno(chmod(path, (mode_t)mode));
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, ret);
}

static JSValue js_node_native_fchmod(JSContext *ctx,
                                     JSValueConst this_val,
                                     int argc,
                                     JSValueConst *argv)
{
    int32_t fd;
    int32_t mode;

    if (argc < 2)
        return JS_ThrowTypeError(ctx, "fchmod(fd, mode)");
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &mode, argv[1]))
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, native_errno(fchmod(fd, (mode_t)mode)));
}

static JSValue js_node_native_chown(JSContext *ctx,
                                    JSValueConst this_val,
                                    int argc,
                                    JSValueConst *argv)
{
    const char *path;
    int32_t uid;
    int32_t gid;
    int ret;

    if (argc < 3)
        return JS_ThrowTypeError(ctx, "chown(path, uid, gid)");
    path = JS_ToCString(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &uid, argv[1]) ||
        JS_ToInt32(ctx, &gid, argv[2])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    ret = native_errno(chown(path, (uid_t)uid, (gid_t)gid));
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, ret);
}

static JSValue js_node_native_fchown(JSContext *ctx,
                                     JSValueConst this_val,
                                     int argc,
                                     JSValueConst *argv)
{
    int32_t fd;
    int32_t uid;
    int32_t gid;

    if (argc < 3)
        return JS_ThrowTypeError(ctx, "fchown(fd, uid, gid)");
    if (JS_ToInt32(ctx, &fd, argv[0]) ||
        JS_ToInt32(ctx, &uid, argv[1]) ||
        JS_ToInt32(ctx, &gid, argv[2]))
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, native_errno(fchown(fd, (uid_t)uid, (gid_t)gid)));
}

static void seconds_to_timeval(double seconds, struct timeval *tv)
{
    time_t sec = (time_t)seconds;
    double frac = seconds - (double)sec;
    suseconds_t usec = (suseconds_t)(frac * 1000000.0);
    if (usec < 0) {
        sec -= 1;
        usec += 1000000;
    }
    tv->tv_sec = sec;
    tv->tv_usec = usec;
}

static JSValue js_node_native_futimes(JSContext *ctx,
                                      JSValueConst this_val,
                                      int argc,
                                      JSValueConst *argv)
{
    int32_t fd;
    double atime;
    double mtime;
    struct timeval tv[2];

    if (argc < 3)
        return JS_ThrowTypeError(ctx, "futimes(fd, atime, mtime)");
    if (JS_ToInt32(ctx, &fd, argv[0]) ||
        JS_ToFloat64(ctx, &atime, argv[1]) ||
        JS_ToFloat64(ctx, &mtime, argv[2]))
        return JS_EXCEPTION;
    seconds_to_timeval(atime, &tv[0]);
    seconds_to_timeval(mtime, &tv[1]);
    return JS_NewInt32(ctx, native_errno(futimes(fd, tv)));
}

static JSValue js_node_native_fsync(JSContext *ctx,
                                    JSValueConst this_val,
                                    int argc,
                                    JSValueConst *argv)
{
    int32_t fd;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "fsync(fd)");
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, native_errno(fsync(fd)));
}

static const JSCFunctionListEntry node_native_funcs[] = {
    JS_CFUNC_DEF("evalScriptAsFunction", 2, js_node_native_eval_script_as_function),
    JS_CFUNC_DEF("createHash", 1, js_node_native_create_hash),
    JS_CFUNC_DEF("createHmac", 2, js_node_native_create_hmac),
    JS_CFUNC_DEF("createDeflate", 1, js_node_native_create_deflate),
    JS_CFUNC_DEF("createInflate", 0, js_node_native_create_inflate),
    JS_CFUNC_DEF("createGzip", 1, js_node_native_create_gzip),
    JS_CFUNC_DEF("createGunzip", 0, js_node_native_create_gunzip),
    JS_CFUNC_DEF("deflateSync", 2, js_node_native_deflate_sync),
    JS_CFUNC_DEF("inflateSync", 1, js_node_native_inflate_sync),
    JS_CFUNC_DEF("gzipSync", 2, js_node_native_gzip_sync),
    JS_CFUNC_DEF("gunzipSync", 1, js_node_native_gunzip_sync),
    JS_CFUNC_DEF("socketConnect", 2, js_node_native_socket_connect),
    JS_CFUNC_DEF("socketRead", 2, js_node_native_socket_read),
    JS_CFUNC_DEF("socketWrite", 2, js_node_native_socket_write),
    JS_CFUNC_DEF("socketClose", 1, js_node_native_socket_close),
    JS_CFUNC_DEF("tlsConnect", 3, js_node_native_tls_connect),
    JS_CFUNC_DEF("tlsRead", 2, js_node_native_tls_read),
    JS_CFUNC_DEF("tlsWrite", 2, js_node_native_tls_write),
    JS_CFUNC_DEF("tlsClose", 1, js_node_native_tls_close),
    JS_CFUNC_DEF("jsonParse", 1, js_node_native_json_parse),
    JS_CFUNC_DEF("decodeUtf8", 1, js_node_native_decode_utf8),
    JS_CFUNC_DEF("setRawMode", 2, js_node_native_set_raw_mode),
    JS_CFUNC_DEF("chmod", 2, js_node_native_chmod),
    JS_CFUNC_DEF("fchmod", 2, js_node_native_fchmod),
    JS_CFUNC_DEF("chown", 3, js_node_native_chown),
    JS_CFUNC_DEF("fchown", 3, js_node_native_fchown),
    JS_CFUNC_DEF("futimes", 3, js_node_native_futimes),
    JS_CFUNC_DEF("fsync", 1, js_node_native_fsync),
};

static int node_native_module_init(JSContext *ctx, JSModuleDef *m)
{
    if (node_native_hash_init(ctx) < 0)
        return -1;
    if (node_native_hmac_init(ctx) < 0)
        return -1;
    if (node_native_zlib_init(ctx) < 0)
        return -1;
    return JS_SetModuleExportList(ctx, m, node_native_funcs,
                                  countof(node_native_funcs));
}

JSModuleDef *js_init_module_node_native(JSContext *ctx, const char *module_name)
{
    JSModuleDef *m = JS_NewCModule(ctx, module_name, node_native_module_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, node_native_funcs,
                           countof(node_native_funcs));
    return m;
}
