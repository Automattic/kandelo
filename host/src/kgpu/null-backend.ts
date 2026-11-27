/**
 * The backend of a GPU worker with no renderer.
 *
 * WHY it exists: "no renderer" must fail visibly, never render nothing and
 * report success. The kernel already refuses context creation with ENODEV
 * while no renderer is set, so a null worker normally never sees a record;
 * if one does arrive, every surface creation answers ENODEV and the executor
 * reports the context lost with that errno.
 */
import { ENODEV, type KgpuBackend } from "./backend.ts";

export function createNullBackend(): KgpuBackend {
  return {
    createSurface: () => -ENODEV,
    destroySurface: () => {},
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    readPixels: () => -ENODEV,
    // Not "lost": there was never a renderer, and creation says so (ENODEV).
    isLost: () => false,
  };
}
