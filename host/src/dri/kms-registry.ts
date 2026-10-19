import type { KmsCursor } from "./cursor-plane.js";
import type { GbmBoRegistry } from "./registry.js";

export type HostFb = {
  fb_id: number;
  bo_id: number;
  width: number;
  height: number;
  pixel_format: number;
  pitch: number;
};

/** The size the virtual connector advertises for a reported display size:
 *  even-aligned and clamped to the mode range, or the 1920x1080 default
 *  when the embedder reported nothing. Anything that sizes a drawing
 *  buffer to the advertised mode derives it here, so the buffer and the
 *  mode can never disagree by a pixel. */
export function connectorModeSize(
  display?: { width: number; height: number },
): { width: number; height: number } {
  if (!display || !(display.width >= 1) || !(display.height >= 1)) {
    return { width: 1920, height: 1080 };
  }
  return {
    width: Math.min(3840, Math.max(640, Math.round(display.width) & ~1)),
    height: Math.min(2160, Math.max(480, Math.round(display.height) & ~1)),
  };
}

/** Build a `struct drm_mode_modeinfo` (68 B) describing the default
 *  videomode the virtual KMS connector advertises. Kandelo's KMS surface
 *  has no real fixed mode — programs render into whatever dumb buffer
 *  they create — but `DRM_IOCTL_MODE_GETCONNECTOR` consumers (SDL2's
 *  KMSDRM backend in particular) reject connectors whose first mode has
 *  zero hdisplay/vdisplay with "Couldn't get a valid connector
 *  videomode."
 *
 *  When the embedder has reported the display's device-pixel size
 *  (`setKmsDisplaySize`, threaded through as `display` here), the mode IS
 *  that size, even-aligned and clamped to [640, 3840] × [480, 2160]. One
 *  mode pixel per device pixel is what keeps a GL compositor's output
 *  from being resampled on its way to the canvas. It is also what makes
 *  a `wl_output` scale meaningful: a compositor divides the mode by its
 *  scale to get the logical grid its clients lay out in, and a mode
 *  derived from anything but device pixels makes that division lie.
 *  Deriving it from the display's ASPECT alone, at a fixed 1080-line
 *  height, renders a HiDPI pane at half its real resolution.
 *  Without a reported size (Node hosts, headless
 *  stats-only CRTCs, the modeset and sdl2 demos, which never call
 *  `setKmsDisplaySize`) the mode is the historical 1920x1080@60. */
export function buildVirtualConnectorMode(
  _connectorId: number,
  display?: { width: number; height: number },
): Uint8Array {
  const { width: w, height: h } = connectorModeSize(display);
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
  private flips = 0;
  private cursor: KmsCursor = {
    version: 0, x: 0, y: 0, hotX: 0, hotY: 0, width: 0, height: 0, pixels: null,
  };

  private cursorBo = 0;
  private cursorBytes: Uint8Array | null = null;

  /** Called under the kernel entry before deferred canvas presentation.
   * Cursor mappings remain live, just like scanout; only changed pixels
   * allocate a new owned snapshot for the detached observer phase. */
  cursorSnapshot(): KmsCursor {
    if (!this.cursorBo) return this.cursor;
    const length = this.cursor.width * this.cursor.height * 4;
    // Cursor images use a packed prefix, even in a larger allocation.
    // Never flush stale importer mappings over the producer's live image.
    this.gbm.syncCreatorToSab(this.cursorBo, length);
    const bytes = this.gbm.pixelView(this.cursorBo);
    if (!bytes || bytes.length < length) {
      throw new Error("KMS cursor BO is unavailable or undersized");
    }
    if (this.cursorBytes?.every((value, i) => value === bytes[i])) return this.cursor;
    this.cursorBytes = bytes.slice(0, length);
    const pixels = new Uint8ClampedArray(length);
    // Linux cursor images are tightly packed premultiplied ARGB8888;
    // ImageData requires straight-alpha RGBA, including partial alpha.
    for (let i = 0; i < length; i += 4) {
      const a = bytes[i + 3];
      pixels[i] = a ? bytes[i + 2] * 255 / a : 0;
      pixels[i + 1] = a ? bytes[i + 1] * 255 / a : 0;
      pixels[i + 2] = a ? bytes[i] * 255 / a : 0;
      pixels[i + 3] = a;
    }
    this.cursor = { ...this.cursor, version: this.cursor.version + 1, pixels };
    return this.cursor;
  }

  setCursor(_pid: number, flags: number, boId: number, width: number, height: number,
    x: number, y: number, hotX: number, hotY: number): void {
    const next = { ...this.cursor, version: this.cursor.version + 1 };
    if (flags & 1) {
      this.cursorBo = boId;
      this.cursorBytes = null;
      next.pixels = null;
      next.width = width;
      next.height = height;
      next.hotX = hotX;
      next.hotY = hotY;
    }
    if (flags & 2) { next.x = x; next.y = y; }
    this.cursor = next;
    this.cursorSnapshot();
  }

  constructor(private gbm: GbmBoRegistry) {}

  addFb(fb: HostFb): void { this.fbs.set(fb.fb_id, fb); }
  rmFb(fb_id: number): void { this.fbs.delete(fb_id); }
  setFb(crtc_id: number, fb_id: number): void {
    this.flips++;
    this.crtcBindings.set(crtc_id, fb_id);
  }

  /** Monotonic count of SETCRTC/PAGE_FLIP latches. The vblank pump
   *  compares it across ticks to wake blocked pollers only when a flip
   *  could have retired into an event ring. */
  flipCount(): number { return this.flips; }

  currentFb(crtc_id: number): HostFb | undefined {
    const id = this.crtcBindings.get(crtc_id);
    return id === undefined ? undefined : this.fbs.get(id);
  }

  setMasterPid(pid: number): void { this.masterPid = pid; }
  dropMaster(): void {
    this.masterPid = null;
    this.cursorBo = 0;
    this.cursorBytes = null;
    this.cursor = { ...this.cursor, version: this.cursor.version + 1, pixels: null };
  }
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
