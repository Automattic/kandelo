import type { GbmBoRegistry } from "./registry.js";

export type HostFb = {
  fb_id: number;
  bo_id: number;
  width: number;
  height: number;
  pixel_format: number;
  pitch: number;
};

/** Build a `struct drm_mode_modeinfo` (68 B) describing the default
 *  videomode the virtual KMS connector advertises. Kandelo's KMS surface
 *  has no real fixed mode — programs render into whatever dumb buffer
 *  they create — but `DRM_IOCTL_MODE_GETCONNECTOR` consumers (SDL2's
 *  KMSDRM backend in particular) reject connectors whose first mode has
 *  zero hdisplay/vdisplay with "Couldn't get a valid connector
 *  videomode." We return a standard 1024x768@60 VESA mode flagged
 *  `PREFERRED | DRIVER` so SDL2 picks it up as the connector's preferred
 *  mode in `KMSDRM_AddDisplay`'s fallback loop. */
export function buildVirtualConnectorMode(_connectorId: number): Uint8Array {
  const out = new Uint8Array(68);
  const view = new DataView(out.buffer);
  // 1024x768@60 VESA-standard timing.
  view.setUint32(0, 65000, true);         // clock kHz
  view.setUint16(4, 1024, true);          // hdisplay
  view.setUint16(6, 1048, true);          // hsync_start
  view.setUint16(8, 1184, true);          // hsync_end
  view.setUint16(10, 1344, true);         // htotal
  view.setUint16(12, 0, true);            // hskew
  view.setUint16(14, 768, true);          // vdisplay
  view.setUint16(16, 771, true);          // vsync_start
  view.setUint16(18, 777, true);          // vsync_end
  view.setUint16(20, 806, true);          // vtotal
  view.setUint16(22, 0, true);            // vscan
  view.setUint32(24, 60, true);           // vrefresh
  view.setUint32(28, 0, true);            // flags
  // DRM_MODE_TYPE_PREFERRED (1<<3) | DRM_MODE_TYPE_DRIVER (1<<6).
  view.setUint32(32, (1 << 3) | (1 << 6), true);
  const name = "1024x768";                // name[32], NUL-padded
  for (let i = 0; i < name.length && i < 31; i++) {
    out[36 + i] = name.charCodeAt(i);
  }
  return out;
}

export class KmsRegistry {
  private fbs = new Map<number, HostFb>();
  private crtcBindings = new Map<number, number>();
  private masterPid: number | null = null;

  constructor(private gbm: GbmBoRegistry) {}

  addFb(fb: HostFb): void { this.fbs.set(fb.fb_id, fb); }
  rmFb(fb_id: number): void { this.fbs.delete(fb_id); }
  setFb(crtc_id: number, fb_id: number): void { this.crtcBindings.set(crtc_id, fb_id); }

  currentFb(crtc_id: number): HostFb | undefined {
    const id = this.crtcBindings.get(crtc_id);
    return id === undefined ? undefined : this.fbs.get(id);
  }

  setMasterPid(pid: number): void { this.masterPid = pid; }
  dropMaster(): void { this.masterPid = null; }
  isMasterPid(pid: number): boolean { return this.masterPid === pid; }

  /** First CRTC with an FB bound for which `pid` holds DRM master.
   *  Null if `pid` is not master or no CRTC has an FB yet. The kernel
   *  currently advertises a single CRTC, so the iteration order doesn't
   *  matter; once multi-head lands the caller can iterate `crtcBindings`
   *  directly. */
  masterCrtcForPid(pid: number): number | null {
    if (this.masterPid !== pid) return null;
    for (const crtc_id of this.crtcBindings.keys()) {
      return crtc_id;
    }
    return null;
  }

  scanoutBytes(crtc_id: number): Uint8Array | undefined {
    const fb = this.currentFb(crtc_id);
    if (!fb) return undefined;
    this.gbm.syncFromMemory(fb.bo_id);
    return this.gbm.pixelView(fb.bo_id);
  }
}
