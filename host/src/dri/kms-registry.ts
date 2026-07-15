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
 *  videomode."
 *
 *  When the embedder has reported the display's device-pixel size
 *  (`setKmsDisplaySize`, threaded through as `display` here), the mode
 *  follows the display's ASPECT at a fixed 1080 logical height:
 *  `round(1080 × aspect) × 1080`, width clamped to [1440, 3840] and
 *  even-aligned. A mode-picking client (wlcompositor, SDL2 KMSDRM) then
 *  fills the pane edge-to-edge with no letterbox. The height stays 1080
 *  so fixed-size client windows keep fitting vertically regardless of
 *  how wide the pane is; very tall panes clamp at 1440 wide and
 *  letterbox again rather than squeezing windows off-screen. Without a
 *  reported size (Node hosts, headless stats-only CRTCs) the mode is
 *  the historical 1920x1080@60. */
export function buildVirtualConnectorMode(
  _connectorId: number,
  display?: { width: number; height: number },
): Uint8Array {
  let w = 1920;
  if (display && display.width >= 1 && display.height >= 1) {
    const aspect = display.width / display.height;
    w = Math.round(1080 * aspect) & ~1;
    w = Math.min(3840, Math.max(1440, w));
  }
  const h = 1080;
  // Synthetic CVT-ish blanking: consumers here only read
  // hdisplay/vdisplay/vrefresh (and libdrm derives refresh from
  // clock/totals), so the porches just need to be self-consistent.
  const htotal = w + 280;
  const vtotal = h + 45;
  const out = new Uint8Array(68);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.round((htotal * vtotal * 60) / 1000), true); // clock kHz
  view.setUint16(4, w, true);             // hdisplay
  view.setUint16(6, w + 88, true);        // hsync_start
  view.setUint16(8, w + 132, true);       // hsync_end
  view.setUint16(10, htotal, true);       // htotal
  view.setUint16(12, 0, true);            // hskew
  view.setUint16(14, h, true);            // vdisplay
  view.setUint16(16, h + 4, true);        // vsync_start
  view.setUint16(18, h + 9, true);        // vsync_end
  view.setUint16(20, vtotal, true);       // vtotal
  view.setUint16(22, 0, true);            // vscan
  view.setUint32(24, 60, true);           // vrefresh
  view.setUint32(28, 0, true);            // flags
  // DRM_MODE_TYPE_PREFERRED (1<<3) | DRM_MODE_TYPE_DRIVER (1<<6).
  view.setUint32(32, (1 << 3) | (1 << 6), true);
  const name = `${w}x${h}`;               // name[32], NUL-padded
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
  /** The pid currently holding DRM master, or null. The compositor's
   *  scanout context is the shared GPU-bo multiplexer context, so the
   *  host resolves it via this pid. */
  getMasterPid(): number | null { return this.masterPid; }

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
