import { INPUT_POINTER_ABS_MAX } from "../../src/generated/abi";

/**
 * The `/dev/input/event1` `EV_ABS` value that places a libinput consumer's
 * pointer at output pixel `px` on an output `extent` pixels long. libinput
 * scales a value `v` to `v * extent / (INPUT_POINTER_ABS_MAX + 1)`; rounding
 * up keeps the scaled position at `px` instead of one pixel short.
 */
export function pointerAbs(px: number, extent: number): number {
  return Math.ceil((px * (INPUT_POINTER_ABS_MAX + 1)) / extent);
}
