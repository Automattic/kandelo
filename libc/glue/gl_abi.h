#ifndef WPK_GL_ABI_H
#define WPK_GL_ABI_H

/*
 * Mirrors `wasm_posix_shared::gl::*` (crates/shared/src/lib.rs). Drift
 * is caught at first contact: the kernel's `GLIO_INIT` handler rejects
 * zero or a client `OP_VERSION` newer than the kernel's compile-time
 * value with `ENOSYS`; earlier tables remain compatible. Bumping `OP_VERSION` here without a matching
 * bump on the Rust side will surface as init failure on every gltri
 * run, not as silent decode corruption.
 */

#include <stddef.h>
#include <stdint.h>

#define WPK_GL_OP_VERSION 15u
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
#define GLIO_UPDATE_SURFACE   0x4Au

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
#define OP_BLEND_FUNC_SEPARATE         0x000Du
#define OP_BLEND_EQUATION_SEPARATE     0x000Eu

#define OP_GEN_BUFFERS                 0x0100u
#define OP_DELETE_BUFFERS              0x0101u
#define OP_BIND_BUFFER                 0x0102u
#define OP_BUFFER_DATA                 0x0103u
#define OP_BUFFER_SUB_DATA             0x0104u
#define OP_BEGIN_CLIENT_ARRAY 0x0105u
#define OP_END_CLIENT_ARRAY 0x0106u

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
#define OP_DETACH_SHADER               0x030Au

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
#define OP_VERTEX_ATTRIB_4FV           0x0505u

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
#define OP_DELETE_FRAMEBUFFERS         0x0707u

#define OP_BLEND_EQUATION 0x000Fu
#define OP_BLEND_COLOR 0x0010u
#define OP_CLEAR_DEPTHF 0x0011u
#define OP_CLEAR_STENCIL 0x0012u
#define OP_COLOR_MASK 0x0013u
#define OP_DEPTH_MASK 0x0014u
#define OP_STENCIL_FUNC 0x0015u
#define OP_STENCIL_FUNC_SEPARATE 0x0016u
#define OP_STENCIL_MASK 0x0017u
#define OP_STENCIL_MASK_SEPARATE 0x0018u
#define OP_STENCIL_OP 0x0019u
#define OP_STENCIL_OP_SEPARATE 0x001Au
#define OP_POLYGON_OFFSET 0x001Bu
#define OP_DEPTH_RANGEF 0x001Cu
#define OP_SAMPLE_COVERAGE 0x001Du
#define OP_TEX_PARAMETERF 0x0208u
#define OP_COMPRESSED_TEX_IMAGE_2D 0x0209u
#define OP_COMPRESSED_TEX_SUB_IMAGE_2D 0x020Au
#define OP_COPY_TEX_IMAGE_2D 0x020Bu
#define OP_COPY_TEX_SUB_IMAGE_2D 0x020Cu
#define OP_UNIFORM1FV 0x0407u
#define OP_UNIFORM2FV 0x0408u
#define OP_UNIFORM3FV 0x0409u
#define OP_UNIFORM1IV 0x040Au
#define OP_UNIFORM2IV 0x040Bu
#define OP_UNIFORM3IV 0x040Cu
#define OP_UNIFORM4IV 0x040Du
#define OP_UNIFORM_MATRIX2FV 0x040Eu
#define OP_UNIFORM_MATRIX3FV 0x040Fu
#define OP_DELETE_RENDERBUFFERS 0x0708u
#define OP_DRAW_BUFFER 0x0709u
#define OP_DRAW_BUFFERS 0x070Au
#define OP_READ_BUFFER 0x070Bu
#define QOP_GET_ACTIVE_UNIFORM 0x000Fu
#define QOP_GET_UNIFORMFV 0x0010u
#define QOP_GET_UNIFORMIV 0x0011u

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
#define QOP_GET_SHADER_PRECISION_FORMAT 0x0Du
#define QOP_FINISH                0x0Eu

#define QOP_GET_BUFFER_PARAMETER 0x0012u
#define QOP_GET_VERTEX_ATTRIBIV 0x0013u
#define QOP_GET_VERTEX_ATTRIBFV 0x0014u
#define QOP_IS_OBJECT 0x0015u
#define QOP_IS_ENABLED 0x0016u
#define QOP_GET_INDEX_USAGE 0x0017u

#define QOP_GET_ACTIVE_ATTRIB 0x0018u
#define QOP_GET_ATTACHED_SHADERS 0x0019u
#define QOP_GET_SHADER_SOURCE 0x001Au
#define QOP_GET_FB_ATTACHMENT 0x001Bu
#define QOP_GET_RENDERBUFFER_PARAMETER 0x001Cu
#define QOP_GET_TEX_PARAMETER 0x001Du
#define OP_VALIDATE_PROGRAM 0x030Bu

#define QOP_SHADER_SOURCE_UPLOAD 0x001Eu
/* Upload input: action, shader, token, total/offset, optional CHUNK bytes.
 * BEGIN=1, CHUNK=2, COMMIT=3, ABORT=4. Checked reply payload echoes token. */

