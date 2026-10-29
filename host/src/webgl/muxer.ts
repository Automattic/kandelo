// Replay each GLES2 texture target independently on the shared context.
import { renderbufferNative, type GlRenderbufferView, type GlTextureView } from "./image-storage.js";
import { reconcileClientArrayRestore, type GlClientArrayFields } from "./client-array.js";
import { hasNativeRepair, repairNativeState } from "./native-recovery.js";
import { knownTextureUnitLimit } from "./limits.js";
import { nativeTextureBinding } from "./texture-bindings.js";
import { captureNativeGlErrors, type GlErrorState } from "./errors.js";
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

// Replay reads device state only; it must not require or retain guest memory.
type GlMuxerOwner = {shadow: GlShadowState; textureViews?: Map<WebGLTexture,GlTextureView>;
  renderbufferViews?: ReadonlyMap<WebGLRenderbuffer,GlRenderbufferView>}
  & GlErrorState & GlClientArrayFields;

export class GlMuxer {
  private current: GlMuxerOwner | null = null;
  private errorOwner: GlErrorState | null = null;
  private textureUnitCount = 32;

  constructor(private gl: WebGL2RenderingContext) {}

  get context(): WebGL2RenderingContext { return this.gl; }

  switchTo(target: GlMuxerOwner): void {
    if (hasNativeRepair(this.gl)) {
      this.invalidateCurrent();
      if (!repairNativeState(this.gl)) throw new Error("Native GL restoration remains pending");
    }
    if (target.clientArrayEndRequested) {
      this.invalidateCurrent();
      if (!reconcileClientArrayRestore(target,this.gl)) throw new Error("Client-array restoration remains pending");
    }
    if (this.current === target) return;
    captureNativeGlErrors(this.gl, this.errorOwner);
    this.errorOwner = null;
    const s = target.shadow;
    const gl = this.gl;

    if (s.vao === null && s.defaultVao === null) s.defaultVao = gl.createVertexArray();
    gl.bindVertexArray(s.vao ?? s.defaultVao);
    gl.bindFramebuffer(GL_FRAMEBUFFER, s.fbo);
    if (s.readFbo !== s.fbo) gl.bindFramebuffer(0x8ca8, s.readFbo);
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
    gl.bindRenderbuffer(0x8d41, s.renderbuffer ? renderbufferNative(target,s.renderbuffer) : null);
    gl.colorMask(...s.colorMask);

    if (s.ditherEnabled) gl.enable(0x0bd0); else gl.disable(0x0bd0);
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

    // Clear units used by the outgoing owner even if the incoming owner
    // has never selected them. Native WebGL2 implementations may expose
    // more units than the 32 initially allocated in the guest shadow.
    const units = this.textureUnitCount = Math.max(this.textureUnitCount,
      knownTextureUnitLimit(gl),
      s.textureUnits.length, s.cubeTextureUnits.length,
      this.current?.shadow.textureUnits.length ?? 0,
      this.current?.shadow.cubeTextureUnits.length ?? 0);
    for (let i = 0; i < units; i++) {
      gl.activeTexture(GL_TEXTURE0 + i);
      gl.bindTexture(GL_TEXTURE_2D, nativeTextureBinding(s,GL_TEXTURE_2D,i,target.textureViews));
      gl.bindTexture(0x8513, nativeTextureBinding(s,0x8513,i,target.textureViews));
    }
    gl.activeTexture(GL_TEXTURE0 + s.activeTexture);

    gl.pixelStorei(GL_UNPACK_ALIGNMENT, s.unpackAlignment);
    gl.pixelStorei(GL_PACK_ALIGNMENT, s.packAlignment);
    for (const [pname, value] of s.pixelStore) gl.pixelStorei(pname, value);

    this.current = target;
    // Retain only the error flags across invalidation, not a guest binding.
    this.errorOwner = { errors: target.errors };
  }

  /** Immutable device queries must preserve the selected owner and must stop
   * if its pending flags cannot be captured. Cleanup invalidation, in
   * contrast, must continue even when the renderer's error read fails. */
  captureCurrentErrors(): void {
    captureNativeGlErrors(this.gl, this.errorOwner);
  }

  /** Deferred cleanup must leave an unread peer error owned and retryable.
   * Unlike unconditional teardown, refusal performs no native cleanup. */
  prepareRetirement(): boolean {
    try { this.captureCurrentErrors(); }
    catch { return false; }
    this.errorOwner = null;
    this.forgetCurrent();
    return true;
  }

  invalidateCurrent(): void {
    try {
      captureNativeGlErrors(this.gl, this.errorOwner);
      this.errorOwner = null;
    } catch {
      // Cleanup must still retire native objects. Keep the outgoing error
      // flags so a later switch must drain them before executing a new owner.
    }
    this.forgetCurrent();
  }

  private forgetCurrent(): void {
    // Commands can grow the selected owner's shadow between switches.
    // Invalidation loses its identity, but must retain the clearing range.
    this.textureUnitCount = Math.max(this.textureUnitCount,
      this.current?.shadow.textureUnits.length ?? 0,
      this.current?.shadow.cubeTextureUnits.length ?? 0);
    this.current = null;
  }
}
