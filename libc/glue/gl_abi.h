#ifndef WPK_GL_ABI_H
#define WPK_GL_ABI_H

/*
 * Mirrors `wasm_posix_shared::gl::*` (crates/shared/src/lib.rs). Drift
 * is caught at first contact: the kernel's `GLIO_INIT` handler rejects
 * a client `OP_VERSION` that doesn't match the kernel's compile-time
 * value with `ENOSYS`. Bumping `OP_VERSION` here without a matching
 * bump on the Rust side will surface as init failure on every gltri
 * run, not as silent decode corruption.
 */

#include <stdint.h>

#define WPK_GL_OP_VERSION 1u
#define WPK_GL_CMDBUF_LEN (1u << 20)
#define WPK_GL_DEVICE     "/dev/dri/renderD128"

/* ioctl request numbers (DRM 'D' magic, 0x40+). */
#define GLIO_INIT             0x40u
#define GLIO_TERMINATE        0x41u
#define GLIO_CREATE_CONTEXT   0x42u
#define GLIO_DESTROY_CONTEXT  0x43u
#define GLIO_CREATE_SURFACE   0x44u
#define GLIO_DESTROY_SURFACE  0x45u
#define GLIO_MAKE_CURRENT     0x46u
#define GLIO_SUBMIT           0x47u
#define GLIO_PRESENT          0x48u
#define GLIO_QUERY            0x49u

/* Surface kind tags. */
#define WPK_SURFACE_DEFAULT  1u
#define WPK_SURFACE_PBUFFER  2u

/* Cmdbuf op tags (TLV: u16 op, u16 payload_len, payload). */
#define OP_CLEAR                       0x0001u
#define OP_CLEAR_COLOR                 0x0002u
#define OP_VIEWPORT                    0x0003u
#define OP_SCISSOR                     0x0004u
#define OP_ENABLE                      0x0005u
#define OP_DISABLE                     0x0006u
#define OP_BLEND_FUNC                  0x0007u
#define OP_DEPTH_FUNC                  0x0008u
#define OP_CULL_FACE                   0x0009u
#define OP_FRONT_FACE                  0x000Au
#define OP_LINE_WIDTH                  0x000Bu
#define OP_PIXEL_STOREI                0x000Cu

#define OP_GEN_BUFFERS                 0x0100u
#define OP_DELETE_BUFFERS              0x0101u
#define OP_BIND_BUFFER                 0x0102u
#define OP_BUFFER_DATA                 0x0103u
#define OP_BUFFER_SUB_DATA             0x0104u

#define OP_GEN_TEXTURES                0x0200u
#define OP_DELETE_TEXTURES             0x0201u
#define OP_BIND_TEXTURE                0x0202u
#define OP_TEX_IMAGE_2D                0x0203u
#define OP_TEX_SUB_IMAGE_2D            0x0204u
#define OP_TEX_PARAMETERI              0x0205u
#define OP_ACTIVE_TEXTURE              0x0206u
#define OP_GENERATE_MIPMAP             0x0207u

#define OP_CREATE_SHADER               0x0300u
#define OP_SHADER_SOURCE               0x0301u
#define OP_COMPILE_SHADER              0x0302u
#define OP_DELETE_SHADER               0x0303u
#define OP_CREATE_PROGRAM              0x0304u
#define OP_ATTACH_SHADER               0x0305u
#define OP_LINK_PROGRAM                0x0306u
#define OP_USE_PROGRAM                 0x0307u
#define OP_BIND_ATTRIB_LOCATION        0x0308u
#define OP_DELETE_PROGRAM              0x0309u

#define OP_UNIFORM1I                   0x0400u
#define OP_UNIFORM1F                   0x0401u
#define OP_UNIFORM2F                   0x0402u
#define OP_UNIFORM3F                   0x0403u
#define OP_UNIFORM4F                   0x0404u
#define OP_UNIFORM_MATRIX4FV           0x0405u
#define OP_UNIFORM4FV                  0x0406u

#define OP_ENABLE_VERTEX_ATTRIB_ARRAY  0x0500u
#define OP_DISABLE_VERTEX_ATTRIB_ARRAY 0x0501u
#define OP_VERTEX_ATTRIB_POINTER       0x0502u
#define OP_DRAW_ARRAYS                 0x0503u
#define OP_DRAW_ELEMENTS               0x0504u

#define OP_GEN_VERTEX_ARRAYS           0x0600u
#define OP_DELETE_VERTEX_ARRAYS        0x0601u
#define OP_BIND_VERTEX_ARRAY           0x0602u

#define OP_GEN_FRAMEBUFFERS            0x0700u
#define OP_BIND_FRAMEBUFFER            0x0701u
#define OP_FRAMEBUFFER_TEXTURE_2D      0x0702u
#define OP_GEN_RENDERBUFFERS           0x0703u
#define OP_BIND_RENDERBUFFER           0x0704u
#define OP_RENDERBUFFER_STORAGE        0x0705u
#define OP_FRAMEBUFFER_RENDERBUFFER    0x0706u

/* Sync-query op tags. */
#define QOP_GET_ERROR             0x01u
#define QOP_GET_STRING            0x02u
#define QOP_GET_INTEGERV          0x03u
#define QOP_GET_FLOATV            0x04u
#define QOP_GET_UNIFORM_LOC       0x05u
#define QOP_GET_ATTRIB_LOC        0x06u
#define QOP_GET_SHADERIV          0x07u
#define QOP_GET_SHADER_INFO_LOG   0x08u
#define QOP_GET_PROGRAMIV         0x09u
#define QOP_GET_PROGRAM_INFO_LOG  0x0Au
#define QOP_READ_PIXELS           0x0Bu
#define QOP_CHECK_FB_STATUS       0x0Cu

/* Marshalled ioctl arg structs — must match shared::gl byte-for-byte. */
struct gl_submit_info { uint32_t offset; uint32_t length; };
struct gl_context_attrs { uint32_t client_version; uint32_t reserved[3]; };
struct gl_surface_attrs { uint32_t kind; uint32_t width; uint32_t height; uint32_t config_id; uint32_t reserved[4]; };
struct gl_query_info {
    uint32_t op;
    uint32_t in_buf_ptr;
    uint32_t in_buf_len;
    uint32_t out_buf_ptr;
    uint32_t out_buf_len;
    uint32_t reserved;
};

/* Cross-archive accessors. libEGL.a defines them; libGLESv2.a calls
 * them. Returns -1 / NULL until eglMakeCurrent has run, so the GL
 * stubs no-op cleanly if called before context setup. */
int      _wpk_gl_fd(void);
uint8_t *_wpk_gl_cmdbuf_base(void);
void     _wpk_gl_flush(void);

#endif