/* V7 checked result: status, count, 16 values, completion magic (76 bytes). */
#define QOP_GET_UNIFORM_VALUES 0x001Fu
#define QOP_GET_ACTIVE_UNIFORM_INFO 0x0020u
#define QOP_LOOKUP_UNIFORM 0x0021u
/* V9: kind (texture=1/RBO=2), target, name; checked accepted=1 reply. */
#define QOP_BIND_IMAGE_OBJECT 0x0022
#define QOP_IMAGE_TARGET 0x0023u
#define QOP_IMAGE_SOURCE_STATE 0x0024u
#define QOP_BOUND_IMAGE_TARGET 0x0025u
#define QOP_BOUND_IMAGE_STATE 0x0026u
#define QOP_IMAGE_OBJECT_DELETE 0x0027u
#define QOP_IMAGE_ATTACHMENT 0x0028u
#define QOP_IMAGE_STORAGE 0x0029u
#define QOP_BIND_FRAMEBUFFER 0x002Au
// V14: target/name (8 bytes), checked accepted binding (12-byte reply).
#define QOP_BIND_BUFFER 0x002Bu
/* V15: name (4 bytes), checked accepted deletion (12-byte reply). */
#define QOP_DELETE_BUFFER 0x002Cu
/* Private mode of the existing BO bind ioctl, returning a source token. */
#define WPK_GL_IMAGE_SOURCE_TARGET 0x57504b49u

/* V3+ query replies: u32 status (0 success, 1 recorded GL error),
 * payload, u32 completion magic. Index usage payload: u32 maximum index
 * followed by 8192 bytes of index-presence bits (byte/short indices).
 * Old query layouts are unchanged. All words are little-endian. */
#define WPK_GL_INDEX_REPLY_LEN 8204u
#define WPK_GL_QUERY_REPLY_MAGIC 0x47514c33u

/* Marshalled ioctl arg structs — must match shared::gl byte-for-byte. */
#define WPK_GL_SESSION_DISPLAY 1u
#define WPK_GL_SESSION_OBJECTS 2u
struct gl_init_info { uint32_t op_version, role; int32_t display_fd; uint32_t display_id; };
struct gl_submit_info { uint32_t offset; uint32_t length; };
struct gl_make_current { uint32_t context_id, draw_surface_id, read_surface_id; };
/* ABI 58: source context 0 creates an independent object group. */
struct gl_context_attrs { uint32_t client_version; uint32_t share_context_id; uint32_t reserved; uint32_t context_id; };
struct gl_surface_attrs { uint32_t kind; uint32_t width; uint32_t height; uint32_t config_id; uint32_t reserved[4]; };
/* ABI 57: zero identity on input; accepted size and fresh identity on output. */
struct gl_surface_create { struct gl_surface_attrs attrs; uint32_t surface_id; };
struct gl_query_info {
    uint32_t op;
    uint32_t in_buf_ptr;
    uint32_t in_buf_len;
    uint32_t out_buf_ptr;
    uint32_t out_buf_len;
    uint32_t reserved;
};

/* Cross-archive accessors require a current context on the calling thread.
 * Native windows own independent device descriptors and transfer BO names. */
int      _wpk_gl_fd(void);
uint8_t *_wpk_gl_cmdbuf_base(void);
void     _wpk_gl_flush(void);

/* Opaque client encoder state belongs to an EGL context, not its current
 * thread. Only libGLESv2 knows its layout; EGL owns creation and retirement. */
struct wpk_gles_context;
struct wpk_gles_context *_wpk_gl_current_encoder(void);
struct wpk_gles_context *_wpk_gl_create_encoder(void);
#define WPK_GL_OBJECT_GROUPS 1
struct wpk_gles_context *_wpk_gl_create_shared_encoder(struct wpk_gles_context *source);
/* Internal name spaces: buffer 0, texture 1, renderbuffer 2, shader/program 3.
 * Returns a GL error enum; failure leaves output and reservations unchanged. */
uint32_t _wpk_gl_reserve_names(struct wpk_gles_context *state, uint32_t name_space, int32_t count,
                               uint32_t *out);
/* Adopt an acknowledged public WPK texture name; hidden image carriers are
 * not public objects. Returns a GL error enum, preserving first error. */
uint32_t _wpk_gl_register_external_texture(struct wpk_gles_context *state, uint32_t name);
void _wpk_gl_destroy_encoder(struct wpk_gles_context *state);

/* An EGLImage made by eglCreateImageKHR from one dma-buf plane. A
 * GPU-tier bo (its PRIME fd has no CPU mapping) is sampled and rendered
 * through the host texture the bo owns; a CPU-tier bo is read from
 * `pixels`, the caller's mapping of the dma-buf. */
struct egl_generation;
struct wpk_egl_image {
    struct egl_generation *generation; /* owns the imported GEM handle */
    uintptr_t public_handle; /* never reuse an invalidated public identity */
    unsigned references;    /* public image plus every live GL sibling */
    int public_live;
    struct wpk_egl_image *next;
    uint32_t handle;          /* GEM handle on the EGL session's fd */
    uint32_t width, height;
    uint32_t fourcc;          /* DRM_FORMAT_[AX]RGB8888 / [AX]BGR8888 */
    uint32_t pitch;
    const uint8_t *pixels;    /* first row of a CPU-tier image, else NULL */
    void *map;                /* the mmap behind `pixels` */
    size_t map_len;
};

/* A private source token, separate from public GL names, for a GPU image.
 * Zero for CPU images, no current context or unavailable native storage. */
/* Lookup retains a temporary reference; the caller must release it. */
struct wpk_egl_image *_wpk_egl_image_lookup(const void *image);
void _wpk_egl_image_retain(struct wpk_egl_image *image);
void _wpk_egl_image_release(struct wpk_egl_image *image);
uint32_t _wpk_egl_image_texture(const struct wpk_egl_image *image);

#endif
