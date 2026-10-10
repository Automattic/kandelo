/**
 * TypeScript mirror of `shared::gl::{OP_*, QOP_*, OP_VERSION}`.
 *
 * Numeric values must match `crates/shared/src/lib.rs::gl::*` byte-for-byte.
 * The kernel forwards bytes through `HostIO::gl_submit` / `gl_query`
 * unchanged; this table is the host bridge's decode side, paired with
 * Phase C's `glue/libglesv2_stub.c` encode side. Drift between the three
 * is caught at first contact: the kernel's `GLIO_INIT` rejects a client
 * `OP_VERSION` newer than its supported table with `ENOSYS`.
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
export const OP_BLEND_FUNC_SEPARATE         = 0x000D;
export const OP_BLEND_EQUATION_SEPARATE     = 0x000E;

export const OP_GEN_BUFFERS                 = 0x0100;
export const OP_DELETE_BUFFERS              = 0x0101;
export const OP_BIND_BUFFER                 = 0x0102;
export const OP_BUFFER_DATA                 = 0x0103;
export const OP_BUFFER_SUB_DATA             = 0x0104;
export const OP_COPY_BUFFER_SUB_DATA        = 0x0105;
export const OP_BIND_BUFFER_RANGE           = 0x0106;
export const OP_BIND_BUFFER_BASE            = 0x0107;

export const OP_GEN_TEXTURES                = 0x0200;
export const OP_DELETE_TEXTURES             = 0x0201;
export const OP_BIND_TEXTURE                = 0x0202;
export const OP_TEX_IMAGE_2D                = 0x0203;
export const OP_TEX_SUB_IMAGE_2D            = 0x0204;
export const OP_TEX_PARAMETERI              = 0x0205;
export const OP_ACTIVE_TEXTURE              = 0x0206;
export const OP_GENERATE_MIPMAP             = 0x0207;
export const OP_TEX_STORAGE_2D              = 0x020D;
export const OP_TEX_STORAGE_3D              = 0x020E;
export const OP_TEX_SUB_IMAGE_3D            = 0x020F;
export const OP_TEX_SUB_IMAGE_2D_PBO        = 0x0210;
export const OP_TEX_SUB_IMAGE_3D_PBO        = 0x0211;
export const OP_COPY_TEX_SUB_IMAGE_3D       = 0x0212;

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
export const OP_DETACH_SHADER               = 0x030A;
export const OP_UNIFORM_BLOCK_BINDING       = 0x030B;

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
export const OP_UNIFORM_UIV                 = 0x0410;
export const OP_UNIFORM_MATRIX_FV           = 0x0411;

export const OP_ENABLE_VERTEX_ATTRIB_ARRAY  = 0x0500;
export const OP_DISABLE_VERTEX_ATTRIB_ARRAY = 0x0501;
export const OP_VERTEX_ATTRIB_POINTER       = 0x0502;
export const OP_DRAW_ARRAYS                 = 0x0503;
export const OP_DRAW_ELEMENTS               = 0x0504;
/** `glVertexAttrib4fv(index, value)` — constant (non-array) vertex
 *  attribute. ScummVM's shader pipeline feeds the per-draw color
 *  through this when the attribute array is disabled. */
export const OP_VERTEX_ATTRIB_4FV           = 0x0505;
export const OP_VERTEX_ATTRIB_I_POINTER     = 0x0506;
export const OP_VERTEX_ATTRIB_DIVISOR       = 0x0507;
export const OP_DRAW_ARRAYS_INSTANCED       = 0x0508;
export const OP_DRAW_ELEMENTS_INSTANCED     = 0x0509;

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
export const OP_DELETE_FRAMEBUFFERS         = 0x0707;
export const OP_FRAMEBUFFER_TEXTURE_LAYER   = 0x070C;
export const OP_RENDERBUFFER_STORAGE_MULTISAMPLE = 0x070D;
export const OP_BLIT_FRAMEBUFFER            = 0x070E;
export const OP_INVALIDATE_FRAMEBUFFER      = 0x070F;
export const OP_CLEAR_BUFFERFV              = 0x0710;
export const OP_CLEAR_BUFFERIV              = 0x0711;
export const OP_CLEAR_BUFFERUIV             = 0x0712;
export const OP_CLEAR_BUFFERFI              = 0x0713;
export const OP_READ_PIXELS_PBO             = 0x0714;

