// Texture-unit replay assumes TEXTURE_2D (no cube/3D targets in the
// current op set).
import {
  GL_BLEND,
  GL_CULL_FACE,
  GL_DEPTH_TEST,
  GL_FRAMEBUFFER,
  GL_PACK_ALIGNMENT,
  GL_POLYGON_OFFSET_FILL,
  GL_SCISSOR_TEST,
  GL_STENCIL_TEST,
  GL_TEXTURE0,
  GL_TEXTURE_2D,
  GL_UNPACK_ALIGNMENT,
  type GlShadowState,
} from "./shadow.js";

export class GlMuxer {
  private current: { shadow: GlShadowState } | null = null;

  constructor(private gl: WebGL2RenderingContext) {}

  switchTo(target: { shadow: GlShadowState }): void {
    if (this.current === target) return;
    const s = target.shadow;
    const gl = this.gl;

    gl.bindVertexArray(s.vao);
    gl.bindFramebuffer(GL_FRAMEBUFFER, s.fbo);
    gl.viewport(...s.viewport);

    if (s.scissor.enabled) gl.enable(GL_SCISSOR_TEST); else gl.disable(GL_SCISSOR_TEST);
    gl.scissor(...s.scissor.rect);

    gl.clearColor(...s.clearColor);

    if (s.depthTestEnabled) gl.enable(GL_DEPTH_TEST); else gl.disable(GL_DEPTH_TEST);
    gl.depthFunc(s.depthFunc);

    if (s.stencilTestEnabled) gl.enable(GL_STENCIL_TEST); else gl.disable(GL_STENCIL_TEST);

    if (s.blendEnabled) gl.enable(GL_BLEND); else gl.disable(GL_BLEND);
    gl.blendFuncSeparate(
      s.blendFunc.srcRGB, s.blendFunc.dstRGB,
      s.blendFunc.srcA, s.blendFunc.dstA,
    );

    if (s.cullFaceEnabled) gl.enable(GL_CULL_FACE); else gl.disable(GL_CULL_FACE);
    gl.cullFace(s.cullFace);
    gl.frontFace(s.frontFace);

    if (s.polygonOffsetFillEnabled) gl.enable(GL_POLYGON_OFFSET_FILL); else gl.disable(GL_POLYGON_OFFSET_FILL);

    gl.useProgram(s.currentProgram);

    for (let i = 0; i < s.textureUnits.length; i++) {
      const tex = s.textureUnits[i];
      if (tex) {
        gl.activeTexture(GL_TEXTURE0 + i);
        gl.bindTexture(GL_TEXTURE_2D, tex);
      }
    }
    gl.activeTexture(GL_TEXTURE0 + s.activeTexture);

    gl.pixelStorei(GL_UNPACK_ALIGNMENT, s.unpackAlignment);
    gl.pixelStorei(GL_PACK_ALIGNMENT, s.packAlignment);

    this.current = target;
  }

  invalidateCurrent(): void {
    this.current = null;
  }
}
