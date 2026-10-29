// TEXTURE_2D units replay from `textureUnits`; the other texture targets
// (3D, 2D array, cube map) from `textureUnitsByTarget`.
import {
  GL_BLEND,
  GL_BACK,
  GL_CULL_FACE,
  GL_DEPTH_TEST,
  GL_FRAMEBUFFER,
  GL_FRONT,
  GL_PACK_ALIGNMENT,
  GL_POLYGON_OFFSET_FILL,
  GL_READ_FRAMEBUFFER,
  GL_SCISSOR_TEST,
  GL_STENCIL_TEST,
  GL_TEXTURE0,
  GL_TEXTURE_2D,
  GL_UNIFORM_BUFFER,
  GL_UNPACK_ALIGNMENT,
  type GlShadowState,
} from "./shadow.js";

export class GlMuxer {
  private current: { shadow: GlShadowState } | null = null;
  /** State keys any binding ever set on this context: replay resets them
   *  for bindings that never set them. */
  private textureTargets = new Set<number>();
  private bufferTargets = new Set<number>();
  private uniformIndices = new Set<number>();
  private pixelStoreNames = new Set<number>();
  private readonly unitCount = 32;

  constructor(private gl: WebGL2RenderingContext) {}

  switchTo(target: { shadow: GlShadowState }): void {
    if (this.current === target) return;
    const s = target.shadow;
    const gl = this.gl;

    if (s.vao === null && s.defaultVao === null) s.defaultVao = gl.createVertexArray();
    gl.bindVertexArray(s.vao ?? s.defaultVao);
    gl.bindFramebuffer(GL_FRAMEBUFFER, s.fbo);
    gl.viewport(...s.viewport);

    if (s.scissor.enabled) gl.enable(GL_SCISSOR_TEST); else gl.disable(GL_SCISSOR_TEST);
    gl.scissor(...s.scissor.rect);

    gl.clearColor(...s.clearColor);
    gl.clearDepth(s.clearDepth);
    gl.clearStencil(s.clearStencil);
    gl.lineWidth(s.lineWidth);
    gl.depthRange(...s.depthRange);
    gl.polygonOffset(...s.polygonOffset);
    gl.sampleCoverage(...s.sampleCoverage);
    if (s.sampleCoverageEnabled) gl.enable(0x80a0); else gl.disable(0x80a0);
    if (s.sampleAlphaToCoverageEnabled) gl.enable(0x809e); else gl.disable(0x809e);
    gl.bindBuffer(0x8892, s.arrayBuffer);
    gl.bindRenderbuffer(0x8d41, s.renderbuffer);
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

    gl.blendColor(...s.blendColor);
    gl.blendFuncSeparate(
      s.blendFunc.srcRGB, s.blendFunc.dstRGB,
      s.blendFunc.srcA, s.blendFunc.dstA,
    );
    gl.blendEquationSeparate(s.blendEquation.rgb, s.blendEquation.alpha);

    if (s.cullFaceEnabled) gl.enable(GL_CULL_FACE); else gl.disable(GL_CULL_FACE);
    gl.cullFace(s.cullFace);
    gl.frontFace(s.frontFace);

    if (s.polygonOffsetFillEnabled) gl.enable(GL_POLYGON_OFFSET_FILL); else gl.disable(GL_POLYGON_OFFSET_FILL);

    gl.useProgram(s.currentProgram);

    const indices = new Set([
      ...s.vertexAttribValues.keys(),
      ...(this.current?.shadow.vertexAttribValues.keys() ?? []),
    ]);
    for (const index of indices) {
      const value = s.vertexAttribValues.get(index) ?? [0, 0, 0, 1];
      gl.vertexAttrib4f(index, value[0], value[1], value[2], value[3]);
    }

    for (let i = 0; i < s.textureUnits.length; i++) {
      gl.activeTexture(GL_TEXTURE0 + i);
      gl.bindTexture(GL_TEXTURE_2D, s.textureUnits[i]);
    }
    gl.pixelStorei(GL_UNPACK_ALIGNMENT, s.unpackAlignment);
    gl.pixelStorei(GL_PACK_ALIGNMENT, s.packAlignment);

    this.replayGles3(s);

    this.current = target;
  }

  /** GLES 3.0 context state. Every field is applied, so state a previous
   *  binding left behind never reaches this one. */
  private replayGles3(s: GlShadowState): void {
    const gl = this.gl;
    gl.bindFramebuffer(GL_READ_FRAMEBUFFER, s.readFbo);

    for (const target of new Set([...this.textureTargets, ...s.textureUnitsByTarget.keys()])) {
      this.textureTargets.add(target);
      const units = s.textureUnitsByTarget.get(target) ?? [];
      for (let i = 0; i < Math.max(units.length, this.unitCount); i++) {
        gl.activeTexture(GL_TEXTURE0 + i);
        gl.bindTexture(target, units[i] ?? null);
      }
    }
    for (let i = 0; i < s.samplerUnits.length; i++) gl.bindSampler(i, s.samplerUnits[i]);
    gl.activeTexture(GL_TEXTURE0 + s.activeTexture);

    for (const target of new Set([...this.bufferTargets, ...s.bufferBindings.keys()])) {
      this.bufferTargets.add(target);
      gl.bindBuffer(target, s.bufferBindings.get(target) ?? null);
    }
    for (const index of new Set([...this.uniformIndices, ...s.uniformBufferRanges.keys()])) {
      this.uniformIndices.add(index);
      const r = s.uniformBufferRanges.get(index);
      if (r && r.size >= 0) gl.bindBufferRange(GL_UNIFORM_BUFFER, index, r.buffer, r.offset, r.size);
      else gl.bindBufferBase(GL_UNIFORM_BUFFER, index, r?.buffer ?? null);
    }
    // The generic binding is the last one glBindBufferRange/Base set.
    gl.bindBuffer(GL_UNIFORM_BUFFER, s.bufferBindings.get(GL_UNIFORM_BUFFER) ?? null);

    for (const pname of new Set([...this.pixelStoreNames, ...s.pixelStore.keys()])) {
      this.pixelStoreNames.add(pname);
      gl.pixelStorei(pname, s.pixelStore.get(pname) ?? 0);
    }
  }

  invalidateCurrent(): void {
    this.current = null;
  }
}
