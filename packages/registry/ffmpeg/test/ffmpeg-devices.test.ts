import { describe, expect, it } from "vitest";
import { ffmpegProgram, fixture, run } from "./ffmpeg-support";

// ffplay video on the Node host (design §6.3): there is no GL there and
// SDL2's KMSDRM backend has no window framebuffer, so no SDL renderer can
// present. ffplay reports it and exits as upstream does, with status 0.
// Documented in docs/browser-support.md ("SDL rendering needs GL").
const NODE_FFPLAY_VIDEO_EXPECTATION = {
  status: 0,
  err: "Failed to create window or renderer: Couldn't find matching render driver",
};

const ffmpeg = ffmpegProgram("ffmpeg");
const ffplay = ffmpegProgram("ffplay");
const clip = fixture("fixture.mp4");

describe.skipIf(!ffmpeg || !ffplay)("ffmpeg devices and ffplay (Node host)", () => {
  it("lists the fbdev and oss devices it was built with", async () => {
    const r = await run(ffmpeg!, ["ffmpeg", "-hide_banner", "-devices"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^\s*D?E\s+fbdev\b/m);
    expect(r.stdout).toMatch(/^\s*D?E\s+oss\b/m);
  });

  it("plays audio to /dev/dsp through FFmpeg's OSS output", async () => {
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-i", clip,
      "-map", "0:a", "-f", "oss", "/dev/dsp"], { timeout: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
  }, 90_000);

  it("writes video frames to /dev/fb0 through FFmpeg's fbdev output", async () => {
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-i", clip,
      "-map", "0:v", "-pix_fmt", "bgra", "-f", "fbdev", "/dev/fb0"], { timeout: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
  }, 90_000);

  it("ffplay plays the soundtrack with -nodisp", async () => {
    const r = await run(ffplay!, ["ffplay", "-v", "error", "-nodisp", "-autoexit", clip],
      { timeout: 60_000, env: ["SDL_AUDIODRIVER=dsp"] });
    expect(r.exitCode, r.stderr).toBe(0);
  }, 90_000);

  it("ffplay video on Node follows the documented boundary", async () => {
    const r = await run(ffplay!, ["ffplay", "-v", "error", "-autoexit", clip],
      { timeout: 60_000, env: ["SDL_AUDIODRIVER=dsp"] });
    expect({ status: r.exitCode, err: r.stderr.trim() }).toEqual(NODE_FFPLAY_VIDEO_EXPECTATION);
  }, 90_000);
});