export const OP_GEN_SAMPLERS                = 0x0800;
export const OP_DELETE_SAMPLERS             = 0x0801;
export const OP_BIND_SAMPLER                = 0x0802;
export const OP_SAMPLER_PARAMETERI          = 0x0803;
export const OP_SAMPLER_PARAMETERF          = 0x0804;

export const OP_FENCE_SYNC                  = 0x0900;
export const OP_DELETE_SYNC                 = 0x0901;
export const OP_WAIT_SYNC                   = 0x0902;

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
export const QOP_GET_SHADER_PRECISION_FORMAT = 0x0D;
export const QOP_FINISH                = 0x0E;
export const QOP_GET_STRINGI           = 0x12;
export const QOP_GET_BUFFER_SUB_DATA   = 0x13;
export const QOP_GET_UNIFORM_BLOCK_INDEX = 0x14;
export const QOP_CLIENT_WAIT_SYNC      = 0x15;
export const QOP_GET_SYNCIV            = 0x16;

/** Bumped in lockstep with `shared::gl::OP_VERSION`. The kernel's
 *  `GLIO_INIT` accepts versions 1 through this value. */
export const OP_VERSION = 3;

// Additive GLES entry points used by native renderers; existing tags stay stable.
export const OP_BLEND_EQUATION = 0x000F;
export const OP_BLEND_COLOR = 0x0010;
export const OP_CLEAR_DEPTHF = 0x0011;
export const OP_CLEAR_STENCIL = 0x0012;
export const OP_COLOR_MASK = 0x0013;
export const OP_DEPTH_MASK = 0x0014;
export const OP_STENCIL_FUNC = 0x0015;
export const OP_STENCIL_FUNC_SEPARATE = 0x0016;
export const OP_STENCIL_MASK = 0x0017;
export const OP_STENCIL_MASK_SEPARATE = 0x0018;
export const OP_STENCIL_OP = 0x0019;
export const OP_STENCIL_OP_SEPARATE = 0x001A;
export const OP_POLYGON_OFFSET = 0x001B;
export const OP_DEPTH_RANGEF = 0x001C;
export const OP_SAMPLE_COVERAGE = 0x001D;
export const OP_TEX_PARAMETERF = 0x0208;
export const OP_COMPRESSED_TEX_IMAGE_2D = 0x0209;
export const OP_COMPRESSED_TEX_SUB_IMAGE_2D = 0x020A;
export const OP_COPY_TEX_IMAGE_2D = 0x020B;
export const OP_COPY_TEX_SUB_IMAGE_2D = 0x020C;
export const OP_UNIFORM1FV = 0x0407;
export const OP_UNIFORM2FV = 0x0408;
export const OP_UNIFORM3FV = 0x0409;
export const OP_UNIFORM1IV = 0x040A;
export const OP_UNIFORM2IV = 0x040B;
export const OP_UNIFORM3IV = 0x040C;
export const OP_UNIFORM4IV = 0x040D;
export const OP_UNIFORM_MATRIX2FV = 0x040E;
export const OP_UNIFORM_MATRIX3FV = 0x040F;
export const OP_DELETE_RENDERBUFFERS = 0x0708;
export const OP_DRAW_BUFFER = 0x0709;
export const OP_DRAW_BUFFERS = 0x070A;
export const OP_READ_BUFFER = 0x070B;
export const QOP_GET_ACTIVE_UNIFORM = 0x000F;
export const QOP_GET_UNIFORMFV = 0x0010;
export const QOP_GET_UNIFORMIV = 0x0011;
