import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import {
  ACCEPTANCE, FATE_AAC_FUZZ, ffmpegProgram, fixture, maxAbsSampleDiff, readFixtureText, run,
} from "./ffmpeg-support";

// Big Buck Bunny (c) Blender Foundation, CC-BY 3.0. Pinned 2026-09-26; see
// fixtures/README.md. Only hashes of its decoded output are committed.
const ZIP_URL = "https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4.zip";
const ZIP_SHA256 = "109e3ede8790bd633f374ca311d9cc61dce8d7f98f5b0797ca98199c9fbceedf";
const MP4_SHA256 = "f78f39603e6774907f2faafabf26a667f4a6fc31769ec304a8a8f7c62d280508";
const CACHE = process.env.KANDELO_FFMPEG_MEDIA_CACHE
  ?? join(homedir(), ".cache/kandelo/ffmpeg-test-media");
const MP4 = join(CACHE, "BigBuckBunny_320x180.mp4");
const FULL_DECODE_MS = 30 * 60_000;
const BX = ["-flags", "+bitexact", "-fflags", "+bitexact"];

const ffmpeg = ffmpegProgram("ffmpeg");
const ffprobe = ffmpegProgram("ffprobe");
const unzip = tryResolveBinary("programs/unzip.wasm");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!ffmpeg || !ffprobe || !unzip)("ffmpeg tier 2: Big Buck Bunny", () => {
  let available = false;

  beforeAll(async () => {
    mkdirSync(CACHE, { recursive: true });
    if (!existsSync(MP4) || sha256(readFileSync(MP4)) !== MP4_SHA256) {
      const zip = join(CACHE, "BigBuckBunny_320x180.mp4.zip");
      if (!existsSync(zip) || sha256(readFileSync(zip)) !== ZIP_SHA256) {
        try {
          const res = await fetch(ZIP_URL);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
        } catch (e) {
          if (ACCEPTANCE) throw new Error(`Big Buck Bunny unreachable: ${String(e)}`);
          return;
        }
      }
      expect(sha256(readFileSync(zip))).toBe(ZIP_SHA256);
      // Extract with Kandelo's own unzip rather than an ambient host tool.
      const r = await run(unzip!, ["unzip", "-o", "-q", zip, "-d", CACHE], { timeout: 300_000 });
      expect(r.exitCode, r.stderr).toBe(0);
    }
    expect(sha256(readFileSync(MP4))).toBe(MP4_SHA256);
    available = true;
  }, 900_000);

  it("decodes the whole video to the native stream hash", async () => {
    if (!available) return;
    const t0 = Date.now();
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-i", MP4,
      "-map", "0:v", ...BX, "-f", "streamhash", "-hash", "sha256", "-"], { timeout: FULL_DECODE_MS });
    console.log(`BBB full video decode: ${((Date.now() - t0) / 1000).toFixed(1)} s (observation, not a benchmark)`);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("bbb.video.streamhash"));
  }, FULL_DECODE_MS);

  it("decodes the whole soundtrack (fixed-point AAC) to native's length", async () => {
    if (!available) return;
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-c:a", "aac_fixed", "-i", MP4,
      "-map", "0:a", "-f", "s16le", "-"], { timeout: FULL_DECODE_MS });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdoutBytes.byteLength).toBe(Number(readFixtureText("bbb.audio-fixed.bytes").trim()));
  }, FULL_DECODE_MS);

  it("matches native within FATE's tolerance where platform math differs", async () => {
    if (!available) return;
    // 10-11 s holds the first samples where native and Kandelo differ by 1.
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-c:a", "aac_fixed", "-i", MP4,
      "-map", "0:a", "-af", "atrim=start=10:end=11", "-f", "s16le", "-"], { timeout: 300_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    const native = new Uint8Array(readFileSync(fixture("bbb.audio-fixed.10s-11s.s16le")));
    expect(maxAbsSampleDiff(r.stdoutBytes, native)).toBeLessThanOrEqual(FATE_AAC_FUZZ);
  }, 300_000);

  it("seeks to 300 s and matches native", async () => {
    if (!available) return;
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-ss", "300", "-i", MP4,
      "-frames:v", "5", "-map", "0:v", ...BX, "-f", "framecrc", "-"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("bbb.seek300.framecrc"));
  }, 300_000);

  it("decodes with 16 threads to the same result or fails cleanly", async () => {
    if (!available) return;
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-threads", "16", "-i", MP4,
      "-map", "0:v", ...BX, "-f", "streamhash", "-hash", "sha256", "-"], { timeout: FULL_DECODE_MS });
    if (r.exitCode === 0) {
      expect(r.stdout).toBe(readFixtureText("bbb.video.streamhash"));
    } else {
      // A clean failure names the resource; a trap or signal death is a gap.
      expect(r.exitCode).toBeLessThan(128);
      expect(r.stderr).toMatch(/thread|resource|memory/i);
    }
  }, FULL_DECODE_MS);

  it("probes a moov-at-end MP4 through a pipe", async () => {
    if (!available) return;
    const r = await run(ffprobe!, ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name",
      "-of", "csv=p=0", "pipe:0"], { stdinBytes: new Uint8Array(readFileSync(MP4)), timeout: 600_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n").sort()).toEqual(["aac", "h264"]);
  }, 600_000);
});
