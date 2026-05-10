/**
 * Node-only resolver for {@link MountSpec}: lives in its own module so
 * the universal `default-mounts.ts` doesn't drag `node:fs` /
 * `node:path` / `HostFileSystem` into browser bundles.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { MountConfig } from "./types";
import { MemoryFileSystem } from "./memory-fs";
import { HostFileSystem } from "./host-fs";
import {
  IMAGE_MEMFS_MAX_BYTES,
  validateSpec,
  type MountSpec,
} from "./default-mounts";

/**
 * Materialise `spec` for the Node host. Image mounts get a fresh
 * `MemoryFileSystem.fromImage(rootfsImage)`; scratch mounts get a
 * `HostFileSystem` rooted at `<sessionDir><spec.path>` (the directory
 * is created with `mkdirSync({recursive:true})` so `safePath` is
 * happy on first access).
 *
 * Pure function: input → output, no global state.
 */
export function resolveForNode(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  sessionDir: string,
): MountConfig[] {
  validateSpec(spec);
  const out: MountConfig[] = [];
  for (const m of spec) {
    if (m.source === "image") {
      out.push({
        mountPoint: m.path,
        backend: MemoryFileSystem.fromImage(rootfsImage, {
          maxByteLength: IMAGE_MEMFS_MAX_BYTES,
        }),
        readonly: m.readonly,
      });
    } else {
      const hostDir = join(sessionDir, m.path);
      mkdirSync(hostDir, { recursive: true });
      out.push({
        mountPoint: m.path,
        backend: new HostFileSystem(hostDir),
        readonly: m.readonly,
      });
    }
  }
  return out;
}
