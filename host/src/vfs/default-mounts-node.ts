/**
 * Node-only resolver for {@link MountSpec}: lives in its own module so
 * the universal `default-mounts.ts` doesn't drag `node:fs` /
 * `node:path` / `HostFileSystem` into browser bundles.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { MountConfig } from "./types";
import { MemoryFileSystem } from "./memory-fs";
import {
  createSessionOwnedHostFileSystem,
  HostFileSystem,
} from "./host-fs";
import {
  restoreVerifiedImageMounts,
  validateSpec,
  type MountSpec,
} from "./default-mounts";

/**
 * Materialise `spec` for the Node host. Image mounts get a fresh,
 * cryptographically verified `MemoryFileSystem`; scratch mounts get a
 * `HostFileSystem` rooted at `<sessionDir><spec.path>` (the directory is
 * created with `mkdirSync({recursive:true})` so `safePath` is happy on first
 * access).
 *
 * The public resolver treats `sessionDir` as caller-owned. Exact native append
 * authority is reserved for the internal resolver whose caller already owns a
 * runtime-created random root.
 */
export function resolveForNode(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  sessionDir: string,
): Promise<MountConfig[]> {
  validateSpec(spec);
  return resolveValidatedForNode(spec, rootfsImage, sessionDir, false);
}

async function resolveValidatedForNode(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  sessionDir: string,
  sessionOwned: boolean,
): Promise<MountConfig[]> {
  const imageMounts = await restoreVerifiedImageMounts(spec, rootfsImage);
  const out: MountConfig[] = [];
  for (const m of spec) {
    if (m.source === "image") {
      const backend = imageMounts.get(m);
      if (backend === undefined) {
        throw new Error(`verified image mount is missing: ${m.path}`);
      }
      out.push({
        mountPoint: m.path,
        backend,
        readonly: m.readonly,
      });
    } else {
      const hostDir = join(sessionDir, m.path);
      mkdirSync(hostDir, { recursive: true, mode: m.mode });
      const backend = sessionOwned
        ? createSessionOwnedHostFileSystem(hostDir)
        : new HostFileSystem(hostDir);
      if (m.mode !== undefined) backend.chmod("/", m.mode);
      if (m.uid !== undefined || m.gid !== undefined) {
        backend.chown("/", m.uid ?? 0, m.gid ?? 0);
      }
      out.push({
        mountPoint: m.path,
        backend,
        readonly: m.readonly,
      });
    }
  }
  return out;
}

/**
 * Materialise mounts beneath the Node worker's private per-boot session root.
 *
 * @internal The caller must have created a fresh, unshared directory and must
 * retain its cleanup lease for the complete kernel lifetime. This distinct
 * entry point prevents a caller-selected path from acquiring exact native
 * append authority.
 */
export function resolveForNodeKernelSession(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  sessionDir: string,
): Promise<MountConfig[]> {
  validateSpec(spec);
  return resolveValidatedForNode(spec, rootfsImage, sessionDir, true);
}
