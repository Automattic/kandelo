import { KMS_CURSOR_FRAMEBUFFER_OFFSET, KMS_CURSOR_RECORD_BYTES } from "./kms-cursor-protocol.js";
import type { KmsCursor } from "./cursor-plane.js";
import type { GbmBoRegistry } from "./registry.js";
import { scanoutFormat } from "./scanout-format.js";
import { kmsGammaTable, type KmsGamma } from "./kms-gamma.js";

/** A framebuffer as ADDFB/ADDFB2 created it: plane 0 starts `offset` bytes
 *  into the BO (`drm_mode_fb_cmd2.offsets[0]`). */
export type HostFb = {
  fb_id: number;
  bo_id: number;
  width: number;
  height: number;
  pixel_format: number;
  pitch: number;
  offset?: number;
};

/** The region a CRTC scans out: its mode's active area at its panning
 *  offset (`drm_mode_crtc.x`/`y`), in framebuffer pixels. */
export type KmsViewport = { x: number; y: number; width: number; height: number };

/** What a CRTC presents. `width`/`height` are the viewport; `x`/`y` its
 *  origin in the framebuffer (texture coordinates for a GPU-tier BO); and
 *  `offset` the byte offset of the viewport's first pixel in the BO, so a
 *  CPU presenter reads `pitch`-strided rows from there. */
