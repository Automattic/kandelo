/**
 * TypeScript mirror of `shared::gl::{OP_*, QOP_*, OP_VERSION}`.
 *
 * Numeric values must match `crates/shared/src/lib.rs::gl::*` byte-for-byte.
 * The kernel forwards bytes through `HostIO::gl_submit` / `gl_query`
 * unchanged; this table is the host bridge's decode side, paired with
 * Phase C's `glue/libglesv2_stub.c` encode side. Drift between the three
 * is caught at first contact: the kernel's `GLIO_INIT` rejects a client
 * `OP_VERSION` mismatch with `ENOSYS`.
 */

// --- cmdbuf opcodes (TLV: u16 op, u16 payload_len, payload) ----------------

export const OP_CLEAR                       = 0x0001;
export const OP_CLEAR_COLOR                 = 0x0002;
export const OP_VIEWPORT                    = 0x0003;
export const OP_SCISSOR                     = 0x0004;
export const OP_ENABLE                      = 0x0005;
export const OP_DISABLE                     = 0x0006;
export const OP_BLEND_FUNC                  = 0x0007;
export const OP_DEPTH_FUNC                  = 0x0008;
export const OP_CULL_FACE                   = 0x0009;
export const OP_FRONT_FACE                  = 0x000A;
export const OP_LINE_WIDTH                  = 0x000B;
export const OP_PIXEL_STOREI                = 0x000C;

export const OP_GEN_BUFFERS                 = 0x0100;
export const OP_DELETE_BUFFERS              = 0x0101;
export const OP_BIND_BUFFER                 = 0x0102;
export const OP_BUFFER_DATA                 = 0x0103;
export const OP_BUFFER_SUB_DATA             = 0x0104;

export const OP_GEN_TEXTURES                = 0x0200;
export const OP_DELETE_TEXTURES             = 0x0201;
export const OP_BIND_TEXTURE                = 0x0202;
export const OP_TEX_IMAGE_2D                = 0x0203;
export const OP_TEX_SUB_IMAGE_2D            = 0x0204;
export const OP_TEX_PARAMETERI              = 0x0205;
export const OP_ACTIVE_TEXTURE              = 0x0206;
export const OP_GENERATE_MIPMAP             = 0x0207;

export const OP_CREATE_SHADER               = 0x0300;
export const OP_SHADER_SOURCE               = 0x0301;
export const OP_COMPILE_SHADER              = 0x0302;
export const OP_DELETE_SHADER               = 0x0303;
export const OP_CREATE_PROGRAM              = 0x0304;
export const OP_ATTACH_SHADER               = 0x0305;
export const OP_LINK_PROGRAM                = 0x0306;
export const OP_USE_PROGRAM                 = 0x0307;
export const OP_BIND_ATTRIB_LOCATION        = 0x0308;
export const OP_DELETE_PROGRAM              = 0x0309;

export const OP_UNIFORM1I                   = 0x0400;
export const OP_UNIFORM1F                   = 0x0401;
export const OP_UNIFORM2F                   = 0x0402;
export const OP_UNIFORM3F                   = 0x0403;
export const OP_UNIFORM4F                   = 0x0404;
export const OP_UNIFORM_MATRIX4FV           = 0x0405;
/** `glUniform4fv(location, count, value)` — array form (es2gears uses
 *  this for the directional light position). `OP_UNIFORM4F` (scalar) is
 *  a different signature; both are needed. */
export const OP_UNIFORM4FV                  = 0x0406;

export const OP_ENABLE_VERTEX_ATTRIB_ARRAY  = 0x0500;
export const OP_DISABLE_VERTEX_ATTRIB_ARRAY = 0x0501;
export const OP_VERTEX_ATTRIB_POINTER       = 0x0502;
export const OP_DRAW_ARRAYS                 = 0x0503;
export const OP_DRAW_ELEMENTS               = 0x0504;

export const OP_GEN_VERTEX_ARRAYS           = 0x0600;
export const OP_DELETE_VERTEX_ARRAYS        = 0x0601;
export const OP_BIND_VERTEX_ARRAY           = 0x0602;

export const OP_GEN_FRAMEBUFFERS            = 0x0700;
export const OP_BIND_FRAMEBUFFER            = 0x0701;
export const OP_FRAMEBUFFER_TEXTURE_2D      = 0x0702;
export const OP_GEN_RENDERBUFFERS           = 0x0703;
export const OP_BIND_RENDERBUFFER           = 0x0704;
export const OP_RENDERBUFFER_STORAGE        = 0x0705;
export const OP_FRAMEBUFFER_RENDERBUFFER    = 0x0706;

// --- sync query op tags (used in GlQueryInfo.op) --------------------------

export const QOP_GET_ERROR             = 0x01;
export const QOP_GET_STRING            = 0x02;
export const QOP_GET_INTEGERV          = 0x03;
export const QOP_GET_FLOATV            = 0x04;
export const QOP_GET_UNIFORM_LOC       = 0x05;
export const QOP_GET_ATTRIB_LOC        = 0x06;
export const QOP_GET_SHADERIV          = 0x07;
export const QOP_GET_SHADER_INFO_LOG   = 0x08;
export const QOP_GET_PROGRAMIV         = 0x09;
export const QOP_GET_PROGRAM_INFO_LOG  = 0x0A;
export const QOP_READ_PIXELS           = 0x0B;
export const QOP_CHECK_FB_STATUS       = 0x0C;

/** Bumped in lockstep with `shared::gl::OP_VERSION`. The kernel's
 *  `GLIO_INIT` handler rejects mismatching values with `ENOSYS`. */
export const OP_VERSION = 1;
