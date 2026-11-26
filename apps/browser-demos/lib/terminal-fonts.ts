/// <reference path="./terminal-font-assets.d.ts" />

import type { Terminal } from "@xterm/xterm";
import type { TerminalFontAsset } from "virtual:kandelo-terminal-fonts";
import baseFontUrl from "@fontsource-variable/noto-sans-mono/files/noto-sans-mono-latin-wght-normal.woff2?url&no-inline";

export const LOCAL_TERMINAL_FONTS = '"JetBrains Mono", "SF Mono", Menlo, monospace';
const BASE_FAMILY = "Kandelo Noto Mono";
const BASE_ASSET = { url: baseFontUrl, weight: "100 900" };
const BASE_TIMEOUT_MS = 1200;
const FONT_TIMEOUT_MS = 8000;
const OUTPUT_WAIT_MS = 400;
const OUTPUT_BYTE_LIMIT = 256 * 1024;
const OUTPUT_CHUNK_LIMIT = 512;

function subsetFamily(index: number): string {
  return `Kandelo Terminal Font ${index}`;
}

class TerminalFonts {
  private baseLoad?: Promise<string>;
  private catalogLoad?: Promise<void>;
  private assets?: readonly (TerminalFontAsset | null)[];
  bmp?: Uint16Array;
  private readonly supplementary = new Map<number, number>();
  private readonly ranges: string[][] = [];
  private readonly subsets = new Map<number, Promise<boolean>>();
  readonly loaded = new Set<number>();

  constructor(private readonly document: Document) {}

  baseFamily(): Promise<string> {
    return this.baseLoad ??= this.load(BASE_FAMILY, BASE_ASSET, BASE_TIMEOUT_MS)
      .then(loaded => loaded ? `"${BASE_FAMILY}", ${LOCAL_TERMINAL_FONTS}` : LOCAL_TERMINAL_FONTS);
  }

  ensureCatalog(text: string): Promise<void> | undefined {
    // The base face already includes the printable Latin-1 repertoire.
    // Ordinary names such as "café" do not need the catalog.
    if (this.assets || !/[^\u0000-\u00ff]/.test(text)) return;
    return this.catalogLoad ??= import("virtual:kandelo-terminal-fonts").then(({ assets, packedSpans }) => {
      const bmp = new Uint16Array(0x10000);
      const bytes = atob(packedSpans);
      let offset = 0;
      const read = () => {
        let value = 0;
        let shift = 0;
        let byte: number;
        do {
          byte = bytes.charCodeAt(offset++);
          value |= (byte & 0x7f) << shift;
          shift += 7;
        } while (byte & 0x80);
        return value;
      };
      let previousEnd = 127;
      while (offset < bytes.length) {
        const start = previousEnd + 1 + read();
        const end = start + read();
        const index = read();
        previousEnd = end;
        if (index === 0) continue;
        if (start < bmp.length) bmp.fill(index, start, Math.min(end + 1, bmp.length));
        for (let cp = Math.max(start, bmp.length); cp <= end; cp++) this.supplementary.set(cp, index);
        // Expose only the code points assigned to this asset. Activating a
        // new subset must not change existing glyphs or the ASCII grid.
        const range = start === end ? start.toString(16) : `${start.toString(16)}-${end.toString(16)}`;
        (this.ranges[index] ??= []).push(`U+${range}`);
      }
      this.bmp = bmp;
      this.assets = assets;
    }).catch(error => {
      this.assets = [];
      console.warn("Unable to load the terminal font catalog", error);
    });
  }

  findSupplementarySubset(codePoint: number): number {
    return this.supplementary.get(codePoint) ?? 0;
  }

  loadSubset(index: number): Promise<boolean> {
    const existing = this.subsets.get(index);
    if (existing) return existing;
    const asset = this.assets?.[index];
    if (!asset) return Promise.resolve(false);
    // The final combining-mark fallback can also render the base of a
    // mixed-script cluster when earlier faces cannot cover it as a whole.
    const unicodeRange = asset.clusterFallback ? "U+20,U+0080-10FFFF" : this.ranges[index].join(",");
    const task = this.load(subsetFamily(index), asset, FONT_TIMEOUT_MS, unicodeRange).then(loaded => {
      if (loaded) this.loaded.add(index);
      return loaded;
    });
    this.subsets.set(index, task);
    return task;
  }

