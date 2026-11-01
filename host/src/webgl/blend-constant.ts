/**
 * Constant color with constant alpha blend factors (ES 2.0 section 4.1.6,
 * table 4.1) on WebGL 2.
 *
 * ES 2.0 accepts every source/destination factor pair. WebGL (1.0 section
 * 6.13, inherited by WebGL 2) rejects with INVALID_OPERATION a blend function
 * whose RGB source and destination factors pair CONSTANT_COLOR or
 * ONE_MINUS_CONSTANT_COLOR with CONSTANT_ALPHA or ONE_MINUS_CONSTANT_ALPHA.
 * The alpha factors are not restricted.
 *
 * Exact emulation: the guest's logical factors stay in the shadow (queries,
 * owner replay and draws read them). Natively the RGB source factor is ONE
 * and the destination factors and blend color stay native. A blended draw
 * whose RGB equation uses factors (FUNC_ADD, FUNC_SUBTRACT,
 * FUNC_REVERSE_SUBTRACT; MIN and MAX ignore factors) runs a private fragment
 * variant (reversed-depth.ts holds the variant machinery) that multiplies the
 * fragment's RGB by the logical source factor, so the native equation sees
 *   Cs * Fs (op) Cd * Fd
 * exactly as ES 2.0 defines it. For a fixed-point color buffer the source
 * color and the factor are clamped to [0, 1] first, as the fixed-point
 * conversion and blend clamping would have done; for a floating-point color
 * buffer (EXT_color_buffer_half_float section 4.1.6) neither is clamped.
 * The RGB source factor is a constant, and the alpha output, alpha factors
 * and destination factors (which may read source alpha) are untouched.
 *
 * Cost: the factor is computed when BlendFunc/BlendColor change; a draw tests
 * one shadow field. Only draws that actually blend with such a pair pay for
 * the variant, a framebuffer component-type query and, when the factor
 * changed, one uniform upload.
 */
import type { GlShadowState } from "./shadow.js";
import type { GlBinding } from "./registry.js";
import { checkedGlCall } from "./program-objects.js";
import { glslTokens } from "./attribute-aliasing.js";
import { renameIdentifiers } from "./reversed-depth.js";

const CONSTANT_COLOR = 0x8001, ONE_MINUS_CONSTANT_COLOR = 0x8002;
const CONSTANT_ALPHA = 0x8003, ONE_MINUS_CONSTANT_ALPHA = 0x8004;
const FUNC_ADD = 0x8006, FUNC_SUBTRACT = 0x800a, FUNC_REVERSE_SUBTRACT = 0x800b;
const ONE = 1;
export const BLEND_SOURCE_FACTOR_UNIFORM = "kandelo_blend_source_factor";
const MAIN = "kandelo_blend_main";

const constantColor = (factor: number) => factor === CONSTANT_COLOR || factor === ONE_MINUS_CONSTANT_COLOR;
const constantAlpha = (factor: number) => factor === CONSTANT_ALPHA || factor === ONE_MINUS_CONSTANT_ALPHA;

/** The RGB factor pair WebGL refuses. */
export function webglForbiddenBlendPair(srcRGB: number, dstRGB: number): boolean {
  return (constantColor(srcRGB) && constantAlpha(dstRGB)) || (constantAlpha(srcRGB) && constantColor(dstRGB));
}

/** The factors installed natively for a logical blend function. */
export function nativeBlendFunc(f: GlShadowState["blendFunc"]): [number, number, number, number] {
  return [webglForbiddenBlendPair(f.srcRGB, f.dstRGB) ? ONE : f.srcRGB, f.dstRGB, f.srcA, f.dstA];
}

/** Recompute the folded RGB source factor after BlendFunc or BlendColor. A new
 * array per change lets each variant detect a stale uniform by identity. */
export function updateBlendSourceFactor(s: GlShadowState): void {
  const { srcRGB, dstRGB } = s.blendFunc;
  if (!webglForbiddenBlendPair(srcRGB, dstRGB)) { s.blendSourceFactor = null; return; }
  const [r, g, b, a] = s.blendColor;
  const factor: [number, number, number] = srcRGB === CONSTANT_COLOR ? [r, g, b]
    : srcRGB === ONE_MINUS_CONSTANT_COLOR ? [1 - r, 1 - g, 1 - b]
    : srcRGB === CONSTANT_ALPHA ? [a, a, a] : [1 - a, 1 - a, 1 - a];
  s.blendSourceFactor = factor;
}

/** Whether this draw needs the fold. Null-factor draws exit on the first test. */
export function blendFoldNeeded(s: GlShadowState): boolean {
  if (s.blendSourceFactor === null || !s.blendEnabled) return false;
  const equation = s.blendEquation.rgb;
  return equation === FUNC_ADD || equation === FUNC_SUBTRACT || equation === FUNC_REVERSE_SUBTRACT;
}

/** "fixed" or "float" for the draw framebuffer's color buffer; null when a
 * native query failed (recorded). A framebuffer without a color attachment
 * writes no color, so either variant is exact; "fixed" is used. */
export function drawColorBufferKind(b: GlBinding): "fixed" | "float" | null {
  const gl = b.gl!;
  let kind: "fixed" | "float" = "fixed";
  if (!checkedGlCall(b, () => {
    const framebuffer = gl.getParameter(0x8ca6) as WebGLFramebuffer | null; // DRAW_FRAMEBUFFER_BINDING
    const attachment = framebuffer ? 0x8ce0 : 0x0405; // COLOR_ATTACHMENT0 : BACK
    const type = Number(gl.getFramebufferAttachmentParameter(0x8ca9, attachment, 0x8cd0)); // OBJECT_TYPE
    if (type === 0) return; // NONE
    if (Number(gl.getFramebufferAttachmentParameter(0x8ca9, attachment, 0x8211)) === 0x1406) kind = "float"; // COMPONENT_TYPE FLOAT
  })) return null;
  return kind;
}

/** The fragment stage of a folding variant: the guest's main becomes an
 * ordinary function, then the color it wrote is multiplied by the source
 * factor. GLSL ES 1.00 shaders write gl_FragColor or gl_FragData[0] (WebGL 2
 * rejects other gl_FragData indices). Null for GLSL ES 3.00 sources, which
 * are not ES 2.0 shaders and have no built-in color output to fold. */
export function blendFoldShaderSource(source: string, clampColor: boolean): string | null {
  if (/^\s*#\s*version\s+[1-9][0-9][0-9]\s+es/m.test(source)) return null;
  const output = glslTokens(source, true).some(token => token.text === "gl_FragData") ? "gl_FragData[0]" : "gl_FragColor";
  const { text } = renameIdentifiers(source, new Map([["main", MAIN]]));
  const product = clampColor
    ? `clamp(${output}.rgb, 0.0, 1.0) * clamp(${BLEND_SOURCE_FACTOR_UNIFORM}, 0.0, 1.0)`
    : `${output}.rgb * ${BLEND_SOURCE_FACTOR_UNIFORM}`;
  return `${text}\nuniform highp vec3 ${BLEND_SOURCE_FACTOR_UNIFORM};\n` +
    `void main() { ${MAIN}(); ${output}.rgb = ${product}; }\n`;
}
