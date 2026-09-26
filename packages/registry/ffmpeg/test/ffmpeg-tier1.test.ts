import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FATE_AAC_FUZZ, ffmpegProgram, fixture, maxAbsSampleDiff, readFixtureText, run,
} from "./ffmpeg-support";

// Kandelo's FFmpeg must reproduce native FFmpeg n9.0's output on the same
// input (fixtures/README.md). The argument lists mirror
// reference/generate-fixtures.sh exactly.
const ffmpeg = ffmpegProgram("ffmpeg");
const ffprobe = ffmpegProgram("ffprobe");
const BX = ["-flags", "+bitexact", "-fflags", "+bitexact"];
const clip = fixture("fixture.mp4");

describe.skipIf(!ffmpeg || !ffprobe)("ffmpeg tier 1: bit-exact against native n9.0", () => {
  it("reports its version", async () => {
    const r = await run(ffmpeg!, ["ffmpeg", "-hide_banner", "-version"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^ffmpeg version 9\.0/);
  });

  it("ffprobe reports the fixture's streams exactly", async () => {
    const r = await run(ffprobe!, [
      "ffprobe", "-v", "error", "-show_entries",
      "stream=index,codec_name,codec_type,width,height,pix_fmt,sample_rate,channels",
      "-of", "json", clip,
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(readFixtureText("fixture.ffprobe.json")));
  });

  it("decodes video to the native framecrc", async () => {
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-i", clip,
      "-map", "0:v", ...BX, "-f", "framecrc", "-",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("fixture.video.framecrc"));
  });

  it("frame-threaded decode is identical to single-threaded", async () => {
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-v", "error", "-threads", "4", "-i", clip,
      "-map", "0:v", ...BX, "-f", "framecrc", "-",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("fixture.video.framecrc"));
  });

  it("fixed-point AAC decode is within FATE's tolerance of native", async () => {
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-v", "error", "-c:a", "aac_fixed", "-i", clip,
      "-map", "0:a", "-f", "s16le", "-",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    const native = new Uint8Array(readFileSync(fixture("fixture.audio-fixed.s16le")));
    expect(maxAbsSampleDiff(r.stdoutBytes, native)).toBeLessThanOrEqual(FATE_AAC_FUZZ);
  });

  it("float AAC decode is within FATE's tolerance of native", async () => {
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-v", "error", "-i", clip, "-map", "0:a", "-f", "s16le", "-",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    const native = new Uint8Array(readFileSync(fixture("fixture.audio-float.s16le")));
    expect(maxAbsSampleDiff(r.stdoutBytes, native)).toBeLessThanOrEqual(FATE_AAC_FUZZ);
  });
});
