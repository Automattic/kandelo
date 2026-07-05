// Texture-unit replay assumes TEXTURE_2D (no cube/3D targets in the
// current op set).
import {
  GL_BLEND,
  GL_BACK,
  GL_CULL_FACE,
  GL_DEPTH_TEST,
  GL_FRAMEBUFFER,
  GL_FRONT,
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
    gl.colorMask(...s.colorMask);

    if (s.depthTestEnabled) gl.enable(GL_DEPTH_TEST); else gl.disable(GL_DEPTH_TEST);
    gl.depthMask(s.depthMask);
    gl.depthFunc(s.depthFunc);

    if (s.stencilTestEnabled) gl.enable(GL_STENCIL_TEST); else gl.disable(GL_STENCIL_TEST);
    gl.stencilFuncSeparate(GL_FRONT, s.stencil.front.func, s.stencil.front.ref, s.stencil.front.valueMask);
    gl.stencilFuncSeparate(GL_BACK, s.stencil.back.func, s.stencil.back.ref, s.stencil.back.valueMask);
    gl.stencilMaskSeparate(GL_FRONT, s.stencil.front.writeMask);
    gl.stencilMaskSeparate(GL_BACK, s.stencil.back.writeMask);
    gl.stencilOpSeparate(GL_FRONT, s.stencil.front.fail, s.stencil.front.zfail, s.stencil.front.zpass);
    gl.stencilOpSeparate(GL_BACK, s.stencil.back.fail, s.stencil.back.zfail, s.stencil.back.zpass);

    if (s.blendEnabled) gl.enable(GL_BLEND); else gl.disable(GL_BLEND);
    gl.blendEquationSeparate(s.blendEquation.modeRGB, s.blendEquation.modeA);
    gl.blendColor(...s.blendColor);
    gl.blendFuncSeparate(
      s.blendFunc.srcRGB, s.blendFunc.dstRGB,
      s.blendFunc.srcA, s.blendFunc.dstA,
    );

    if (s.cullFaceEnabled) gl.enable(GL_CULL_FACE); else gl.disable(GL_CULL_FACE);
    gl.cullFace(s.cullFace);
    gl.frontFace(s.frontFace);

    if (s.polygonOffsetFillEnabled) gl.enable(GL_POLYGON_OFFSET_FILL); else gl.disable(GL_POLYGON_OFFSET_FILL);

    gl.useProgram(s.currentProgram);

    for (const [index, value] of s.vertexAttribValues) {
      gl.vertexAttrib4f(index, value[0], value[1], value[2], value[3]);
    }

    for (let i = 0; i < s.textureUnits.length; i++) {
      gl.activeTexture(GL_TEXTURE0 + i);
      gl.bindTexture(GL_TEXTURE_2D, s.textureUnits[i]);
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
