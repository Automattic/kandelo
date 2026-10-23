import * as O from "./ops.js";
import { EXTRA_PIXEL_STORE_DEFAULTS } from "./shadow.js";

const INVALID_ENUM = 0x500;
const INVALID_VALUE = 0x501;
const caps = new Set([0x0bd0, 0x0b71, 0x0b90, 0x0be2, 0x0b44, 0x0c11, 0x8037, 0x809e, 0x80a0]);
const faces = new Set([0x0404, 0x0405, 0x0408]);
// EXT_blend_minmax is part of the existing advertised WebGL2-backed API.
const equations = new Set([0x8006, 0x800a, 0x800b, 0x8007, 0x8008]);
const stencilOps = new Set([0, 0x1e00, 0x1e01, 0x1e02, 0x1e03, 0x150a, 0x8507, 0x8508]);
const pixelStore = new Set(EXTRA_PIXEL_STORE_DEFAULTS.map(([name]) => name));
const compare = (value: number) => value >= 0x200 && value <= 0x207;
const blendFactors = new Set([
  0, 1, 0x0300, 0x0301, 0x0302, 0x0303, 0x0304, 0x0305, 0x0306, 0x0307,
  0x8001, 0x8002, 0x8003, 0x8004,
]);
const sourceFactor = (value: number) => value === 0x0308 || blendFactors.has(value);

/** GLES errors reject one command, not its structurally valid batch. Check
 * arguments before native calls or shadow changes, so later owner replay
 * cannot turn an invalid call into a persistent state mutation. */
export function stateArgumentError(op: number, v: DataView): number {
  const u = (offset = 0) => v.getUint32(offset, true);
  switch (op) {
    case O.OP_CLEAR: return (u() & ~(0x4000 | 0x100 | 0x400)) !== 0 ? INVALID_VALUE : 0;
    case O.OP_VIEWPORT:
    case O.OP_SCISSOR:
      return v.getInt32(8, true) < 0 || v.getInt32(12, true) < 0 ? INVALID_VALUE : 0;
    case O.OP_ENABLE:
    case O.OP_DISABLE: return caps.has(u()) ? 0 : INVALID_ENUM;
    case O.OP_DEPTH_FUNC: return compare(u()) ? 0 : INVALID_ENUM;
    case O.OP_CULL_FACE: return faces.has(u()) ? 0 : INVALID_ENUM;
    case O.OP_FRONT_FACE: return u() === 0x900 || u() === 0x901 ? 0 : INVALID_ENUM;
    case O.OP_LINE_WIDTH:
      return v.getFloat32(0, true) > 0 ? 0 : INVALID_VALUE;
    case O.OP_BLEND_FUNC:
      return sourceFactor(u()) && blendFactors.has(u(4)) ? 0 : INVALID_ENUM;
    case O.OP_BLEND_FUNC_SEPARATE:
      return sourceFactor(u()) && blendFactors.has(u(4)) &&
        sourceFactor(u(8)) && blendFactors.has(u(12)) ? 0 : INVALID_ENUM;
    case O.OP_BLEND_EQUATION: return equations.has(u()) ? 0 : INVALID_ENUM;
    case O.OP_BLEND_EQUATION_SEPARATE:
      return equations.has(u()) && equations.has(u(4)) ? 0 : INVALID_ENUM;
    case O.OP_STENCIL_FUNC: return compare(u()) ? 0 : INVALID_ENUM;
    case O.OP_STENCIL_FUNC_SEPARATE:
      return faces.has(u()) && compare(u(4)) ? 0 : INVALID_ENUM;
    case O.OP_STENCIL_MASK_SEPARATE: return faces.has(u()) ? 0 : INVALID_ENUM;
    case O.OP_STENCIL_OP:
      return [u(), u(4), u(8)].every(value => stencilOps.has(value)) ? 0 : INVALID_ENUM;
    case O.OP_STENCIL_OP_SEPARATE:
      return faces.has(u()) && [u(4), u(8), u(12)].every(value => stencilOps.has(value)) ? 0 : INVALID_ENUM;
    case O.OP_PIXEL_STOREI: {
      const name = u(), value = v.getInt32(4, true);
      if (name === 0x0cf5 || name === 0x0d05) return [1, 2, 4, 8].includes(value) ? 0 : INVALID_VALUE;
      if (!pixelStore.has(name)) return INVALID_ENUM;
      return value < 0 ? INVALID_VALUE : 0;
    }
    default: return 0;
  }
}
