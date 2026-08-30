/**
 * PR7 Phase-1 gate: libwpkdraw rasterizes into a caller-owned heap buffer.
 *
 * Spawns programs/wpkdraw_smoke.c under a NodeKernelHost. The program wraps
 * a heap buffer as a wpk_surface, fills a red rect, and renders "OK" text —
 * all pure CPU, no compositor and no KMS. It self-reports a sampled rect
 * pixel and the glyph coverage over stdout, which we assert here (there is
 * no framebuffer to read back). Skips if the binary isn't built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const bin = tryResolveBinary("programs/wpkdraw_smoke.wasm");
const hasBinary = !!bin;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("wpkdraw — CPU raster into a wrapped heap buffer", () => {
  it.skipIf(!hasBinary)(
    "fills a red rect and renders glyph coverage",
    async () => {
      const out = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { out.value += new TextDecoder().decode(data); },
      });

      try {
        await host.init();
        const code = await host.spawn(loadBytes(bin!), ["wpkdraw_smoke"], {});
        expect(code, out.value).toBe(0);

        // Opaque red fill landed in the sampled pixel (ARGB8888).
        const rect = out.value.match(/RECT_PX x=15 y=15 px=0x([0-9a-f]{8})/);
        expect(rect, out.value).not.toBeNull();
        expect(parseInt(rect![1], 16) >>> 0).toBe(0xffff0000);

        // "OK" measured to a sane width for a 16px monospace face.
        const width = out.value.match(/TEXT_WIDTH s=OK w=(\d+)/);
        expect(width, out.value).not.toBeNull();
        expect(Number(width![1])).toBeGreaterThan(4);

        // The glyph rasterizer lit pixels inside the text box.
        const cover = out.value.match(/GLYPH_COVERAGE n=(\d+)/);
        expect(cover, out.value).not.toBeNull();
        expect(Number(cover![1])).toBeGreaterThan(0);

        // AA line: fully-saturated core, partially-covered fringe pixels
        // (intermediate channel values — impossible with hard-edged rects).
        const line = out.value.match(/AA_LINE core=0x([0-9a-f]{8}) fringe=(\d+)/);
        expect(line, out.value).not.toBeNull();
        expect(parseInt(line![1], 16) >>> 0).toBe(0xff00ff00);
        expect(Number(line![2])).toBeGreaterThan(0);

        // AA disc: same contract.
        const disc = out.value.match(/AA_DISC core=0x([0-9a-f]{8}) fringe=(\d+)/);
        expect(disc, out.value).not.toBeNull();
        expect(parseInt(disc![1], 16) >>> 0).toBe(0xff0000ff);
        expect(Number(disc![2])).toBeGreaterThan(0);

        // Scale 2: a logical coordinate lands at twice the device one, so
        // the logical rect (10,10)-(30,30) fills device (20,20)-(60,60)
        // exactly — lit at its far corner, black one pixel past it. An
        // off-by-one in the multiply or the clip shows up here.
        const scaled = out.value.match(
          /SCALED_RECT in=0x([0-9a-f]{8}) edge=0x([0-9a-f]{8}) out=0x([0-9a-f]{8})/);
        expect(scaled, out.value).not.toBeNull();
        expect(parseInt(scaled![1], 16) >>> 0).toBe(0xffff0000);
        expect(parseInt(scaled![2], 16) >>> 0).toBe(0xffff0000);
        expect(parseInt(scaled![3], 16) >>> 0).toBe(0xff000000);

        // Metrics stay LOGICAL, so an app's layout is unchanged by the
        // scale — the glyphs are rasterized bigger, not the boxes.
        const scaledWidth = out.value.match(/SCALED_TEXT_WIDTH s=OK w=(\d+)/);
        expect(scaledWidth, out.value).not.toBeNull();
        expect(Number(scaledWidth![1])).toBe(Number(width![1]));
        const scaledAscent = out.value.match(/SCALED_ASCENT px=(\d+)/);
        expect(scaledAscent, out.value).not.toBeNull();
        expect(Number(scaledAscent![1])).toBeGreaterThan(0);

        expect(out.value).toContain("WPKDRAW_SMOKE_OK");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    30_000,
  );
});