export type HostScanout = HostFb & { x: number; y: number; offset: number };

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
  private gammas = new Map<number, KmsGamma>();
  private gammaVersion = 0;
  private fbs = new Map<number, HostFb>();
  private crtcBindings = new Map<number, number>();
  private crtcViewports = new Map<number, KmsViewport>();
  private masterPid: number | null = null;
  private masterFileId: bigint | null = null;
  private masterLeaseId = 0n;
  private lastMasterLeaseId = 0n;
  private flips = 0;
  private cursor: KmsCursor = {
    version: 0, x: 0, y: 0, hotX: 0, hotY: 0, width: 0, height: 0, pixels: null,
  };

  private cursorBo = 0;
  private cursorFbId = 0;
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
        version: this.cursor.version + 1, pixels: null, premultiplied: null };
      return this.cursor;
    }
    if (gpu === undefined) this.gbm.syncToSab(this.cursorBo, length);
    const bytes = gpu ?? this.gbm.readPixelView(this.cursorBo);
    if (!bytes || bytes.length < length) {
      throw new Error("KMS cursor BO is unavailable or undersized");
    }
    if (this.cursorBytes?.every((value, i) => value === bytes[i])) return this.cursor;
    this.cursorBytes = bytes.slice(0, length);
    const pixels = new Uint8ClampedArray(length);
    const premultiplied = new Uint8ClampedArray(length);
    // CPU cursor images use premultiplied ARGB8888 bytes; native GPU
    // readback is already RGBA. Both need straight alpha for ImageData;
    // a CRTC color stage blends the premultiplied image itself.
    for (let i = 0; i < length; i += 4) {
      const a = bytes[i + 3];
      const r = bytes[i + (gpu === undefined ? 2 : 0)], g = bytes[i + 1], b = bytes[i + (gpu === undefined ? 0 : 2)];
      pixels[i] = a ? r * 255 / a : 0;
      pixels[i + 1] = a ? g * 255 / a : 0;
      pixels[i + 2] = a ? b * 255 / a : 0;
      pixels[i + 3] = a;
      premultiplied[i] = r; premultiplied[i + 1] = g; premultiplied[i + 2] = b; premultiplied[i + 3] = a;
    }
    this.cursor = { ...this.cursor, version: this.cursor.version + 1, pixels, premultiplied };
    return this.cursor;
  }

  setCursor(_pid: number, flags: number, boId: number, width: number, height: number,
    x: number, y: number, hotX: number, hotY: number, fbId = 0): KmsCursor {
    const next = { ...this.cursor, version: this.cursor.version + 1 };
    if (flags & 1) {
      this.cursorBo = boId;
      this.cursorFbId = fbId;
      this.cursorBytes = null;
      next.pixels = null;
      next.premultiplied = null;
      next.width = width;
      next.height = height;
      next.hotX = hotX;
      next.hotY = hotY;
    }
    if (flags & 2) { next.x = x; next.y = y; }
    this.cursor = next;
    return this.cursorSnapshot();
  }

  /** Apply the kernel's coalesced cursor-plane record (protocol 4). The
   *  cursor plane is device state, as on Linux: records carry no master
   *  grant, and a master change neither hides nor replaces the cursor. */
  applyCursorRecord(bytes: Uint8Array): KmsCursor | undefined {
    if (bytes.byteLength !== KMS_CURSOR_RECORD_BYTES) throw new Error("Invalid KMS cursor record");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getBigUint64(0, true) !== 0n) throw new Error("Invalid KMS cursor record");
    const fbId = view.getUint32(KMS_CURSOR_FRAMEBUFFER_OFFSET, true);
    const bo = view.getUint32(8, true);
    const width = view.getUint32(12, true), height = view.getUint32(16, true);
    const x = view.getInt32(20, true), y = view.getInt32(24, true);
    const hotX = view.getInt32(28, true), hotY = view.getInt32(32, true);
    if ((bo !== 0 && fbId === 0)
        || (bo === 0 && (fbId !== 0 || width !== 0 || height !== 0 || hotX !== 0 || hotY !== 0))) {
      throw new Error("Invalid KMS cursor image identity");
    }
    if (bo && (!width || !height || width > 64 || height > 64)) {
      throw new Error("Invalid KMS cursor image geometry");
    }
    const imageChanged = fbId !== this.cursorFbId || bo !== this.cursorBo || width !== this.cursor.width
      || height !== this.cursor.height || hotX !== this.cursor.hotX || hotY !== this.cursor.hotY;
    return this.setCursor(0, imageChanged ? 3 : 2, bo, width, height, x, y, hotX, hotY, fbId);
  }

  constructor(private gbm: GbmBoRegistry,
    // Synchronous owned RGBA bytes from actual retained native storage.
    // undefined selects CPU storage; null means native context loss.
    private readGpuCursor?: (bo: number, width: number, height: number) =>
      Uint8Array<ArrayBuffer> | null | undefined) {}

  /** The kernel changed the LUT the CRTC's output passes through
   *  (`host_kms_set_gamma`): 256 red, green, then blue 16-bit entries, or
   *  null for none. */
  setGamma(crtc_id: number, lut: Uint16Array | null): void {
    const table = lut ? kmsGammaTable(lut) : null;
    const previous = this.gammas.get(crtc_id);
    if (!table) {
      if (previous) this.gammas.delete(crtc_id);
      return;
    }
    if (previous && previous.table.every((value, i) => value === table[i])) return;
    this.gammas.set(crtc_id, { version: ++this.gammaVersion, table });
  }

  /** The CRTC's color stage, or null when its output is its planes as
   *  they are (no LUT, or one that maps every value to itself). */
  gamma(crtc_id: number): KmsGamma | null { return this.gammas.get(crtc_id) ?? null; }

  /** The current cursor plane image and position, without sampling its
   *  BO again (the vblank pump refreshes it each tick). */
  currentCursor(): KmsCursor { return this.cursor; }

  addFb(fb: HostFb): void { this.fbs.set(fb.fb_id, fb); }
  rmFb(fb_id: number): void { this.fbs.delete(fb_id); }
  /** Latch `fb_id` on the CRTC. The kernel always passes the scanned
   *  viewport; without one (or with an empty one) the whole fb is shown. */
  setFb(crtc_id: number, fb_id: number, viewport?: KmsViewport): void {
    this.flips++;
    this.crtcBindings.set(crtc_id, fb_id);
    if (viewport && viewport.width > 0 && viewport.height > 0) {
      this.crtcViewports.set(crtc_id, { ...viewport });
    } else {
      this.crtcViewports.delete(crtc_id);
    }
  }

  /** Whether the CRTC scans out nothing although it has scanned out:
   *  the kernel latched no framebuffer (a CRTC turned off, `ACTIVE` 0 or
   *  DPMS Off, or disabled), or the latched framebuffer was removed (RMFB
   *  disables the CRTC that scans it). A dark CRTC's output is black, on
   *  every presenter. A CRTC that never latched anything is not dark: its
   *  output was never shown. */
  isDark(crtc_id: number): boolean {
    const id = this.crtcBindings.get(crtc_id);
    return id !== undefined && (id === 0 || !this.fbs.has(id));
  }

  /** Monotonic count of SETCRTC/PAGE_FLIP latches. The vblank pump
   *  compares it across ticks to wake blocked pollers only when a flip
   *  could have retired into an event ring. */
  flipCount(): number { return this.flips; }

  /** The CRTC's scanout: the bound fb narrowed to the viewport the kernel
   *  latched. A viewport outside the fb (the kernel rejects those with
   *  ENOSPC) presents nothing rather than bytes outside the plane. */
  currentFb(crtc_id: number): HostScanout | undefined {
    const id = this.crtcBindings.get(crtc_id);
    const fb = id === undefined ? undefined : this.fbs.get(id);
    if (!fb) return undefined;
    const view = this.crtcViewports.get(crtc_id)
      ?? { x: 0, y: 0, width: fb.width, height: fb.height };
    if (view.x + view.width > fb.width || view.y + view.height > fb.height) return undefined;
    // Only a horizontal pan needs the format's pixel size; a format the
    // presenters reject is still reported unpanned for them to refuse.
    const xBytes = view.x === 0 ? 0 : view.x * scanoutFormat(fb.pixel_format).bytesPerPixel;
    return {
      ...fb,
      width: view.width,
      height: view.height,
      x: view.x,
      y: view.y,
      offset: (fb.offset ?? 0) + view.y * fb.pitch + xBytes,
    };
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
    // The cursor plane is device state: a new master inherits it.
    if (leaseId > this.lastMasterLeaseId) this.lastMasterLeaseId = leaseId;
    this.masterPid = pid;
    this.masterFileId = fileId;
    this.masterLeaseId = leaseId;
    return true;
  }

  /** The kernel destroyed a BO. The cursor plane holds a reference on its
   *  image, so this is only the image an already-queued record replaces;
   *  stop presenting it rather than read retired storage. Position stays. */
  retireCursorBo(boId: number): boolean {
    if (!this.cursorBo || this.cursorBo !== boId) return false;
    this.cursorBo = 0;
    this.cursorFbId = 0;
    this.cursorBytes = null;
    this.cursor = { ...this.cursor, version: this.cursor.version + 1,
      hotX: 0, hotY: 0, width: 0, height: 0, pixels: null, premultiplied: null };
    return true;
  }

  /** A late release receipt must not clear a renewed grant. */
  dropMaster(fileId: bigint, leaseId: bigint): boolean {
    if (this.masterFileId !== fileId || this.masterLeaseId !== leaseId) return false;
    this.masterPid = null;
    this.masterFileId = null;
    this.masterLeaseId = 0n;
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

  /** The scanned bytes, starting at the viewport's first pixel; rows are
   *  `currentFb(crtc).pitch` apart. */
  scanoutBytes(crtc_id: number): Uint8Array | undefined {
    const fb = this.currentFb(crtc_id);
    if (!fb) return undefined;
    this.gbm.syncFromMemory(fb.bo_id);
    const pixels = this.gbm.readPixelView(fb.bo_id);
    if (!pixels || fb.offset > pixels.byteLength) return undefined;
    return pixels.subarray(fb.offset);
  }
}
