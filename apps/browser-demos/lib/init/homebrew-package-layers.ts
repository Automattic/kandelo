import {
  composeHomebrewRuntimeLayers,
  type ComposedHomebrewRuntimeLayers,
  type HomebrewRuntimeLayerReference,
} from "../../../../host/src/homebrew-runtime-layer-consumer";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import {
  validateBootDescriptor,
} from "../../../../web-libs/kandelo-session/src/boot-descriptor";
import type {
  BootDescriptor,
} from "../../../../web-libs/kandelo-session/src/kernel-host";

export interface ComposeBootDescriptorVfsOptions {
  descriptor: BootDescriptor;
  baseImageBytes: Uint8Array;
  maxByteLength?: number;
  kernelAbi: number;
  /** Credential-free descriptor transport. */
  fetch?: (url: string) => Promise<Response>;
  /** Credential-free deferred-tree transport. */
  archiveFetch?: (url: string) => Promise<Response>;
}

export interface ComposedBootDescriptorVfs extends ComposedHomebrewRuntimeLayers {
  references: HomebrewRuntimeLayerReference[];
}

/**
 * Project the closed `package-layer` mount surface into runtime-layer
 * references. Callers must validate the complete boot descriptor first so a
 * partially checked mount never reaches package transport.
 */
export function homebrewRuntimeLayerReferences(
  descriptor: BootDescriptor,
): HomebrewRuntimeLayerReference[] {
  return descriptor.mounts
    .filter((mount) => mount.source === "package-layer")
    .map((mount, index) => {
      if (
        typeof mount.name !== "string" ||
        typeof mount.url !== "string" ||
        typeof mount.ref !== "string" ||
        !mount.ref.startsWith("sha256:") ||
        typeof mount.bytes !== "number"
      ) {
        throw new Error(`package-layer mount ${index} was not validated`);
      }
      return {
        id: mount.name,
        descriptor: {
          url: mount.url,
          sha256: mount.ref.slice("sha256:".length),
          bytes: mount.bytes,
        },
      };
    });
}

/**
 * Restore one exact base image and apply every selected package layer through
 * the same closed boot-descriptor path used by the interactive browser host.
 * The returned filesystem is published only after the complete composition
 * succeeds; first-use payload archives remain deferred.
 */
export async function composeBootDescriptorVfs(
  options: ComposeBootDescriptorVfsOptions,
): Promise<ComposedBootDescriptorVfs> {
  validateBootDescriptor(options.descriptor);
  const references = homebrewRuntimeLayerReferences(options.descriptor);
  if (references.length === 0) {
    const fs = options.maxByteLength === undefined
      ? MemoryFileSystem.fromImagePreservingCapacity(options.baseImageBytes)
      : MemoryFileSystem.fromImage(options.baseImageBytes, {
        maxByteLength: options.maxByteLength,
      });
    return { fs, layers: [], references };
  }

  const composed = await composeHomebrewRuntimeLayers({
    baseImageBytes: options.baseImageBytes,
    ...(options.maxByteLength === undefined
      ? {}
      : { maxByteLength: options.maxByteLength }),
    arch: options.descriptor.runtime.arch,
    kernelAbi: options.kernelAbi,
    layers: references,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.archiveFetch === undefined
      ? {}
      : { archiveFetch: options.archiveFetch }),
  });
  return { ...composed, references };
}
