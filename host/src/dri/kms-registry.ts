import { KMS_CURSOR_RECORD_BYTES } from "./kms-cursor-protocol.js";
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
  private masterFileId: bigint | null = null;
  private masterLeaseId = 0n;
  private lastMasterLeaseId = 0n;
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
    // Merge writes from any mapping; unchanged readers cannot erase them.
    const gpu = this.readGpuCursor?.(this.cursorBo, this.cursor.width, this.cursor.height);
    if (gpu === null) {
      // Lost native storage cannot keep advertising the previous image.
      this.cursorBytes = null;
      if (this.cursor.pixels) this.cursor = { ...this.cursor,
        version: this.cursor.version + 1, pixels: null };
      return this.cursor;
    }
    if (gpu === undefined) this.gbm.syncToSab(this.cursorBo, length);
    const bytes = gpu ?? this.gbm.pixelView(this.cursorBo);
    if (!bytes || bytes.length < length) {
      throw new Error("KMS cursor BO is unavailable or undersized");
    }
    if (this.cursorBytes?.every((value, i) => value === bytes[i])) return this.cursor;
    this.cursorBytes = bytes.slice(0, length);
    const pixels = new Uint8ClampedArray(length);
    // CPU cursor images use premultiplied ARGB8888 bytes; native GPU
    // readback is already RGBA. Both need straight alpha for ImageData.
    for (let i = 0; i < length; i += 4) {
      const a = bytes[i + 3];
      pixels[i] = a ? bytes[i + (gpu === undefined ? 2 : 0)] * 255 / a : 0;
      pixels[i + 1] = a ? bytes[i + 1] * 255 / a : 0;
      pixels[i + 2] = a ? bytes[i + (gpu === undefined ? 0 : 2)] * 255 / a : 0;
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

  /** A queued observer record cannot cross a drop/reacquire boundary. */
  applyCursorRecord(bytes: Uint8Array): void {
    if (bytes.byteLength !== KMS_CURSOR_RECORD_BYTES) throw new Error("Invalid KMS cursor record");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getBigUint64(0, true) !== this.masterLeaseId) return;
    if (view.getUint32(36, true) !== 0) throw new Error("Invalid KMS cursor reserved word");
    const bo = view.getUint32(8, true);
    const width = view.getUint32(12, true), height = view.getUint32(16, true);
    const x = view.getInt32(20, true), y = view.getInt32(24, true);
    const hotX = view.getInt32(28, true), hotY = view.getInt32(32, true);
    if (bo && (!width || !height || width > 64 || height > 64)) {
      throw new Error("Invalid KMS cursor image geometry");
    }
    const imageChanged = bo !== this.cursorBo || width !== this.cursor.width
      || height !== this.cursor.height || hotX !== this.cursor.hotX || hotY !== this.cursor.hotY;
    this.setCursor(0, imageChanged ? 3 : 2, bo, width, height, x, y, hotX, hotY);
  }

  constructor(private gbm: GbmBoRegistry,
    // Synchronous owned RGBA bytes from actual retained native storage.
    // undefined selects CPU storage; null means native context loss.
    private readGpuCursor?: (bo: number, width: number, height: number) =>
      Uint8Array<ArrayBuffer> | null | undefined) {}

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

  setMaster(pid: number, fileId: bigint, leaseId: bigint): boolean {
    const max = 0xffff_ffff_ffff_ffffn;
    if (typeof fileId !== "bigint" || typeof leaseId !== "bigint"
        || fileId <= 0n || fileId > max || leaseId <= 0n || leaseId > max) {
      throw new Error("Invalid DRM master identity");
    }
    if (leaseId < this.lastMasterLeaseId
        || (leaseId === this.lastMasterLeaseId
          && (this.masterFileId !== fileId || this.masterLeaseId !== leaseId))) return false;
    if (leaseId > this.lastMasterLeaseId) {
      this.clearCursor();
      this.lastMasterLeaseId = leaseId;
    }
    this.masterPid = pid;
    this.masterFileId = fileId;
    this.masterLeaseId = leaseId;
    return true;
  }

  private clearCursor(): void {
    this.cursorBo = 0;
    this.cursorBytes = null;
    this.cursor = { version: this.cursor.version + 1, x: 0, y: 0,
      hotX: 0, hotY: 0, width: 0, height: 0, pixels: null };
  }

  /** A late release receipt must not clear a renewed grant. */
  dropMaster(fileId: bigint, leaseId: bigint): boolean {
    if (this.masterFileId !== fileId || this.masterLeaseId !== leaseId) return false;
    this.masterPid = null;
    this.masterFileId = null;
    this.masterLeaseId = 0n;
    this.clearCursor();
    return true;
  }

  isMasterFile(fileId: bigint | null | undefined): boolean {
    return fileId != null && this.masterFileId === fileId;
  }
  getMasterFileId(): bigint | null { return this.masterFileId; }
  getMasterLeaseId(): bigint { return this.masterLeaseId; }

  /** Presenter metadata is not authority and can outlive neither its Worker
   * nor its file's grant. Retiring one Worker does not close inherited fds. */
  notePresenter(pid: number): void { if (this.masterFileId !== null) this.masterPid = pid; }
  retirePresenter(pid: number): void { if (this.masterPid === pid) this.masterPid = null; }
  getMasterPid(): number | null { return this.masterPid; }

  masterCrtcForFile(fileId: bigint | null | undefined): number | null {
    if (!this.isMasterFile(fileId)) return null;
    for (const crtcId of this.crtcBindings.keys()) return crtcId;
    return null;
  }

  scanoutBytes(crtc_id: number): Uint8Array | undefined {
    const fb = this.currentFb(crtc_id);
    if (!fb) return undefined;
    this.gbm.syncFromMemory(fb.bo_id);
    return this.gbm.pixelView(fb.bo_id);
  }
}
