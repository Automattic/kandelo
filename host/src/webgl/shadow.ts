/**
 * Per-binding WebGL2 state mirror (plan §B1). The muxer (Task B2)
 * re-applies these fields when switching the shared context between
 * `(pid, ctx_id)` bindings. The cmdbuf decoder writes the shadow
 * alongside the matching `gl.*` call for every state-mutating op.
 */

export interface GlShadowState {
  viewport: [number, number, number, number];
  scissor: { enabled: boolean, rect: [number, number, number, number] };

  clearColor: [number, number, number, number];

  depthTestEnabled: boolean;
  depthFunc: number;
  stencilTestEnabled: boolean;
  blendEnabled: boolean;
  blendFunc: { srcRGB: number, dstRGB: number, srcA: number, dstA: number };

  cullFaceEnabled: boolean;
  cullFace: number;
  frontFace: number;
  polygonOffsetFillEnabled: boolean;

  currentProgram: WebGLProgram | null;
  vao: WebGLVertexArrayObject | null;
  fbo: WebGLFramebuffer | null;

  activeTexture: number;
  textureUnits: (WebGLTexture | null)[];

  unpackAlignment: number;
  packAlignment: number;
}

export function defaultShadow(): GlShadowState {
  return {
    viewport: [0, 0, 0, 0],
    scissor: { enabled: false, rect: [0, 0, 0, 0] },
    clearColor: [0, 0, 0, 0],
    depthTestEnabled: false,
    depthFunc: 0x0201,   // GL_LESS
    stencilTestEnabled: false,
    blendEnabled: false,
    blendFunc: { srcRGB: 1, dstRGB: 0, srcA: 1, dstA: 0 },
    cullFaceEnabled: false,
    cullFace: 0x0405,    // GL_BACK
    frontFace: 0x0901,   // GL_CCW
    polygonOffsetFillEnabled: false,
    currentProgram: null,
    vao: null,
    fbo: null,
    activeTexture: 0,
    textureUnits: new Array(32).fill(null),
    unpackAlignment: 4,
    packAlignment: 4,
  };
}

export const GL_DEPTH_TEST          = 0x0B71;
export const GL_STENCIL_TEST        = 0x0B90;
export const GL_BLEND               = 0x0BE2;
export const GL_CULL_FACE           = 0x0B44;
export const GL_SCISSOR_TEST        = 0x0C11;
export const GL_POLYGON_OFFSET_FILL = 0x8037;

export const GL_UNPACK_ALIGNMENT = 0x0CF5;
export const GL_PACK_ALIGNMENT   = 0x0D05;

export const GL_FRAMEBUFFER      = 0x8D40;
export const GL_READ_FRAMEBUFFER = 0x8CA8;
export const GL_TEXTURE0         = 0x84C0;
export const GL_TEXTURE_2D       = 0x0DE1;

export function setCap(s: GlShadowState, cap: number, enabled: boolean): void {
  switch (cap) {
    case GL_DEPTH_TEST:          s.depthTestEnabled = enabled; return;
    case GL_STENCIL_TEST:        s.stencilTestEnabled = enabled; return;
    case GL_BLEND:               s.blendEnabled = enabled; return;
    case GL_CULL_FACE:           s.cullFaceEnabled = enabled; return;
    case GL_POLYGON_OFFSET_FILL: s.polygonOffsetFillEnabled = enabled; return;
    case GL_SCISSOR_TEST:
      s.scissor.enabled = enabled;
      return;
  }
}
