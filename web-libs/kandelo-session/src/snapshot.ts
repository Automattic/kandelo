// Snapshot exporter — "fold a computer into a URL."
//
// Walks a BootDescriptor's writable mounts, evaluates the size of any
// inline overlay, and picks the smallest viable ShareMode. Wraps the
// produced descriptor in a Snapshot record that the Share dialog renders.
//
// What this is NOT (yet):
//   - It does not walk a live kernel VFS to compute a fresh overlay from
//     current writable state. That's the kernel/host-side gap noted in
//     kernel-host-contract.md ("Snapshot exporter"). When the diff engine
//     lands, this file's pickMode() stays the same — only takeSnapshot()
//     grows a "walk mounts, build overlay" step before mode selection.
//
// Mode-picker thresholds match the README:
//
//   preset    ← descriptor has no writable changes / no inline overlay
//   delta     ← compressed inline overlay ≤ 6 KB
//   inline    ← 6 KB < compressed payload ≤ 28 KB
//   manifest  ← compressed payload > 28 KB
//   private   ← explicit user choice (encrypts overlay; key in fragment)
//   local     ← explicit user choice (references OPFS workspace)
//
// `recipe`, `replay`, `live` are explicit-only and not chosen by auto.

import {
  BootDescriptorError, encodeBootDescriptor,
} from "./boot-descriptor";
import type {
  BootDescriptor, ShareMode, Snapshot, SnapshotOptions,
} from "./kernel-host";

// Auto-mode size thresholds (bytes of *compressed* k1 payload).
const DELTA_MAX = 6 * 1024;
const INLINE_MAX = 28 * 1024;

/**
 * Build a Snapshot from a (potentially live-walked) BootDescriptor.
 *
 * Today this just runs the encoder, measures, and picks a mode. When the
 * kernel-side overlay walker lands, callers will pre-fill `descriptor.mounts`
 * with the freshly-computed inline-overlay entry before calling in.
 */
export async function takeSnapshot(
  descriptor: BootDescriptor,
  opts: SnapshotOptions = {},
): Promise<Snapshot> {
  // Find an inline-overlay mount so we can measure it; many descriptors
  // won't have one (preset machines) and that's fine.
  const overlay = descriptor.mounts.find((m) => m.source === "inline-overlay");
  const overlayBytes = typeof overlay?.data === "string" ? overlay.data.length : 0;

  // Honor explicit mode preference, but still compute encoded size for the
  // UI to display.
  let mode: Exclude<ShareMode, "auto">;
  let reason: string;
  if (opts.preferMode && opts.preferMode !== "auto") {
    mode = opts.preferMode as Exclude<ShareMode, "auto">;
    reason = `Mode forced to ${opts.preferMode}.`;
  } else {
    const picked = pickMode(overlayBytes);
    mode = picked.mode;
    reason = picked.reason;
  }

  // Encode to get a real byte count for the URL bar / tier display. If
  // encoding throws (payload exceeds cap), promote to manifest and report.
  let byteSize: number;
  try {
    const enc = await encodeBootDescriptor(descriptor);
    byteSize = enc.urlBytes;
  } catch (err) {
    if (err instanceof BootDescriptorError && err.code === "E_PAYLOAD_TOO_LARGE") {
      mode = "manifest";
      reason = "Compressed payload exceeded URL caps — uploaded as a manifest.";
      byteSize = 0;
    } else {
      throw err;
    }
  }

  return { descriptor, mode, byteSize, reason };
}

interface PickedMode {
  mode: Exclude<ShareMode, "auto">;
  reason: string;
}

export function pickMode(overlayBytes: number): PickedMode {
  if (overlayBytes === 0) {
    return {
      mode: "preset",
      reason: "No writable state to encode — link is a preset.",
    };
  }
  if (overlayBytes <= DELTA_MAX) {
    return {
      mode: "delta",
      reason: `${overlayBytes} byte overlay fits inline as a delta.`,
    };
  }
  if (overlayBytes <= INLINE_MAX) {
    return {
      mode: "inline",
      reason: `${overlayBytes} byte payload fits in a power-user URL.`,
    };
  }
  return {
    mode: "manifest",
    reason: `${overlayBytes} byte payload too large to inline — uploaded as a manifest.`,
  };
}