  private async load(family: string, asset: TerminalFontAsset, timeout: number, unicodeRange?: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const face = new FontFace(family, `url(${JSON.stringify(asset.url)}) format("woff2")`, {
        weight: asset.weight,
        unicodeRange,
      });
      await Promise.race([
        face.load(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Font load timed out")), timeout);
        }),
      ]);
      // Register only loaded faces. This keeps font fetching under the
      // catalog's control even after the writer has fallen back.
      this.document.fonts.add(face);
      return true;
    } catch (error) {
      console.warn(`Unable to load ${family}`, error);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

const managers = new WeakMap<Document, TerminalFonts>();

function terminalFonts(document: Document): TerminalFonts {
  let fonts = managers.get(document);
  if (!fonts) {
    fonts = new TerminalFonts(document);
    managers.set(document, fonts);
  }
  return fonts;
}

export function loadTerminalBaseFont(document: Document): Promise<string> {
  return terminalFonts(document).baseFamily();
}

type Output = string | Uint8Array;
interface QueuedOutput {
  data: Output;
  callback?: () => void;
  ready: boolean;
}

function firstNonAscii(data: Output): number {
  if (typeof data === "string") return data.search(/[^\x00-\x7f]/);
  for (let i = 0; i < data.length; i++) {
    if (data[i] >= 0x80) return i;
  }
  return -1;
}

/** Preserve xterm's original byte stream and batching. Only a font miss
 * holds output. A slow resource can delay the start of a batch, but it
 * cannot stall a shell indefinitely or accumulate unbounded PTY history. */
export class TerminalFontWriter {
  private readonly fonts: TerminalFonts;
  private readonly decoder = new TextDecoder();
  private readonly requested = new Map<number, Promise<void>>();
  private readonly active: boolean[] = [];
  private readonly activeIndexes: number[] = [];
  private readonly base: string;
  private readonly queue: QueuedOutput[] = [];
  private head = 0;
  private queuedBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private decoderUsed = false;
  private dirty = false;
  private updateScheduled = false;
  private disposed = false;

  constructor(private readonly terminal: Pick<Terminal, "options" | "write">, document: Document) {
    this.fonts = terminalFonts(document);
    this.base = terminal.options.fontFamily ?? LOCAL_TERMINAL_FONTS;
  }

  write(data: Output, callback?: () => void): void {
    if (this.disposed) return;
    const pending = this.prepare(data);
    if (!pending && this.queue.length === 0) {
      this.applyFonts();
      this.terminal.write(data, callback);
      return;
    }

    const entry = { data, callback, ready: !pending };
    this.queue.push(entry);
    this.queuedBytes += this.size(data);
    if (this.queuedBytes > OUTPUT_BYTE_LIMIT || this.queue.length > OUTPUT_CHUNK_LIMIT) {
      this.drain(true);
      return;
    }
    this.timer ??= setTimeout(() => this.drain(true), OUTPUT_WAIT_MS);
    if (pending) {
      void pending.then(() => {
        entry.ready = true;
        this.drain();
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearQueue();
  }

  private prepare(data: Output): Promise<void> | undefined {
    if (!data.length) return;
    const first = firstNonAscii(data);
    if (first === -1) {
      // An ASCII byte cannot complete a pending UTF-8 sequence. Reset only
      // the inspection decoder and let xterm decode the untouched stream.
      if (typeof data !== "string" && this.decoderUsed) {
        this.decoder.decode();
        this.decoderUsed = false;
      }
      return;
    }

    let text: string;
    if (typeof data === "string") {
      text = data.slice(first);
    } else {
      text = this.decoder.decode(data, { stream: true });
      this.decoderUsed = true;
    }
    if (!text) return;

    const catalog = this.fonts.ensureCatalog(text);
    if (catalog) return catalog.then(() => this.disposed ? undefined : this.prepareText(text));
    return this.prepareText(text);
  }

  private prepareText(text: string): Promise<void> | undefined {
    let pending: Set<Promise<void>> | undefined;
    const bmp = this.fonts.bmp;
    if (!bmp) return;
    for (let i = 0; i < text.length; i++) {
      const codeUnit = text.charCodeAt(i);
      const cp = codeUnit >= 0xd800 && codeUnit <= 0xdbff ? text.codePointAt(i)! : codeUnit;
      if (cp > 0xffff) i++;
      const index = cp <= 0xffff ? bmp[cp] : this.fonts.findSupplementarySubset(cp);
      if (!index || this.active[index]) continue;
      if (this.fonts.loaded.has(index)) {
        this.activate(index);
        continue;
      }

      let load = this.requested.get(index);
      if (!load) {
        load = this.fonts.loadSubset(index).then(loaded => {
          if (loaded) this.activate(index);
          else this.requested.set(index, FINISHED_FONT_REQUEST);
        });
        this.requested.set(index, load);
      }
      if (load !== FINISHED_FONT_REQUEST) (pending ??= new Set()).add(load);
    }
    if (pending) return Promise.all(pending).then(() => undefined);
  }

  private activate(index: number): void {
    if (this.disposed || this.active[index]) return;
    this.active[index] = true;
    this.activeIndexes.push(index);
    this.dirty = true;
    // A late load can improve rows already flushed with fallback metrics.
    // Coalesce concurrent arrivals. Font-family changes clear xterm's font
    // width cache and redraw through its public option path.
    if (this.updateScheduled) return;
    this.updateScheduled = true;
    queueMicrotask(() => {
      this.updateScheduled = false;
      this.applyFonts();
    });
  }

  private applyFonts(): void {
    if (this.disposed || !this.dirty) return;
    this.dirty = false;
    const fallbacks = this.activeIndexes.sort((a, b) => a - b)
      .map(index => `"${subsetFamily(index)}"`).join(", ");
    this.terminal.options.fontFamily = this.base.startsWith(`"${BASE_FAMILY}"`)
      ? `"${BASE_FAMILY}", ${fallbacks}, ${LOCAL_TERMINAL_FONTS}`
      : `${fallbacks}, ${this.base}`;
  }

  private drain(force = false): void {
    if (this.disposed || this.queue.length === 0) return;
    this.applyFonts();
    while (this.head < this.queue.length) {
      const entry = this.queue[this.head];
      if (!force && !entry.ready) break;
      this.head++;
      this.queuedBytes -= this.size(entry.data);
      this.terminal.write(entry.data, entry.callback);
    }
    if (this.head === this.queue.length) this.clearQueue();
  }

  private clearQueue(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.head = 0;
    this.queuedBytes = 0;
  }

  private size(data: Output): number {
    return typeof data === "string" ? data.length * 2 : data.byteLength;
  }
}

const FINISHED_FONT_REQUEST = Promise.resolve();
